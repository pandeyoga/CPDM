import { butuhPerHariKerja, seharusnya, type HostTarget, type TargetInputs } from "./targets.js";
import { addDays, daysInMonth, toJakartaHM } from "./time.js";
import type { CumulativeField, LedgerEntry, Platform } from "./types.js";

export type HariKelompok = "Sen–Kam" | "Jum–Min";

export interface HostSummary {
  host: string; target: number; realisasi: number; seharusnya: number;
  pctTarget: number; selisih: number; butuhPerHariKerja: number;
  vsBulanLalu: number | null; menitOnAir: number; omzetPerJam: number | null;
  konversi: number | null; disiplin: number | null;
  streakDiBawah: number; status: "ok" | "warn" | "bad";
}

export interface FunnelShopee {
  omzet: number | null; pesanan: number | null; dilihat: number | null; keranjang: number | null; komentar: number | null;
  atcRate: number | null; cartToOrder: number | null; konversi: number | null; aov: number | null;
  omzetPerJam: number | null; komentarPerDilihat: number | null;
}
export interface FunnelTiktok {
  omzet: number | null; terjual: number | null; tayangan: number | null; impresi: number | null;
  komentar: number | null; pengikutBaru: number | null;
  tapIn: number | null; konversi: number | null; nilaiPerProduk: number | null; komentarPerTayangan: number | null;
}
export interface Funnel { shopee: FunnelShopee; tiktok: FunnelTiktok }

export interface KreditRow {
  messageId: string; tanggal: string;
  jam: number; // jam mulai interval (Asia/Jakarta, 0–23)
  hariKelompok: HariKelompok; host: string; platform: Platform;
  omzet: number | null; pesanan: number | null; penontonMasuk: number | null; komentar: number | null;
  keranjang: number | null; impresi: number | null; pengikutBaru: number | null;
  menitOnAir: number; omzetHarapan: number | null; status: "dihitung" | "belum_teratribusi";
}

export const HOST_BELUM_TERATRIBUSI = "(belum teratribusi)";
const MIN_HARI_INDEKS = 21;
const BATAS_WARN = 0.1;
const STREAK_BAD = 3;
const JAM_MS = 3_600_000;
const MENIT_MS = 60_000;

const teratribusi = (e: LedgerEntry): boolean => !e.flags.includes("belum_teratribusi");
const hostEfektif = (e: LedgerEntry): string => (teratribusi(e) ? e.host : HOST_BELUM_TERATRIBUSI);
const kunci = (e: LedgerEntry): string => `${e.messageId}|${e.platform}|${hostEfektif(e)}`;
const bulanDari = (date: string): string => date.slice(0, 7);
const jamJakarta = (t: number): number => Number(toJakartaHM(new Date(t)).slice(0, 2));

function hariKelompok(date: string): HariKelompok {
  const hari = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return hari >= 1 && hari <= 4 ? "Sen–Kam" : "Jum–Min";
}

function jumlah(es: LedgerEntry[], field: CumulativeField): number | null {
  let total: number | null = null;
  for (const e of es) {
    const v = e.credit[field];
    if (v !== undefined) total = (total ?? 0) + v;
  }
  return total;
}

// Hanya entri yang punya kedua field yang ikut dihitung; null kalau penyebutnya 0.
function rasio(es: LedgerEntry[], pembilang: CumulativeField, penyebut: CumulativeField): number | null {
  let atas = 0;
  let bawah = 0;
  for (const e of es) {
    const a = e.credit[pembilang];
    const b = e.credit[penyebut];
    if (a === undefined || b === undefined) continue;
    atas += a;
    bawah += b;
  }
  return bawah === 0 ? null : atas / bawah;
}

const bagi = (a: number | null, b: number): number | null => (a === null || b === 0 ? null : a / b);

// Per jam jam (Asia/Jakarta): `mentah` = menit interval entri di jam itu; `menit` = bagiannya atas waktu on-air.
interface Potongan { mentah: number; menit: number }
type Alokasi = Map<LedgerEntry, Map<number, Potongan>>;

/**
 * Waktu on-air dibagi per host efektif per tanggal entri: di setiap potongan waktu yang dilalui k interval
 * host itu, tiap entri mendapat 1/k. Jadi Σ menit entri satu host = panjang gabungan intervalnya (dua
 * platform yang dilaporkan berselang beberapa menit tidak dihitung dua kali).
 */
function alokasi(entries: LedgerEntry[]): Alokasi {
  const out: Alokasi = new Map();
  const grup = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    out.set(e, new Map());
    const k = `${hostEfektif(e)}|${e.date}`;
    const anggota = grup.get(k);
    if (anggota) anggota.push(e);
    else grup.set(k, [e]);
  }
  for (const anggota of grup.values()) {
    const titik = new Set<number>();
    for (const e of anggota) {
      const mulai = e.intervalStart.getTime();
      const akhir = e.at.getTime();
      if (akhir <= mulai) continue;
      titik.add(mulai).add(akhir);
      for (let j = (Math.floor(mulai / JAM_MS) + 1) * JAM_MS; j < akhir; j += JAM_MS) titik.add(j);
    }
    const urut = [...titik].sort((a, b) => a - b);
    for (let i = 0; i + 1 < urut.length; i++) {
      const p = urut[i]!;
      const q = urut[i + 1]!;
      const tutup = anggota.filter((e) => e.intervalStart.getTime() <= p && e.at.getTime() >= q);
      if (tutup.length === 0) continue;
      const menit = (q - p) / MENIT_MS;
      const jam = jamJakarta(p);
      for (const e of tutup) {
        const perJam = out.get(e)!;
        const x = perJam.get(jam) ?? { mentah: 0, menit: 0 };
        x.mentah += menit;
        x.menit += menit / tutup.length;
        perJam.set(jam, x);
      }
    }
  }
  return out;
}

function menitOnAir(alok: Alokasi, es: LedgerEntry[]): number {
  let total = 0;
  for (const e of es) for (const p of alok.get(e)?.values() ?? []) total += p.menit;
  return total;
}

type Ember = Record<HariKelompok, Map<number, { omzet: number; jam: number }>>;

// Omzet dan jam on-air entri teratribusi bulan itu, dibagi ke jam yang dilalui intervalnya.
function isiEmber(entries: LedgerEntry[], month: string, alok: Alokasi): Ember {
  const ember: Ember = { "Sen–Kam": new Map(), "Jum–Min": new Map() };
  for (const e of entries) {
    const omzet = e.credit.omzet;
    if (!teratribusi(e) || bulanDari(e.date) !== month || omzet === undefined) continue;
    const perJam = alok.get(e)!;
    let mentah = 0;
    for (const p of perJam.values()) mentah += p.mentah;
    if (mentah === 0) continue;
    const kelompok = ember[hariKelompok(e.date)];
    for (const [jam, p] of perJam) {
      const b = kelompok.get(jam) ?? { omzet: 0, jam: 0 };
      b.omzet += (omzet * p.mentah) / mentah;
      b.jam += p.menit / 60;
      kelompok.set(jam, b);
    }
  }
  return ember;
}

const tarif = (b: { omzet: number; jam: number } | undefined): number | null =>
  b === undefined || b.jam === 0 ? null : b.omzet / b.jam;

export function heatmap(entries: LedgerEntry[], month: string): Record<HariKelompok, Record<number, number | null>> {
  const ember = isiEmber(entries, month, alokasi(entries));
  const peta = (k: HariKelompok): Record<number, number | null> =>
    Object.fromEntries(Array.from({ length: 24 }, (_, jam) => [jam, tarif(ember[k].get(jam))]));
  return { "Sen–Kam": peta("Sen–Kam"), "Jum–Min": peta("Jum–Min") };
}

/** Kunci `${messageId}|${platform}|${host}` (host "(belum teratribusi)" untuk entri yang belum teratribusi). */
export function expectedOmzet(entries: LedgerEntry[], month: string): Map<string, number> {
  const alok = alokasi(entries);
  const ember = isiEmber(entries, month, alok);
  const out = new Map<string, number>();
  for (const e of entries) {
    if (bulanDari(e.date) !== month) continue;
    const kelompok = ember[hariKelompok(e.date)];
    let harapan = 0;
    for (const [jam, p] of alok.get(e)!) harapan += (tarif(kelompok.get(jam)) ?? 0) * (p.menit / 60);
    out.set(kunci(e), harapan);
  }
  return out;
}

export function indeksSlot(entries: LedgerEntry[], host: string, month: string): number | null {
  const dasar = entries.filter((e) => teratribusi(e) && bulanDari(e.date) === month);
  if (new Set(dasar.map((e) => e.date)).size < MIN_HARI_INDEKS) return null;
  const harapan = expectedOmzet(entries, month);
  let omzet = 0;
  let ekspektasi = 0;
  for (const e of dasar) {
    if (e.host !== host || e.credit.omzet === undefined) continue;
    omzet += e.credit.omzet;
    ekspektasi += harapan.get(kunci(e)) ?? 0;
  }
  return ekspektasi > 0 ? omzet / ekspektasi : null;
}

export function funnel(entries: LedgerEntry[], filter: { host?: string; from?: string; to?: string } = {}): Funnel {
  const es = entries.filter(
    (e) =>
      (filter.host === undefined || hostEfektif(e) === filter.host) &&
      (filter.from === undefined || e.date >= filter.from) &&
      (filter.to === undefined || e.date <= filter.to),
  );
  const jam = menitOnAir(alokasi(es), es) / 60;
  const s = es.filter((e) => e.platform === "shopee");
  const t = es.filter((e) => e.platform === "tiktok");
  return {
    shopee: {
      omzet: jumlah(s, "omzet"), pesanan: jumlah(s, "pesanan"), dilihat: jumlah(s, "penontonMasuk"),
      keranjang: jumlah(s, "keranjang"), komentar: jumlah(s, "komentar"),
      atcRate: rasio(s, "keranjang", "penontonMasuk"),
      cartToOrder: rasio(s, "pesanan", "keranjang"),
      konversi: rasio(s, "pesanan", "penontonMasuk"),
      aov: rasio(s, "omzet", "pesanan"),
      omzetPerJam: bagi(jumlah(s, "omzet"), jam),
      komentarPerDilihat: rasio(s, "komentar", "penontonMasuk"),
    },
    tiktok: {
      omzet: jumlah(t, "omzet"), terjual: jumlah(t, "pesanan"), tayangan: jumlah(t, "penontonMasuk"),
      impresi: jumlah(t, "impresi"), komentar: jumlah(t, "komentar"), pengikutBaru: jumlah(t, "pengikutBaru"),
      tapIn: rasio(t, "penontonMasuk", "impresi"),
      konversi: rasio(t, "pesanan", "penontonMasuk"),
      nilaiPerProduk: rasio(t, "omzet", "pesanan"),
      komentarPerTayangan: rasio(t, "komentar", "penontonMasuk"),
    },
  };
}

export function dailyByHost(entries: LedgerEntry[], month: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const e of entries) {
    const omzet = e.credit.omzet;
    if (!teratribusi(e) || bulanDari(e.date) !== month || omzet === undefined) continue;
    const perTanggal = (out[e.host] ??= {});
    perTanggal[e.date] = (perTanggal[e.date] ?? 0) + omzet;
  }
  return out;
}

export function toKreditRows(entries: LedgerEntry[], expected: Map<string, number>): KreditRow[] {
  const alok = alokasi(entries);
  return entries.map((e) => {
    const nilai = (f: CumulativeField): number | null => e.credit[f] ?? null;
    return {
      messageId: e.messageId, tanggal: e.date, jam: jamJakarta(e.intervalStart.getTime()),
      hariKelompok: hariKelompok(e.date), host: hostEfektif(e), platform: e.platform,
      omzet: nilai("omzet"), pesanan: nilai("pesanan"), penontonMasuk: nilai("penontonMasuk"),
      komentar: nilai("komentar"), keranjang: nilai("keranjang"), impresi: nilai("impresi"),
      pengikutBaru: nilai("pengikutBaru"),
      menitOnAir: menitOnAir(alok, [e]), omzetHarapan: expected.get(kunci(e)) ?? null,
      status: teratribusi(e) ? "dihitung" : "belum_teratribusi",
    };
  });
}

const omzetDari = (es: LedgerEntry[]): number => jumlah(es, "omzet") ?? 0;

/**
 * Hari live berturut-turut sampai kemarin dengan kredit < perHariKerja. Dilewati (tidak memutus, tidak
 * menambah): izin, hari tanpa live, di luar rentang aktif host, tanpa jadwal: hari tanpa laporan host;
 * dengan jadwal: hari tanpa shift host (shift tanpa laporan dihitung kredit 0).
 */
function streakDiBawah(host: string, es: LedgerEntry[], t: HostTarget, inp: TargetInputs, today: string): number {
  const cfg = inp.hosts.find((h) => h.name === host);
  const hari = daysInMonth(inp.month);
  const kemarin = addDays(today, -1);
  let n = 0;
  for (const d of hari.filter((x) => x <= kemarin).reverse()) {
    const laporan = es.filter((e) => e.host === host && e.date === d);
    const dilewati =
      inp.tanpaLive.includes(d) ||
      inp.izin.some((z) => z.host === host && z.date === d) ||
      (cfg?.aktifMulai !== undefined && d < cfg.aktifMulai) ||
      (cfg?.aktifSelesai !== undefined && d > cfg.aktifSelesai) ||
      (inp.jadwal ? !inp.jadwal.some((r) => r.date === d && r.host === host) : laporan.length === 0);
    if (dilewati) continue;
    if (omzetDari(laporan.filter(teratribusi)) >= t.perHariKerja) break;
    n++;
  }
  return n;
}

function status(realisasi: number, harus: number, streak: number): HostSummary["status"] {
  if (streak >= STREAK_BAD) return "bad";
  if (realisasi >= harus) return "ok";
  return harus - realisasi <= BATAS_WARN * harus ? "warn" : "bad";
}

export function summarizeHosts(
  entries: LedgerEntry[],
  lastMonth: LedgerEntry[],
  targets: Record<string, HostTarget>,
  inp: TargetInputs,
  today: string,
  laporanBermasalah: Record<string, number>,
): HostSummary[] {
  const hari = daysInMonth(inp.month);
  const akhirBulan = hari[hari.length - 1]!;
  const sampai = today < akhirBulan ? today : akhirBulan;
  const bulanIni = entries.filter((e) => bulanDari(e.date) === inp.month && e.date <= sampai);
  const alok = alokasi(bulanIni);

  // Pembanding: bulan lalu tanggal 1 s/d min(d, akhir bulan lalu).
  const hariLalu = daysInMonth(addDays(`${inp.month}-01`, -1).slice(0, 7));
  const batasLalu = hariLalu[Math.min(Number(sampai.slice(8, 10)), hariLalu.length) - 1]!;
  const awalLalu = hariLalu[0]!;

  return inp.hosts.flatMap(({ name: host }): HostSummary[] => {
    const t = targets[host];
    if (!t) return [];
    const milik = bulanIni.filter((e) => teratribusi(e) && e.host === host);
    const realisasi = omzetDari(milik);
    const menit = menitOnAir(alok, milik);
    const harus = Math.max(0, seharusnya(t, inp, host, sampai));
    const lalu = omzetDari(
      lastMonth.filter((e) => teratribusi(e) && e.host === host && e.date >= awalLalu && e.date <= batasLalu),
    );
    const laporan = new Set(bulanIni.filter((e) => e.host === host).map((e) => e.messageId)).size;
    const streak = streakDiBawah(host, bulanIni, t, inp, today);
    return [{
      host,
      target: t.bulan,
      realisasi,
      seharusnya: harus,
      pctTarget: t.bulan > 0 ? realisasi / t.bulan : 0,
      selisih: realisasi - harus,
      butuhPerHariKerja: butuhPerHariKerja(t, realisasi, inp, host, today),
      vsBulanLalu: lalu > 0 ? realisasi / lalu - 1 : null,
      menitOnAir: menit,
      omzetPerJam: bagi(realisasi, menit / 60),
      konversi: rasio(milik, "pesanan", "penontonMasuk"),
      disiplin: laporan > 0 ? Math.max(0, 1 - (laporanBermasalah[host] ?? 0) / laporan) : null,
      streakDiBawah: streak,
      status: status(realisasi, harus, streak),
    }];
  });
}
