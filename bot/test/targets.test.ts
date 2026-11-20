import { describe, it, expect } from "vitest";
import { computeTargets, seharusnya, butuhPerHariKerja, targetHarianRows, onAirHours, type TargetInputs } from "../src/domain/targets.js";

const base = (over: Partial<TargetInputs> = {}): TargetInputs => ({
  month: "2026-11", teamTarget: 60_000_000,
  hosts: [{ name: "Brando" }, { name: "Vanna" }, { name: "Linda" }],
  tanpaLive: [], izin: [], gangguan: [], jadwal: null, jamLive: 13, ...over,
});

describe("targets tanpa jadwal", () => {
  it("awal, perHariKerja, seharusnya", () => {
    const inp = base(); const t = computeTargets(inp);
    expect(t.Brando!.awal).toBe(20_000_000);
    expect(t.Brando!.perHariKerja).toBeCloseTo(777_777.78, 1);
    expect(seharusnya(t.Brando!, inp, "Brando", "2026-11-20")).toBeCloseTo(13_333_333.33, 1);
  });
  it("izin menggugurkan satu hari kerja", () => {
    const inp = base({ izin: [{ host: "Brando", date: "2026-11-18" }] });
    const t = computeTargets(inp).Brando!;
    expect(t.gugur).toHaveLength(1);
    expect(t.gugur[0]!.jumlah).toBeCloseTo(777_777.78, 1);
    expect(t.bulan).toBeCloseTo(19_222_222.22, 1);
    expect(seharusnya(t, inp, "Brando", "2026-11-20")).toBeCloseTo(13_333_333.33 - 777_777.78, 1);
  });
  it("gangguan 120 menit", () => {
    const t = computeTargets(base({ gangguan: [{ host: "Vanna", date: "2026-11-20", menit: 120 }] })).Vanna!;
    expect(t.gugur[0]!.jumlah).toBeCloseTo(307_692.31, 1);
    expect(t.gugur[0]!.sebab).toBe("gangguan");
  });
  it("tanpaLive mengurangi hari", () => {
    const inp = base({ tanpaLive: ["2026-11-25"] });
    const t = computeTargets(inp).Brando!;
    expect(t.perHariKerja).toBeCloseTo(20_000_000 / (29 * 6 / 7), 4);
    expect(seharusnya(t, inp, "Brando", "2026-11-30")).toBeCloseTo(20_000_000, 4);
  });
  it("Linda aktif mulai 16/11", () => {
    const t = computeTargets(base({ hosts: [{ name: "Brando" }, { name: "Vanna" }, { name: "Linda", aktifMulai: "2026-11-16" }] }));
    expect(t.Brando!.awal).toBeCloseTo(24_000_000, 4);
    expect(t.Vanna!.awal).toBeCloseTo(24_000_000, 4);
    expect(t.Linda!.awal).toBeCloseTo(12_000_000, 4);
  });
  it("izin di luar hari aktif tidak menggugurkan; total gugur dibatasi", () => {
    const inp = base({ hosts: [{ name: "Brando" }, { name: "Linda", aktifMulai: "2026-11-16" }], izin: [{ host: "Linda", date: "2026-11-05" }] });
    expect(computeTargets(inp).Linda!.gugur).toHaveLength(0);
    const all = base({ izin: Array.from({ length: 30 }, (_, i) => ({ host: "Brando", date: `2026-11-${String(i + 1).padStart(2, "0")}` })) });
    expect(computeTargets(all).Brando!.bulan).toBeGreaterThanOrEqual(0);
  });
  it("butuhPerHariKerja", () => {
    const inp = base(); const t = computeTargets(inp).Brando!;
    // 10 hari tersisa (21..30) * 6/7
    expect(butuhPerHariKerja(t, 5_000_000, inp, "Brando", "2026-11-20")).toBeCloseTo(15_000_000 / (10 * 6 / 7), 4);
    expect(butuhPerHariKerja(t, 99_000_000, inp, "Brando", "2026-11-20")).toBe(0);
    expect(butuhPerHariKerja(t, 5_000_000, inp, "Brando", "2026-11-30")).toBe(15_000_000);
  });
});

describe("targets dengan jadwal", () => {
  const jadwal = [
    { date: "2026-11-17", host: "Brando", mulai: "06:00", selesai: "13:00" },
    { date: "2026-11-17", host: "Vanna", mulai: "13:00", selesai: "20:00" },
    { date: "2026-11-18", host: "Brando", mulai: "06:00", selesai: "13:00" },
  ];
  it("jam on-air", () => {
    const inp = base({ jamLive: 11, jadwal });
    expect(onAirHours(inp, "Brando", "2026-11-17")).toBe(5.5);
    expect(onAirHours(inp, "Brando", "2026-11-18")).toBe(11);
    expect(onAirHours(inp, "Vanna", "2026-11-18")).toBe(0);
  });
  it("izin dan seharusnya memakai proporsi jam", () => {
    const inp = base({ jamLive: 11, jadwal, izin: [{ host: "Brando", date: "2026-11-17" }, { host: "Brando", date: "2026-11-20" }] });
    const t = computeTargets(inp).Brando!;
    const awal = t.awal; const J = 16.5;
    expect(t.gugur).toHaveLength(1);
    expect(t.gugur[0]!.jumlah).toBeCloseTo(awal * 5.5 / J, 4);
    expect(t.perHariKerja).toBeCloseTo(awal / 2, 4);
    expect(seharusnya(t, inp, "Brando", "2026-11-17")).toBeCloseTo(awal * 5.5 / J - awal * 5.5 / J, 4);
    expect(butuhPerHariKerja(t, 0, inp, "Brando", "2026-11-17")).toBeCloseTo(t.bulan, 4);
  });
});

describe("targetHarianRows", () => {
  it("invarian tanpa jadwal", () => {
    const inp = base({ izin: [{ host: "Brando", date: "2026-11-18" }], gangguan: [{ host: "Brando", date: "2026-11-18", menit: 60 }, { host: "Vanna", date: "2026-11-20", menit: 120 }] });
    const t = computeTargets(inp); const rows = targetHarianRows(t, inp);
    for (const h of ["Brando", "Vanna", "Linda"]) {
      const r = rows.filter((x) => x.host === h);
      expect(r.reduce((s, x) => s + x.target, 0)).toBeCloseTo(t[h]!.awal, 4);
      expect(r.reduce((s, x) => s + x.gugur, 0)).toBeCloseTo(t[h]!.awal - t[h]!.bulan, 4);
      for (let d = 1; d <= 30; d++) {
        const date = `2026-11-${String(d).padStart(2, "0")}`;
        const cum = r.filter((x) => x.tanggal <= date).reduce((s, x) => s + x.target - x.gugur, 0);
        expect(cum).toBeCloseTo(seharusnya(t[h]!, inp, h, date), 4);
      }
    }
    expect(rows.filter((x) => x.host === "Brando" && x.tanggal === "2026-11-18")).toHaveLength(2);
  });
  it("invarian dengan jadwal", () => {
    const jadwal = [
      { date: "2026-11-17", host: "Brando", mulai: "06:00", selesai: "13:00" },
      { date: "2026-11-17", host: "Vanna", mulai: "13:00", selesai: "20:00" },
      { date: "2026-11-18", host: "Brando", mulai: "06:00", selesai: "13:00" },
    ];
    const inp = base({ jamLive: 11, jadwal, izin: [{ host: "Brando", date: "2026-11-18" }] });
    const t = computeTargets(inp); const rows = targetHarianRows(t, inp);
    const r = rows.filter((x) => x.host === "Brando");
    expect(r.reduce((s, x) => s + x.target, 0)).toBeCloseTo(t.Brando!.awal, 4);
    for (const date of ["2026-11-17", "2026-11-18", "2026-11-25"]) {
      const cum = r.filter((x) => x.tanggal <= date).reduce((s, x) => s + x.target - x.gugur, 0);
      expect(cum).toBeCloseTo(seharusnya(t.Brando!, inp, "Brando", date), 4);
    }
  });
});
