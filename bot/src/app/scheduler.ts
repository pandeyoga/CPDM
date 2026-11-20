import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import cron from "node-cron";
import type { Config } from "../config.js";
import { msgBelumLapor, msgGangguanDitutup, msgOwner, msgPagi, msgRekap, msgTidakCocok } from "../domain/messages.js";
import { dailyByHost } from "../domain/rekap.js";
import { addDays, jakartaDateTime, toJakartaDate, toJakartaHM } from "../domain/time.js";
import type { HostConfig, Settings } from "../domain/types.js";
import type { Db } from "../infra/db.js";
import type { Extractor } from "../infra/extractor.js";
import type { GangguanRow, Invalid, SheetOp, SheetsGateway } from "../infra/sheets.js";
import type { Incoming, WahaClient } from "../infra/waha.js";
import { unduhSegera } from "./bukti.js";
import {
  barisGangguan, gambarTertunda, handleMessage, KV_GANGGUAN_AKTIF, kvIzin, retryPending, type GangguanAktif, type HandleDeps,
  type UploadBuktiOp,
} from "./handleMessage.js";
import {
  bacaInputOwner, catatTerapan, masalahHari, opUsang, refresh, sinkron, type InputOwner, type OpBerversi, type RefreshGateway,
  type RefreshResult,
} from "./refresh.js";

/*
 * Penjadwal: cron (Asia/Jakarta) memanggil fungsi "apa yang dikerjakan pada jam T" di bawah; semuanya membaca jam
 * dari deps.now() sehingga bisa diuji dengan jam palsu.
 *   tiap menit  flushOutbox; lalu (setelah catch-up selesai) tutup gangguan hari lalu, pesan pagi (jamPagi), tag akhir
 *               shift (Jadwal aktif), rekap malam, pesan owner tertunda
 *   tiap 5 mnt  detak (Heartbeat), dan terpisah: proses ulang gambar tertunda
 *   tiap 15 mnt refresh
 *   23:50       pengecekan silang Kontrol
 * Pesan grup diserialkan di antrean `pesan` (handleMessage, catch-up, proses ulang); refresh dan pesan terjadwal di
 * antrean `tugas`. Pesan inisiatif bot lewat sendCapped (batas per penerima per hari; tanda terima tidak dihitung;
 * rekap grup, ringkasan owner, eskalasi, dan alarm pengecekan silang bebas batas). Pesan terjadwal yang gagal terkirim
 * (error WAHA) diulang di menit berikutnya selama masih dalam jendelanya.
 */

const ZONA = "Asia/Jakarta";
const MENIT_MS = 60_000;
/** Pesan terjadwal yang terlewat (bot baru hidup) atau gagal terkirim masih dikirim selama ini sesudah jamnya. */
const JENDELA_MS = 60 * MENIT_MS;
const REKAP_SETELAH_LAPORAN_MS = 30 * MENIT_MS;
/** Rekap ditunda selama masih ada gambar tertunda hari itu, paling lama selama ini. */
const TUNDA_REKAP_MS = 60 * MENIT_MS;
const CATCH_UP_MUNDUR_MS = 5 * MENIT_MS;
const BATAS_PESAN_BAWAAN = 6;
const SELISIH_MAKS_RP = 1;
const BATCH_ANTREAN = 50;
/** Setelah sekian kali gagal unggah, Sesi Live ditulis tanpa tautan bukti (tautan ditambahkan kalau unggahan berhasil). */
const BATAS_GAGAL_BUKTI = 5;
const KV_INPUT = "inputOwner";
const KV_OWNER_TERTUNDA = "ownerTertunda";
/** Awal celah pesan yang belum di-catch-up (ISO); "" = tidak ada celah. */
const KV_CATCH_UP_SEJAK = "catchUpSejak";

export type Gateway = RefreshGateway & Pick<SheetsGateway, "apply" | "uploadBukti" | "readKontrol" | "readKoreksiMenunggu">;

export interface SchedulerDeps {
  config: Pick<Config, "LIVE_GROUP_ID">;
  db: Db;
  waha: Pick<WahaClient, "sendText" | "download" | "messageById" | "messagesSince" | "sessionStatus">;
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
  /**
   * Pesan yang masuk saat bot mati mungkin belum diproses: benar sejak runtime dibuat sampai catch-up berhasil, dan
   * lagi kalau WAHA/Sheets belum siap. Pesan terjadwal menunggu sampai ini false dan tidak ada catch-up yang berjalan.
   */
  perluCatchUp: boolean;
  catchUpJalan: Promise<void> | null;
}

export function buatRuntime(deps: SchedulerDeps): Runtime {
  return {
    deps, input: muatInput(deps.db), waStatus: "UNKNOWN", pesan: buatAntrean(), tugas: buatAntrean(),
    flush: null, prosesUlangJalan: false, perluCatchUp: true, catchUpJalan: null,
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

/**
 * Webhook → antrean pesan. Gambar diunduh segera (di luar antrean, sebelum ekstraksi lain yang lambat) karena tautan
 * media WAHA kedaluwarsa. Tanpa input owner (belum pernah terbaca) pesan ditinggal dan diambil lagi oleh catch-up.
 */
export function terima(rt: Runtime, m: Incoming): Promise<void> {
  const unduhan = unduhSegera(m, rt.deps);
  return rt.pesan(async () => {
    await unduhan;
    const deps = handleDeps(rt);
    if (!deps) {
      rt.perluCatchUp = true;
      const terakhir = rt.deps.db.lastProcessedTs();
      tandaiCelah(rt.deps.db, terakhir && terakhir < m.ts ? terakhir : m.ts);
      console.error(`penjadwal: pesan ${m.id} menunggu catch-up (Pengaturan belum pernah terbaca)`);
      return;
    }
    await proses(rt, m, deps);
  });
}

/**
 * Awal celah catch-up: dipasang sekali saat celah dimulai (mulai, atau pesan ditinggal) dan tidak ditimpa percobaan
 * yang gagal, supaya webhook live yang diproses sementara itu tidak memajukan titik mulai catch-up. Mengembalikan
 * awal celah yang berlaku (null = tidak ada yang perlu dikejar).
 */
function tandaiCelah(db: Db, sejak: Date | null): Date | null {
  const v = db.getKv(KV_CATCH_UP_SEJAK);
  if (v) return new Date(v);
  if (sejak) db.setKv(KV_CATCH_UP_SEJAK, sejak.toISOString());
  return sejak;
}

export function catchUp(rt: Runtime): Promise<void> {
  return lacakCatchUp(rt, rt.pesan(() => catchUpSekarang(rt)));
}

/** rt.catchUpJalan = p sampai p selesai (dibersihkan sebelum pemanggil yang menunggu p dilanjutkan). */
function lacakCatchUp(rt: Runtime, kerja: Promise<void>): Promise<void> {
  const selesai = (): void => {
    if (rt.catchUpJalan === p) rt.catchUpJalan = null;
  };
  const p: Promise<void> = kerja.then(selesai, (e: unknown) => {
    selesai();
    throw e;
  });
  rt.catchUpJalan = p;
  return p;
}

/**
 * messagesSince(grup, awal celah − 5 menit), urut ts. Awal celah = kv catchUpSejak (bertahan saat gagal/restart),
 * dipasang dari lastProcessedTs saat celah dimulai, dihapus setelah berhasil. Semua gambar diunduh dulu (tautan
 * media kedaluwarsa), lalu pesan diproses satu per satu; yang sudah ditandai dilewati handleMessage.
 */
async function catchUpSekarang(rt: Runtime): Promise<void> {
  const { db } = rt.deps;
  const sejak = tandaiCelah(db, db.lastProcessedTs());
  const deps = handleDeps(rt);
  if (!deps) {
    rt.perluCatchUp = true;
    return;
  }
  if (!sejak) {
    rt.perluCatchUp = false;
    return;
  }
  let pesan: Incoming[];
  try {
    pesan = await rt.deps.waha.messagesSince(rt.deps.config.LIVE_GROUP_ID, new Date(sejak.getTime() - CATCH_UP_MUNDUR_MS));
  } catch (e) {
    rt.perluCatchUp = true;
    console.error(`penjadwal: catch-up gagal, diulang menit berikutnya: ${pesanError(e)}`);
    return;
  }
  const urut = [...pesan].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  for (const m of urut) await unduhSegera(m, rt.deps);
  for (const m of urut) await proses(rt, m, deps);
  db.setKv(KV_CATCH_UP_SEJAK, "");
  rt.perluCatchUp = false;
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

/**
 * terkirim; batas = tidak dikirim karena batas harian (dicatat ke Log Bot); gagal = error WAHA (boleh diulang);
 * tanpaPenerima = No WA owner kosong.
 */
export type HasilKirim = "terkirim" | "batas" | "gagal" | "tanpaPenerima";

/**
 * Kirim pesan inisiatif bot; kalau sentCount ≥ batas per hari, tidak dikirim dan dicatat ke Log Bot. `wajib` = bebas
 * batas (tetap dihitung).
 */
export async function sendCapped(
  rt: Runtime, waId: string, text: string, opsi: { mentions?: string[]; wajib?: boolean } = {},
): Promise<HasilKirim> {
  const { db, waha, now } = rt.deps;
  const tanggal = toJakartaDate(now());
  const batas = rt.input?.settings.maxPesanPerHari ?? BATAS_PESAN_BAWAAN;
  if (!opsi.wajib && db.sentCount(waId, tanggal) >= batas) {
    catatLog(rt, "WARN", `Pesan bot ke ${waId} tidak dikirim: batas ${batas} pesan per hari tercapai. Isi: ${text}`);
    return "batas";
  }
  try {
    await waha.sendText(waId, text, undefined, opsi.mentions && opsi.mentions.length > 0 ? opsi.mentions : undefined);
  } catch (e) {
    console.error(`penjadwal: kirim pesan ke ${waId} gagal: ${pesanError(e)}`);
    catatLog(rt, "ERROR", `Kirim pesan ke ${waId} gagal: ${pesanError(e)}`);
    return "gagal";
  }
  db.logSent(waId, tanggal);
  return "terkirim";
}

/** Teguran, eskalasi, dan ringkasan hanya pribadi ke owner (Pengaturan "No WA owner"). */
async function kirimOwner(rt: Runtime, text: string, wajib = false): Promise<HasilKirim> {
  const owner = rt.input?.settings.ownerWaId;
  if (!owner) {
    console.error("penjadwal: No WA owner belum diisi, pesan owner tidak terkirim");
    catatLog(rt, "WARN", `No WA owner belum diisi; pesan owner tidak terkirim: ${text}`);
    return "tanpaPenerima";
  }
  return sendCapped(rt, owner, text, { wajib });
}

/** Pemberitahuan owner yang tidak boleh hilang (gangguan ditutup otomatis): disimpan di kv, dikirim tiap menit. */
function antreOwner(rt: Runtime, teks: string): void {
  const { db } = rt.deps;
  db.setKv(KV_OWNER_TERTUNDA, JSON.stringify([...bacaDaftar(db, KV_OWNER_TERTUNDA), teks]));
}

async function kirimOwnerTertunda(rt: Runtime): Promise<void> {
  const { db } = rt.deps;
  const sisa: string[] = [];
  for (const teks of bacaDaftar(db, KV_OWNER_TERTUNDA)) if ((await kirimOwner(rt, teks)) === "gagal") sisa.push(teks);
  db.setKv(KV_OWNER_TERTUNDA, JSON.stringify(sisa));
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
      if (item.op.type === "uploadBukti" && item.attempts + 1 >= BATAS_GAGAL_BUKTI) buktiTanpaTautan(rt, item.op as unknown as UploadBuktiOp);
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

const kvBuktiTertunda = (messageId: string): string => `buktiTertunda:${messageId}`;

/**
 * Dedupe per messageId (kv bukti:<messageId> sudah ada → lewati); berkas hilang → "" (Sesi Live tanpa tautan).
 * Unggahan yang dulu gagal ≥ 5 kali (Sesi Live sudah ditulis tanpa tautan) tetap dicoba; berhasil → tautan
 * ditambahkan ke baris Sesi Live itu. Setelah terunggah berkas lokal dihapus, kecuali masih dirujuk gambar tertunda.
 */
async function unggahBukti(rt: Runtime, op: UploadBuktiOp): Promise<void> {
  const { db, gateway } = rt.deps;
  const k = `bukti:${op.messageId}`;
  const susulan = db.getKv(kvBuktiTertunda(op.messageId)) === "1";
  if (db.getKv(k) !== null && !susulan) return;
  if (!existsSync(op.path)) {
    if (susulan) db.setKv(kvBuktiTertunda(op.messageId), "");
    else db.setKv(k, "");
    catatLog(rt, "WARN", `Bukti ${op.messageId} tidak diunggah: berkas lokal tidak ada`);
    return;
  }
  const link = await gateway.uploadBukti(readFileSync(op.path), basename(op.path));
  db.setKv(k, link);
  if (susulan) {
    db.setKv(kvBuktiTertunda(op.messageId), "");
    db.outbox.push({ type: "linkBuktiSesi", messageId: op.messageId, link } satisfies SheetOp);
  }
  const tertunda = [...db.pendingExtract.all(), ...db.pendingCaption.all()].some((p) => p.msgId === op.messageId);
  if (!tertunda) rmSync(op.path, { force: true });
}

/** Unggahan gagal ≥ 5 kali: Sesi Live boleh ditulis tanpa tautan (kv bukti "" ), Log Bot sekali; antrean tetap mencoba. */
function buktiTanpaTautan(rt: Runtime, op: UploadBuktiOp): void {
  const { db } = rt.deps;
  const k = `bukti:${op.messageId}`;
  if (db.getKv(k) !== null) return;
  db.setKv(k, "");
  db.setKv(kvBuktiTertunda(op.messageId), "1");
  catatLog(rt, "WARN", `Bukti ${op.messageId} belum terunggah setelah ${BATAS_GAGAL_BUKTI} percobaan; Sesi Live ditulis tanpa tautan, tautan ditambahkan kalau unggahan berhasil`);
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
  for (const p of hasil.pesanOwner) {
    if ((await kirimOwner(rt, p.teks, p.wajib)) !== "gagal") p.terkirim();
  }
  return hasil;
}

/* ---------- Pesan terjadwal ---------- */

/**
 * Dijalankan tiap menit: antrean ke Sheets; catch-up kalau perlu; lalu, hanya setelah catch-up selesai (laporan yang
 * masuk saat bot mati sudah tersimpan), pesan terjadwal.
 */
export async function tiapMenit(rt: Runtime): Promise<void> {
  await flushOutbox(rt);
  if (!rt.input) await jalankanRefresh(rt);
  if (rt.perluCatchUp && rt.input && !rt.catchUpJalan) await catchUp(rt);
  if (rt.perluCatchUp || rt.catchUpJalan) return;
  const kerja: Array<[string, (rt: Runtime) => Promise<void>]> = [
    ["tutup gangguan hari lalu", tutupGangguanLama], ["pagi", pagi], ["akhir shift", akhirShift], ["rekap", rekap],
    ["pesan owner tertunda", kirimOwnerTertunda],
  ];
  await rt.tugas(async () => {
    for (const [nama, k] of kerja) {
      try {
        await k(rt);
      } catch (e) {
        console.error(`penjadwal: ${nama} gagal: ${pesanError(e)}`);
      }
    }
  });
}

const dalamJendela = (now: Date, mulai: Date): boolean =>
  now.getTime() >= mulai.getTime() && now.getTime() < mulai.getTime() + JENDELA_MS;

function gangguanAktif(db: Db): GangguanAktif[] {
  return bacaDaftar<GangguanAktif>(db, KV_GANGGUAN_AKTIF);
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

const tertundaPada = (db: Db, hari: string) => gambarTertunda(db).filter((g) => hariLive(g.receivedAt) === hari);

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
  const { settings, jadwal, gangguan } = hasil.input;
  const rows = jadwal ? hasil.summaries.filter((s) => jadwal.some((j) => j.date === hari && j.host === s.host)) : hasil.summaries;
  if (rows.length > 0) {
    const kemarin = addDays(hari, -1);
    const gangguanKemarin = [...new Set(gangguan.filter((g) => g.date === kemarin && g.host !== "").map((g) => g.host))];
    const shift: Record<string, string> = {};
    for (const j of jadwal ?? []) {
      if (j.date !== hari) continue;
      const jam = `${j.mulai}–${j.selesai}`;
      shift[j.host] = shift[j.host] ? `${shift[j.host]}, ${jam}` : jam;
    }
    const r = await sendCapped(rt, rt.deps.config.LIVE_GROUP_ID, msgPagi(hari, rows, gangguanKemarin, shift), {
      mentions: waIds(settings, rows.map((x) => x.host)),
    });
    if (r === "gagal") return; // diulang menit berikutnya selama masih dalam jendela
  }
  db.setKv(k, t.toISOString());
}

/**
 * Jadwal aktif: di akhir shift, satu pesan grup menag host yang hari itu belum lapor sama sekali (sekali per host per
 * tanggal). Bukan "belum lapor": ada laporan, ada gambar tertunda atas namanya, atau ada #izin (status apa pun) /
 * izin yang disetujui. Gambar tertunda yang pemiliknya belum diketahui menunda tag (paling lama sampai jendela habis).
 */
async function akhirShift(rt: Runtime): Promise<void> {
  const { db, now } = rt.deps;
  const input = rt.input;
  if (!input?.settings.jadwalAktif || !input.jadwal || gangguanAktif(db).length > 0) return;
  const t = now();
  const hari = toJakartaDate(t);
  const tag: Array<{ k: string; host: HostConfig }> = [];
  for (const r of input.jadwal) {
    if (r.date !== hari && r.date !== addDays(hari, -1)) continue;
    const selesai = jakartaDateTime(r.selesai <= r.mulai ? addDays(r.date, 1) : r.date, r.selesai);
    const k = `akhirShift:${r.date}|${r.host}`;
    if (!dalamJendela(t, selesai) || db.getKv(k) !== null || tag.some((x) => x.k === k)) continue;
    const tertunda = tertundaPada(db, r.date);
    if (tertunda.some((g) => g.host === null)) continue;
    const lapor = tertunda.some((g) => g.host === r.host) ||
      db.reports(r.date.slice(0, 7)).some((x) => x.host === r.host && hariLive(x.receivedAt) === r.date);
    const izin = db.getKv(kvIzin(r.date, r.host)) !== null || input.izin.some((z) => z.host === r.host && z.date === r.date);
    if (lapor || izin) {
      db.setKv(k, t.toISOString());
      continue;
    }
    tag.push({ k, host: input.settings.hosts.find((h) => h.name === r.host) ?? { name: r.host } });
  }
  if (tag.length === 0) return;
  const hosts = tag.map((x) => x.host);
  const hasil = await sendCapped(rt, rt.deps.config.LIVE_GROUP_ID, msgBelumLapor(hosts), {
    mentions: hosts.flatMap((h) => (h.waId ? [h.waId] : [])),
  });
  if (hasil !== "gagal") for (const x of tag) db.setKv(x.k, t.toISOString());
}

/**
 * Rekap malam (grup) + ringkasan owner (pribadi), keduanya bebas batas harian; gangguan yang masih aktif ditutup lebih
 * dulu. Ditunda selama ada gambar tertunda hari itu (paling lama 60 menit). Gagal kirim → diulang tiap menit sampai
 * 23:59 (atau 60 menit setelah percobaan pertama bila lebih lambat).
 */
async function rekap(rt: Runtime): Promise<void> {
  const { db, now, gateway } = rt.deps;
  const t = now();
  const hari = hariLive(t);
  const kGrup = `rekap:${hari}`;
  const kOwner = `rekapOwner:${hari}`;
  const kCoba = `rekapCoba:${hari}`;
  if (!rt.input || (db.getKv(kGrup) !== null && db.getKv(kOwner) !== null)) return;
  const jatuhTempo = waktuRekap(hari, rt.input.settings.jamRekap, laporanTerakhir(db, hari)).getTime();
  if (t.getTime() < jatuhTempo) return;
  if (tertundaPada(db, hari).length > 0 && t.getTime() < jatuhTempo + TUNDA_REKAP_MS) return;
  const coba = db.getKv(kCoba);
  if (coba !== null && t.getTime() > Math.max(jakartaDateTime(hari, "23:59").getTime(), Date.parse(coba) + JENDELA_MS)) {
    catatLog(rt, "ERROR", `Rekap ${hari} tidak terkirim sampai batas waktu, dihentikan`);
    db.setKv(kGrup, t.toISOString());
    db.setKv(kOwner, t.toISOString());
    return;
  }
  if (coba === null) db.setKv(kCoba, t.toISOString());
  tutupGangguan(rt, () => true, () => hari);
  const hasil = await refreshSekarang(rt, hari);
  if (!hasil) return;
  if (db.getKv(kGrup) === null) {
    const perHari = dailyByHost(hasil.ledger, hari.slice(0, 7));
    const harian = Object.fromEntries(hasil.summaries.map((s) => [s.host, perHari[s.host]?.[hari] ?? 0]));
    const r = await sendCapped(rt, rt.deps.config.LIVE_GROUP_ID, msgRekap(hari, hasil.summaries, harian), {
      mentions: waIds(hasil.input.settings, hasil.summaries.map((s) => s.host)), wajib: true,
    });
    if (r !== "gagal") db.setKv(kGrup, t.toISOString());
  }
  if (db.getKv(kOwner) === null) {
    let koreksiMenunggu = 0;
    try {
      koreksiMenunggu = await gateway.readKoreksiMenunggu();
    } catch (e) {
      console.error(`rekap: jumlah koreksi menunggu tidak terbaca: ${pesanError(e)}`);
    }
    // Eskalasi dikirim sendiri oleh refresh saat streak baru dimulai, tidak diulang di ringkasan.
    const teks = msgOwner(hari, { ...masalahHari(hasil.ledger, hari), koreksiMenunggu, eskalasi: [] });
    if ((await kirimOwner(rt, teks, true)) !== "gagal") db.setKv(kOwner, t.toISOString());
  }
}

/** Gangguan dari tanggal live sebelumnya yang masih aktif ditutup, supaya pesan pagi tidak tertahan. */
async function tutupGangguanLama(rt: Runtime): Promise<void> {
  const hari = hariLive(rt.deps.now());
  tutupGangguan(rt, (g) => g.tanggal < hari, (g) => g.tanggal);
}

/**
 * Tutup gangguan aktif terpilih: selesai di jam live selesai `hariTutup`, atau laporan terakhir hari itu sesudah mulai
 * kalau lebih awal. Baris Gangguan (Menunggu) diantrekan dan owner diberi tahu (pesan tertunda, tidak hilang).
 */
function tutupGangguan(rt: Runtime, pilih: (g: GangguanAktif) => boolean, hariTutup: (g: GangguanAktif) => string): void {
  const { db } = rt.deps;
  const aktif = gangguanAktif(db);
  const tutup = aktif.filter(pilih);
  if (tutup.length === 0 || !rt.input) return;
  const rows: GangguanRow[] = [];
  for (const g of tutup) {
    const hari = hariTutup(g);
    const mulai = jakartaDateTime(g.tanggal, g.mulai);
    const terakhir = laporanTerakhir(db, hari);
    let selesai = jakartaDateTime(hari, rt.input.settings.liveSelesai);
    if (terakhir && terakhir > mulai && terakhir < selesai) selesai = terakhir;
    if (selesai < mulai) selesai = mulai;
    rows.push(...barisGangguan(g, selesai));
  }
  for (const row of rows) db.outbox.push({ type: "appendGangguan", row });
  const sisa = aktif.filter((g) => !pilih(g));
  db.setKv(KV_GANGGUAN_AKTIF, sisa.length > 0 ? JSON.stringify(sisa) : "");
  antreOwner(rt, msgGangguanDitutup(rows));
}

/* ---------- Pengecekan silang ---------- */

/**
 * 23:50: realisasi bulan ini di tab Kontrol (rumus) vs hitungan bot. Selisih > Rp1, atau host tidak ada di Kontrol
 * (sel error), → Log Bot per host + satu pesan owner (bebas batas). Dilewati selama Data Kredit/Target Harian terbaru
 * belum terkirim.
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
    if (beda.length > 0) await kirimOwner(rt, msgTidakCocok(beda.map((s) => s.host)), true);
  });
}

/* ---------- Mulai ---------- */

/**
 * Daftarkan cron dan jalankan urutan awal: muat input owner, catch-up (dimasukkan ke antrean pesan lebih dulu dari
 * webhook mana pun; pesan terjadwal menunggu sampai selesai), refresh, detak. Panggil sebelum server mendengarkan.
 */
export function startScheduler(deps: SchedulerDeps): { rt: Runtime; siap: Promise<void>; stop: () => Promise<void> } {
  const rt = buatRuntime(deps);
  const awal = muatAwal(rt);
  const cu = lacakCatchUp(rt, rt.pesan(async () => {
    await awal;
    await catchUpSekarang(rt);
  }));
  const siap = (async () => {
    await cu;
    await jalankanRefresh(rt);
    await detak(rt);
  })().catch((e: unknown) => console.error(`penjadwal: urutan awal gagal: ${pesanError(e)}`));

  const opsi = { timezone: ZONA, noOverlap: true };
  const log = (nama: string) => (e: unknown) => console.error(`penjadwal: ${nama} gagal: ${pesanError(e)}`);
  const tugas = [
    cron.schedule("* * * * *", () => tiapMenit(rt).catch(log("tiap menit")), opsi),
    // Detak terpisah dari proses ulang: antrean pesan yang sibuk tidak boleh menahan Heartbeat.
    cron.schedule("*/5 * * * *", () => detak(rt).catch(log("detak")), opsi),
    cron.schedule("*/5 * * * *", () => prosesUlang(rt).catch(log("proses ulang")), opsi),
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

function bacaDaftar<T = string>(db: Db, k: string): T[] {
  const v = db.getKv(k);
  if (!v) return [];
  try {
    const arr = JSON.parse(v) as unknown;
    return Array.isArray(arr) ? (arr as T[]) : [];
  } catch {
    return [];
  }
}

const pesanError = (e: unknown): string => (e instanceof Error ? e.message : String(e));
