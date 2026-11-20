import type { Platform } from "./types.js";

export type Command =
  | { kind: "gangguan"; scope: Platform | "semua"; alasan: string }
  | { kind: "normal" }
  | { kind: "izin"; date: string; alasan: string };

export type CaptionMatch =
  | { host: string; isMati: boolean }
  | { error: "kosong" | "tidak_dikenal" | "ganda" };

// Token pendek (4-5 huruf) hanya boleh selisih 1, agar "Rina" tidak dianggap "Linda".
const maxDistance = (len: number): number => (len >= 6 ? 2 : 1);
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
  const tokens = all.filter((t) => t !== "mati" && t.length >= MIN_TOKEN_LENGTH);

  const exact = new Set<string>();
  const fuzzy = new Set<string>();
  let ambiguous = false;
  for (const token of tokens) {
    const scored = hosts
      .map((h) => ({ h, d: levenshtein(token, h.toLowerCase()) }))
      .filter((x) => x.d <= maxDistance(token.length));
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
  const day = Number(d[1]);
  const month = Number(d[2]);
  const year = Number(today.slice(0, 4));
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const valid = new Date(`${date}T00:00:00.000Z`);
  if (month < 1 || month > 12 || Number.isNaN(valid.getTime()) || valid.toISOString().slice(0, 10) !== date) return null;
  return { kind: "izin", date, alasan: (d[3] ?? "").trim() };
}
