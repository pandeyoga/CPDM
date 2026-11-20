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

/* ---------- Pembaca sel ---------- */

type Cell = unknown;
const EPOCH_SHEETS = Date.UTC(1899, 11, 30);
const text = (c: Cell): string => (c === undefined || c === null ? "" : String(c).trim());
const serialToDate = (n: number): string => new Date(EPOCH_SHEETS + Math.floor(n) * 86_400_000).toISOString().slice(0, 10);

function toDate(c: Cell): string | undefined {
  if (typeof c === "number" && c > 0) return serialToDate(c);
  const s = text(c);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2]?.padStart(2, "0")}-${m[1]?.padStart(2, "0")}` : undefined;
}
const pad2 = (n: number): string => String(n).padStart(2, "0");
function toMinutes(c: Cell): number | undefined {
  if (typeof c === "number") return Math.round((c - Math.floor(c)) * 1440) % 1440;
  const m = /^(\d{1,2}):(\d{2})/.exec(text(c));
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}
function toHM(c: Cell): string | undefined {
  const min = toMinutes(c);
  return min === undefined ? undefined : `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}
function toNumber(c: Cell): number | undefined {
  if (typeof c === "number") return c;
  const s = text(c);
  if (s === "") return undefined;
  const n = parseNum(s);
  if (n) return n.value;
  const plain = Number(s.replace(",", "."));
  return Number.isFinite(plain) ? plain : undefined;
}
function toMonth(c: Cell): string | undefined {
  const s = text(c);
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  return toDate(c)?.slice(0, 7);
}
/** "No WA" → id WhatsApp "628…@c.us" (0 di depan → 62). */
function toWaId(c: Cell): string | undefined {
  const s = text(c);
  if (s === "") return undefined;
  if (s.includes("@")) return s;
  let d = s.replace(/\D/g, "");
  if (d === "") return undefined;
  if (d.startsWith("0")) d = `62${d.slice(1)}`;
  return `${d}@c.us`;
}
const sama = (c: Cell, nilai: string): boolean => text(c).toLowerCase() === nilai;
const platformOf = (c: Cell): Platform | undefined => {
  const p = text(c).toLowerCase();
  return p === "tiktok" || p === "shopee" ? p : undefined;
};

/* ---------- Pengaturan ---------- */

export function fromSettingsRows(rows: Cell[][]): Settings {
  const kv = new Map<string, Cell>();
  for (const r of rows) {
    const key = text(r[0]);
    if (key !== "") kv.set(key, r[1]);
  }
  const k = PENGATURAN_KEYS;
  const hm = (key: string, bawaan: string): string => toHM(kv.get(key)) ?? bawaan;
  const angka = (key: string, bawaan: number): number => toNumber(kv.get(key)) ?? bawaan;

  const teamTarget: Record<string, number> = {};
  const hosts: HostConfig[] = [];
  rows.slice(1).forEach((r, i) => {
    const bulan = toMonth(r[3]);
    const target = toNumber(r[4]);
    if (bulan && target !== undefined) teamTarget[bulan] = target;
    const nama = text(r[6]);
    if (nama !== "" && i < MAX_HOST_PENGATURAN) {
      const host: HostConfig = { name: nama };
      const waId = toWaId(r[7]);
      const mulai = toDate(r[8]);
      const selesai = toDate(r[9]);
      if (waId) host.waId = waId;
      if (mulai) host.aktifMulai = mulai;
      if (selesai) host.aktifSelesai = selesai;
      hosts.push(host);
    }
  });

  const jadwal = kv.get(k.jadwalAktif);
  return {
    teamTarget,
    jadwalAktif: jadwal === true || sama(jadwal, "ya"),
    liveMulai: hm(k.liveMulai, "09:00"),
    liveSelesai: hm(k.liveSelesai, "22:00"),
    jamPagi: hm(k.jamPagi, "08:00"),
    jamRekap: hm(k.jamRekap, "22:30"),
    maxGapMenit: angka(k.maxGapMenit, 240),
    maxPesanPerHari: angka(k.maxPesanPerHari, 6),
    hosts,
    ownerWaId: toWaId(kv.get(k.ownerWaId)) ?? "",
    ownerEmail: text(kv.get(k.ownerEmail)),
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

const dataRows = (rows: Cell[][]): Cell[][] => rows.slice(1);

export function parseKoreksiRows(rows: Cell[][]): Array<{ messageId: string; platform: Platform; field: CumulativeField; value: number }> {
  const out: Array<{ messageId: string; platform: Platform; field: CumulativeField; value: number }> = [];
  for (const r of dataRows(rows)) {
    const platform = platformOf(r[KOREKSI_IDX.platform]);
    const field = FIELDS.find((f) => f === text(r[KOREKSI_IDX.field]));
    const value = toNumber(r[KOREKSI_IDX.nilai]);
    const messageId = text(r[KOREKSI_IDX.messageId]);
    if (sama(r[KOREKSI_IDX.jenis], "koreksi") && sama(r[KOREKSI_IDX.keputusan], KEPUTUSAN_KOREKSI) && platform && field && value !== undefined && messageId !== "") {
      out.push({ messageId, platform, field, value });
    }
  }
  return out;
}

/** Kunci `${messageId}|${platform}` (ledger R15). */
export function parseAtribusiRows(rows: Cell[][], hosts: Array<{ name: string }>): Map<string, Array<{ host: string; share: number }>> {
  const out = new Map<string, Array<{ host: string; share: number }>>();
  for (const r of dataRows(rows)) {
    const platform = platformOf(r[KOREKSI_IDX.platform]);
    const messageId = text(r[KOREKSI_IDX.messageId]);
    if (!sama(r[KOREKSI_IDX.jenis], "atribusi") || !sama(r[KOREKSI_IDX.keputusan], KEPUTUSAN_KOREKSI) || !platform || messageId === "") continue;
    const parsed = parseAtribusi(text(r[KOREKSI_IDX.atribusi]), hosts);
    if (parsed) out.set(`${messageId}|${platform}`, parsed);
  }
  return out;
}

export function parseKehadiranRows(rows: Cell[][]): Array<{ host: string; date: string }> {
  const out: Array<{ host: string; date: string }> = [];
  for (const r of dataRows(rows)) {
    const date = toDate(r[0]);
    const jenis = text(r[2]).toLowerCase();
    if (date && text(r[1]) !== "" && ["sakit", "izin", "cuti"].includes(jenis) && sama(r[5], KEPUTUSAN_LAIN)) out.push({ host: text(r[1]), date });
  }
  return out;
}

export function parseGangguanRows(rows: Cell[][]): Array<{ host: string; date: string; menit: number }> {
  const out: Array<{ host: string; date: string; menit: number }> = [];
  for (const r of dataRows(rows)) {
    const date = toDate(r[0]);
    const mulai = toMinutes(r[2]);
    const selesai = toMinutes(r[3]);
    if (!date || text(r[1]) === "" || mulai === undefined || selesai === undefined || !sama(r[6], KEPUTUSAN_LAIN)) continue;
    const menit = selesai - mulai;
    if (menit > 0) out.push({ host: text(r[1]), date, menit });
  }
  return out;
}

export function parseKalenderRows(rows: Cell[][]): string[] {
  return dataRows(rows).flatMap((r) => toDate(r[0]) ?? []);
}

export function parseJadwalRows(rows: Cell[][]): Array<{ date: string; host: string; mulai: string; selesai: string }> {
  const out: Array<{ date: string; host: string; mulai: string; selesai: string }> = [];
  for (const r of dataRows(rows)) {
    const date = toDate(r[0]);
    const mulai = toHM(r[2]);
    const selesai = toHM(r[3]);
    if (date && text(r[1]) !== "" && mulai && selesai) out.push({ date, host: text(r[1]), mulai, selesai });
  }
  return out;
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
}
export interface GangguanRow { tanggal: string; host: string; mulai: string; selesai: string; alasan: string; sumber: string }
export interface KehadiranRow { tanggal: string; host: string; jenis: "Sakit" | "Izin" | "Cuti" | "Telat"; alasan: string; sumber: string }
export interface KondisiRow { host: string; butuhPerHariKerja: number | null; disiplin: number | null; status: string }

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
  serialTanggal(r.tanggal), r.host, r.masalah, r.angkaBot, r.usulan, STATUS_MENUNGGU, "", r.messageId,
  r.platform ?? "", r.jenis, r.field ?? "", r.value ?? "",
];

const colLetter = (n: number): string => String.fromCharCode(65 + n);
const q = (tab: string): string => `'${tab}'`;

export type SheetsClient = sheets_v4.Sheets;
export type DriveClient = drive_v3.Drive;
type GatewayConfig = Pick<Config, "LIVE_SPREADSHEET_ID" | "BUKTI_FOLDER_ID"> &
  Partial<Pick<Config, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GOOGLE_REFRESH_TOKEN" | "JADWAL_SPREADSHEET_ID">>;

export class SheetsGateway {
  private readonly sheets: SheetsClient;
  private readonly drive: DriveClient;

  constructor(private readonly cfg: GatewayConfig, clients?: { sheets: SheetsClient; drive: DriveClient }) {
    if (clients) {
      this.sheets = clients.sheets;
      this.drive = clients.drive;
      return;
    }
    if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET || !cfg.GOOGLE_REFRESH_TOKEN) throw new Error("Kredensial Google tidak lengkap");
    const auth = new google.auth.OAuth2(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: cfg.GOOGLE_REFRESH_TOKEN });
    this.sheets = google.sheets({ version: "v4", auth });
    this.drive = google.drive({ version: "v3", auth });
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

  readSettings = async (): Promise<Settings> => fromSettingsRows(await this.read(`${TAB.pengaturan}!${PENGATURAN_READ}`));
  readKoreksiKeputusan = async () => parseKoreksiRows(await this.read(`${q(TAB.koreksi)}!A:L`));
  readAtribusi = async () => parseAtribusiRows(await this.read(`${q(TAB.koreksi)}!A:L`), (await this.readSettings()).hosts);
  readKehadiran = async () => parseKehadiranRows(await this.read(`${TAB.kehadiran}!A:F`));
  readGangguan = async () => parseGangguanRows(await this.read(`${TAB.gangguan}!A:G`));
  readKalenderLive = async () => parseKalenderRows(await this.read(`${q(TAB.kalender)}!A:B`));
  readJadwal = async () =>
    parseJadwalRows(await this.read(`${q(TAB.jadwal)}!A:D`, this.cfg.JADWAL_SPREADSHEET_ID ?? this.id));

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
        return this.rewriteTable(TAB.targetHarian, TARGET_HARIAN_COLUMNS.length, (old) => [
          ...old.filter((r) => typeof r[0] !== "number" || serialToDate(r[0]).slice(0, 7) !== op.month),
          ...toTargetHarianRows(op.rows),
        ]);
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
    if (old.length > next.length) {
      await this.sheets.spreadsheets.values.clear({
        spreadsheetId: this.id, range: `${q(tab)}!A${next.length + 2}:${last}${old.length + 1}`,
      });
    }
  }

  private async writeKondisi(rows: KondisiRow[]): Promise<void> {
    const t = DASHBOARD_HOST_KONDISI;
    const r0 = t.barisPertama;
    const r1 = r0 + MAX_HOST_PENGATURAN - 1;
    const padded = Array.from({ length: MAX_HOST_PENGATURAN }, (_, i) => rows[i]);
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
