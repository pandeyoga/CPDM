import { describe, expect, it } from "vitest";
import { comparisonRange, periodRange, PEMBANDING, PRESETS } from "../src/domain/period.js";

const T = "2026-11-20"; // Jumat
const r = (dari: string, sampai: string) => ({ dari, sampai });

describe("periodRange (today = Jumat 20 Nov 2026)", () => {
  it("preset sesuai brief", () => {
    expect(periodRange("Hari ini", T)).toEqual(r("2026-11-20", "2026-11-20"));
    expect(periodRange("7 hari terakhir", T)).toEqual(r("2026-11-14", "2026-11-20"));
    expect(periodRange("Minggu ini", T)).toEqual(r("2026-11-16", "2026-11-20"));
    expect(periodRange("Minggu lalu", T)).toEqual(r("2026-11-09", "2026-11-15"));
    expect(periodRange("Bulan lalu", T)).toEqual(r("2026-10-01", "2026-10-31"));
    expect(periodRange("Custom", T, r("2026-11-01", "2026-11-15"))).toEqual(r("2026-11-01", "2026-11-15"));
  });

  it("preset lain", () => {
    expect(periodRange("Kemarin", T)).toEqual(r("2026-11-19", "2026-11-19"));
    expect(periodRange("30 hari terakhir", T)).toEqual(r("2026-10-22", "2026-11-20"));
    expect(periodRange("Bulan ini", T)).toEqual(r("2026-11-01", "2026-11-20"));
  });

  it("minggu dimulai Senin: hari Senin dan Minggu", () => {
    expect(periodRange("Minggu ini", "2026-11-16")).toEqual(r("2026-11-16", "2026-11-16"));
    expect(periodRange("Minggu ini", "2026-11-22")).toEqual(r("2026-11-16", "2026-11-22"));
    expect(periodRange("Minggu lalu", "2026-11-22")).toEqual(r("2026-11-09", "2026-11-15"));
    expect(periodRange("Minggu lalu", "2026-11-23")).toEqual(r("2026-11-16", "2026-11-22"));
  });

  it("lewat batas bulan dan tahun", () => {
    expect(periodRange("Bulan lalu", "2027-01-05")).toEqual(r("2026-12-01", "2026-12-31"));
    expect(periodRange("Bulan lalu", "2028-03-31")).toEqual(r("2028-02-01", "2028-02-29"));
    expect(periodRange("Kemarin", "2027-01-01")).toEqual(r("2026-12-31", "2026-12-31"));
    expect(periodRange("Minggu lalu", "2027-01-03")).toEqual(r("2026-12-21", "2026-12-27"));
  });

  it("Custom tanpa tanggal ditolak; Custom terbalik dikembalikan apa adanya", () => {
    expect(() => periodRange("Custom", T)).toThrow();
    expect(periodRange("Custom", T, r("2026-11-15", "2026-11-01"))).toEqual(r("2026-11-15", "2026-11-01"));
  });

  it("daftar pilihan", () => {
    expect(PRESETS).toEqual([
      "Hari ini", "Kemarin", "7 hari terakhir", "30 hari terakhir", "Minggu ini", "Minggu lalu", "Bulan ini", "Bulan lalu", "Custom",
    ]);
    expect(PEMBANDING).toEqual({
      sebelumnya: "Periode sebelumnya", bulan_lalu: "Bulan lalu tanggal sama", tanpa: "Tanpa pembanding",
    });
  });
});

describe("comparisonRange", () => {
  it("sesuai brief", () => {
    expect(comparisonRange(periodRange("Bulan ini", T), "bulan_lalu")).toEqual(r("2026-10-01", "2026-10-20"));
    expect(comparisonRange(periodRange("7 hari terakhir", T), "sebelumnya")).toEqual(r("2026-11-07", "2026-11-13"));
  });

  it("periode sebelumnya: jumlah hari sama, berakhir sehari sebelum dari", () => {
    expect(comparisonRange(r("2026-11-20", "2026-11-20"), "sebelumnya")).toEqual(r("2026-11-19", "2026-11-19"));
    expect(comparisonRange(r("2026-11-01", "2026-11-20"), "sebelumnya")).toEqual(r("2026-10-12", "2026-10-31"));
    expect(comparisonRange(r("2026-03-01", "2026-03-31"), "sebelumnya")).toEqual(r("2026-01-29", "2026-02-28"));
  });

  it("bulan lalu tanggal sama (R25): kedua ujung mundur satu bulan, hari dijepit ke panjang bulan itu", () => {
    expect(comparisonRange(periodRange("Hari ini", T), "bulan_lalu")).toEqual(r("2026-10-20", "2026-10-20"));
    expect(comparisonRange(periodRange("Bulan ini", T), "bulan_lalu")).toEqual(r("2026-10-01", "2026-10-20"));
    expect(comparisonRange(r("2026-11-05", "2026-11-15"), "bulan_lalu")).toEqual(r("2026-10-05", "2026-10-15"));
    expect(comparisonRange(periodRange("Bulan lalu", T), "bulan_lalu")).toEqual(r("2026-09-01", "2026-09-30"));
    expect(comparisonRange(r("2026-03-31", "2026-03-31"), "bulan_lalu")).toEqual(r("2026-02-28", "2026-02-28"));
    expect(comparisonRange(r("2026-11-14", "2026-11-20"), "bulan_lalu")).toEqual(r("2026-10-14", "2026-10-20"));
    expect(comparisonRange(r("2026-03-01", "2026-03-30"), "bulan_lalu")).toEqual(r("2026-02-01", "2026-02-28"));
    expect(comparisonRange(r("2028-03-29", "2028-03-31"), "bulan_lalu")).toEqual(r("2028-02-29", "2028-02-29"));
    expect(comparisonRange(r("2027-01-10", "2027-01-15"), "bulan_lalu")).toEqual(r("2026-12-10", "2026-12-15"));
    expect(comparisonRange(r("2026-10-22", "2026-11-20"), "bulan_lalu")).toEqual(r("2026-09-22", "2026-10-20"));
  });

  it("tanpa pembanding dan rentang tidak valid → null", () => {
    expect(comparisonRange(r("2026-11-01", "2026-11-20"), "tanpa")).toBeNull();
    expect(comparisonRange(r("2026-11-15", "2026-11-01"), "sebelumnya")).toBeNull();
    expect(comparisonRange(r("2026-11-15", "2026-11-01"), "bulan_lalu")).toBeNull();
  });
});
