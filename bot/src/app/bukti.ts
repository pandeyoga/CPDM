import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { parseCommand } from "../domain/caption.js";
import { toJakartaDate } from "../domain/time.js";
import type { Db } from "../infra/db.js";
import type { Incoming, WahaClient } from "../infra/waha.js";

/*
 * Bukti gambar lokal: <dataDir>/bukti/<messageId>.<ext>, ext menurut MIME (jpg/png/webp/gif; "bin" bila tidak
 * dikenal). Tautan media WAHA kedaluwarsa, jadi gambar diunduh segera saat diterima (webhook) atau segera sesudah
 * messagesSince (catch-up), sebelum ekstraksi yang lambat; handleMessage memakai berkas yang sudah ada.
 */

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MIME_EXT = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
const EXT_TAK_DIKENAL = "bin";

/** MIME dari magic bytes (JPEG/PNG/WEBP/GIF), null bila bukan salah satunya. */
export function deteksiMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return "image/gif";
  return null;
}

/** MIME untuk ekstraktor: media.mimetype bila didukung, selain itu magic bytes; null = tidak bisa diproses. */
export function pilihMime(mimeMedia: string | undefined, buf: Buffer): string | null {
  const m = mimeMedia?.trim().toLowerCase();
  return m && m in EXT ? m : deteksiMime(buf);
}

const namaBerkas = (messageId: string): string => messageId.replace(/[^\w@.-]/g, "_");

/** Simpan bukti; mime null → berkas .bin dengan mime "" (ditolak saat ekstraksi). */
export function simpanBukti(dataDir: string, messageId: string, buf: Buffer, mime: string | null): { path: string; mime: string } {
  const dir = join(dataDir, "bukti");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${namaBerkas(messageId)}.${(mime && EXT[mime]) ?? EXT_TAK_DIKENAL}`);
  writeFileSync(path, buf);
  return { path, mime: mime ?? "" };
}

/** Bukti lokal pesan ini yang sudah diunduh (mis. segera saat diterima), atau null. */
export function cariBukti(dataDir: string, messageId: string): { path: string; mime: string } | null {
  for (const ext of [...Object.values(EXT), EXT_TAK_DIKENAL]) {
    const path = join(dataDir, "bukti", `${namaBerkas(messageId)}.${ext}`);
    if (existsSync(path)) return { path, mime: MIME_EXT[ext] ?? "" };
  }
  return null;
}

export interface SumberMedia { messageId: string; chatId: string; mediaUrl: string; mimeMedia?: string | undefined }
export type WahaMedia = Pick<WahaClient, "download" | "messageById">;

/**
 * Unduh media lalu simpan. Unduhan gagal (mis. tautan kedaluwarsa) → pesan diambil ulang menurut id untuk tautan
 * segar dan diunduh sekali lagi; kalau itu juga tidak bisa, error unduhan pertama dilempar.
 */
export async function unduhBukti(waha: WahaMedia, dataDir: string, s: SumberMedia): Promise<{ path: string; mime: string; mediaUrl: string }> {
  let mediaUrl = s.mediaUrl;
  let mimeMedia = s.mimeMedia;
  let buf: Buffer;
  try {
    ({ buf } = await waha.download(mediaUrl));
  } catch (e) {
    const segar = await waha.messageById(s.chatId, s.messageId).catch(() => null);
    if (!segar?.mediaUrl) throw e;
    mediaUrl = segar.mediaUrl;
    mimeMedia = segar.mime ?? mimeMedia;
    ({ buf } = await waha.download(mediaUrl));
  }
  return { ...simpanBukti(dataDir, s.messageId, buf, pilihMime(mimeMedia, buf)), mediaUrl };
}

export interface UnduhDeps {
  config: Pick<Config, "LIVE_GROUP_ID">;
  db: Pick<Db, "isProcessed">;
  waha: WahaMedia;
  dataDir: string;
}

/**
 * Unduh segera gambar grup yang belum diproses (bukan perintah, belum ada berkas lokal). Gagal hanya dicatat:
 * handleMessage mencoba lagi (termasuk mengambil ulang tautan segar).
 */
export async function unduhSegera(m: Incoming, deps: UnduhDeps): Promise<void> {
  const { config, db, waha, dataDir } = deps;
  if (m.chatId !== config.LIVE_GROUP_ID || !m.hasImage || !m.mediaUrl) return;
  if (db.isProcessed(m.id) || parseCommand(m.text, toJakartaDate(m.ts)) || cariBukti(dataDir, m.id)) return;
  try {
    await unduhBukti(waha, dataDir, { messageId: m.id, chatId: m.chatId, mediaUrl: m.mediaUrl, mimeMedia: m.mime });
  } catch (e) {
    console.error(`bukti: unduh segera ${m.id} gagal, dicoba lagi saat diproses: ${e instanceof Error ? e.message : String(e)}`);
  }
}
