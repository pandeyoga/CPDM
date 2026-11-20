import { jakartaDateTime, toJakartaDate } from "./time.js";
import type { CumulativeField, Flag, LedgerEntry, Num, Platform, PlatformReading, Report } from "./types.js";

export interface LedgerOptions {
  maxGapMenit: number;
  liveMulai: string;
  onShift?: (host: string, date: string) => boolean;
  attributions?: Map<string, Array<{ host: string; share: number }>>;
}

export interface Correction { messageId: string; platform: Platform; field: CumulativeField; value: number }

type Credit = Partial<Record<CumulativeField, number>>;

const FIELDS: readonly CumulativeField[] = [
  "omzet", "pesanan", "penontonMasuk", "komentar", "keranjang", "impresi", "pengikutBaru", "durasiDetik",
];
const MENIT_MS = 60_000;
// Omzet yang sama-sama dibulatkan boleh turun sampai 10% tanpa dianggap siaran baru.
const BATAS_DERAU_PEMBULATAN = 0.1;

interface Jejak {
  prev: Report;
  prevAt: Date;
  date: string;
  segment: number;
  siaranPerTanggal: Map<string, number>;
}

const waktu = (r: Report): Date => r.effectiveAt ?? r.receivedAt;
const isLayarAkhir = (r: Report): boolean => r.isMati || r.reading.screen === "akhir";

function nilai(reading: PlatformReading, field: CumulativeField): number | null {
  return field === "durasiDetik" ? reading.durasiDetik : (reading[field]?.value ?? null);
}

const derauPembulatan = (prev: Num, cur: Num): boolean =>
  prev.rounded && cur.rounded && prev.value - cur.value <= BATAS_DERAU_PEMBULATAN * prev.value;

// Siaran baru kalau laporan sebelumnya layar akhir, atau omzet turun (tanpa layar akhir → belum lengkap).
function putus(prev: Report, cur: Report): { baru: boolean; belumLengkap: boolean } {
  if (isLayarAkhir(prev)) return { baru: true, belumLengkap: false };
  const a = prev.reading.omzet;
  const b = cur.reading.omzet;
  const turun = a !== null && b !== null && b.value < a.value && !derauPembulatan(a, b);
  return { baru: turun, belumLengkap: turun };
}

// prev null = laporan pertama siaran: kredit nilai penuh. Selisih negatif dijepit ke 0.
function hitungKredit(prev: PlatformReading | null, cur: PlatformReading): Credit {
  const credit: Credit = {};
  for (const field of FIELDS) {
    const sekarang = nilai(cur, field);
    if (sekarang === null) continue;
    if (prev === null) {
      credit[field] = sekarang;
      continue;
    }
    const sebelum = nilai(prev, field);
    if (sebelum !== null) credit[field] = Math.max(0, sekarang - sebelum);
  }
  return credit;
}

// Awal interval laporan pertama siaran: laporan terakhir siaran sebelumnya, atau liveMulai untuk
// siaran pertama hari itu — kecuali liveMulai jatuh sesudah laporan ini (siaran lewat tengah malam)
// atau sebelum laporan sebelumnya.
function awalSiaran(at: Date, date: string, segment: number, prevAt: Date | undefined, liveMulai: string): Date {
  const mulai = jakartaDateTime(date, liveMulai);
  const pakaiMulai = segment === 1 && mulai.getTime() <= at.getTime()
    && (prevAt === undefined || mulai.getTime() > prevAt.getTime());
  return pakaiMulai ? mulai : (prevAt ?? at);
}

function kali(credit: Credit, share: number): Credit {
  const out: Credit = {};
  for (const field of FIELDS) {
    const v = credit[field];
    if (v !== undefined) out[field] = v * share;
  }
  return out;
}

export function buildLedger(reports: Report[], opts: LedgerOptions): LedgerEntry[] {
  const urut = reports
    .map((report, index) => ({ report, index, at: waktu(report) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.index - b.index);

  const jejak = new Map<Platform, Jejak>();
  const entries: LedgerEntry[] = [];

  for (const { report, at } of urut) {
    const { reading } = report;
    const lalu = jejak.get(reading.platform);
    const flags: Flag[] = [];
    let date: string;
    let segment: number;
    let intervalStart: Date;
    let credit: Credit;

    const p = lalu ? putus(lalu.prev, report) : { baru: true, belumLengkap: false };
    const siaranPerTanggal = lalu?.siaranPerTanggal ?? new Map<string, number>();
    if (lalu === undefined || p.baru) {
      date = toJakartaDate(at);
      segment = (siaranPerTanggal.get(date) ?? 0) + 1;
      siaranPerTanggal.set(date, segment);
      intervalStart = awalSiaran(at, date, segment, lalu?.prevAt, opts.liveMulai);
      credit = hitungKredit(null, reading);
      if (lalu) flags.push("siaran_baru");
      if (p.belumLengkap) flags.push("siaran_belum_lengkap");
    } else {
      ({ date, segment } = lalu);
      intervalStart = lalu.prevAt;
      credit = hitungKredit(lalu.prev.reading, reading);
    }
    jejak.set(reading.platform, { prev: report, prevAt: at, date, segment, siaranPerTanggal });

    if (isLayarAkhir(report)) flags.push("layar_akhir");
    if (reading.omzet?.rounded) flags.push("dibulatkan");

    const base = { messageId: report.messageId, platform: reading.platform, date, at, intervalStart, segment };
    const pecahan = opts.attributions?.get(report.messageId);
    if (pecahan !== undefined && pecahan.length > 0) {
      for (const { host, share } of pecahan) entries.push({ ...base, host, credit: kali(credit, share), flags: [...flags] });
      continue;
    }
    const jedaTakWajar = at.getTime() - intervalStart.getTime() > opts.maxGapMenit * MENIT_MS;
    if (jedaTakWajar || opts.onShift?.(report.host, date) === false) flags.push("belum_teratribusi");
    entries.push({ ...base, host: report.host, credit, flags });
  }
  return entries;
}

export function applyCorrections(reports: Report[], approved: Correction[]): Report[] {
  return reports.map((r) => {
    const reading: PlatformReading = { ...r.reading };
    for (const c of approved) {
      if (c.messageId !== r.messageId || c.platform !== reading.platform) continue;
      if (c.field === "durasiDetik") reading.durasiDetik = c.value;
      else reading[c.field] = { value: c.value, rounded: false };
    }
    return { ...r, reading };
  });
}
