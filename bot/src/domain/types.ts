export type Platform = "tiktok" | "shopee";
export interface Num { value: number; rounded: boolean }
export interface PlatformReading {
  platform: Platform;
  screen: "berjalan" | "akhir";
  omzet: Num | null;          // TikTok GMV teratribusi | Shopee Penjualan
  pesanan: Num | null;        // TikTok produk terjual | Shopee pesanan dibuat
  penontonMasuk: Num | null;  // TikTok tayangan | Shopee dilihat
  komentar: Num | null;
  keranjang: Num | null;      // Shopee
  impresi: Num | null;        // TikTok
  pengikutBaru: Num | null;   // TikTok
  penontonAktif: Num | null;  // Shopee, sesaat (tidak dikurangkan)
  rataNontonDetik: number | null; // Shopee, sesaat
  durasiDetik: number | null;
}
export type CumulativeField = "omzet"|"pesanan"|"penontonMasuk"|"komentar"|"keranjang"|"impresi"|"pengikutBaru"|"durasiDetik";
export type ExtractResult =
  | { ok: true; readings: PlatformReading[] }
  | { ok: false; reason: "bukan_layar_live" | "tidak_terbaca" | "ditolak" };
export interface Report {
  messageId: string; receivedAt: Date; effectiveAt?: Date;
  host: string; isMati: boolean; reading: PlatformReading;
}
export type Flag = "dibulatkan"|"siaran_baru"|"layar_akhir"|"siaran_belum_lengkap"|"belum_teratribusi";
export interface LedgerEntry {
  messageId: string; host: string; platform: Platform;
  date: string;              // YYYY-MM-DD tanggal mulai siaran
  at: Date; intervalStart: Date; segment: number;
  credit: Partial<Record<CumulativeField, number>>;
  flags: Flag[];
  share?: number;            // porsi atribusi; hanya pada entri hasil pecahan atribusi
}
export interface HostConfig {
  name: string; waId?: string; aktifMulai?: string; aktifSelesai?: string;
  /** Nomor baris tabel host di Pengaturan (1-based); menentukan baris host di Dashboard Host. */
  row?: number;
}
export interface Settings {
  teamTarget: Record<string, number>;   // "2026-11" → rupiah
  jadwalAktif: boolean; liveMulai: string; liveSelesai: string;
  jamPagi: string; jamRekap: string; maxGapMenit: number; maxPesanPerHari: number;
  hosts: HostConfig[]; ownerWaId: string; ownerEmail: string;
}
