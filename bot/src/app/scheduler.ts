import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import cron from "node-cron";
import type { Config } from "../config.js";
import { msgBelumLapor, msgGangguanDitutup, msgOwner, msgPagi, msgRekap, msgTidakCocok } from "../domain/messages.js";
import { dailyByHost } from "../domain/rekap.js";
import { addDays, jakartaDateTime, toJakartaDate, toJakartaHM } from "../domain/time.js";
import type { Settings } from "../domain/types.js";
import type { Db } from "../infra/db.js";
import type { Extractor } from "../infra/extractor.js";
import type { GangguanRow, Invalid, SheetOp, SheetsGateway } from "../infra/sheets.js";
import type { Incoming, WahaClient } from "../infra/waha.js";
import {
  barisGangguan, handleMessage, KV_GANGGUAN_AKTIF, retryPending, type GangguanAktif, type HandleDeps, type UploadBuktiOp,
} from "./handleMessage.js";
import {
  bacaInputOwner, catatTerapan, masalahHari, opUsang, refresh, sinkron, type InputOwner, type OpBerversi, type RefreshGateway,
  type RefreshResult,
} from "./refresh.js";

/*
 * Penjadwal: cron (Asia/Jakarta) memanggil fungsi "apa yang dikerjakan pada jam T" di bawah; semuanya membaca jam
 * dari deps.now() sehingga bisa diuji dengan jam palsu.
 *   tiap menit  flushOutbox, lalu pesan pagi (jamPagi), tag akhir shift (Jadwal aktif), rekap malam
 *   tiap 5 mnt  detak (Heartbeat) dan proses ulang gambar tertunda
 *   tiap 15 mnt refresh
 *   23:50       pengecekan silang Kontrol
 * Pesan grup diserialkan di antrean `pesan` (handleMessage, catch-up, proses ulang); refresh dan pesan terjadwal di
 * antrean `tugas`. Pesan inisiatif bot lewat sendCapped (batas per penerima per hari; tanda terima tidak dihitung).
 */

const ZONA = "Asia/Jakarta";
const MENIT_MS = 60_000;
/** Pesan terjadwal yang terlewat (bot baru hidup) masih dikirim selama ini sesudah jamnya. */
const JENDELA_MS = 60 * MENIT_MS;
const REKAP_SETELAH_LAPORAN_MS = 30 * MENIT_MS;
const CATCH_UP_MUNDUR_MS = 5 * MENIT_MS;
const BATAS_PESAN_BAWAAN = 6;
const SELISIH_MAKS_RP = 1;
const BATCH_ANTREAN = 50;
const KV_INPUT = "inputOwner";

export type Gateway = RefreshGateway & Pick<SheetsGateway, "apply" | "uploadBukti" | "readKontrol" | "readKoreksiMenunggu">;

export interface SchedulerDeps {
  config: Pick<Config, "LIVE_GROUP_ID">;
  db: Db;
  waha: Pick<WahaClient, "sendText" | "download" | "messagesSince" | "sessionStatus">;
  extractor: Extractor;
  gateway: Gateway;
  dataDir: string;
  now: () => Date;
  /** Penampung onInvalid SheetsGateway (3rd constructor arg). */
  invalid: Invalid[];
}

/** Antrean satu-per-satu: kerja berikutnya mulai setelah kerja sebelumnya selesai (berhasil atau gagal). */
export type Antrean = <T>(kerja: () => Promise<T>) => Promise<T>;

export function buatAntrean(): Antrean {
  let ekor: Promise<unknown> = Promise.resolve();
  return <T>(kerja: () => Promise<T>): Promise<T> => {
    const hasil = ekor.then(kerja);
    ekor = hasil.catch(() => undefined);
    return hasil;
  };
}

export interface Runtime {
  readonly deps: SchedulerDeps;
  /** Input owner terakhir (refresh); null sampai pernah terbaca. Disalin ke kv supaya bertahan restart. */
  input: InputOwner | null;
  /** Status sesi WAHA dari detak terakhir (GET /health). */
  waStatus: string;
  readonly pesan: Antrean;
  readonly tugas: Antrean;
  flush: Promise<void> | null;
  prosesUlangJalan: boolean;
  /** Ada pesan yang mungkin terlewat (WAHA/Sheets belum siap); catch-up diulang di menit berikutnya. */
  perluCatchUp: boolean;
}

export function buatRuntime(deps: SchedulerDeps): Runtime {
  return {
    deps, input: muatInput(deps.db), waStatus: "UNKNOWN", pesan: buatAntrean(), tugas: buatAntrean(),
    flush: null, prosesUlangJalan: false, perluCatchUp: false,
  };
}

/* ---------- Pesan masuk ---------- */

function handleDeps(rt: Runtime): HandleDeps | null {
  if (!rt.input) return null;
  const { config, db, waha, extractor, dataDir, now } = rt.deps;
  return {
    config, db, waha, extractor, dataDir, now, settings: rt.input.settings, koreksi: rt.input.koreksi,
    kirimOwner: (text) => kirimOwner(rt, text),
  };
}

async function proses(rt: Runtime, m: Incoming, deps: HandleDeps): Promise<void> {
  try {
    await handleMessage(m, deps);
  } catch (e) {
    console.error(`penjadwal: pesan ${m.id} gagal diproses: ${pesanError(e)}`);
  }
}

/** Webhook → antrean pesan. Tanpa input owner (belum pernah terbaca) pesan ditinggal dan diambil lagi oleh catch-up. */
export function terima(rt: Runtime, m: Incoming): Promise<void> {
  return rt.pesan(async () => {
    const deps = handleDeps(rt);
    if (!deps) {
      rt.perluCatchUp = true;
      console.error(`penjadwal: pesan ${m.id} menunggu catch-up (Pengaturan belum pernah terbaca)`);
      return;
    }
    await proses(rt, m, deps);
  });
}

export function catchUp(rt: Runtime): Promise<void> {
  return rt.pesan(() => catchUpSekarang(rt));
}

/** messagesSince(grup, lastProcessedTs − 5 menit), urut ts; pesan yang sudah ditandai dilewati handleMessage. */
async function catchUpSekarang(rt: Runtime): Promise<void> {
  const deps = handleDeps(rt);
  if (!deps) {
    rt.perluCatchUp = true;
    return;
  }
  const terakhir = rt.deps.db.lastProcessedTs();
  rt.perluCatchUp = false;
  if (!terakhir) return;
  let pesan: Incoming[];
  try {
    pesan = await rt.deps.waha.messagesSince(rt.deps.config.LIVE_GROUP_ID, new Date(terakhir.getTime() - CATCH_UP_MUNDUR_MS));
  } catch (e) {
    rt.perluCatchUp = true;
    console.error(`penjadwal: catch-up gagal, diulang menit berikutnya: ${pesanError(e)}`);
    return;
  }
  for (const m of [...pesan].sort((a, b) => a.ts.getTime() - b.ts.getTime())) await proses(rt, m, deps);
}

/** Proses ulang gambar tertunda (tiap 5 menit) di antrean pesan; tidak pernah tumpang tindih atau menumpuk. */
export async function prosesUlang(rt: Runtime): Promise<void> {
  if (rt.prosesUlangJalan) return;
  rt.prosesUlangJalan = true;
  try {
    await rt.pesan(async () => {
      const deps = handleDeps(rt);
      if (deps) await retryPending(deps);
    });
  } catch (e) {
    console.error(`penjadwal: proses ulang gagal: ${pesanError(e)}`);
  } finally {
    rt.prosesUlangJalan = false;
  }
}

/* ---------- Pengiriman pesan inisiatif bot ---------- */

/** Kirim pesan inisiatif bot; kalau sentCount ≥ batas per hari, tidak dikirim dan dicatat ke Log Bot. */
export async function sendCapped(rt: Runtime, waId: string, text: string, mentions?: string[]): Promise<boolean> {
  const { db, waha, now } = rt.deps;
  const tanggal = toJakartaDate(now());
  const batas = rt.input?.settings.maxPesanPerHari ?? BATAS_PESAN_BAWAAN;
  if (db.sentCount(waId, tanggal) >= batas) {
    catatLog(rt, "WARN", `Pesan bot ke ${waId} tidak dikirim: batas ${batas} pesan per hari tercapai. Isi: ${text}`);
    return false;
  }
  try {
    await waha.sendText(waId, text, undefined, mentions && mentions.length > 0 ? mentions : undefined);
  } catch (e) {
    console.error(`penjadwal: kirim pesan ke ${waId} gagal: ${pesanError(e)}`);
    catatLog(rt, "ERROR", `Kirim pesan ke ${waId} gagal: ${pesanError(e)}`);
    return false;
  }
  db.logSent(waId, tanggal);
  return true;
}

/** Teguran, eskalasi, dan ringkasan hanya pribadi ke owner (Pengaturan "No WA owner"). */
async function kirimOwner(rt: Runtime, text: string): Promise<boolean> {
  const owner = rt.input?.settings.ownerWaId;
  if (!owner) {
    console.error("penjadwal: No WA owner belum diisi, pesan owner tidak terkirim");
    catatLog(rt, "WARN", `No WA owner belum diisi; pesan owner tidak terkirim: ${text}`);
    return false;
  }
  return sendCapped(rt, owner, text);
}

function catatLog(rt: Runtime, level: string, pesan: string): void {
  rt.deps.db.outbox.push({ type: "appendLog", at: rt.deps.now(), level, pesan });
}

const waIds = (s: Settings, hosts: string[]): string[] =>
  s.hosts.filter((h) => hosts.includes(h.name) && h.waId).map((h) => h.waId!);

/* ---------- Antrean ke Sheets ---------- */

/** Jalankan operasi antrean yang jatuh tempo (urut id). Gagal → backoff db.outbox.fail; log hanya err.message. */
export function flushOutbox(rt: Runtime): Promise<void> {
  rt.flush ??= jalankanAntrean(rt).finally(() => { rt.flush = null; });
  return rt.flush;
}

async function jalankanAntrean(rt: Runtime): Promise<void> {
  const { db } = rt.deps;
  for (const item of db.outbox.next(BATCH_ANTREAN)) {
    try {
      await jalankanOp(rt, item.op);
      db.outbox.ack(item.id);
    } catch (e) {
      db.outbox.fail(item.id);
      console.error(`antrean: ${item.op.type} #${item.id} gagal (percobaan ${item.attempts + 1}): ${pesanError(e)}`);
    }
  }
}

async function jalankanOp(rt: Runtime, op: OpBerversi): Promise<void> {
  const { db, gateway } = rt.deps;
  if (op.type === "uploadBukti") return unggahBukti(rt, op as unknown as UploadBuktiOp);
  if (opUsang(db, op)) return;
  await gateway.apply(keSheetOp(op));
  catatTerapan(db, op);
}

/** Dedupe per messageId (kv bukti:<messageId> sudah ada → lewati); berkas hilang → "" (Sesi Live tanpa tautan). */
async function unggahBukti(rt: Runtime, op: UploadBuktiOp): Promise<void> {
  const { db, gateway } = rt.deps;
  const k = `bukti:${op.messageId}`;
  if (db.getKv(k) !== null) return;
  if (!existsSync(op.path)) {
    db.setKv(k, "");
    catatLog(rt, "WARN", `Bukti ${op.messageId} tidak diunggah: berkas lokal tidak ada`);
    return;
  }
  db.setKv(k, await gateway.uploadBukti(readFileSync(op.path), basename(op.path)));
}

/** Operasi tersimpan sebagai JSON: buang penanda versi, pulihkan Date. */
function keSheetOp(op: OpBerversi): SheetOp {
  const { versi: _versi, ...rest } = op;
  if ((rest.type === "appendLog" || rest.type === "writeHeartbeat") && typeof rest.at === "string") {
    return { ...rest, at: new Date(rest.at) } as unknown as SheetOp;
  }
  return rest as unknown as SheetOp;
}

/* ---------- Detak dan refresh ---------- */

export async function detak(rt: Runtime): Promise<void> {
  let status: string;
  try {
    status = await rt.deps.waha.sessionStatus();
  } catch (e) {
    status = "UNREACHABLE";
    console.error(`detak: status WAHA tidak terbaca: ${pesanError(e)}`);
  }
  rt.waStatus = status;
  try {
    await rt.deps.gateway.apply({ type: "writeHeartbeat", at: rt.deps.now(), waStatus: status });
  } catch (e) {
    console.error(`detak: Heartbeat gagal ditulis: ${pesanError(e)}`);
  }
}

export function jalankanRefresh(rt: Runtime, today?: string): Promise<RefreshResult | null> {
  return rt.tugas(() => refreshSekarang(rt, today));
}

/** Refresh di dalam kerja antrean `tugas`. null bila input owner belum pernah terbaca. */
async function refreshSekarang(rt: Runtime, today = toJakartaDate(rt.deps.now())): Promise<RefreshResult | null> {
  const { db, gateway, now, invalid } = rt.deps;
  let hasil: RefreshResult;
  try {
    hasil = await refresh({ db, gateway, now, invalid }, today, rt.input);
  } catch (e) {
    console.error(`refresh gagal: ${pesanError(e)}`);
    return null;
  }
  rt.input = hasil.input;
  simpanInput(db, hasil.input);
  for (const p of hasil.pesanOwner) await kirimOwner(rt, p);
  return hasil;
}

/* ---------- Pesan terjadwal ---------- */

/** Dijalankan tiap menit: antrean ke Sheets, catch-up tertunda, lalu pesan pagi, tag akhir shift, rekap malam. */
export async function tiapMenit(rt: Runtime): Promise<void> {
  await flushOutbox(rt);
  if (!rt.input) await jalankanRefresh(rt);
  if (rt.perluCatchUp && rt.input) await catchUp(rt);
  await rt.tugas(async () => {
    for (const [nama, kerja] of [["pagi", pagi], ["akhir shift", akhirShift], ["rekap", rekap]] as const) {
      try {
        await kerja(rt);
      } catch (e) {
        console.error(`penjadwal: ${nama} gagal: ${pesanError(e)}`);
      }
    }
  });
}

const dalamJendela = (now: Date, mulai: Date): boolean =>
  now.getTime() >= mulai.getTime() && now.getTime() < mulai.getTime() + JENDELA_MS;

function gangguanAktif(db: Db): GangguanAktif[] {
  const v = db.getKv(KV_GANGGUAN_AKTIF);
  if (!v) return [];
  try {
    const arr = JSON.parse(v) as unknown;
    return Array.isArray(arr) ? (arr as GangguanAktif[]) : [];
  } catch {
    return [];
  }
}

/** Tanggal live: laporan sebelum 06:00 ikut hari sebelumnya (sama dengan ledger). */
function hariLive(t: Date): string {
  const tanggal = toJakartaDate(t);
  return toJakartaHM(t) < "06:00" ? addDays(tanggal, -1) : tanggal;
}

function laporanTerakhir(db: Db, hari: string): Date | null {
  let akhir: Date | null = null;
  for (const r of db.reports(hari.slice(0, 7))) {
    if (hariLive(r.receivedAt) === hari && (!akhir || r.receivedAt > akhir)) akhir = r.receivedAt;
  }
  return akhir;
}

/** Rekap = jamRekap, atau 30 menit setelah laporan terakhir kalau itu lebih lambat. */
export function waktuRekap(hari: string, jamRekap: string, terakhir: Date | null): Date {
  const jadwal = jakartaDateTime(hari, jamRekap).getTime();
  return new Date(Math.max(jadwal, terakhir ? terakhir.getTime() + REKAP_SETELAH_LAPORAN_MS : 0));
}

/** Update pagi di grup sekali per hari; Jadwal aktif → hanya host yang masuk shift. Tidak dikirim selama gangguan. */
async function pagi(rt: Runtime): Promise<void> {
  const { db, now } = rt.deps;
  const t = now();
  const hari = toJakartaDate(t);
  const k = `pagi:${hari}`;
  if (!rt.input || db.getKv(k) !== null) return;
  if (!dalamJendela(t, jakartaDateTime(hari, rt.input.settings.jamPagi)) || gangguanAktif(db).length > 0) return;
  const hasil = await refreshSekarang(rt, hari);
  if (!hasil) return;
  db.setKv(k, t.toISOString());
  const { settings, jadwal, gangguan } = hasil.input;
  const rows = jadwal ? hasil.summaries.filter((s) => jadwal.some((j) => j.date === hari && j.host === s.host)) : hasil.summaries;
  if (rows.length === 0) return;
  const kemarin = addDays(hari, -1);
  const gangguanKemarin = [...new Set(gangguan.filter((g) => g.date === kemarin && g.host !== "").map((g) => g.host))];
  await sendCapped(rt, rt.deps.config.LIVE_GROUP_ID, msgPagi(hari, rows, gangguanKemarin), waIds(settings, rows.map((r) => r.host)));
}

/** Jadwal aktif: di akhir shift, tag host yang hari itu belum lapor sama sekali (sekali per host per tanggal). */
async function akhirShift(rt: Runtime): Promise<void> {
  const { db, now } = rt.deps;
  const input = rt.input;
  if (!input?.settings.jadwalAktif || !input.jadwal || gangguanAktif(db).length > 0) return;
  const t = now();
  const hari = toJakartaDate(t);
  for (const r of input.jadwal) {
    if (r.date !== hari && r.date !== addDays(hari, -1)) continue;
    const selesai = jakartaDateTime(r.selesai <= r.mulai ? addDays(r.date, 1) : r.date, r.selesai);
    const k = `akhirShift:${r.date}|${r.host}`;
    if (!dalamJendela(t, selesai) || db.getKv(k) !== null) continue;
    db.setKv(k, t.toISOString());
    const sudahLapor = db.reports(r.date.slice(0, 7)).some((x) => x.host === r.host && hariLive(x.receivedAt) === r.date);
    if (sudahLapor) continue;
    const host = input.settings.hosts.find((h) => h.name === r.host) ?? { name: r.host };
    await sendCapped(rt, rt.deps.config.LIVE_GROUP_ID, msgBelumLapor(host), host.waId ? [host.waId] : undefined);
  }
}

/** Rekap malam (grup) + ringkasan owner (pribadi); gangguan yang masih aktif ditutup lebih dulu. */
async function rekap(rt: Runtime): Promise<void> {
  const { db, now, gateway } = rt.deps;
  const t = now();
  const hari = hariLive(t);
  const k = `rekap:${hari}`;
  if (!rt.input || db.getKv(k) !== null) return;
  const terakhir = laporanTerakhir(db, hari);
  if (t.getTime() < waktuRekap(hari, rt.input.settings.jamRekap, terakhir).getTime()) return;
  const hasil = await refreshSekarang(rt, hari);
  if (!hasil) return;
  db.setKv(k, t.toISOString());
  const ditutup = tutupGangguan(rt, hari, terakhir);
  const { settings } = hasil.input;
  const perHari = dailyByHost(hasil.ledger, hari.slice(0, 7));
  const harian = Object.fromEntries(hasil.summaries.map((s) => [s.host, perHari[s.host]?.[hari] ?? 0]));
  await sendCapped(rt, rt.deps.config.LIVE_GROUP_ID, msgRekap(hari, hasil.summaries, harian),
    waIds(settings, hasil.summaries.map((s) => s.host)));
  let koreksiMenunggu = 0;
  try {
    koreksiMenunggu = await gateway.readKoreksiMenunggu();
  } catch (e) {
    console.error(`rekap: jumlah koreksi menunggu tidak terbaca: ${pesanError(e)}`);
  }
  // Eskalasi dikirim sendiri oleh refresh saat streak baru dimulai, tidak diulang di ringkasan.
  await kirimOwner(rt, msgOwner(hari, { ...masalahHari(hasil.ledger, hari), koreksiMenunggu, eskalasi: [] }));
  if (ditutup.length > 0) await kirimOwner(rt, msgGangguanDitutup(ditutup));
}

/** Gangguan aktif saat rekap: selesai di jam live selesai, atau laporan terakhir sesudah mulai kalau lebih awal. */
function tutupGangguan(rt: Runtime, hari: string, terakhir: Date | null): GangguanRow[] {
  const { db } = rt.deps;
  const aktif = gangguanAktif(db);
  if (aktif.length === 0 || !rt.input) return [];
  const batas = jakartaDateTime(hari, rt.input.settings.liveSelesai);
  const rows: GangguanRow[] = [];
  for (const g of aktif) {
    const mulai = jakartaDateTime(g.tanggal, g.mulai);
    let selesai = batas;
    if (terakhir && terakhir > mulai && terakhir < selesai) selesai = terakhir;
    if (selesai < mulai) selesai = mulai;
    rows.push(...barisGangguan(g, selesai));
  }
  for (const row of rows) db.outbox.push({ type: "appendGangguan", row });
  db.setKv(KV_GANGGUAN_AKTIF, "");
  return rows;
}

/* ---------- Pengecekan silang ---------- */

/**
 * 23:50: realisasi bulan ini di tab Kontrol (rumus) vs hitungan bot. Selisih > Rp1, atau host tidak ada di Kontrol
 * (sel error), → Log Bot per host + satu pesan owner. Dilewati selama Data Kredit/Target Harian terbaru belum terkirim.
 */
export function cekSilang(rt: Runtime): Promise<void> {
  return rt.tugas(async () => {
    const { db, gateway, now } = rt.deps;
    const hari = toJakartaDate(now());
    const hasil = await refreshSekarang(rt, hari);
    if (!hasil) return;
    await flushOutbox(rt); // tunggu flush yang sedang jalan, lalu satu putaran penuh
    await flushOutbox(rt);
    const bulan = hari.slice(0, 7);
    if (!sinkron(db, `kredit:${bulan}`) || !sinkron(db, `targetHarian:${bulan}`)) {
      catatLog(rt, "WARN", "Pengecekan silang dilewati: tulisan ke spreadsheet masih tertunda di antrean");
      return;
    }
    const kontrol = await gateway.readKontrol();
    const beda = hasil.summaries.filter((s) => {
      const v = kontrol[s.host];
      return v === undefined || Math.abs(v - s.realisasi) > SELISIH_MAKS_RP;
    });
    for (const s of beda) {
      catatLog(rt, "WARN", `Pengecekan silang: ${s.host} di Kontrol ${kontrol[s.host] ?? "(kosong/error)"}, hitungan bot ${s.realisasi}`);
    }
    if (beda.length > 0) await kirimOwner(rt, msgTidakCocok(beda.map((s) => s.host)));
  });
}

/* ---------- Mulai ---------- */

/**
 * Daftarkan cron dan jalankan urutan awal: muat input owner, catch-up (dimasukkan ke antrean pesan lebih dulu dari
 * webhook mana pun), refresh, detak. Panggil sebelum server mulai mendengarkan.
 */
export function startScheduler(deps: SchedulerDeps): { rt: Runtime; siap: Promise<void>; stop: () => Promise<void> } {
  const rt = buatRuntime(deps);
  const awal = muatAwal(rt);
  const cu = rt.pesan(async () => {
    await awal;
    await catchUpSekarang(rt);
  });
  const siap = (async () => {
    await cu;
    await jalankanRefresh(rt);
    await detak(rt);
  })().catch((e: unknown) => console.error(`penjadwal: urutan awal gagal: ${pesanError(e)}`));

  const opsi = { timezone: ZONA, noOverlap: true };
  const log = (nama: string) => (e: unknown) => console.error(`penjadwal: ${nama} gagal: ${pesanError(e)}`);
  const tugas = [
    cron.schedule("* * * * *", () => tiapMenit(rt).catch(log("tiap menit")), opsi),
    cron.schedule("*/5 * * * *", () => Promise.all([detak(rt), prosesUlang(rt)]).catch(log("detak/proses ulang")), opsi),
    cron.schedule("*/15 * * * *", () => jalankanRefresh(rt).catch(log("refresh")), opsi),
    cron.schedule("50 23 * * *", () => cekSilang(rt).catch(log("pengecekan silang")), opsi),
  ];
  return {
    rt, siap,
    stop: async () => {
      for (const t of tugas) await t.destroy();
    },
  };
}

/** Input owner segar saat mulai (tanpa menghitung ulang sebelum catch-up mengisi celah laporan). */
async function muatAwal(rt: Runtime): Promise<void> {
  const { db, gateway, invalid } = rt.deps;
  try {
    rt.input = await bacaInputOwner(gateway);
    invalid.splice(0); // dilaporkan oleh refresh pertama
    simpanInput(db, rt.input);
  } catch (e) {
    console.error(`penjadwal: input owner tidak terbaca saat mulai${rt.input ? ", memakai salinan terakhir" : ""}: ${pesanError(e)}`);
  }
}

function simpanInput(db: Db, input: InputOwner): void {
  db.setKv(KV_INPUT, JSON.stringify({ ...input, atribusi: [...input.atribusi] }));
}

function muatInput(db: Db): InputOwner | null {
  const v = db.getKv(KV_INPUT);
  if (!v) return null;
  try {
    const o = JSON.parse(v) as Omit<InputOwner, "atribusi"> & { atribusi: Array<[string, Array<{ host: string; share: number }>]> };
    return { ...o, atribusi: new Map(o.atribusi) };
  } catch {
    return null;
  }
}

const pesanError = (e: unknown): string => (e instanceof Error ? e.message : String(e));
