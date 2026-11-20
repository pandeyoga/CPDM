import type { Num } from "./types.js";

const KALI: Record<string, number> = { rb: 1_000, k: 1_000, jt: 1_000_000, m: 1_000_000 };
// Titik = pemisah ribuan (kelompok 3 digit), koma = desimal.
const POLA = /^(?:rp)?((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?)(rb|jt|k|m)?$/;

export function parseNum(text: string): Num | null {
  const m = POLA.exec(text.replace(/\s+/g, "").toLowerCase());
  if (!m || m[1] === undefined) return null;
  const angka = Number(m[1].replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(angka)) return null;
  const akhiran = m[2];
  if (akhiran === undefined) return { value: angka, rounded: false };
  return { value: Math.round(angka * (KALI[akhiran] ?? 1)), rounded: true };
}

export function parseDurasi(text: string): number | null {
  const bagian = text.trim().split(":");
  if (bagian.length < 2 || bagian.length > 3) return null;
  if (!bagian.every((p) => /^\d{1,2}$/.test(p))) return null;
  return bagian.reduce((acc, p) => acc * 60 + Number(p), 0);
}
