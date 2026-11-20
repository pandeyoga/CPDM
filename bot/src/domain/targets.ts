import type { HostConfig } from "./types.js";
import { daysInMonth } from "./time.js";

export interface TargetInputs {
  month: string;
  teamTarget: number;
  hosts: HostConfig[];
  tanpaLive: string[];
  izin: Array<{ host: string; date: string }>;
  gangguan: Array<{ host: string; date: string; menit: number }>;
  jadwal: null | Array<{ date: string; host: string; mulai: string; selesai: string }>;
  jamLive: number;
}
export interface HostTarget {
  bulan: number;
  awal: number;
  gugur: Array<{ date: string; jumlah: number; sebab: "izin" | "gangguan" }>;
  perHariKerja: number;
}
type Gugur = HostTarget["gugur"][number];

function hostConfig(inp: TargetInputs, host: string): HostConfig | undefined {
  return inp.hosts.find((h) => h.name === host);
}

/** Hari aktif host (tanpa jadwal): hari live dalam rentang aktif host, terurut. */
function activeDays(inp: TargetInputs, host: string): string[] {
  const cfg = hostConfig(inp, host);
  if (!cfg) return [];
  return daysInMonth(inp.month).filter(
    (d) =>
      !inp.tanpaLive.includes(d) &&
      (!cfg.aktifMulai || d >= cfg.aktifMulai) &&
      (!cfg.aktifSelesai || d <= cfg.aktifSelesai),
  );
}

/** Jam on-air host pada tanggal (jadwal ada): jamLive ÷ host berbeda pada tanggal itu, 0 bila host tak shift. */
export function onAirHours(inp: TargetInputs, host: string, date: string): number {
  if (!inp.jadwal) return 0;
  const rows = inp.jadwal.filter((r) => r.date === date);
  if (!rows.some((r) => r.host === host)) return 0;
  return inp.jamLive / new Set(rows.map((r) => r.host)).size;
}

/** Hari kerja host: hari aktif; dengan jadwal, hanya hari host punya shift. Terurut. */
function workDays(inp: TargetInputs, host: string): string[] {
  const days = activeDays(inp, host);
  return inp.jadwal ? days.filter((d) => onAirHours(inp, host, d) > 0) : days;
}

function monthlyHours(inp: TargetInputs, host: string): number {
  if (inp.jadwal) return workDays(inp, host).reduce((s, d) => s + onAirHours(inp, host, d), 0);
  const n = inp.hosts.filter((h) => activeDays(inp, h.name).length > 0).length;
  return n === 0 ? 0 : (activeDays(inp, host).length * inp.jamLive) / n;
}

function awalOf(inp: TargetInputs, host: string): number {
  const total = inp.hosts.reduce((s, h) => s + workDays(inp, h.name).length, 0);
  return total === 0 ? 0 : (inp.teamTarget * workDays(inp, host).length) / total;
}

export function computeTargets(inp: TargetInputs): Record<string, HostTarget> {
  const out: Record<string, HostTarget> = {};
  for (const h of inp.hosts) {
    const host = h.name;
    const aktif = activeDays(inp, host).length;
    const work = workDays(inp, host);
    const awal = awalOf(inp, host);
    const J = monthlyHours(inp, host);
    const workSet = new Set(work);
    const raw: Gugur[] = [];
    const seen = new Set<string>();
    for (const z of inp.izin) {
      if (z.host !== host || seen.has(z.date) || !workSet.has(z.date)) continue;
      seen.add(z.date);
      const jumlah = inp.jadwal
        ? (J > 0 ? (awal * onAirHours(inp, host, z.date)) / J : 0)
        : (awal * 7) / (6 * aktif);
      if (jumlah > 0) raw.push({ date: z.date, jumlah, sebab: "izin" });
    }
    for (const g of inp.gangguan) {
      if (g.host !== host || !workSet.has(g.date) || J <= 0) continue;
      const jumlah = (awal * (g.menit / 60)) / J;
      if (jumlah > 0) raw.push({ date: g.date, jumlah, sebab: "gangguan" });
    }
    raw.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sebab === b.sebab ? 0 : a.sebab === "izin" ? -1 : 1));
    let sisa = awal;
    const gugur: Gugur[] = [];
    for (const g of raw) {
      const jumlah = Math.min(g.jumlah, sisa);
      if (jumlah <= 0) break;
      sisa -= jumlah;
      gugur.push({ ...g, jumlah });
    }
    const hariKerja = inp.jadwal ? work.length : aktif * (6 / 7);
    out[host] = { bulan: sisa, awal, gugur, perHariKerja: hariKerja > 0 ? awal / hariKerja : 0 };
  }
  return out;
}

/** Bagian target (sebelum gugur) per hari kerja host. */
function dayShares(inp: TargetInputs, host: string, awal: number): Array<{ date: string; share: number }> {
  const work = workDays(inp, host);
  if (inp.jadwal) {
    const J = monthlyHours(inp, host);
    return work.map((date) => ({ date, share: J > 0 ? (awal * onAirHours(inp, host, date)) / J : 0 }));
  }
  return work.map((date) => ({ date, share: awal / work.length }));
}

export function seharusnya(t: HostTarget, inp: TargetInputs, host: string, upTo: string): number {
  const gugur = t.gugur.filter((g) => g.date <= upTo).reduce((s, g) => s + g.jumlah, 0);
  const earned = dayShares(inp, host, t.awal)
    .filter((d) => d.date <= upTo)
    .reduce((s, d) => s + d.share, 0);
  return earned - gugur;
}

export function butuhPerHariKerja(t: HostTarget, realisasi: number, inp: TargetInputs, host: string, today: string): number {
  const sisa = Math.max(0, t.bulan - realisasi);
  const remaining = workDays(inp, host).filter((d) => d > today).length;
  const hariKerja = inp.jadwal ? remaining : remaining * (6 / 7);
  return hariKerja > 0 ? sisa / hariKerja : sisa;
}

export function targetHarianRows(
  targets: Record<string, HostTarget>,
  inp: TargetInputs,
): Array<{ tanggal: string; host: string; target: number; gugur: number; sebab: "" | "izin" | "gangguan" }> {
  const rows: Array<{ tanggal: string; host: string; target: number; gugur: number; sebab: "" | "izin" | "gangguan" }> = [];
  for (const h of inp.hosts) {
    const t = targets[h.name];
    if (!t) continue;
    for (const { date, share } of dayShares(inp, h.name, t.awal)) {
      const gs = t.gugur.filter((g) => g.date === date);
      if (gs.length === 0) {
        rows.push({ tanggal: date, host: h.name, target: share, gugur: 0, sebab: "" });
        continue;
      }
      gs.forEach((g, i) =>
        rows.push({ tanggal: date, host: h.name, target: i === 0 ? share : 0, gugur: g.jumlah, sebab: g.sebab }),
      );
    }
  }
  return rows;
}
