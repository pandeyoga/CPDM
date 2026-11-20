import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { matchCaption, parseCommand, parseKoreksi, type Command } from "../domain/caption.js";
import { buildLedger } from "../domain/ledger.js";
import {
  msgAckKoreksi, msgAckPerintah, msgDiproses, msgFormatKoreksi, msgKirimUlang, msgMintaRiwayat, msgSiapa, msgTanda,
} from "../domain/messages.js";
import { addDays, jakartaDateTime, toJakartaDate, toJakartaHM } from "../domain/time.js";
import type { ExtractResult, HostConfig, Platform, Report, Settings } from "../domain/types.js";
import type { Db } from "../infra/db.js";
import type { Extractor } from "../infra/extractor.js";
import type { GangguanRow, KehadiranRow } from "../infra/sheets.js";
import type { Incoming, WahaClient } from "../infra/waha.js";

/*
 * Orkestrasi satu pesan grup. Semua tulisan ke Sheets lewat db.outbox (tidak butuh gateway Sheets di sini).
 * Pesan bot yang balasannya penting dilacak di kv menurut id pesan terkirim (R35):
 *   receipt:<id> → messageId laporan (juga dipasang untuk id foto asli), siapa:<id> → messageId gambar tertunda,
 *   riwayat:<id> → {platform, host, beforeIso}. Konteks gambar tertunda di kv gambar:<messageId>.
 */

export interface HandleDeps {
  config: Pick<Config, "LIVE_GROUP_ID">;
  db: Db;
  waha: Pick<WahaClient, "sendText" | "download">;
  extractor: Extractor;
  settings: Settings;
  /** Bukti disimpan di <dataDir>/bukti/<messageId>.<ext> sebelum diunggah lewat antrean (R36). */
  dataDir: string;
}

/** Operasi antrean di luar SheetOp; dijalankan runner antrean (Task 12) lewat sheets.uploadBukti. */
export type UploadBuktiOp = { type: "uploadBukti"; messageId: string; path: string };

export const KV_GANGGUAN_AKTIF = "gangguanAktif";
const SUMBER = "Grup WA";

interface Gambar {
  messageId: string; receivedAt: string; path: string; mime: string; caption: string;
  /** Layar akhir dari riwayat live: waktu efektif, platform yang diminta, dan kunci kv permintaannya. */
  effectiveAt?: string; platform?: Platform; riwayatKey?: string;
}
type GambarSiap = Gambar & { host: string; isMati: boolean };
interface Riwayat { platform: Platform; host: string; beforeIso: string }
interface GangguanAktif { tanggal: string; mulai: string; host: string; alasan: string; scope: Platform | "semua" }

export async function handleMessage(m: Incoming, deps: HandleDeps): Promise<void> {
  if (m.chatId !== deps.config.LIVE_GROUP_ID) return;
  if (!deps.db.markMessage(m.id, m.ts)) return;
  if (m.hasImage) return terimaGambar(m, deps);
  const cmd = parseCommand(m.text, toJakartaDate(m.ts));
  if (cmd) return perintah(m, cmd, deps);
  if (m.replyToId) return balasanTeks(m, m.replyToId, deps);
}

/** Proses ulang antrean pendingExtract (dipanggil penjadwal). Yang masih gagal tetap di antrean, tanpa pesan baru. */
export async function retryPendingExtract(deps: HandleDeps): Promise<void> {
  for (const p of deps.db.pendingExtract.all()) {
    const g = bacaJson<GambarSiap>(deps.db, `gambar:${p.msgId}`);
    if (!g || typeof g.host !== "string" || !existsSync(p.imagePath)) {
      console.error(`handleMessage: antrean ekstraksi ${p.msgId} dibuang (konteks atau gambar hilang)`);
      deps.db.pendingExtract.done(p.msgId);
      continue;
    }
    if (await prosesGambar(g, deps, true)) deps.db.pendingExtract.done(p.msgId);
  }
}

/* ---------- Gambar ---------- */

async function terimaGambar(m: Incoming, deps: HandleDeps): Promise<void> {
  const { db } = deps;
  let unduhan: { path: string; mime: string };
  try {
    if (!m.mediaUrl) throw new Error("gambar tanpa URL media");
    const { buf, mime } = await deps.waha.download(m.mediaUrl);
    unduhan = { path: simpanBukti(deps.dataDir, m.id, buf, mime), mime };
  } catch (e) {
    console.error(`handleMessage: unduh gambar ${m.id} gagal: ${pesanError(e)}`);
    await kirim(deps, msgKirimUlang("ditolak"), m.id);
    return;
  }
  const g: Gambar = { messageId: m.id, receivedAt: m.ts.toISOString(), ...unduhan, caption: m.text };

  const riwayatKey = m.replyToId ? `riwayat:${kunci(m.replyToId)}` : undefined;
  const riwayat = riwayatKey ? bacaJson<Riwayat>(db, riwayatKey) : null;
  if (riwayatKey && riwayat) {
    const effectiveAt = new Date(new Date(riwayat.beforeIso).getTime() - 1000).toISOString();
    await prosesGambar({ ...g, host: riwayat.host, isMati: true, effectiveAt, platform: riwayat.platform, riwayatKey }, deps, false);
    return;
  }

  const cocok = matchCaption(m.text, namaHost(deps.settings));
  if ("error" in cocok) {
    db.setKv(`gambar:${m.id}`, JSON.stringify(g));
    db.pendingCaption.put(m.id, g.path, m.text);
    db.logProblem(m.id, null, toJakartaDate(m.ts), "caption");
    lacak(db, "siapa", await kirim(deps, msgSiapa(), m.id), m.id);
    return;
  }
  await prosesGambar({ ...g, host: cocok.host, isMati: cocok.isMati }, deps, false);
}

/** true bila selesai (tersimpan atau ditolak); false bila ekstraksi gagal dan gambar ada di pendingExtract. */
async function prosesGambar(g: GambarSiap, deps: HandleDeps, diulang: boolean): Promise<boolean> {
  const { db } = deps;
  const image = readFileSync(g.path);
  let hasil: ExtractResult;
  try {
    hasil = await deps.extractor.extract(image, g.mime);
  } catch (e) {
    console.error(`handleMessage: ekstraksi ${g.messageId} gagal, diantrekan: ${pesanError(e)}`);
    if (!diulang) {
      db.setKv(`gambar:${g.messageId}`, JSON.stringify(g));
      db.pendingExtract.put(g.messageId, g.path, g.caption);
      await kirim(deps, msgDiproses(), g.messageId);
    }
    return false;
  }

  const readings = hasil.ok ? hasil.readings.filter((r) => g.platform === undefined || r.platform === g.platform) : [];
  if (readings.length === 0) {
    rmSync(g.path, { force: true });
    await kirim(deps, msgKirimUlang(hasil.ok ? "tidak_terbaca" : hasil.reason), g.messageId);
    return true;
  }

  const receivedAt = new Date(g.receivedAt);
  const effectiveAt = g.effectiveAt === undefined ? undefined : new Date(g.effectiveAt);
  for (const reading of readings) {
    db.saveReport({ messageId: g.messageId, receivedAt, ...(effectiveAt ? { effectiveAt } : {}), host: g.host, isMati: g.isMati, reading });
  }
  db.outbox.push({ type: "uploadBukti", messageId: g.messageId, path: g.path } satisfies UploadBuktiOp);
  if (g.riwayatKey) db.setKv(g.riwayatKey, "");
  await kirimTandaTerima(g, effectiveAt ?? receivedAt, deps);
  return true;
}

/**
 * Ledger dari hari Jakarta sebelumnya pukul 00:00 (R14); kredit entri pesan ini → msgTanda. Entri
 * siaran_belum_lengkap memicu msgMintaRiwayat yang menag host laporan terakhir sebelum reset.
 */
async function kirimTandaTerima(g: GambarSiap, at: Date, deps: HandleDeps): Promise<void> {
  const { db, settings } = deps;
  const tanggal = toJakartaDate(at);
  const mulai = jakartaDateTime(addDays(tanggal, -1), "00:00").getTime();
  const reports = db.reports(tanggal.slice(0, 7)).filter((r) => waktu(r).getTime() >= mulai);
  const entries = buildLedger(reports, { maxGapMenit: settings.maxGapMenit, liveMulai: settings.liveMulai });
  const baru = entries.filter((e) => e.messageId === g.messageId);

  const perPlatform = baru.map((e) => ({ platform: e.platform, kredit: e.credit.omzet ?? 0, rounded: e.flags.includes("dibulatkan") }));
  const flags = [...new Set(baru.flatMap((e) => e.flags))];
  lacak(db, "receipt", await kirim(deps, msgTanda(hostConfig(settings, g.host), perPlatform, flags), g.messageId), g.messageId);
  db.setKv(`receipt:${kunci(g.messageId)}`, g.messageId);

  for (const e of baru) {
    if (!e.flags.includes("siaran_belum_lengkap")) continue;
    const sebelum = entries.slice(0, entries.indexOf(e)).reverse().find((x) => x.platform === e.platform && x.messageId !== g.messageId);
    const host = hostConfig(settings, sebelum?.host ?? g.host);
    const id = await kirim(deps, msgMintaRiwayat(host, e.platform), g.messageId, host.waId ? [host.waId] : undefined);
    const riwayat: Riwayat = { platform: e.platform, host: host.name, beforeIso: e.at.toISOString() };
    lacak(db, "riwayat", id, JSON.stringify(riwayat));
  }
}

/* ---------- Balasan teks ---------- */

async function balasanTeks(m: Incoming, replyToId: string, deps: HandleDeps): Promise<void> {
  const k = kunci(replyToId);
  const tertunda = deps.db.getKv(`siapa:${k}`);
  if (tertunda) return jawabSiapa(m, tertunda, deps);
  const laporan = deps.db.getKv(`receipt:${k}`);
  if (laporan && /\d/.test(m.text)) return koreksi(m, laporan, deps);
}

async function jawabSiapa(m: Incoming, msgId: string, deps: HandleDeps): Promise<void> {
  const { db } = deps;
  const g = bacaJson<Gambar>(db, `gambar:${msgId}`);
  const pending = g ? db.pendingCaption.take(msgId) : null;
  if (!g || !pending) return;
  const cocok = matchCaption(m.text, namaHost(deps.settings));
  if ("error" in cocok) {
    db.pendingCaption.put(pending.msgId, pending.imageRef, pending.caption);
    lacak(db, "siapa", await kirim(deps, msgSiapa(), m.id), msgId);
    return;
  }
  db.setProblemHost(msgId, cocok.host);
  const isMati = cocok.isMati || /(^|[^\p{L}\p{N}])mati($|[^\p{L}\p{N}])/iu.test(g.caption);
  await prosesGambar({ ...g, host: cocok.host, isMati }, deps, false);
}

/** Koreksi tidak pernah langsung berlaku: baris Koreksi berstatus Menunggu sampai owner memilih Setujui. */
async function koreksi(m: Incoming, messageId: string, deps: HandleDeps): Promise<void> {
  const k = parseKoreksi(m.text);
  const laporan = k ? cariLaporan(deps.db, messageId, k.platform, m.ts) : undefined;
  if (!k || !laporan) {
    await kirim(deps, msgFormatKoreksi(), m.id);
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
 * R34 (HP bersama): host = nama host di teks perintah (token nama dibuang dari alasan), lalu nomor pengirim
 * yang cocok dengan No WA host, lalu kosong (diisi owner).
 */
function hostPerintah(teks: string, from: string, settings: Settings): { host: string; alasan: string } {
  const nama = namaHost(settings);
  const cocok = matchCaption(teks, nama);
  if ("host" in cocok) {
    const bukanNama = (t: string): boolean => {
      const c = matchCaption(t, nama);
      return !("host" in c && c.host === cocok.host);
    };
    return { host: cocok.host, alasan: teks.split(/\s+/).filter(bukanNama).join(" ") };
  }
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
