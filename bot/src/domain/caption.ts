import { parseNum } from "./numbers.js";
import { addDays } from "./time.js";
import type { CumulativeField, Platform } from "./types.js";

export type Command =
  | { kind: "gangguan"; scope: Platform | "semua"; alasan: string }
  | { kind: "normal" }
  | { kind: "izin"; date: string; alasan: string };

export type CaptionMatch =
  | { host: string; isMati: boolean }
  | { error: "kosong" | "tidak_dikenal" | "ganda" };

// Selisih 1 bila token atau nama pendek (<=5 huruf), agar "Rina"/"pindah" tidak dianggap "Linda".
const maxDistance = (tokenLen: number, hostLen: number): number => (Math.min(tokenLen, hostLen) <= 5 ? 1 : 2);
const MIN_TOKEN_LENGTH = 4;

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

export function matchCaption(caption: string, hosts: string[]): CaptionMatch {
  const all = caption.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  if (all.length === 0) return { error: "kosong" };
  const isMati = all.includes("mati");
  const tokens = all.filter((t) => t !== "mati");

  const exact = new Set<string>();
  const fuzzy = new Set<string>();
  let ambiguous = false;
  for (const token of tokens) {
    const scored = hosts
      .map((h) => ({ h, d: levenshtein(token, h.toLowerCase()) }))
      .filter((x) => x.d === 0 || (token.length >= MIN_TOKEN_LENGTH && x.d <= maxDistance(token.length, x.h.length)));
    if (scored.length === 0) continue;
    const best = Math.min(...scored.map((x) => x.d));
    const winners = scored.filter((x) => x.d === best);
    if (best === 0) {
      for (const w of winners) exact.add(w.h);
    } else if (winners.length > 1) {
      ambiguous = true;
    } else {
      fuzzy.add(winners[0]!.h);
    }
  }

  const found = exact.size > 0 ? exact : fuzzy;
  if (exact.size === 0 && ambiguous) return { error: "ganda" };
  if (found.size === 0) return { error: "tidak_dikenal" };
  if (found.size > 1) return { error: "ganda" };
  return { host: [...found][0]!, isMati };
}

export function parseCommand(text: string, today: string): Command | null {
  const m = /^\s*#(gangguan|normal|izin)\b\s*([\s\S]*)$/i.exec(text);
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  const rest = (m[2] ?? "").trim();

  if (word === "normal") return { kind: "normal" };

  if (word === "gangguan") {
    const first = /^(\S+)\s*([\s\S]*)$/.exec(rest);
    const scope = first?.[1]?.toLowerCase();
    if (scope === "tiktok" || scope === "shopee") {
      return { kind: "gangguan", scope, alasan: (first?.[2] ?? "").trim() };
    }
    return { kind: "gangguan", scope: "semua", alasan: rest };
  }

  const d = /^(\d{1,2})\/(\d{1,2})(?:\s+([\s\S]*))?$/.exec(rest);
  if (!d) return { kind: "izin", date: today, alasan: rest };
  const year = Number(today.slice(0, 4));
  let date = tanggal(year, Number(d[2]), Number(d[1]));
  // Lebih dari 30 hari lalu → maksudnya tahun depan (mis. "#izin 5/1" dikirim November).
  if (date && date < addDays(today, -IZIN_MUNDUR_HARI)) date = tanggal(year + 1, Number(d[2]), Number(d[1]));
  return date ? { kind: "izin", date, alasan: (d[3] ?? "").trim() } : null;
}

const IZIN_MUNDUR_HARI = 30;

/** "YYYY-MM-DD" bila tanggal itu ada, selain itu null. */
function tanggal(year: number, month: number, day: number): string | null {
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const valid = new Date(`${date}T00:00:00.000Z`);
  if (month < 1 || month > 12 || Number.isNaN(valid.getTime()) || valid.toISOString().slice(0, 10) !== date) return null;
  return date;
}

/**
 * Atribusi ulang laporan yang tercatat atas nama host yang salah: "koreksi host Vanna", "host Vanna", "bukan Brando,
 * Vanna" (juga "bukan Brando, tapi Vanna"). Nama harus sama persis dengan nama host (tanpa beda huruf besar-kecil);
 * selain itu null (tidak menebak).
 */
export function parseKoreksiHost(text: string, hosts: string[]): string | null {
  const t = text.trim().replace(/[.!]+$/, "").trim();
  const m = /^(?:koreksi\s+)?host\s*:?\s+(.+)$/iu.exec(t) ?? /^bukan\s+[^,]+,\s*(?:tapi\s+|tetapi\s+)?(.+)$/iu.exec(t);
  const nama = m?.[1]?.trim().toLowerCase();
  return nama ? (hosts.find((h) => h.toLowerCase() === nama) ?? null) : null;
}

export interface Koreksi { platform: Platform; field: Exclude<CumulativeField, "durasiDetik">; value: number }

const FIELD_KOREKSI: Record<string, Koreksi["field"]> = {
  omzet: "omzet", pesanan: "pesanan", penonton: "penontonMasuk", dilihat: "penontonMasuk", tayangan: "penontonMasuk",
  komentar: "komentar", keranjang: "keranjang", impresi: "impresi", pengikut: "pengikutBaru",
};

/** "[koreksi] <tiktok|shopee> [field] <angka>"; field bawaan omzet. Selain format itu null (tidak menebak). */
export function parseKoreksi(text: string): Koreksi | null {
  const m = /^\s*(?:koreksi\s+)?(tiktok|shopee)\s+(\S.*?)\s*$/iu.exec(text);
  if (!m) return null;
  const sisa = m[2]!;
  const kata = /^(\p{L}+)\s+(\S.*)$/u.exec(sisa);
  const field = kata ? FIELD_KOREKSI[kata[1]!.toLowerCase()] : undefined;
  const angka = parseNum(field && kata ? kata[2]! : sisa);
  return angka ? { platform: m[1]!.toLowerCase() as Platform, field: field ?? "omzet", value: angka.value } : null;
}
