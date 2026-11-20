import { addDays, daysInMonth } from "./time.js";

/** Pilihan sel Periode (B2) di setiap tab dashboard dan analisis, sesuai urutan validasi daftar. */
export const PRESETS = [
  "Hari ini", "Kemarin", "7 hari terakhir", "30 hari terakhir", "Minggu ini", "Minggu lalu", "Bulan ini", "Bulan lalu", "Custom",
] as const;
export type Preset = (typeof PRESETS)[number];

export type ModePembanding = "sebelumnya" | "bulan_lalu" | "tanpa";
/** Teks pilihan sel Bandingkan (H2) per mode. */
export const PEMBANDING: Record<ModePembanding, string> = {
  sebelumnya: "Periode sebelumnya",
  bulan_lalu: "Bulan lalu tanggal sama",
  tanpa: "Tanpa pembanding",
};

export interface Rentang { dari: string; sampai: string }

// 1 = Senin … 7 = Minggu (minggu dimulai Senin).
const hariKe = (date: string): number => new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
const awalBulan = (date: string): string => `${date.slice(0, 7)}-01`;
// Tanggal yang sama sebulan sebelumnya; hari dijepit ke panjang bulan itu (31 Mar → 28 Feb).
function bulanSebelumnya(date: string): string {
  const hari = daysInMonth(addDays(awalBulan(date), -1).slice(0, 7));
  return hari[Math.min(Number(date.slice(8, 10)), hari.length) - 1]!;
}
const selisihHari = (a: string, b: string): number =>
  (Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000;

/** Rentang tanggal preset relatif terhadap `today` (YYYY-MM-DD). Preset berjalan berakhir hari ini. */
export function periodRange(preset: Preset, today: string, custom?: Rentang): Rentang {
  const senin = addDays(today, 1 - hariKe(today));
  switch (preset) {
    case "Hari ini": return { dari: today, sampai: today };
    case "Kemarin": return { dari: addDays(today, -1), sampai: addDays(today, -1) };
    case "7 hari terakhir": return { dari: addDays(today, -6), sampai: today };
    case "30 hari terakhir": return { dari: addDays(today, -29), sampai: today };
    case "Minggu ini": return { dari: senin, sampai: today };
    case "Minggu lalu": return { dari: addDays(senin, -7), sampai: addDays(senin, -1) };
    case "Bulan ini": return { dari: awalBulan(today), sampai: today };
    case "Bulan lalu": {
      const akhir = addDays(awalBulan(today), -1);
      return { dari: awalBulan(akhir), sampai: akhir };
    }
    case "Custom":
      if (!custom) throw new Error("Preset Custom butuh tanggal dari dan sampai");
      return { dari: custom.dari, sampai: custom.sampai };
  }
}

/**
 * Rentang pembanding; null untuk "tanpa" atau rentang tidak valid (dari > sampai).
 * - sebelumnya: jumlah hari sama, berakhir sehari sebelum `dari`.
 * - bulan_lalu (R25): kedua ujung mundur satu bulan kalender, hari dijepit ke panjang bulan itu.
 */
export function comparisonRange(range: Rentang, mode: ModePembanding): Rentang | null {
  if (mode === "tanpa" || range.dari > range.sampai) return null;
  if (mode === "sebelumnya") {
    const n = selisihHari(range.dari, range.sampai) + 1;
    return { dari: addDays(range.dari, -n), sampai: addDays(range.dari, -1) };
  }
  return { dari: bulanSebelumnya(range.dari), sampai: bulanSebelumnya(range.sampai) };
}
