import { DetailedCellError, HyperFormula } from "hyperformula";
import { beforeAll, describe, expect, it } from "vitest";
import { comparisonRange, periodRange, PEMBANDING, PRESETS, type ModePembanding, type Preset } from "../src/domain/period.js";
import {
  dailyByHost, expectedOmzet, funnel, heatmap, HOST_BELUM_TERATRIBUSI, indeksSlot, summarizeHosts, toKreditRows,
  type HostSummary,
} from "../src/domain/rekap.js";
import {
  dashboardFormulas, KREDIT_COLUMNS, kreditCells, LAYOUTS, serialTanggal, TARGET_HARIAN_COLUMNS, targetHarianCells,
  type Layout,
} from "../src/domain/sheetFormulas.js";
import { computeTargets, seharusnya, targetHarianRows, type TargetInputs } from "../src/domain/targets.js";
import { addDays } from "../src/domain/time.js";
import type { CumulativeField, Flag, LedgerEntry, Platform } from "../src/domain/types.js";

// ---------- Fixture: data contoh mockup (3 host, 1–20 Nov) ditambah Oktober ----------

const J = (dt: string): Date => new Date(`${dt}:00+07:00`);
let seq = 0;
interface EntryInput {
  host: string; date: string; from: string; to: string; platform?: Platform;
  credit: Partial<Record<CumulativeField, number>>; flags?: Flag[]; id?: string; share?: number;
}
function ent(p: EntryInput): LedgerEntry {
  const waktu = (hm: string): Date => J(hm.includes("T") ? hm : `${p.date}T${hm}`);
  return {
    messageId: p.id ?? `m${++seq}`, host: p.host, platform: p.platform ?? "shopee", date: p.date,
    at: waktu(p.to), intervalStart: waktu(p.from), segment: 1, credit: p.credit, flags: p.flags ?? [],
    ...(p.share === undefined ? {} : { share: p.share }),
  };
}

const HOSTS = ["Brando", "Vanna", "Linda"] as const;
type Host = (typeof HOSTS)[number];
// [mulai Shopee, mulai TikTok, selesai]: TikTok mulai beberapa menit kemudian (gabungan menit on-air diuji).
const SLOT: Record<Host, [string, string, string]> = {
  Brando: ["09:00", "09:05", "13:20"], Vanna: ["13:20", "13:30", "17:40"], Linda: ["17:40", "17:45", "21:50"],
};
const pad = (n: number): string => String(n).padStart(2, "0");
const hari = (a: number, b: number, kecuali: number[]): number[] =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i).filter((d) => !kecuali.includes(d));

// Total dibagi ke n hari dengan variasi, kelipatan Rp1.000, jumlahnya tepat.
function bagiTotal(total: number, n: number, seed: number): number[] {
  const bobot = Array.from({ length: n }, (_, i) => 8 + ((i * 5 + seed) % 7));
  const sb = bobot.reduce((a, b) => a + b, 0);
  const v = bobot.map((b) => Math.floor((total * b) / sb / 1000) * 1000);
  v[n - 1] = v[n - 1]! + total - v.reduce((a, b) => a + b, 0);
  return v;
}

// Satu pesan dua platform; sebagian field kadang tidak terbaca (null).
function live(host: Host, date: string, omzet: number, i: number, selesai?: string): LedgerEntry[] {
  const [mulai, mulaiTiktok, akhir] = SLOT[host];
  const id = `${host}-${date}`;
  const s = Math.round((omzet * 0.6) / 1000) * 1000;
  const t = omzet - s;
  const dilihat = Math.round(s / 1500);
  const tayangan = Math.round(t / 700);
  const shopee: Partial<Record<CumulativeField, number>> = {
    omzet: s, pesanan: Math.max(1, Math.round(s / 100_000)), penontonMasuk: dilihat, komentar: Math.round(dilihat / 5),
  };
  if (i % 7 !== 3) shopee.keranjang = Math.round(dilihat / 15);
  const tiktok: Partial<Record<CumulativeField, number>> = {
    omzet: t, pesanan: Math.max(1, Math.round(t / 80_000)), penontonMasuk: tayangan, pengikutBaru: i % 4,
  };
  if (i % 5 !== 2) tiktok.impresi = tayangan * 30;
  if (i % 6 !== 4) tiktok.komentar = Math.round(tayangan / 4);
  return [
    ent({ host, date, from: mulai, to: selesai ?? akhir, platform: "shopee", id, credit: shopee }),
    ent({ host, date, from: mulaiTiktok, to: selesai ?? akhir, platform: "tiktok", id, credit: tiktok }),
  ];
}

function siaran(host: Host, month: string, hariLive: number[], total: number, selesai: Record<number, string> = {}): LedgerEntry[] {
  const omzet = bagiTotal(total, hariLive.length, host.length);
  return hariLive.flatMap((d, i) => live(host, `${month}-${pad(d)}`, omzet[i]!, i + d, selesai[d]));
}

// Angka asli live Selasa 17 Nov (sama dengan tes rekap).
const nov17 = (): LedgerEntry[] => [
  ent({ host: "Brando", date: "2026-11-17", from: "09:00", to: "14:00", platform: "shopee", id: "a",
    credit: { omzet: 700_000, pesanan: 6, penontonMasuk: 500, keranjang: 30, komentar: 100 } }),
  ent({ host: "Brando", date: "2026-11-17", from: "09:00", to: "14:00", platform: "tiktok", id: "a",
    credit: { omzet: 300_000, pesanan: 3, penontonMasuk: 400, impresi: 12_000, komentar: 113, pengikutBaru: 2 } }),
  ent({ host: "Vanna", date: "2026-11-17", from: "14:00", to: "20:00", platform: "shopee", id: "b",
    credit: { omzet: 617_034, pesanan: 7, penontonMasuk: 452, keranjang: 32, komentar: 115 } }),
  ent({ host: "Vanna", date: "2026-11-17", from: "14:00", to: "20:00", platform: "tiktok", id: "b",
    credit: { omzet: 278_000, pesanan: 4, penontonMasuk: 370, impresi: 11_700, komentar: 100, pengikutBaru: 3 } }),
];

// Realisasi 1–20 Nov: Brando 11,2 jt, Vanna 14,1 jt, Linda 12,6 jt (mockup).
const ENTRIES: LedgerEntry[] = [
  ...siaran("Brando", "2026-10", hari(1, 31, [4, 11]), 12_400_000),
  ...siaran("Vanna", "2026-10", hari(1, 31, [7]), 13_100_000),
  ...siaran("Linda", "2026-10", hari(1, 31, [21]), 12_200_000),
  ent({ host: "Vanna", date: "2026-10-14", from: "21:50", to: "22:30", id: "x-okt", flags: ["belum_teratribusi"],
    credit: { omzet: 250_000, pesanan: 2, penontonMasuk: 180 } }),
  ...siaran("Brando", "2026-11", hari(1, 20, [8, 17]), 9_900_000),
  ...siaran("Vanna", "2026-11", hari(1, 20, [17, 18]), 12_854_966),
  // 18/11 gangguan (siaran pendek); 19/11 lewat tengah malam tetap tanggal 19.
  ...siaran("Linda", "2026-11", hari(1, 20, [12, 17]), 12_600_000, { 18: "20:20", 19: "2026-11-20T00:30" }),
  ...nov17(),
  // Atribusi pecahan 50/50 di jeda 21:50–22:50.
  ent({ host: "Brando", date: "2026-11-05", from: "21:50", to: "22:50", platform: "tiktok", id: "pecah", share: 0.5,
    credit: { omzet: 300_000, pesanan: 2 } }),
  ent({ host: "Vanna", date: "2026-11-05", from: "21:50", to: "22:50", platform: "tiktok", id: "pecah", share: 0.5,
    credit: { omzet: 300_000, pesanan: 2 } }),
  // Laporan tanpa durasi.
  ent({ host: "Vanna", date: "2026-11-10", from: "13:20", to: "13:20", platform: "tiktok", id: "nol", credit: { omzet: 50_000, pesanan: 1 } }),
  // Laporan tanpa omzet terbaca: menit on-air host tetap dihitung, peta jam dan indeks melewatinya.
  ent({ host: "Brando", date: "2026-10-15", from: "13:20", to: "14:00", platform: "tiktok", id: "tanpa-omzet",
    credit: { pesanan: 1, penontonMasuk: 30 } }),
  // Laporan pergantian terlewat → belum teratribusi.
  ent({ host: "Linda", date: "2026-11-18", from: "20:20", to: "21:10", id: "x-nov", flags: ["belum_teratribusi"],
    credit: { omzet: 450_000, pesanan: 4, penontonMasuk: 300, keranjang: 20 } }),
];

const INP_NOV: TargetInputs = {
  month: "2026-11", teamTarget: 60_000_000, hosts: HOSTS.map((name) => ({ name })), tanpaLive: [],
  izin: [{ host: "Linda", date: "2026-11-12" }], gangguan: [{ host: "Linda", date: "2026-11-18", menit: 90 }],
  jadwal: null, jamLive: 13,
};
const INP_OKT: TargetInputs = { ...INP_NOV, month: "2026-10", teamTarget: 54_000_000, izin: [], gangguan: [] };
const TGT_NOV = computeTargets(INP_NOV);
const TGT_OKT = computeTargets(INP_OKT);
const EXPECTED = new Map([...expectedOmzet(ENTRIES, "2026-10"), ...expectedOmzet(ENTRIES, "2026-11")]);
const ROWS = toKreditRows(ENTRIES, EXPECTED);
const TARGET_ROWS = [...targetHarianRows(TGT_OKT, INP_OKT), ...targetHarianRows(TGT_NOV, INP_NOV)];

// ---------- Buku kerja HyperFormula ----------

type Nilai = string | number | boolean | null;
interface Buku {
  hf: HyperFormula;
  get(tab: string, a1: string): Nilai;
  set(tab: string, a1: string, v: string | number | null): void;
  hariIni(date: string): void;
  filter(tab: Layout, preset: Preset, opsi?: { dari?: string; sampai?: string; pembanding?: string }): void;
}

function buatBuku(layouts: readonly Layout[]): Buku {
  const hf = HyperFormula.buildEmpty({ licenseKey: "gpl-v3" });
  const isi = (nama: string, data: Array<Array<string | number | null>>): void => {
    hf.addSheet(nama);
    hf.setSheetContent(hf.getSheetId(nama)!, data);
  };
  const alamat = (tab: string, a1: string) => {
    const a = hf.simpleCellAddressFromString(a1, hf.getSheetId(tab)!);
    if (!a) throw new Error(`alamat ${tab}!${a1}`);
    return a;
  };
  hf.suspendEvaluation();
  // Pengaturan: A1:A10 = daftar host, B1 = hari ini (produksi: =TODAY()).
  isi("Pengaturan", Array.from({ length: 10 }, (_, i) => [HOSTS[i] ?? null, i === 0 ? serialTanggal("2026-11-20") : null]));
  isi("Data Kredit", [KREDIT_COLUMNS.map((c) => c.header), ...ROWS.map(kreditCells)]);
  isi("Target Harian", [TARGET_HARIAN_COLUMNS.map((c) => c.header), ...TARGET_ROWS.map(targetHarianCells)]);
  hf.addNamedExpression("HARI_INI", "='Pengaturan'!$B$1");
  hf.addNamedExpression("DAFTAR_HOST", "='Pengaturan'!$A$1:$A$10");
  for (const tab of layouts) {
    hf.addSheet(tab);
    for (const [a1, f] of Object.entries(dashboardFormulas(tab))) hf.setCellContents(alamat(tab, a1), f);
  }
  hf.resumeEvaluation();
  let hariIniSekarang = "2026-11-20";
  const buku: Buku = {
    hf,
    get(tab, a1) {
      const v = hf.getCellValue(alamat(tab, a1));
      if (v instanceof DetailedCellError) throw new Error(`${tab}!${a1}: ${v.value} ${v.message}`);
      return v;
    },
    set(tab, a1, v) {
      hf.setCellContents(alamat(tab, a1), v);
    },
    hariIni(date) {
      if (date === hariIniSekarang) return; // hindari hitung ulang seluruh buku tanpa perubahan
      hariIniSekarang = date;
      buku.set("Pengaturan", "B1", serialTanggal(date));
    },
    filter(tab, preset, opsi = {}) {
      hf.batch(() => {
        buku.set(tab, "B2", preset);
        buku.set(tab, "D2", opsi.dari === undefined ? null : serialTanggal(opsi.dari));
        buku.set(tab, "F2", opsi.sampai === undefined ? null : serialTanggal(opsi.sampai));
        buku.set(tab, "H2", opsi.pembanding ?? PEMBANDING.bulan_lalu);
      });
    },
  };
  return buku;
}

// ---------- Pembanding TS ----------

const ringkas = (inp: TargetInputs, today: string): Record<string, HostSummary> => {
  const tgt = inp.month === "2026-10" ? TGT_OKT : TGT_NOV;
  return Object.fromEntries(summarizeHosts(ENTRIES, ENTRIES, tgt, inp, today, {}).map((r) => [r.host, r]));
};

function realisasiTS(host: string, dari: string, sampai: string): number {
  let total = 0;
  for (const month of new Set([dari.slice(0, 7), sampai.slice(0, 7)])) {
    for (const [d, v] of Object.entries(dailyByHost(ENTRIES, month)[host] ?? {})) if (d >= dari && d <= sampai) total += v;
  }
  return total;
}

const teratribusi = (e: LedgerEntry): boolean => !e.flags.includes("belum_teratribusi");
const dalam = (e: LedgerEntry, dari: string, sampai: string): boolean => e.date >= dari && e.date <= sampai;
// Rasio berpasangan: hanya entri yang punya kedua field.
function rasioEntri(es: LedgerEntry[], a: CumulativeField, b: CumulativeField): number | null {
  let atas = 0;
  let bawah = 0;
  for (const e of es) {
    const x = e.credit[a];
    const y = e.credit[b];
    if (x === undefined || y === undefined) continue;
    atas += x;
    bawah += y;
  }
  return bawah === 0 ? null : atas / bawah;
}
const omzetEntri = (es: LedgerEntry[]): number => es.reduce((s, e) => s + (e.credit.omzet ?? 0), 0);

function expectRp(actual: Nilai, expected: number, label: string): void {
  expect(actual, label).toBeTypeOf("number");
  expect(Math.abs((actual as number) - expected), `${label}: ${String(actual)} vs ${expected}`).toBeLessThanOrEqual(1);
}
function expectRasio(actual: Nilai, expected: number | null, label: string): void {
  if (expected === null) {
    expect(actual, label).toBe("");
    return;
  }
  expect(actual, label).toBeTypeOf("number");
  expect(Math.abs((actual as number) - expected), `${label}: ${String(actual)} vs ${expected}`).toBeLessThanOrEqual(0.0001);
}
const kolom = (n: number): string => (n < 26 ? String.fromCharCode(65 + n) : kolom(Math.floor(n / 26) - 1) + kolom(n % 26));

// ---------- Tes ----------

describe("kolom tabel fakta", { timeout: 60_000 }, () => {
  it("Data Kredit mengikuti KreditRow; tanggal ditulis sebagai serial tanggal; kosong tetap null", () => {
    expect(KREDIT_COLUMNS.map((c) => c.key)).toEqual(Object.keys(ROWS[0]!));
    const r = ROWS.find((x) => x.messageId === "nol")!;
    const sel = kreditCells(r);
    const di = (k: string): unknown => sel[KREDIT_COLUMNS.findIndex((c) => c.key === k)];
    expect(di("tanggal")).toBe(serialTanggal("2026-11-10"));
    expect(di("omzet")).toBe(50_000);
    expect(di("penontonMasuk")).toBeNull();
    expect(di("status")).toBe("dihitung");
    expect(sel).toHaveLength(KREDIT_COLUMNS.length);
  });

  it("Target Harian mengikuti baris targetHarianRows", () => {
    expect(TARGET_HARIAN_COLUMNS.map((c) => c.key)).toEqual(Object.keys(TARGET_ROWS[0]!));
    const gugur = TARGET_ROWS.find((x) => x.sebab === "izin")!;
    expect(targetHarianCells(gugur)).toEqual([serialTanggal("2026-11-12"), "Linda", gugur.target, gugur.gugur, "izin"]);
  });

  it("serial tanggal sama dengan Google Sheets / HyperFormula (hari 0 = 30-12-1899)", () => {
    expect(serialTanggal("2026-11-20")).toBe(46346);
    expect(serialTanggal("1900-03-01")).toBe(61);
    const hf = HyperFormula.buildFromArray([["=DATE(2026,11,20)", "=DATE(2028,2,29)"]], { licenseKey: "gpl-v3" });
    expect(hf.getSheetValues(0)[0]).toEqual([serialTanggal("2026-11-20"), serialTanggal("2028-02-29")]);
  });
});

describe("rumus hanya memakai fungsi yang diizinkan", { timeout: 60_000 }, () => {
  // TRIM ditambahkan untuk nama host DAFTAR_HOST (M4, final review); didukung Google Sheets dan HyperFormula.
  const BOLEH = new Set(["SUMIFS", "COUNTIFS", "IF", "IFERROR", "MIN", "MAX", "DATE", "EOMONTH", "WEEKDAY", "INDEX", "MATCH", "AND", "OR", "TRIM"]);

  it.each(LAYOUTS)("%s", (tab) => {
    const rumus = Object.entries(dashboardFormulas(tab));
    expect(rumus.length).toBeGreaterThan(0);
    for (const [a1, f] of rumus) {
      expect(f.startsWith("="), a1).toBe(true);
      const tanpaTeks = f.replace(/"[^"]*"/g, '""');
      for (const [, nama] of tanpaTeks.matchAll(/([A-Z][A-Z0-9_.]*)\(/g)) expect(BOLEH.has(nama!), `${tab}!${a1}: ${nama}`).toBe(true);
      // Tabel fakta selalu dirujuk dengan kolom penuh.
      for (const [ref] of tanpaTeks.matchAll(/'(Data Kredit|Target Harian)'!\S{0,12}/g)) {
        expect(ref, `${tab}!${a1}`).toMatch(/^'(Data Kredit|Target Harian)'!\$[A-Z]+:\$[A-Z]+/);
      }
    }
  });
});

describe("rentang efektif dan pembanding di J2:K3 = periodRange / comparisonRange", { timeout: 60_000 }, () => {
  let buku: Buku;
  beforeAll(() => {
    buku = buatBuku([]);
    buku.hf.addSheet("Dashboard Host");
    const filter = Object.entries(dashboardFormulas("Dashboard Host")).filter(([a1]) => /^[A-Z]+[23]$/.test(a1));
    for (const [a1, f] of filter) buku.set("Dashboard Host", a1, f);
  }, 60_000);
  const MODE: ModePembanding[] = ["sebelumnya", "bulan_lalu", "tanpa"];
  const sel = (a1: string): Nilai => buku.get("Dashboard Host", a1);
  const cocok = (r: { dari: string; sampai: string } | null, label: string): void => {
    const harap = r === null ? ["", "", "", ""] : [serialTanggal(r.dari), serialTanggal(r.sampai)];
    expect([sel("J3"), sel("K3")], label).toEqual(harap.slice(0, 2));
    expect([sel("H3"), sel("I3")], label).toEqual(harap.slice(0, 2));
  };

  it("semua preset × pembanding untuk 84 hari (akhir tahun, Februari kabisat, Senin/Minggu)", () => {
    const hariUji = ["2026-11-20", ...Array.from({ length: 83 }, (_, i) => addDays("2027-12-20", i))];
    for (const today of hariUji) {
      buku.hariIni(today);
      for (const preset of PRESETS.filter((p) => p !== "Custom")) {
        const r = periodRange(preset, today);
        for (const mode of MODE) {
          buku.filter("Dashboard Host", preset, { pembanding: PEMBANDING[mode] });
          const label = `${today} ${preset} ${mode}`;
          expect([sel("J2"), sel("K2"), sel("D3"), sel("F3"), sel("B3")], label)
            .toEqual([serialTanggal(r.dari), serialTanggal(r.sampai), serialTanggal(r.dari), serialTanggal(r.sampai), ""]);
          cocok(comparisonRange(r, mode), label);
        }
      }
    }
  });

  it("R25: Bulan lalu tanggal sama menggeser kedua ujung satu bulan (hari dijepit)", () => {
    const kasus: Array<[string, Preset, { dari: string; sampai: string } | undefined, string, string]> = [
      ["2026-11-20", "Hari ini", undefined, "2026-10-20", "2026-10-20"],
      ["2026-11-20", "Bulan ini", undefined, "2026-10-01", "2026-10-20"],
      ["2026-11-20", "Custom", { dari: "2026-11-05", sampai: "2026-11-15" }, "2026-10-05", "2026-10-15"],
      ["2026-11-20", "Bulan lalu", undefined, "2026-09-01", "2026-09-30"],
      ["2026-11-20", "Custom", { dari: "2026-03-31", sampai: "2026-03-31" }, "2026-02-28", "2026-02-28"],
    ];
    for (const [today, preset, custom, dari, sampai] of kasus) {
      buku.hariIni(today);
      buku.filter("Dashboard Host", preset, { ...custom, pembanding: PEMBANDING.bulan_lalu });
      const label = `${preset} ${custom?.dari ?? ""}`;
      expect(comparisonRange(periodRange(preset, today, custom), "bulan_lalu"), label).toEqual({ dari, sampai });
      expect([sel("J3"), sel("K3"), sel("H3"), sel("I3")], label)
        .toEqual([serialTanggal(dari), serialTanggal(sampai), serialTanggal(dari), serialTanggal(sampai)]);
    }
  });

  it("Custom: dikembalikan apa adanya; Dari > Sampai atau kosong → tidak valid", () => {
    buku.hariIni("2026-11-20");
    const pasangan: Array<[string, string]> = [
      ["2026-11-01", "2026-11-15"], ["2026-11-15", "2026-11-15"], ["2026-01-31", "2026-03-30"], ["2028-02-10", "2028-03-31"],
      ["2026-11-05", "2026-11-15"], ["2026-03-31", "2026-03-31"], ["2028-03-29", "2028-03-31"], ["2026-12-31", "2027-01-30"],
    ];
    for (const [dari, sampai] of pasangan) {
      for (const mode of MODE) {
        buku.filter("Dashboard Host", "Custom", { dari, sampai, pembanding: PEMBANDING[mode] });
        const r = periodRange("Custom", "2026-11-20", { dari, sampai });
        expect([sel("J2"), sel("K2"), sel("B3")]).toEqual([serialTanggal(r.dari), serialTanggal(r.sampai), ""]);
        cocok(comparisonRange(r, mode), `${dari}..${sampai} ${mode}`);
      }
    }
    buku.filter("Dashboard Host", "Custom", { dari: "2026-11-15", sampai: "2026-11-01" });
    expect(comparisonRange({ dari: "2026-11-15", sampai: "2026-11-01" }, "bulan_lalu")).toBeNull();
    expect([sel("J2"), sel("K2"), sel("J3"), sel("K3"), sel("D3"), sel("F3"), sel("B3")])
      .toEqual(["", "", "", "", "", "", "Tanggal tidak valid"]);
    buku.filter("Dashboard Host", "Custom", { dari: "2026-11-15" });
    expect([sel("J2"), sel("B3")]).toEqual(["", "Tanggal tidak valid"]);
  });
});

describe("dashboard dihitung dari Data Kredit dan Target Harian (fixture mockup)", { timeout: 60_000 }, () => {
  let buku: Buku;
  beforeAll(() => {
    buku = buatBuku(LAYOUTS);
  }, 60_000);
  const DH = "Dashboard Host";
  const BARIS: Record<Host, number> = { Brando: 8, Vanna: 9, Linda: 10 };

  describe("Dashboard Host", () => {
    it("Bulan ini (20/11): realisasi, target, seharusnya, pembanding Oktober 1–20 = summarizeHosts", () => {
      buku.hariIni("2026-11-20");
      buku.filter(DH, "Bulan ini", { pembanding: PEMBANDING.bulan_lalu });
      const g = (a1: string): Nilai => buku.get(DH, a1);
      expect([g("J2"), g("K2"), g("J3"), g("K3"), g("B3")])
        .toEqual([serialTanggal("2026-11-01"), serialTanggal("2026-11-20"), serialTanggal("2026-10-01"), serialTanggal("2026-10-20"), ""]);
      expectRp(g("C8"), 11_200_000, "realisasi Brando");
      expectRp(g("B8"), 20_000_000, "target Brando");
      expectRp(g("N8"), 13_333_333, "seharusnya Brando");

      const ts = ringkas(INP_NOV, "2026-11-20");
      for (const host of HOSTS) {
        const r = BARIS[host];
        const t = ts[host]!;
        expect(g(`A${r}`)).toBe(host);
        expectRp(g(`B${r}`), t.target, `${host} target`);
        expectRp(g(`C${r}`), t.realisasi, `${host} realisasi`);
        expectRasio(g(`D${r}`), t.pctTarget, `${host} %target`);
        expectRasio(g(`E${r}`), t.seharusnya / t.target, `${host} %seharusnya`);
        expectRp(g(`F${r}`), t.selisih, `${host} selisih`);
        expectRasio(g(`H${r}`), t.vsBulanLalu, `${host} vs Okt 1–20`);
        expectRasio(g(`I${r}`), t.menitOnAir / 60, `${host} jam on-air`);
        expectRp(g(`J${r}`), t.omzetPerJam!, `${host} omzet/jam`);
        expectRasio(g(`K${r}`), t.konversi, `${host} konversi`);
        expectRp(g(`N${r}`), t.seharusnya, `${host} seharusnya`);
        expectRp(g(`O${r}`), realisasiTS(host, "2026-10-01", "2026-10-20"), `${host} realisasi Okt 1–20`);
      }
      // Gugur izin/gangguan Linda mengurangi target pribadi, bukan target tim.
      expect(ts.Linda!.target).toBeLessThan(20_000_000);
      for (let r = 11; r <= 17; r++) for (const c of "ABCDEFHIJKNO") expect(g(`${c}${r}`), `${c}${r}`).toBe("");

      // Ringkasan tim.
      const realisasi = HOSTS.reduce((s, h) => s + ts[h]!.realisasi, 0);
      const nov = ENTRIES.filter((e) => teratribusi(e) && dalam(e, "2026-11-01", "2026-11-20"));
      expectRp(g("A5"), realisasi, "omzet live");
      expectRp(g("B5"), 60_000_000, "target tim");
      expectRp(g("C5"), 40_000_000, "seharusnya tim");
      expectRasio(g("D5"), realisasi / 60_000_000, "% tercapai");
      expectRasio(g("E5"), 40_000_000 / 60_000_000, "% seharusnya");
      expectRp(g("F5"), realisasi - 40_000_000, "selisih tim");
      const okt = HOSTS.reduce((s, h) => s + realisasiTS(h, "2026-10-01", "2026-10-20"), 0);
      expectRp(g("G5"), okt, "pembanding tim");
      expectRasio(g("H5"), realisasi / okt - 1, "vs pembanding tim");
      expectRp(g("I5"), omzetEntri(nov.filter((e) => e.platform === "tiktok")), "TikTok");
      expectRp(g("J5"), omzetEntri(nov.filter((e) => e.platform === "shopee")), "Shopee");
    });

    it("Custom 2026-11-01..2026-11-15: realisasi per host = penjumlahan TS rentang itu", () => {
      buku.hariIni("2026-11-20");
      buku.filter(DH, "Custom", { dari: "2026-11-01", sampai: "2026-11-15" });
      for (const host of HOSTS) {
        const r = BARIS[host];
        expectRp(buku.get(DH, `C${r}`), realisasiTS(host, "2026-11-01", "2026-11-15"), `${host} realisasi`);
        expectRp(buku.get(DH, `N${r}`), seharusnya(TGT_NOV[host]!, INP_NOV, host, "2026-11-15"), `${host} seharusnya`);
        expectRp(buku.get(DH, `B${r}`), TGT_NOV[host]!.bulan, `${host} target bulan`);
        expectRp(buku.get(DH, `O${r}`), realisasiTS(host, "2026-10-01", "2026-10-15"), `${host} pembanding`);
      }
    });

    it("rentang mencakup masa depan: seharusnya hanya sampai hari ini", () => {
      buku.hariIni("2026-11-20");
      buku.filter(DH, "Custom", { dari: "2026-11-16", sampai: "2026-11-30" });
      const harus = (h: Host): number => seharusnya(TGT_NOV[h]!, INP_NOV, h, "2026-11-20") - seharusnya(TGT_NOV[h]!, INP_NOV, h, "2026-11-15");
      for (const host of HOSTS) expectRp(buku.get(DH, `N${BARIS[host]}`), harus(host), host);
      buku.filter(DH, "Custom", { dari: "2026-11-25", sampai: "2026-11-30" });
      expectRp(buku.get(DH, "N8"), 0, "seluruhnya masa depan");
      // Hari izin Linda: gugur > jatah hari itu → seharusnya dijepit 0 (seperti summarizeHosts).
      buku.filter(DH, "Custom", { dari: "2026-11-12", sampai: "2026-11-12" });
      expect(seharusnya(TGT_NOV.Linda!, INP_NOV, "Linda", "2026-11-12") - seharusnya(TGT_NOV.Linda!, INP_NOV, "Linda", "2026-11-11"))
        .toBeLessThan(0);
      expectRp(buku.get(DH, "N10"), 0, "Linda hari izin");
    });

    it("Periode sebelumnya: Minggu lalu dibanding minggu sebelumnya", () => {
      buku.hariIni("2026-11-20");
      buku.filter(DH, "Minggu lalu", { pembanding: PEMBANDING.sebelumnya });
      expect([buku.get(DH, "H3"), buku.get(DH, "I3")]).toEqual([serialTanggal("2026-11-02"), serialTanggal("2026-11-08")]);
      for (const host of HOSTS) {
        const kini = realisasiTS(host, "2026-11-09", "2026-11-15");
        const lalu = realisasiTS(host, "2026-11-02", "2026-11-08");
        expectRp(buku.get(DH, `C${BARIS[host]}`), kini, host);
        expectRasio(buku.get(DH, `H${BARIS[host]}`), kini / lalu - 1, `${host} vs`);
      }
      buku.filter(DH, "Minggu lalu", { pembanding: PEMBANDING.tanpa });
      expect([buku.get(DH, "G5"), buku.get(DH, "H5"), buku.get(DH, "H8"), buku.get(DH, "O8")]).toEqual(["", "", "", ""]);
    });

    it("baris belum_teratribusi tidak masuk realisasi host mana pun, muncul di total belum teratribusi", () => {
      buku.hariIni("2026-11-20");
      for (const [preset, dari, sampai] of [["Bulan ini", "2026-11-01", "2026-11-20"], ["Bulan lalu", "2026-10-01", "2026-10-31"]] as const) {
        buku.filter(DH, preset);
        const belum = funnel(ENTRIES, { host: HOST_BELUM_TERATRIBUSI, from: dari, to: sampai });
        const totalBelum = (belum.shopee.omzet ?? 0) + (belum.tiktok.omzet ?? 0);
        expect(totalBelum).toBeGreaterThan(0);
        expectRp(buku.get(DH, "K5"), totalBelum, `${preset} belum teratribusi`);
        const semua = omzetEntri(ENTRIES.filter((e) => dalam(e, dari, sampai)));
        const host = HOSTS.reduce((s, h) => s + (buku.get(DH, `C${BARIS[h]}`) as number), 0);
        expectRp(host, semua - totalBelum, `${preset} Σ host`);
        expectRp(buku.get(DH, "A5"), semua - totalBelum, `${preset} omzet live`);
      }
    });
  });

  describe("Analisis Live", () => {
    const AL = "Analisis Live";
    const g = (a1: string): Nilai => buku.get(AL, a1);

    function cocokFunnel(dari: string, sampai: string): void {
      const f = funnel(ENTRIES, { from: dari, to: sampai });
      const shopee = [f.shopee.omzet, f.shopee.pesanan, f.shopee.dilihat, f.shopee.keranjang, f.shopee.komentar];
      shopee.forEach((v, i) => (v === null ? expect(g(`B${6 + i}`)).toBe("") : expectRp(g(`B${6 + i}`), v, `shopee ${i}`)));
      const rasioShopee = [f.shopee.atcRate, f.shopee.cartToOrder, f.shopee.konversi, f.shopee.aov, f.shopee.omzetPerJam, f.shopee.komentarPerDilihat];
      rasioShopee.forEach((v, i) => expectRasio(g(`B${11 + i}`), v, `shopee rasio ${i}`));
      const tiktok = [f.tiktok.omzet, f.tiktok.terjual, f.tiktok.tayangan, f.tiktok.impresi, f.tiktok.komentar, f.tiktok.pengikutBaru];
      tiktok.forEach((v, i) => (v === null ? expect(g(`E${6 + i}`)).toBe("") : expectRp(g(`E${6 + i}`), v, `tiktok ${i}`)));
      const rasioTiktok = [f.tiktok.tapIn, f.tiktok.konversi, f.tiktok.nilaiPerProduk, f.tiktok.komentarPerTayangan];
      rasioTiktok.forEach((v, i) => expectRasio(g(`E${12 + i}`), v, `tiktok rasio ${i}`));
    }

    it("corong Shopee pada Hari ini (today = 17 Nov): atcRate 0,065 dan semua angka = funnel TS", () => {
      buku.hariIni("2026-11-17");
      buku.filter(AL, "Hari ini");
      expect(g("B11")).toBeCloseTo(0.065, 3);
      expectRp(g("B6"), 1_317_034, "omzet Shopee");
      cocokFunnel("2026-11-17", "2026-11-17");
    });

    it("Bulan lalu (Oktober penuh): corong, per host, indeks slot, peta jam = TS", () => {
      buku.hariIni("2026-11-20");
      buku.filter(AL, "Bulan lalu");
      cocokFunnel("2026-10-01", "2026-10-31");
      const ts = ringkas(INP_OKT, "2026-10-31");
      const rows = ROWS.filter((r) => r.status === "dihitung" && r.tanggal.startsWith("2026-10"));
      HOSTS.forEach((host, i) => {
        const r = 20 + i;
        const es = ENTRIES.filter((e) => teratribusi(e) && e.host === host && dalam(e, "2026-10-01", "2026-10-31"));
        const milikRows = rows.filter((x) => x.host === host && x.komentar !== null);
        const komentarPerJam = milikRows.reduce((s, x) => s + x.komentar!, 0) / (milikRows.reduce((s, x) => s + x.menitOnAir, 0) / 60);
        expect(g(`A${r}`)).toBe(host);
        expectRp(g(`B${r}`), ts[host]!.omzetPerJam!, `${host} omzet/jam`);
        expectRp(g(`C${r}`), rasioEntri(es, "omzet", "pesanan")!, `${host} AOV`);
        expectRasio(g(`D${r}`), ts[host]!.konversi, `${host} konversi`);
        expectRasio(g(`E${r}`), rasioEntri(es, "keranjang", "penontonMasuk"), `${host} add-to-cart`);
        expectRasio(g(`F${r}`), komentarPerJam, `${host} komentar/jam`);
        const indeks = indeksSlot(ENTRIES, host, "2026-10");
        expect(indeks).not.toBeNull();
        expectRasio(g(`G${r}`), indeks, `${host} indeks`);
      });
      const h = heatmap(ENTRIES, "2026-10");
      (["Sen–Kam", "Jum–Min"] as const).forEach((kel, i) => {
        for (let jam = 0; jam < 24; jam++) {
          const v = h[kel][jam]!;
          const a1 = `${kolom(1 + jam)}${33 + i}`;
          if (v === null) expect(g(a1), a1).toBe("");
          else expectRp(g(a1), v, `${kel} ${jam}`);
        }
      });
    });

    it("indeks slot kosong kalau rentang < 21 hari live (Bulan ini = 20 hari) — sama dengan indeksSlot null", () => {
      buku.hariIni("2026-11-20");
      buku.filter(AL, "Bulan ini");
      for (const [i, host] of HOSTS.entries()) {
        expect(indeksSlot(ENTRIES, host, "2026-11")).toBeNull();
        expect(g(`G${20 + i}`)).toBe("");
      }
      expect(g("A23")).toBe("");
    });
  });

  describe("Harian per Host", () => {
    const HH = "Harian per Host";
    it("baris tanggal rentang terpilih, kolom host, isi = dailyByHost; kosong bila tidak ada data", () => {
      buku.hariIni("2026-11-20");
      buku.filter(HH, "Bulan ini");
      expect(["B4", "C4", "D4", "E4"].map((a1) => buku.get(HH, a1))).toEqual(["Brando", "Vanna", "Linda", ""]);
      const harian = dailyByHost(ENTRIES, "2026-11");
      for (let i = 0; i < 20; i++) {
        const d = `2026-11-${pad(i + 1)}`;
        expect(buku.get(HH, `A${5 + i}`)).toBe(serialTanggal(d));
        HOSTS.forEach((host, j) => {
          const a1 = `${kolom(1 + j)}${5 + i}`;
          const v = harian[host]?.[d];
          if (v === undefined) expect(buku.get(HH, a1), `${host} ${d}`).toBe("");
          else expectRp(buku.get(HH, a1), v, `${host} ${d}`);
        });
        expect(buku.get(HH, `E${5 + i}`)).toBe("");
      }
      expect(buku.get(HH, "A25")).toBe("");
      expect(buku.get(HH, "B25")).toBe("");
      expect(buku.get(HH, "B3")).toBe("");
    });

    it("rentang lebih dari 92 hari: hanya 92 hari pertama, dengan catatan", () => {
      buku.filter(HH, "Custom", { dari: "2026-08-01", sampai: "2026-11-20" });
      expect(buku.get(HH, "B3")).toBe("Hanya 92 hari pertama ditampilkan");
      expect(buku.get(HH, "A96")).toBe(serialTanggal(addDays("2026-08-01", 91)));
      expectRp(buku.get(HH, "B66"), dailyByHost(ENTRIES, "2026-10").Brando!["2026-10-01"]!, "Brando 1 Okt");
    });
  });

  it("Tren Bulanan: baris Oktober dan November = penjumlahan TS per bulan; 24 bulan terakhir", () => {
    const TB = "Tren Bulanan";
    buku.hariIni("2026-11-20");
    const g = (a1: string): Nilai => buku.get(TB, a1);
    expect(g("A6")).toBe(serialTanggal("2026-11-01"));
    expect(g("A7")).toBe(serialTanggal("2026-10-01"));
    expect(g("A29")).toBe(serialTanggal("2024-12-01"));
    expect(["G4", "L4", "Q4", "V4"].map(g)).toEqual(["Brando", "Vanna", "Linda", ""]);
    for (const [r, inp, today, tim] of [[6, INP_NOV, "2026-11-20", 60_000_000], [7, INP_OKT, "2026-10-31", 54_000_000]] as const) {
      const ts = ringkas(inp, today);
      const es = ENTRIES.filter((e) => teratribusi(e) && e.date.startsWith(inp.month));
      const realisasi = HOSTS.reduce((s, h) => s + ts[h]!.realisasi, 0);
      const menit = HOSTS.reduce((s, h) => s + ts[h]!.menitOnAir, 0);
      expectRp(g(`B${r}`), realisasi, `${inp.month} tim realisasi`);
      expectRp(g(`C${r}`), tim, `${inp.month} tim target`);
      expectRasio(g(`D${r}`), realisasi / tim, `${inp.month} tim %`);
      expectRp(g(`E${r}`), realisasi / (menit / 60), `${inp.month} tim omzet/jam`);
      expectRasio(g(`F${r}`), rasioEntri(es, "pesanan", "penontonMasuk"), `${inp.month} tim konversi`);
      HOSTS.forEach((host, i) => {
        const c = 6 + 5 * i;
        const t = ts[host]!;
        const label = `${inp.month} ${host}`;
        expectRp(g(`${kolom(c)}${r}`), t.realisasi, `${label} realisasi`);
        expectRp(g(`${kolom(c + 1)}${r}`), t.target, `${label} target`);
        expectRasio(g(`${kolom(c + 2)}${r}`), t.pctTarget, `${label} %`);
        expectRp(g(`${kolom(c + 3)}${r}`), t.omzetPerJam!, `${label} omzet/jam`);
        expectRasio(g(`${kolom(c + 4)}${r}`), t.konversi, `${label} konversi`);
      });
      for (let c = 21; c < 56; c++) expect(g(`${kolom(c)}${r}`), `${kolom(c)}${r}`).toBe("");
    }
    for (let c = 1; c < 56; c++) expect(g(`${kolom(c)}8`), `${kolom(c)}8 (September kosong)`).toBe("");
  });

  it("Kontrol: realisasi, target dan seharusnya bulan ini per host = summarizeHosts", () => {
    for (const today of ["2026-11-20", "2026-11-15"]) {
      buku.hariIni(today);
      const ts = ringkas(INP_NOV, today);
      HOSTS.forEach((host, i) => {
        const r = 2 + i;
        expect(buku.get("Kontrol", `A${r}`)).toBe(host);
        expectRp(buku.get("Kontrol", `B${r}`), ts[host]!.realisasi, `${today} ${host} realisasi`);
        expectRp(buku.get("Kontrol", `C${r}`), ts[host]!.target, `${today} ${host} target`);
        expectRp(buku.get("Kontrol", `D${r}`), ts[host]!.seharusnya, `${today} ${host} seharusnya`);
      });
      expect([buku.get("Kontrol", "A5"), buku.get("Kontrol", "B5")]).toEqual(["", ""]);
    }
  });

  it("Custom Dari > Sampai: status 'Tanggal tidak valid' dan semua angka kosong di setiap tab berfilter", () => {
    buku.hariIni("2026-11-20");
    for (const tab of ["Dashboard Host", "Harian per Host", "Analisis Live"] as const) {
      buku.filter(tab, "Custom", { dari: "2026-11-15", sampai: "2026-11-01" });
      expect(buku.get(tab, "B3")).toBe("Tanggal tidak valid");
      let diperiksa = 0;
      for (const [a1, f] of Object.entries(dashboardFormulas(tab))) {
        if (a1 === "B3" || f.includes("DAFTAR_HOST")) continue;
        expect(buku.get(tab, a1), `${tab}!${a1}`).toBe("");
        diperiksa++;
      }
      expect(diperiksa).toBeGreaterThan(20);
    }
  });
});

describe("M4: nama host di DAFTAR_HOST dengan spasi berlebih tetap cocok", { timeout: 60_000 }, () => {
  it("'  Brando ' di Pengaturan → nama dan realisasi Kontrol sama dengan 'Brando'", () => {
    const buku = buatBuku(["Kontrol"]);
    const sebelum = buku.get("Kontrol", "B2");
    expect(sebelum).toBeTypeOf("number");
    expect(sebelum as number).toBeGreaterThan(0);
    buku.set("Pengaturan", "A1", "  Brando ");
    expect(buku.get("Kontrol", "A2")).toBe("Brando");
    expect(buku.get("Kontrol", "B2")).toBe(sebelum);
  });
});
