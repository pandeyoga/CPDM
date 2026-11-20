import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { matchCaption, parseCommand, parseKoreksi, type Command } from "../domain/caption.js";
import { buildLedger } from "../domain/ledger.js";
import {
  msgAckKoreksi, msgAckPerintah, msgDiproses, msgFormatKoreksi, msgKirimUlang, msgKoreksiTanpaPlatform, msgMintaRiwayat,
  msgSiapa, msgTanda,
} from "../domain/messages.js";
import { addDays, jakartaDateTime, toJakartaDate, toJakartaHM } from "../domain/time.js";
import type { ExtractResult, HostConfig, LedgerEntry, Platform, PlatformReading, Report, Settings } from "../domain/types.js";
import type { Db } from "../infra/db.js";
import type { Extractor } from "../infra/extractor.js";
import type { GangguanRow, KehadiranRow } from "../infra/sheets.js";
import type { Incoming, WahaClient } from "../infra/waha.js";

/*
 * Orkestrasi satu pesan grup. Semua tulisan ke Sheets lewat db.outbox (tidak butuh gateway Sheets di sini).
 * Pesan bot yang balasannya penting dilacak di kv menurut id pesan terkirim (R35):
 *   receipt:<id> → messageId laporan (juga dipasang untuk id foto asli), siapa:<id> → messageId gambar tertunda,
 *   riwayat:<id> → {platform, host, beforeIso, afterIso}.
 * Gambar tidak pernah hilang setelah markMessage: konteksnya (kv gambar:<messageId>) dan antrean pendingExtract
 * ditulis sebelum unduh/ekstraksi dan baru dilepas pada hasil akhir (tersimpan atau ditolak).
 */

export interface HandleDeps {
  config: Pick<Config, "LIVE_GROUP_ID">;
  db: Db;
  waha: Pick<WahaClient, "sendText" | "download">;
  extractor: Extractor;
  settings: Settings;
  /** Jam proses (bukan jam pesan); dipakai untuk umur antrean ekstraksi. */
  now: () => Date;
  /** Bukti disimpan di <dataDir>/bukti/<messageId>.<ext> sebelum diunggah lewat antrean (R36). */
  dataDir: string;
}

/** Operasi antrean di luar SheetOp; dijalankan runner antrean (Task 12) lewat sheets.uploadBukti. */
export type UploadBuktiOp = { type: "uploadBukti"; messageId: string; path: string };

export const KV_GANGGUAN_AKTIF = "gangguanAktif";
const SUMBER = "Grup WA";
/** Item pendingExtract baru diambil ulang setelah selama ini (yang lebih muda mungkin masih diproses). */
const PROSES_ULANG_SETELAH_MS = 5 * 60_000;

/** Gambar yang sedang diekstraksi di proses ini; retryPendingExtract tidak mengambilnya dobel. */
const sedangDiproses = new Set<string>();

interface Gambar {
  messageId: string; receivedAt: string; caption: string; mediaUrl: string;
  /** Berkas lokal; "" sampai unduhan berhasil (proses ulang mengunduh lagi dari mediaUrl). */
  path: string; mime: string;
  /** Jam proses saat masuk antrean ekstraksi. */
  enqueuedAt: string;
  /** Calon layar akhir dari riwayat live: waktu efektif, platform yang diminta, dan kunci kv permintaannya. */
  effectiveAt?: string; platform?: Platform; riwayatKey?: string;
}
type GambarSiap = Gambar & { host: string; isMati: boolean };
interface Riwayat { platform: Platform; host: string; beforeIso: string; afterIso?: string }
interface GangguanAktif { tanggal: string; mulai: string; host: string; alasan: string; scope: Platform | "semua" }

export async function handleMessage(m: Incoming, deps: HandleDeps): Promise<void> {
  if (m.chatId !== deps.config.LIVE_GROUP_ID) return;
  if (!deps.db.markMessage(m.id, m.ts)) return;
  const cmd = parseCommand(m.text, toJakartaDate(m.ts));
  if (cmd) return perintah(m, cmd, deps);
  if (m.hasImage) return terimaGambar(m, deps);
  if (m.replyToId) return balasanTeks(m, m.replyToId, deps);
}

/**
 * Proses ulang antrean pendingExtract (dipanggil penjadwal). Item yang sedang diproses atau lebih muda dari
 * 5 menit dilewati; yang masih gagal tetap di antrean, tanpa pesan baru.
 */
export async function retryPendingExtract(deps: HandleDeps): Promise<void> {
  const batas = deps.now().getTime() - PROSES_ULANG_SETELAH_MS;
  for (const p of deps.db.pendingExtract.all()) {
    const g = bacaJson<GambarSiap>(deps.db, `gambar:${p.msgId}`);
    if (!g || typeof g.host !== "string") {
      console.error(`handleMessage: antrean ekstraksi ${p.msgId} dibuang (konteks gambar hilang)`);
      deps.db.pendingExtract.done(p.msgId);
      continue;
    }
    if (Date.parse(g.enqueuedAt) > batas) continue;
    await prosesGambar(g, deps, true);
  }
}

/* ---------- Gambar ---------- */

async function terimaGambar(m: Incoming, deps: HandleDeps): Promise<void> {
  if (!m.mediaUrl) {
    console.error(`handleMessage: gambar ${m.id} tanpa URL media, diabaikan`);
    return;
  }
  const g: Gambar = {
    messageId: m.id, receivedAt: m.ts.toISOString(), caption: m.text, mediaUrl: m.mediaUrl, path: "", mime: "",
    enqueuedAt: deps.now().toISOString(),
  };
  const cocok = matchCaption(m.text, namaHost(deps.settings));

  // Balasan ke msgMintaRiwayat = calon layar akhir, kecuali caption menyebut host lain.
  const riwayatKey = m.replyToId ? `riwayat:${kunci(m.replyToId)}` : undefined;
  const riwayat = riwayatKey ? bacaJson<Riwayat>(deps.db, riwayatKey) : null;
  if (riwayatKey && riwayat && !("host" in cocok && cocok.host !== riwayat.host)) {
    const effectiveAt = waktuLayarAkhir(riwayat).toISOString();
    return antrekanDanProses({ ...g, host: riwayat.host, isMati: true, platform: riwayat.platform, riwayatKey, effectiveAt }, deps);
  }
  if ("host" in cocok) return antrekanDanProses({ ...g, host: cocok.host, isMati: cocok.isMati }, deps);
  await tanyaSiapa(g, deps);
}

/**
 * Layar akhir riwayat: 1 detik sebelum laporan pertama siaran baru. Bila itu jatuh di tanggal lain dari laporan
 * terakhir siaran lama (siaran kemarin), dipasang 1 detik sesudah laporan terakhir itu; kalau tidak, ledger
 * menganggapnya siaran baru (ganti hari + jeda) dan mengkreditkan seluruh siaran lama sekali lagi.
 */
function waktuLayarAkhir(r: Riwayat): Date {
  const sebelumBaru = new Date(Date.parse(r.beforeIso) - 1000);
  if (r.afterIso === undefined) return sebelumBaru;
  const lama = new Date(r.afterIso);
  return toJakartaDate(sebelumBaru) === toJakartaDate(lama) ? sebelumBaru : new Date(lama.getTime() + 1000);
}

/** Caption tanpa satu host: simpan tertunda, unduh segera (URL media WAHA kedaluwarsa), lalu tanya. */
async function tanyaSiapa(g: Gambar, deps: HandleDeps): Promise<void> {
  const { db } = deps;
  simpanKonteks(db, g);
  db.pendingCaption.put(g.messageId, g.mediaUrl, g.caption);
  db.logProblem(g.messageId, null, toJakartaDate(new Date(g.receivedAt)), "caption");
  if (!adaBerkas(g)) {
    try {
      simpanKonteks(db, await unduh(g, deps));
    } catch (e) {
      console.error(`handleMessage: unduh gambar ${g.messageId} gagal, dicoba lagi setelah nama host dijawab: ${pesanError(e)}`);
    }
  }
  const id = await kirim(deps, msgSiapa(), g.messageId);
  if (id) lacak(db, "siapa", id, g.messageId);
  else console.error(`handleMessage: gambar ${g.messageId} tetap menunggu nama host (pertanyaan tidak terkirim atau id-nya tidak diketahui)`);
}

async function antrekanDanProses(g: GambarSiap, deps: HandleDeps): Promise<void> {
  simpanAntrean(deps.db, g);
  await prosesGambar(g, deps, false);
}

async function prosesGambar(g: GambarSiap, deps: HandleDeps, diulang: boolean): Promise<void> {
  if (sedangDiproses.has(g.messageId)) return; // mis. proses ulang terjadwal saat ekstraksi pertama belum selesai
  sedangDiproses.add(g.messageId);
  try {
    await ekstrakDanSimpan(g, deps, diulang);
  } finally {
    sedangDiproses.delete(g.messageId);
  }
}

async function ekstrakDanSimpan(g: GambarSiap, deps: HandleDeps, diulang: boolean): Promise<void> {
  let hasil: ExtractResult;
  try {
    if (!adaBerkas(g)) {
      g = await unduh(g, deps);
      simpanAntrean(deps.db, g);
    }
    hasil = await deps.extractor.extract(readFileSync(g.path), g.mime);
  } catch (e) {
    console.error(`handleMessage: gambar ${g.messageId} belum bisa diekstraksi, menunggu proses ulang: ${pesanError(e)}`);
    if (!diulang) await kirim(deps, msgDiproses(), g.messageId);
    return;
  }
  if (!hasil.ok) return tolak(g, hasil.reason, deps);
  if (g.riwayatKey === undefined) return simpanLaporan(g, hasil.readings, deps);

  const readings = hasil.readings.filter((r) => r.platform === g.platform);
  if (readings.length === 0) return tolak(g, "tidak_terbaca", deps);
  if (layarAkhirSah(g, readings, deps)) return simpanLaporan(g, readings, deps);
  return bukanLayarAkhir(g, hasil.readings, deps);
}

async function tolak(g: GambarSiap, reason: Parameters<typeof msgKirimUlang>[0], deps: HandleDeps): Promise<void> {
  rmSync(g.path, { force: true });
  deps.db.pendingExtract.done(g.messageId);
  await kirim(deps, msgKirimUlang(reason), g.messageId);
}

/** Calon layar akhir sah bila, dipasang di effectiveAt, tidak memulai siaran baru (mis. omzet di bawah puncak siaran lama). */
function layarAkhirSah(g: GambarSiap, readings: PlatformReading[], deps: HandleDeps): boolean {
  const kandidat = keLaporan(g, readings);
  const entries = ledgerSekitar(waktu(kandidat[0]!), deps, kandidat).filter((e) => e.messageId === g.messageId);
  return entries.every((e) => !e.flags.includes("siaran_belum_lengkap") && !e.flags.includes("siaran_baru"));
}

/** Balasan ke msgMintaRiwayat yang bukan layar akhir sah diproses sebagai gambar biasa (host dari caption). */
async function bukanLayarAkhir(g: GambarSiap, readings: PlatformReading[], deps: HandleDeps): Promise<void> {
  const biasa: Gambar = {
    messageId: g.messageId, receivedAt: g.receivedAt, caption: g.caption, mediaUrl: g.mediaUrl, path: g.path, mime: g.mime,
    enqueuedAt: g.enqueuedAt,
  };
  const cocok = matchCaption(g.caption, namaHost(deps.settings));
  if ("host" in cocok) {
    const siap: GambarSiap = { ...biasa, host: cocok.host, isMati: cocok.isMati };
    simpanKonteks(deps.db, siap);
    return simpanLaporan(siap, readings, deps);
  }
  deps.db.pendingExtract.done(g.messageId);
  await tanyaSiapa(biasa, deps);
}

async function simpanLaporan(g: GambarSiap, readings: PlatformReading[], deps: HandleDeps): Promise<void> {
  const { db } = deps;
  const laporan = keLaporan(g, readings);
  for (const r of laporan) db.saveReport(r);
  db.outbox.push({ type: "uploadBukti", messageId: g.messageId, path: g.path } satisfies UploadBuktiOp);
  if (g.riwayatKey) db.setKv(g.riwayatKey, "");
  db.pendingExtract.done(g.messageId);
  await kirimTandaTerima(g, waktu(laporan[0]!), deps);
}

function keLaporan(g: GambarSiap, readings: PlatformReading[]): Report[] {
  const receivedAt = new Date(g.receivedAt);
  const effectiveAt = g.effectiveAt === undefined ? undefined : new Date(g.effectiveAt);
  return readings.map((reading) => ({
    messageId: g.messageId, receivedAt, ...(effectiveAt ? { effectiveAt } : {}), host: g.host, isMati: g.isMati, reading,
  }));
}

/** Ledger dari hari Jakarta sebelumnya pukul 00:00 (R14); `tambahan` menggantikan laporan tersimpan dengan messageId sama. */
function ledgerSekitar(at: Date, deps: HandleDeps, tambahan: Report[] = []): LedgerEntry[] {
  const tanggal = toJakartaDate(at);
  const mulai = jakartaDateTime(addDays(tanggal, -1), "00:00").getTime();
  const ganti = new Set(tambahan.map((r) => r.messageId));
  const reports = deps.db.reports(tanggal.slice(0, 7)).filter((r) => waktu(r).getTime() >= mulai && !ganti.has(r.messageId));
  return buildLedger([...reports, ...tambahan], { maxGapMenit: deps.settings.maxGapMenit, liveMulai: deps.settings.liveMulai });
}

/**
 * Kredit entri pesan ini → msgTanda (omzet null = "belum terbaca"). Entri siaran_belum_lengkap memicu
 * msgMintaRiwayat yang menag host laporan terakhir sebelum reset.
 */
async function kirimTandaTerima(g: GambarSiap, at: Date, deps: HandleDeps): Promise<void> {
  const { db, settings } = deps;
  const entries = ledgerSekitar(at, deps);
  const baru = entries.filter((e) => e.messageId === g.messageId);

  const perPlatform = baru.map((e) => ({ platform: e.platform, kredit: e.credit.omzet ?? null, rounded: e.flags.includes("dibulatkan") }));
  const flags = [...new Set(baru.flatMap((e) => e.flags))];
  lacak(db, "receipt", await kirim(deps, msgTanda(hostConfig(settings, g.host), perPlatform, flags), g.messageId), g.messageId);
  db.setKv(`receipt:${kunci(g.messageId)}`, g.messageId);

  for (const e of baru) {
    if (!e.flags.includes("siaran_belum_lengkap")) continue;
    const sebelum = entries.slice(0, entries.indexOf(e)).reverse().find((x) => x.platform === e.platform && x.messageId !== g.messageId);
    const host = hostConfig(settings, sebelum?.host ?? g.host);
    const id = await kirim(deps, msgMintaRiwayat(host, e.platform), g.messageId, host.waId ? [host.waId] : undefined);
    const riwayat: Riwayat = {
      platform: e.platform, host: host.name, beforeIso: e.at.toISOString(), ...(sebelum ? { afterIso: sebelum.at.toISOString() } : {}),
    };
    lacak(db, "riwayat", id, JSON.stringify(riwayat));
  }
}

/* ---------- Balasan teks ---------- */

async function balasanTeks(m: Incoming, replyToId: string, deps: HandleDeps): Promise<void> {
  const k = kunci(replyToId);
  const tertunda = deps.db.getKv(`siapa:${k}`);
  if (tertunda) return jawabSiapa(m, tertunda, deps);
  const laporan = deps.db.getKv(`receipt:${k}`);
  if (laporan) return koreksi(m, laporan, deps);
}

async function jawabSiapa(m: Incoming, msgId: string, deps: HandleDeps): Promise<void> {
  const { db } = deps;
  const g = bacaJson<Gambar & { host?: string }>(db, `gambar:${msgId}`);
  if (!g || g.host !== undefined) return; // sudah dijawab
  const cocok = matchCaption(m.text, namaHost(deps.settings));
  if ("error" in cocok) {
    lacak(db, "siapa", await kirim(deps, msgSiapa(), m.id), msgId);
    return;
  }
  const isMati = cocok.isMati || /(^|[^\p{L}\p{N}])mati($|[^\p{L}\p{N}])/iu.test(g.caption);
  const siap: GambarSiap = { ...g, host: cocok.host, isMati, enqueuedAt: deps.now().toISOString() };
  simpanAntrean(db, siap); // antre dulu, baru lepas dari pendingCaption
  db.pendingCaption.take(msgId);
  db.setProblemHost(msgId, cocok.host);
  await prosesGambar(siap, deps, false);
}

/** Koreksi tidak pernah langsung berlaku: baris Koreksi berstatus Menunggu sampai owner memilih Setujui. */
async function koreksi(m: Incoming, messageId: string, deps: HandleDeps): Promise<void> {
  const k = parseKoreksi(m.text);
  if (!k) {
    // Hanya balasan yang jelas dimaksudkan sebagai koreksi yang dijawab dengan format; "makasih" dll. diabaikan.
    if (/^\s*koreksi\b|\b(tiktok|shopee)\b/i.test(m.text)) await kirim(deps, msgFormatKoreksi(), m.id);
    return;
  }
  const laporan = cariLaporan(deps.db, messageId, k.platform, m.ts);
  if (!laporan) {
    await kirim(deps, msgKoreksiTanpaPlatform(k.platform), m.id);
    return;
  }
  deps.db.outbox.push({
    type: "appendKoreksi",
    row: {
      tanggal: toJakartaDate(waktu(laporan)), host: laporan.host, masalah: `Koreksi dari grup: "${m.text.trim()}"`,
      angkaBot: laporan.reading[k.field]?.value ?? "", usulan: k.value, jenis: "koreksi",
      messageId, platform: k.platform, field: k.field, value: k.value,
    },
  });
  await kirim(deps, msgAckKoreksi(k.platform), m.id);
}

/** Laporan dicari di bulan balasan dan bulan sebelumnya. */
function cariLaporan(db: Db, messageId: string, platform: Platform, ts: Date): Report | undefined {
  const bulan = toJakartaDate(ts).slice(0, 7);
  for (const b of [bulan, addDays(`${bulan}-01`, -1).slice(0, 7)]) {
    const r = db.reports(b).find((x) => x.messageId === messageId && x.reading.platform === platform);
    if (r) return r;
  }
  return undefined;
}

/* ---------- Perintah ---------- */

async function perintah(m: Incoming, cmd: Command, deps: HandleDeps): Promise<void> {
  const { db } = deps;
  if (cmd.kind === "normal") {
    for (const g of bacaJson<GangguanAktif[]>(db, KV_GANGGUAN_AKTIF) ?? []) {
      for (const row of barisGangguan(g, m.ts)) db.outbox.push({ type: "appendGangguan", row });
    }
    db.setKv(KV_GANGGUAN_AKTIF, "");
    await kirim(deps, msgAckPerintah(cmd), m.id);
    return;
  }
  const { host, alasan } = hostPerintah(cmd.alasan, m.from, deps.settings);
  if (cmd.kind === "izin") {
    const row: KehadiranRow = { tanggal: cmd.date, host, jenis: jenisIzin(alasan), alasan, sumber: SUMBER };
    db.outbox.push({ type: "appendKehadiran", row });
  } else {
    // Baris Gangguan ditulis saat #normal, ketika jam mulai dan selesai sudah diketahui.
    const aktif = bacaJson<GangguanAktif[]>(db, KV_GANGGUAN_AKTIF) ?? [];
    aktif.push({ tanggal: toJakartaDate(m.ts), mulai: toJakartaHM(m.ts), host, alasan, scope: cmd.scope });
    db.setKv(KV_GANGGUAN_AKTIF, JSON.stringify(aktif));
  }
  await kirim(deps, msgAckPerintah({ ...cmd, alasan }), m.id);
}

/**
 * R34b (HP bersama): host = tepat satu token yang sama persis (tanpa beda huruf besar-kecil) dengan nama host
 * di teks perintah; token itu dibuang dari alasan. Tanpa itu: nomor pengirim = No WA host, lalu kosong (owner).
 */
function hostPerintah(teks: string, from: string, settings: Settings): { host: string; alasan: string } {
  const kata = teks.split(/\s+/).filter((t) => t !== "");
  const namaDari = (t: string): string | undefined => {
    const bersih = t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
    return settings.hosts.find((h) => h.name.toLowerCase() === bersih)?.name;
  };
  const disebut = new Set(kata.flatMap((t) => namaDari(t) ?? []));
  if (disebut.size === 1) return { host: [...disebut][0]!, alasan: kata.filter((t) => namaDari(t) === undefined).join(" ") };
  return { host: settings.hosts.find((h) => h.waId === from)?.name ?? "", alasan: teks };
}

function jenisIzin(alasan: string): KehadiranRow["jenis"] {
  const kata = alasan.toLowerCase().split(/[^\p{L}]+/u);
  if (kata.includes("sakit")) return "Sakit";
  if (kata.includes("cuti")) return "Cuti";
  if (kata.includes("telat") || kata.includes("terlambat")) return "Telat";
  return "Izin";
}

/** Satu baris per tanggal Jakarta yang dilewati gangguan (lewat tengah malam: 23:59 / 00:00). */
function barisGangguan(g: GangguanAktif, selesai: Date): GangguanRow[] {
  const akhir = toJakartaDate(selesai);
  const label = g.scope === "tiktok" ? "TikTok" : "Shopee";
  const alasan = g.scope === "semua" ? g.alasan : `${label}${g.alasan ? `: ${g.alasan}` : ""}`;
  const rows: GangguanRow[] = [];
  for (let t = g.tanggal; t <= akhir; t = addDays(t, 1)) {
    rows.push({
      tanggal: t, host: g.host, mulai: t === g.tanggal ? g.mulai : "00:00", selesai: t === akhir ? toJakartaHM(selesai) : "23:59",
      alasan, sumber: SUMBER,
    });
  }
  return rows;
}

/* ---------- Pembantu ---------- */

/** Kirim ke grup; kegagalan WAHA dicatat, tidak dilempar. Mengembalikan id pesan terkirim bila ada. */
async function kirim(deps: HandleDeps, text: string, replyTo?: string, mentions?: string[]): Promise<string | null> {
  try {
    return (await deps.waha.sendText(deps.config.LIVE_GROUP_ID, text, replyTo, mentions))?.id ?? null;
  } catch (e) {
    console.error(`handleMessage: kirim pesan gagal: ${pesanError(e)}`);
    return null;
  }
}

function lacak(db: Db, jenis: "receipt" | "siapa" | "riwayat", sentId: string | null, nilai: string): void {
  if (sentId) db.setKv(`${jenis}:${kunci(sentId)}`, nilai);
}

/**
 * Kunci pelacakan: id pesan polos. WAHA memberi id serialisasi "true_<chat>_<id>[_<pengirim>]", sedangkan
 * replyTo.id bisa berupa id polos atau serialisasi (PROVISIONAL, Task 0); keduanya dinormalkan ke <id>.
 */
function kunci(id: string): string {
  return /^(?:true|false)_[^_]+_([^_]+)/.exec(id)?.[1] ?? id;
}

function bacaJson<T>(db: Db, k: string): T | null {
  const v = db.getKv(k);
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

function simpanKonteks(db: Db, g: Gambar): void {
  db.setKv(`gambar:${g.messageId}`, JSON.stringify(g));
}

function simpanAntrean(db: Db, g: GambarSiap): void {
  simpanKonteks(db, g);
  db.pendingExtract.put(g.messageId, g.path, g.caption);
}

const adaBerkas = (g: Gambar): boolean => g.path !== "" && existsSync(g.path);

async function unduh<T extends Gambar>(g: T, deps: HandleDeps): Promise<T> {
  const { buf, mime } = await deps.waha.download(g.mediaUrl);
  return { ...g, path: simpanBukti(deps.dataDir, g.messageId, buf, mime), mime };
}

function simpanBukti(dataDir: string, messageId: string, buf: Buffer, mime: string): string {
  const dir = join(dataDir, "bukti");
  mkdirSync(dir, { recursive: true });
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const path = join(dir, `${messageId.replace(/[^\w@.-]/g, "_")}.${ext}`);
  writeFileSync(path, buf);
  return path;
}

const namaHost = (s: Settings): string[] => s.hosts.map((h) => h.name);
const hostConfig = (s: Settings, name: string): HostConfig => s.hosts.find((h) => h.name === name) ?? { name };
const waktu = (r: Report): Date => r.effectiveAt ?? r.receivedAt;
const pesanError = (e: unknown): string => (e instanceof Error ? e.message : String(e));
