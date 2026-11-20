import { jakartaDateTime, toJakartaDate, toJakartaHM } from "./time.js";
import type { CumulativeField, Flag, LedgerEntry, Num, Platform, PlatformReading, Report } from "./types.js";

export interface LedgerOptions {
  maxGapMenit: number;
  liveMulai: string;
  onShift?: (host: string, date: string) => boolean;
  /** Kunci `${messageId}|${platform}` → pembagian kredit entri itu ke host-host. */
  attributions?: Map<string, Array<{ host: string; share: number }>>;
}

export interface Correction { messageId: string; platform: Platform; field: CumulativeField; value: number }

type Credit = Partial<Record<CumulativeField, number>>;

const FIELDS: readonly CumulativeField[] = [
  "omzet", "pesanan", "penontonMasuk", "komentar", "keranjang", "impresi", "pengikutBaru", "durasiDetik",
];
const MENIT_MS = 60_000;
// Omzet yang turun dengan salah satu sisi dibulatkan, paling jauh 10% di bawah angka tertinggi
// siaran, dianggap derau pembulatan, bukan siaran baru.
const BATAS_DERAU_PEMBULATAN = 0.1;
// Laporan siaran lanjutan mulai jam ini di hari kalender sesudah tanggal mulai ikut tanggalnya sendiri.
const JAM_GANTI_HARI = "06:00";

interface Siaran {
  mulai: string;              // tanggal (Jakarta) laporan pertama siaran
  puncak: Credit;             // angka tertinggi tiap field sejauh ini di siaran
  nomor: Map<string, number>; // nomor siaran ini untuk tiap tanggal entri
}

// Kiriman ulang layar akhir tidak masuk jejak: laporan sesudahnya tetap dibandingkan dengan layar akhir asli.
interface Jejak {
  prev: Report;
  prevAt: Date;
  prevDate: string; // tanggal entri laporan sebelumnya
  siaran: Siaran;
  siaranPerTanggal: Map<string, number>;
}

type Putus = "lanjut" | "baru" | "belum_lengkap" | "duplikat";

const waktu = (r: Report): Date => r.effectiveAt ?? r.receivedAt;
const isLayarAkhir = (r: Report): boolean => r.isMati || r.reading.screen === "akhir";

function nilai(reading: PlatformReading, field: CumulativeField): number | null {
  return field === "durasiDetik" ? reading.durasiDetik : (reading[field]?.value ?? null);
}

const derauPembulatan = (prev: Num, cur: Num, puncak: number): boolean =>
  (prev.rounded || cur.rounded) && puncak - cur.value <= BATAS_DERAU_PEMBULATAN * puncak;

const sama = (a: PlatformReading, b: PlatformReading): boolean => FIELDS.every((f) => nilai(a, f) === nilai(b, f));

// Sesudah layar akhir: kiriman ulang (semua angka sama) = duplikat, selain itu siaran baru.
// Siaran baru belum lengkap kalau omzet turun (bukan derau), atau ganti tanggal entri dengan jeda > maxGap.
function putus(lalu: Jejak, cur: PlatformReading, at: Date, maxGapMs: number): Putus {
  const { prev, siaran } = lalu;
  if (isLayarAkhir(prev)) return sama(prev.reading, cur) ? "duplikat" : "baru";
  const a = prev.reading.omzet;
  const b = cur.omzet;
  if (a !== null && b !== null && b.value < a.value && !derauPembulatan(a, b, siaran.puncak.omzet ?? a.value)) {
    return "belum_lengkap";
  }
  const gantiHari = tanggalEntri(at, siaran.mulai) !== lalu.prevDate;
  return gantiHari && at.getTime() - lalu.prevAt.getTime() > maxGapMs ? "belum_lengkap" : "lanjut";
}

// Laporan pertama siaran: kredit nilai penuh. Sesudahnya: selisih terhadap angka tertinggi sejauh ini
// di siaran, minimal 0; field tanpa angka sebelumnya di siaran tidak diberi kredit. Memperbarui puncak.
function kreditkan(siaran: Siaran, cur: PlatformReading, awal: boolean): Credit {
  const credit: Credit = {};
  for (const field of FIELDS) {
    const sekarang = nilai(cur, field);
    if (sekarang === null) continue;
    const puncak = siaran.puncak[field];
    if (awal) credit[field] = sekarang;
    else if (puncak !== undefined) credit[field] = Math.max(0, sekarang - puncak);
    siaran.puncak[field] = Math.max(puncak ?? sekarang, sekarang);
  }
  return credit;
}

function kreditNol(cur: PlatformReading): Credit {
  const credit: Credit = {};
  for (const field of FIELDS) if (nilai(cur, field) !== null) credit[field] = 0;
  return credit;
}

function tanggalEntri(at: Date, mulai: string): string {
  const hari = toJakartaDate(at);
  return hari > mulai && toJakartaHM(at) >= JAM_GANTI_HARI ? hari : mulai;
}

// Nomor siaran per platform per tanggal entri, mulai dari 1.
function nomorSiaran(siaran: Siaran, date: string, perTanggal: Map<string, number>): number {
  const ada = siaran.nomor.get(date);
  if (ada !== undefined) return ada;
  const nomor = (perTanggal.get(date) ?? 0) + 1;
  perTanggal.set(date, nomor);
  siaran.nomor.set(date, nomor);
  return nomor;
}

// Awal interval laporan pertama siaran: laporan terakhir siaran sebelumnya di hari yang sama. Untuk
// siaran pertama hari itu: liveMulai, atau laporan ini sendiri kalau liveMulai belum tiba — tidak pernah
// laporan hari sebelumnya.
function awalSiaran(at: Date, date: string, segment: number, prevAt: Date | undefined, liveMulai: string): Date {
  if (segment > 1 && prevAt !== undefined) return prevAt;
  const mulai = jakartaDateTime(date, liveMulai);
  return mulai.getTime() <= at.getTime() ? mulai : at;
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
  const maxGapMs = opts.maxGapMenit * MENIT_MS;
  const urut = reports
    .map((report, index) => ({ report, index, at: waktu(report) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.index - b.index);

  const jejak = new Map<Platform, Jejak>();
  const entries: LedgerEntry[] = [];

  for (const { report, at } of urut) {
    const { reading } = report;
    const lalu = jejak.get(reading.platform);
    const status: Putus = lalu ? putus(lalu, reading, at, maxGapMs) : "baru";

    if (lalu !== undefined && status === "duplikat") {
      const segment = nomorSiaran(lalu.siaran, lalu.prevDate, lalu.siaranPerTanggal);
      entries.push({
        messageId: report.messageId, host: report.host, platform: reading.platform, date: lalu.prevDate,
        at, intervalStart: at, segment, credit: kreditNol(reading), flags: [],
      });
      continue;
    }

    const baru = lalu === undefined || status !== "lanjut";
    const siaran: Siaran = baru ? { mulai: toJakartaDate(at), puncak: {}, nomor: new Map() } : lalu.siaran;
    const siaranPerTanggal = lalu?.siaranPerTanggal ?? new Map<string, number>();

    const credit = kreditkan(siaran, reading, baru);
    const date = tanggalEntri(at, siaran.mulai);
    const segment = nomorSiaran(siaran, date, siaranPerTanggal);
    const intervalStart = baru ? awalSiaran(at, date, segment, lalu?.prevAt, opts.liveMulai) : lalu.prevAt;
    jejak.set(reading.platform, { prev: report, prevAt: at, prevDate: date, siaran, siaranPerTanggal });

    const flags: Flag[] = [];
    if (baru && lalu) flags.push("siaran_baru");
    if (status === "belum_lengkap") flags.push("siaran_belum_lengkap");
    if (isLayarAkhir(report)) flags.push("layar_akhir");
    if (reading.omzet?.rounded) flags.push("dibulatkan");

    const base = { messageId: report.messageId, platform: reading.platform, date, at, intervalStart, segment };
    const pecahan = opts.attributions?.get(`${report.messageId}|${reading.platform}`);
    if (pecahan !== undefined && pecahan.length > 0) {
      for (const { host, share } of pecahan) {
        entries.push({ ...base, host, credit: kali(credit, share), flags: [...flags], share });
      }
      continue;
    }
    const jedaTakWajar = at.getTime() - intervalStart.getTime() > maxGapMs;
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
