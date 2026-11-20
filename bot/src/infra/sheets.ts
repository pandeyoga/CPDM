import { Readable } from "node:stream";
import { google, type drive_v3, type sheets_v4 } from "googleapis";
import type { Config } from "../config.js";
import { parseNum } from "../domain/numbers.js";
import { HOST_BELUM_TERATRIBUSI, type KreditRow } from "../domain/rekap.js";
import {
  DASHBOARD_HOST_KONDISI, KONTROL_RANGE, KREDIT_COLUMNS, kreditCells, serialTanggal, targetHarianCells,
  TARGET_HARIAN_COLUMNS, type NilaiSel, type TargetHarianRow,
} from "../domain/sheetFormulas.js";
import { toJakartaDate, toJakartaHM } from "../domain/time.js";
import type { CumulativeField, HostConfig, LedgerEntry, Platform, Settings } from "../domain/types.js";

/* ---------- Tata letak tab (dipakai juga oleh blueprint sheet, Task 13) ---------- */

export const TAB = {
  pengaturan: "Pengaturan", sesi: "Sesi Live", koreksi: "Koreksi & Atribusi", gangguan: "Gangguan",
  kehadiran: "Kehadiran", kalender: "Kalender Live", dataKredit: "Data Kredit", targetHarian: "Target Harian",
  log: "Log Bot", heartbeat: "Heartbeat", jadwal: "Data Jadwal", kontrol: "Kontrol", dashboardHost: "Dashboard Host",
} as const;

/** Pengaturan: pasangan kunci/nilai di A:B (baris 1 header). */
export const PENGATURAN_KEYS = {
  jadwalAktif: "Jadwal aktif", liveMulai: "Jam live mulai", liveSelesai: "Jam live selesai", jamPagi: "Jam update pagi",
  jamRekap: "Jam rekap", maxGapMenit: "Batas jeda (menit)", maxPesanPerHari: "Batas pesan per orang per hari",
  ownerWaId: "No WA owner", ownerEmail: "Email owner",
} as const;
export const PENGATURAN_KEY_ORDER = Object.values(PENGATURAN_KEYS);
/** Tabel target bulanan D:E, tabel host G:J (maks 10 baris, DAFTAR_HOST = Pengaturan!G2:G11), Pola Sesi L:N (belum dipakai). */
export const PENGATURAN_TARGET_HEADERS = ["Bulan", "Target"] as const;
export const PENGATURAN_HOST_HEADERS = ["Nama", "No WA", "Aktif mulai", "Aktif selesai"] as const;
export const DAFTAR_HOST_RANGE = "Pengaturan!G2:G11";
/** Baris pertama dan terakhir DAFTAR_HOST; host di luar itu tidak tampil di Dashboard Host. */
export const BARIS_HOST = { pertama: 2, terakhir: 11 } as const;
export const PENGATURAN_KOLOM = { kunci: "A", nilai: "B", bulan: "D", target: "E", host: "G", polaSesi: "L" } as const;
export const MAX_HOST_PENGATURAN = 10;
const PENGATURAN_READ = "A1:N60";

const kolom = <T extends string>(...h: T[]) => h;
export const SESI_HEADERS = kolom("Tgl", "Jam", "Host", "Platform", "Siaran", "Angka layar", "+Omzet", "+Pesanan", "Keterangan", "Bukti", "ID Pesan");
export const KOREKSI_HEADERS = kolom("Tgl", "Host", "Masalah", "Angka bot", "Usulan", "Keputusan", "Atribusi", "ID Pesan", "Platform", "Jenis", "Field", "Nilai");
export const GANGGUAN_HEADERS = kolom("Tanggal", "Host", "Mulai", "Selesai", "Alasan", "Sumber", "Keputusan");
export const KEHADIRAN_HEADERS = kolom("Tanggal", "Host", "Jenis", "Alasan", "Sumber", "Keputusan");
export const KALENDER_HEADERS = kolom("Tanggal", "Keterangan");
export const JADWAL_HEADERS = kolom("Tanggal", "Host", "Mulai", "Selesai");
export const LOG_HEADERS = kolom("Waktu", "Level", "Pesan");
export const HEARTBEAT_HEADERS = kolom("Waktu", "Status WA");
const KOREKSI_IDX = { keputusan: 5, atribusi: 6, messageId: 7, platform: 8, jenis: 9, field: 10, nilai: 11 } as const;

const STATUS_MENUNGGU = "Menunggu";
const KEPUTUSAN_KOREKSI = "setujui";
const KEPUTUSAN_LAIN = "disetujui";
const FIELDS: readonly CumulativeField[] = ["omzet", "pesanan", "penontonMasuk", "komentar", "keranjang", "impresi", "pengikutBaru", "durasiDetik"];

/* ---------- Pembaca sel (ketat: nilai tak valid → undefined, tidak menebak) ---------- */

type Cell = unknown;
export interface Invalid { tab: string; row: number; reason: string }
export interface Parsed<T> { value: T; invalid: Invalid[] }

const EPOCH_SHEETS = Date.UTC(1899, 11, 30);
const text = (c: Cell): string => (c === undefined || c === null ? "" : String(c).trim());
const blank = (c: Cell): boolean => text(c) === "";
const serialToDate = (n: number): string => new Date(EPOCH_SHEETS + Math.floor(n) * 86_400_000).toISOString().slice(0, 10);

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function toDate(c: Cell): string | undefined {
  if (typeof c === "number") return c >= 1 && c < 2_958_466 ? serialToDate(c) : undefined;
  const s = text(c);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return validYmd(Number(iso[1]), Number(iso[2]), Number(iso[3])) ? s : undefined;
  const id = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (id && validYmd(Number(id[3]), Number(id[2]), Number(id[1]))) return `${id[3]}-${pad2(Number(id[2]))}-${pad2(Number(id[1]))}`;
  return undefined;
}
const pad2 = (n: number): string => String(n).padStart(2, "0");
/** Jam 00:00–23:59: teks "HH:MM(:SS)" atau pecahan hari [0,1) dari sel waktu. Angka biasa (mis. 9) tidak valid. */
function toMinutes(c: Cell): number | undefined {
  if (typeof c === "number") return c >= 0 && c < 1 ? Math.round(c * 1440) % 1440 : undefined;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text(c));
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : undefined;
}
function toHM(c: Cell): string | undefined {
  const min = toMinutes(c);
  return min === undefined ? undefined : `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}
/** Angka: sel bertipe angka, hasil parseNum, atau ^\d+$ / ^\d+\.\d+$. Selain itu undefined. */
function toNumber(c: Cell): number | undefined {
  if (typeof c === "number") return Number.isFinite(c) ? c : undefined;
  const s = text(c);
  const n = parseNum(s);
  if (n) return n.value;
  return /^\d+$|^\d+\.\d+$/.test(s) ? Number(s) : undefined;
}
function toMonth(c: Cell): string | undefined {
  const s = text(c);
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? s : undefined;
  return toDate(c)?.slice(0, 7);
}
/** "No WA" → id WhatsApp "628…@c.us" (0 di depan → 62); 8–15 digit. */
function toWaId(c: Cell): string | undefined {
  const s = text(c);
  if (s.includes("@")) return /^\d{8,15}@(c|g)\.us$/.test(s) ? s : undefined;
  if (!/^[\d\s+\-()]+$/.test(s)) return undefined;
  let d = s.replace(/\D/g, "");
  if (d.startsWith("0")) d = `62${d.slice(1)}`;
  return d.length >= 8 && d.length <= 15 ? `${d}@c.us` : undefined;
}
const sama = (c: Cell, nilai: string): boolean => text(c).toLowerCase() === nilai;
const platformOf = (c: Cell): Platform | undefined => {
  const p = text(c).toLowerCase();
  return p === "tiktok" || p === "shopee" ? p : undefined;
};

/* ---------- Pengaturan ---------- */

export function fromSettingsRows(rows: Cell[][]): Parsed<Settings> {
  const invalid: Invalid[] = [];
  const bad = (row: number, reason: string): void => void invalid.push({ tab: TAB.pengaturan, row, reason });
  const kv = new Map<string, { cell: Cell; row: number }>();
  rows.forEach((r, i) => {
    const key = text(r[0]);
    if (key !== "") kv.set(key, { cell: r[1], row: i + 1 });
  });
  const k = PENGATURAN_KEYS;
  /** Kosong → bawaan (tanpa laporan); terisi tapi tak valid → bawaan + laporan. */
  function ambil<T>(key: string, bawaan: T, baca: (c: Cell) => T | undefined): T {
    const e = kv.get(key);
    if (!e || blank(e.cell)) return bawaan;
    const v = baca(e.cell);
    if (v === undefined) bad(e.row, `${key}: nilai "${text(e.cell)}" tidak valid, memakai bawaan`);
    return v ?? bawaan;
  }
  const bulat = (min: number) => (c: Cell): number | undefined => {
    const n = toNumber(c);
    return n !== undefined && Number.isInteger(n) && n >= min ? n : undefined;
  };

  const teamTarget: Record<string, number> = {};
  const hosts: HostConfig[] = [];
  rows.forEach((r, i) => {
    if (i === 0) return;
    const row = i + 1;
    if (!blank(r[3]) || !blank(r[4])) {
      const bulan = toMonth(r[3]);
      const target = toNumber(r[4]);
      if (bulan && target !== undefined && target >= 0) teamTarget[bulan] = target;
      else bad(row, `Target bulanan "${text(r[3])}" / "${text(r[4])}" tidak valid`);
    }
    const nama = text(r[6]);
    if (nama === "") return;
    if (hosts.length >= MAX_HOST_PENGATURAN) return bad(row, `Host "${nama}" melebihi batas ${MAX_HOST_PENGATURAN} host`);
    if (row > BARIS_HOST.terakhir) bad(row, `Host "${nama}" di luar daftar host G${BARIS_HOST.pertama}:G${BARIS_HOST.terakhir}; tidak tampil di Dashboard Host`);
    const host: HostConfig = { name: nama, row };
    if (!blank(r[7])) {
      const waId = toWaId(r[7]);
      if (waId) host.waId = waId;
      else bad(row, `No WA host ${nama} tidak valid`);
    }
    for (const [idx, prop, label] of [[8, "aktifMulai", "Aktif mulai"], [9, "aktifSelesai", "Aktif selesai"]] as const) {
      if (blank(r[idx])) continue;
      const d = toDate(r[idx]);
      if (d) host[prop] = d;
      else bad(row, `${label} host ${nama} tidak valid`);
    }
    hosts.push(host);
  });

  const jadwal = ambil<boolean>(k.jadwalAktif, false, (c) => (c === true || sama(c, "ya") ? true : c === false || sama(c, "tidak") ? false : undefined));
  return {
    value: {
      teamTarget,
      jadwalAktif: jadwal,
      liveMulai: ambil(k.liveMulai, "09:00", toHM),
      liveSelesai: ambil(k.liveSelesai, "22:00", toHM),
      jamPagi: ambil(k.jamPagi, "08:00", toHM),
      jamRekap: ambil(k.jamRekap, "22:30", toHM),
      maxGapMenit: ambil(k.maxGapMenit, 240, bulat(1)),
      maxPesanPerHari: ambil(k.maxPesanPerHari, 6, bulat(0)),
      hosts,
      ownerWaId: ambil(k.ownerWaId, "", toWaId),
      ownerEmail: text(kv.get(k.ownerEmail)?.cell),
    },
    invalid,
  };
}

/* ---------- Atribusi ---------- */

/** "Brando" → 100%; "Brando 50, Vanna 50" → pecahan. Persen harus berjumlah 100, nama harus host. Selain itu null. */
export function parseAtribusi(input: string, hosts: Array<{ name: string }>): Array<{ host: string; share: number }> | null {
  const bagian = input.split(",").map((s) => s.trim());
  if (bagian.some((b) => b === "")) return null;
  const cari = (nama: string): string | undefined => hosts.find((h) => h.name.toLowerCase() === nama.toLowerCase())?.name;
  if (bagian.length === 1) {
    const host = cari(bagian[0] ?? "");
    return host ? [{ host, share: 1 }] : null;
  }
  const hasil: Array<{ host: string; share: number }> = [];
  let jumlah = 0;
  for (const b of bagian) {
    const m = /^(.+?)\s+(\d+(?:[.,]\d+)?)\s*%?$/.exec(b);
    const host = m ? cari(m[1] ?? "") : undefined;
    if (!m || !host || hasil.some((h) => h.host === host)) return null;
    const persen = Number((m[2] ?? "").replace(",", "."));
    jumlah += persen;
    hasil.push({ host, share: persen / 100 });
  }
  return Math.abs(jumlah - 100) < 1e-9 ? hasil : null;
}

/* ---------- Parser tab input owner ---------- */

/** Jalankan `baca` per baris data (tanpa header); baris kosong dilewati; Error dari `baca` dicatat sebagai invalid. */
function parseRows<T>(tab: string, rows: Cell[][], baca: (r: Cell[]) => T | null): Parsed<T[]> {
  const value: T[] = [];
  const invalid: Invalid[] = [];
  rows.forEach((r, i) => {
    if (i === 0 || r.every(blank)) return;
    try {
      const v = baca(r);
      if (v !== null) value.push(v);
    } catch (e) {
      invalid.push({ tab, row: i + 1, reason: (e as Error).message });
    }
  });
  return { value, invalid };
}
const wajib = <T>(v: T | undefined, alasan: string): T => {
  if (v === undefined) throw new Error(alasan);
  return v;
};

export function parseKoreksiRows(rows: Cell[][]): Parsed<Array<{ messageId: string; platform: Platform; field: CumulativeField; value: number }>> {
  return parseRows(TAB.koreksi, rows, (r) => {
    if (!sama(r[KOREKSI_IDX.jenis], "koreksi") || !sama(r[KOREKSI_IDX.keputusan], KEPUTUSAN_KOREKSI)) return null;
    const messageId = text(r[KOREKSI_IDX.messageId]);
    if (messageId === "") throw new Error("Koreksi disetujui tanpa ID Pesan");
    const platform = wajib(platformOf(r[KOREKSI_IDX.platform]), `Platform "${text(r[KOREKSI_IDX.platform])}" tidak valid`);
    const fieldText = text(r[KOREKSI_IDX.field]).toLowerCase();
    const field = wajib(FIELDS.find((f) => f.toLowerCase() === fieldText), `Field "${text(r[KOREKSI_IDX.field])}" tidak dikenal`);
    const value = wajib(toNumber(r[KOREKSI_IDX.nilai]), `Nilai "${text(r[KOREKSI_IDX.nilai])}" bukan angka valid`);
    return { messageId, platform, field, value };
  });
}

/** Jumlah baris koreksi (jenis "koreksi") yang Keputusan-nya masih "Menunggu" (ringkasan owner). */
export function parseKoreksiMenunggu(rows: Cell[][]): number {
  return rows.filter((r, i) => i > 0 && sama(r[KOREKSI_IDX.jenis], "koreksi") && sama(r[KOREKSI_IDX.keputusan], STATUS_MENUNGGU.toLowerCase())).length;
}

/** Kunci `${messageId}|${platform}` (ledger R15). */
export function parseAtribusiRows(rows: Cell[][], hosts: Array<{ name: string }>): Parsed<Map<string, Array<{ host: string; share: number }>>> {
  const p = parseRows(TAB.koreksi, rows, (r) => {
    if (!sama(r[KOREKSI_IDX.jenis], "atribusi") || !sama(r[KOREKSI_IDX.keputusan], KEPUTUSAN_KOREKSI)) return null;
    const messageId = text(r[KOREKSI_IDX.messageId]);
    const platform = platformOf(r[KOREKSI_IDX.platform]);
    if (messageId === "" || !platform) throw new Error("Atribusi disetujui tanpa ID Pesan/Platform valid");
    const split = wajib(parseAtribusi(text(r[KOREKSI_IDX.atribusi]), hosts) ?? undefined, `Atribusi "${text(r[KOREKSI_IDX.atribusi])}" tidak valid`);
    return { key: `${messageId}|${platform}`, split };
  });
  return { value: new Map(p.value.map((e) => [e.key, e.split])), invalid: p.invalid };
}

export function parseKehadiranRows(rows: Cell[][]): Parsed<Array<{ host: string; date: string }>> {
  return parseRows(TAB.kehadiran, rows, (r) => {
    if (!sama(r[5], KEPUTUSAN_LAIN)) return null;
    const date = wajib(toDate(r[0]), `Tanggal "${text(r[0])}" tidak valid`);
    const host = wajib(text(r[1]) === "" ? undefined : text(r[1]), "Host kosong");
    const jenis = text(r[2]).toLowerCase();
    if (!["sakit", "izin", "cuti", "telat"].includes(jenis)) throw new Error(`Jenis "${text(r[2])}" tidak dikenal`);
    return jenis === "telat" ? null : { host, date };
  });
}

export function parseGangguanRows(rows: Cell[][]): Parsed<Array<{ host: string; date: string; menit: number }>> {
  return parseRows(TAB.gangguan, rows, (r) => {
    if (!sama(r[6], KEPUTUSAN_LAIN)) return null;
    const date = wajib(toDate(r[0]), `Tanggal "${text(r[0])}" tidak valid`);
    const host = wajib(text(r[1]) === "" ? undefined : text(r[1]), "Host kosong");
    const mulai = wajib(toMinutes(r[2]), `Mulai "${text(r[2])}" tidak valid`);
    const selesai = wajib(toMinutes(r[3]), `Selesai "${text(r[3])}" tidak valid`);
    if (selesai <= mulai) throw new Error("Selesai harus setelah Mulai");
    return { host, date, menit: selesai - mulai };
  });
}

export function parseKalenderRows(rows: Cell[][]): Parsed<string[]> {
  return parseRows(TAB.kalender, rows, (r) => wajib(toDate(r[0]), `Tanggal "${text(r[0])}" tidak valid`));
}

export function parseJadwalRows(rows: Cell[][]): Parsed<Array<{ date: string; host: string; mulai: string; selesai: string }>> {
  return parseRows(TAB.jadwal, rows, (r) => ({
    date: wajib(toDate(r[0]), `Tanggal "${text(r[0])}" tidak valid`),
    host: wajib(text(r[1]) === "" ? undefined : text(r[1]), "Host kosong"),
    mulai: wajib(toHM(r[2]), `Mulai "${text(r[2])}" tidak valid`),
    selesai: wajib(toHM(r[3]), `Selesai "${text(r[3])}" tidak valid`),
  }));
}

/* ---------- Pemetaan tulis ---------- */

export interface SesiExtra {
  /** Angka layar kumulatif per `${messageId}|${platform}`. */
  angkaLayar?: Map<string, number>;
  /** Tautan bukti per messageId. */
  bukti?: Map<string, string>;
}

function keteranganSesi(flags: LedgerEntry["flags"]): string {
  if (flags.includes("layar_akhir")) return "live mati – layar akhir";
  if (flags.includes("siaran_belum_lengkap")) return "siaran belum lengkap";
  if (flags.includes("belum_teratribusi")) return "belum teratribusi";
  if (flags.includes("dibulatkan")) return "dibulatkan";
  if (flags.includes("siaran_baru")) return "siaran baru";
  return "OK";
}

/** Kolom = SESI_HEADERS (mengikuti tab Sesi Live di format-live.png). */
export function toSesiRows(entries: LedgerEntry[], extra: SesiExtra = {}): NilaiSel[][] {
  return entries.map((e) => [
    serialTanggal(toJakartaDate(e.at)),
    toJakartaHM(e.at),
    e.flags.includes("belum_teratribusi") ? HOST_BELUM_TERATRIBUSI : e.host,
    e.platform === "tiktok" ? "TikTok" : "Shopee",
    `#${e.segment}${e.flags.includes("layar_akhir") ? " akhir" : ""}`,
    extra.angkaLayar?.get(`${e.messageId}|${e.platform}`) ?? "",
    e.credit.omzet ?? "",
    e.credit.pesanan ?? "",
    keteranganSesi(e.flags),
    extra.bukti?.get(e.messageId) ?? "",
    e.messageId,
  ]);
}

const kosong = (cells: NilaiSel[]): NilaiSel[] => cells.map((c) => c ?? "");
export const toKreditSheetRows = (rows: KreditRow[]): NilaiSel[][] => rows.map((r) => kosong(kreditCells(r)));
export const toTargetHarianRows = (rows: TargetHarianRow[]): NilaiSel[][] => rows.map((r) => kosong(targetHarianCells(r)));

const KI = (k: (typeof KREDIT_COLUMNS)[number]["key"]): number => KREDIT_COLUMNS.findIndex((c) => c.key === k);
const grupKredit = (r: NilaiSel[]): string => `${r[KI("messageId")]}|${r[KI("platform")]}`;
const kunciKredit = (r: NilaiSel[]): string => `${grupKredit(r)}|${r[KI("host")]}|${r[KI("jam")]}`;

/** Upsert kunci messageId|platform|host|jam; baris basi dengan messageId|platform sama dibuang. Urutan lama dipertahankan. */
export function mergeKredit(existing: NilaiSel[][], rows: KreditRow[]): NilaiSel[][] {
  const baru = toKreditSheetRows(rows);
  const byKey = new Map(baru.map((r) => [kunciKredit(r), r]));
  const grup = new Set(baru.map(grupKredit));
  const dipakai = new Set<string>();
  const hasil: NilaiSel[][] = [];
  for (const r of existing) {
    if (!grup.has(grupKredit(r))) {
      hasil.push(r);
      continue;
    }
    const key = kunciKredit(r);
    const ganti = byKey.get(key);
    if (ganti && !dipakai.has(key)) {
      hasil.push(ganti);
      dipakai.add(key);
    }
  }
  for (const r of baru) if (!dipakai.has(kunciKredit(r))) hasil.push(r);
  return hasil;
}

/* ---------- Operasi tulis ---------- */

export interface KoreksiRow {
  tanggal: string; host: string; masalah: string; angkaBot: string | number; usulan: string | number;
  jenis: "koreksi" | "atribusi" | "siaran_belum_lengkap";
  messageId: string; platform?: Platform; field?: CumulativeField; value?: number;
  /** Kolom Atribusi terisi lebih dulu (atribusi ulang dari grup); owner tinggal memilih Setujui. */
  atribusi?: string;
}
export interface GangguanRow { tanggal: string; host: string; mulai: string; selesai: string; alasan: string; sumber: string }
export interface KehadiranRow { tanggal: string; host: string; jenis: "Sakit" | "Izin" | "Cuti" | "Telat"; alasan: string; sumber: string }
export interface KondisiRow {
  host: string; butuhPerHariKerja: number | null; disiplin: number | null; status: string;
  /** Posisi di DAFTAR_HOST (0 = baris G2); tanpa ini dipakai urutan array. Di luar 0–9 tidak ditulis. */
  posisi?: number;
}

export type SheetOp =
  | { type: "appendSesi"; rows: NilaiSel[][] }
  | { type: "upsertKredit"; rows: KreditRow[] }
  | { type: "writeTargetHarian"; month: string; rows: TargetHarianRow[] }
  | { type: "appendKoreksi"; row: KoreksiRow }
  | { type: "appendGangguan"; row: GangguanRow }
  | { type: "appendKehadiran"; row: KehadiranRow }
  | { type: "writeKondisi"; rows: KondisiRow[] }
  | { type: "writeHeartbeat"; at: Date; waStatus: string }
  | { type: "appendLog"; at: Date; level: string; pesan: string };

const koreksiCells = (r: KoreksiRow): NilaiSel[] => [
  serialTanggal(r.tanggal), r.host, r.masalah, r.angkaBot, r.usulan, STATUS_MENUNGGU, r.atribusi ?? "", r.messageId,
  r.platform ?? "", r.jenis, r.field ?? "", r.value ?? "",
];

/** Target Harian: baris bulan lain dipertahankan, baris bulan itu diganti seluruhnya. */
export function mergeTargetHarian(existing: NilaiSel[][], month: string, rows: TargetHarianRow[]): NilaiSel[][] {
  const lain = existing.filter((r) => typeof r[0] !== "number" || serialToDate(r[0]).slice(0, 7) !== month);
  return [...lain, ...toTargetHarianRows(rows)];
}

/** Rentang ekor yang harus dihapus setelah tabel (data mulai baris 2) menyusut dari oldLen ke newLen baris; null bila tak perlu. */
export function tailClearRange(tab: string, width: number, newLen: number, oldLen: number): string | null {
  if (oldLen <= newLen) return null;
  const last = colLetter(width - 1);
  return `'${tab}'!A${newLen + 2}:${last}${oldLen + 1}`;
}

const colLetter = (n: number): string => String.fromCharCode(65 + n);
const q = (tab: string): string => `'${tab}'`;

export type SheetsClient = sheets_v4.Sheets;
export type DriveClient = drive_v3.Drive;
type GatewayConfig = Pick<Config, "LIVE_SPREADSHEET_ID" | "BUKTI_FOLDER_ID"> &
  Partial<Pick<Config, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GOOGLE_REFRESH_TOKEN" | "JADWAL_SPREADSHEET_ID">>;

/** Batas waktu setiap panggilan Google (token OAuth, Sheets, Drive) supaya permintaan macet tidak menahan antrean. */
export const GOOGLE_TIMEOUT_MS = 30_000;

export function klienGoogle(cfg: { clientId: string; clientSecret: string; refreshToken: string }) {
  const auth = new google.auth.OAuth2({
    clientId: cfg.clientId, clientSecret: cfg.clientSecret, transporterOptions: { timeout: GOOGLE_TIMEOUT_MS },
  });
  auth.setCredentials({ refresh_token: cfg.refreshToken });
  return {
    auth,
    sheets: google.sheets({ version: "v4", auth, timeout: GOOGLE_TIMEOUT_MS }),
    drive: google.drive({ version: "v3", auth, timeout: GOOGLE_TIMEOUT_MS }),
  };
}

export class SheetsGateway {
  private readonly sheets: SheetsClient;
  private readonly drive: DriveClient;

  constructor(
    private readonly cfg: GatewayConfig,
    clients?: { sheets: SheetsClient; drive: DriveClient },
    private readonly onInvalid?: (items: Invalid[]) => void,
  ) {
    if (clients) {
      this.sheets = clients.sheets;
      this.drive = clients.drive;
      return;
    }
    if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET || !cfg.GOOGLE_REFRESH_TOKEN) throw new Error("Kredensial Google tidak lengkap");
    const k = klienGoogle({ clientId: cfg.GOOGLE_CLIENT_ID, clientSecret: cfg.GOOGLE_CLIENT_SECRET, refreshToken: cfg.GOOGLE_REFRESH_TOKEN });
    this.sheets = k.sheets;
    this.drive = k.drive;
  }

  private get id(): string {
    return this.cfg.LIVE_SPREADSHEET_ID;
  }

  private async read(range: string, spreadsheetId = this.id): Promise<Cell[][]> {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId, range, valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER",
    });
    return (res.data.values ?? []) as Cell[][];
  }

  /** Baris input owner yang tak valid dilaporkan ke onInvalid (caller menulis Log Bot / memberi tahu owner). */
  private lapor<T>(p: Parsed<T>): T {
    if (p.invalid.length > 0) this.onInvalid?.(p.invalid);
    return p.value;
  }

  readSettings = async (): Promise<Settings> => this.lapor(fromSettingsRows(await this.read(`${TAB.pengaturan}!${PENGATURAN_READ}`)));
  readKoreksiKeputusan = async () => this.lapor(parseKoreksiRows(await this.read(`${q(TAB.koreksi)}!A:L`)));
  /** `hosts` dari Pengaturan yang sudah dibaca (refresh); tanpa itu Pengaturan dibaca ulang. */
  readAtribusi = async (hosts?: Array<{ name: string }>) =>
    this.lapor(parseAtribusiRows(await this.read(`${q(TAB.koreksi)}!A:L`), hosts ?? (await this.readSettings()).hosts));
  readKoreksiMenunggu = async (): Promise<number> => parseKoreksiMenunggu(await this.read(`${q(TAB.koreksi)}!A:L`));
  readKehadiran = async () => this.lapor(parseKehadiranRows(await this.read(`${TAB.kehadiran}!A:F`)));
  readGangguan = async () => this.lapor(parseGangguanRows(await this.read(`${TAB.gangguan}!A:G`)));
  readKalenderLive = async () => this.lapor(parseKalenderRows(await this.read(`${q(TAB.kalender)}!A:B`)));
  readJadwal = async () =>
    this.lapor(parseJadwalRows(await this.read(`${q(TAB.jadwal)}!A:D`, this.cfg.JADWAL_SPREADSHEET_ID ?? this.id)));

  /** Realisasi bulan ini per host dari tab Kontrol (kolom B), untuk pengecekan silang. */
  async readKontrol(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of await this.read(`${TAB.kontrol}!${KONTROL_RANGE}`)) {
      const host = text(r[0]);
      const v = toNumber(r[1]);
      if (host !== "" && v !== undefined) out[host] = v;
    }
    return out;
  }

  /**
   * Unggah bukti ke folder BUKTI_FOLDER_ID. Dengan scope drive.file, folder tujuan harus dibuat oleh OAuth client
   * yang sama (setup-sheet membuatnya di Task 13); folder buatan tangan tidak bisa ditulisi.
   */
  async uploadBukti(buf: Buffer, name: string): Promise<string> {
    const mimeType = /\.png$/i.test(name) ? "image/png" : /\.webp$/i.test(name) ? "image/webp" : "image/jpeg";
    const res = await this.drive.files.create({
      requestBody: { name, parents: [this.cfg.BUKTI_FOLDER_ID] },
      media: { mimeType, body: Readable.from(buf) },
      fields: "id,webViewLink",
    });
    const link = res.data.webViewLink;
    if (!link) throw new Error(`Drive tidak mengembalikan webViewLink untuk ${name}`);
    return link;
  }

  async apply(op: SheetOp): Promise<void> {
    switch (op.type) {
      case "appendSesi": return this.append(TAB.sesi, op.rows);
      case "appendKoreksi": return this.append(TAB.koreksi, [koreksiCells(op.row)]);
      case "appendGangguan": {
        const r = op.row;
        return this.append(TAB.gangguan, [[serialTanggal(r.tanggal), r.host, r.mulai, r.selesai, r.alasan, r.sumber, STATUS_MENUNGGU]]);
      }
      case "appendKehadiran": {
        const r = op.row;
        return this.append(TAB.kehadiran, [[serialTanggal(r.tanggal), r.host, r.jenis, r.alasan, r.sumber, STATUS_MENUNGGU]]);
      }
      case "appendLog": return this.append(TAB.log, [[op.at.toISOString(), op.level, op.pesan]]);
      case "writeHeartbeat":
        return this.put(`${TAB.heartbeat}!A2:B2`, [[op.at.toISOString(), op.waStatus]]);
      case "upsertKredit": return this.rewriteTable(TAB.dataKredit, KREDIT_COLUMNS.length, (old) => mergeKredit(old, op.rows));
      case "writeTargetHarian":
        return this.rewriteTable(TAB.targetHarian, TARGET_HARIAN_COLUMNS.length, (old) => mergeTargetHarian(old, op.month, op.rows));
      case "writeKondisi": return this.writeKondisi(op.rows);
    }
  }

  private async append(tab: string, values: NilaiSel[][]): Promise<void> {
    if (values.length === 0) return;
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.id, range: `${q(tab)}!A:A`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
      requestBody: { values: values.map(kosong) },
    });
  }

  private async put(range: string, values: NilaiSel[][]): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.id, range, valueInputOption: "RAW", requestBody: { values },
    });
  }

  /** Baca baris data (tanpa header), ubah, tulis ulang dari A2, lalu hapus sisa ekor yang lebih panjang dari hasil baru. */
  private async rewriteTable(tab: string, width: number, change: (old: NilaiSel[][]) => NilaiSel[][]): Promise<void> {
    const last = colLetter(width - 1);
    const old = (await this.read(`${q(tab)}!A2:${last}`)) as NilaiSel[][];
    const next = change(old);
    if (next.length > 0) await this.put(`${q(tab)}!A2`, next);
    const tail = tailClearRange(tab, width, next.length, old.length);
    if (tail) await this.sheets.spreadsheets.values.clear({ spreadsheetId: this.id, range: tail });
  }

  private async writeKondisi(rows: KondisiRow[]): Promise<void> {
    const t = DASHBOARD_HOST_KONDISI;
    const r0 = t.barisPertama;
    const r1 = r0 + MAX_HOST_PENGATURAN - 1;
    const padded: Array<KondisiRow | undefined> = Array.from({ length: MAX_HOST_PENGATURAN }, () => undefined);
    rows.forEach((r, i) => {
      const p = r.posisi ?? i;
      if (p >= 0 && p < MAX_HOST_PENGATURAN) padded[p] = r;
    });
    const sheet = q(TAB.dashboardHost);
    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.id,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `${sheet}!${t.butuhPerHariKerja}${r0}:${t.butuhPerHariKerja}${r1}`, values: padded.map((r) => [r?.butuhPerHariKerja ?? ""]) },
          { range: `${sheet}!${t.disiplin}${r0}:${t.status}${r1}`, values: padded.map((r) => [r?.disiplin ?? "", r?.status ?? ""]) },
        ],
      },
    });
  }
}
