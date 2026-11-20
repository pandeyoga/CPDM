import { describe, expect, it } from "vitest";
import { applyCorrections, buildLedger } from "../src/domain/ledger.js";
import type { Platform, PlatformReading, Report } from "../src/domain/types.js";

// Waktu Asia/Jakarta, mis. "2026-11-20T10:00".
const J = (dt: string): Date => new Date(`${dt}:00+07:00`);

let seq = 0;
interface RepInput {
  host: string;
  at: string;
  omzet: number | null;
  platform?: Platform;
  rounded?: boolean;
  isMati?: boolean;
  screen?: "berjalan" | "akhir";
  effectiveAt?: string;
  id?: string;
  extra?: Partial<PlatformReading>;
}
function rep(p: RepInput): Report {
  const reading: PlatformReading = {
    platform: p.platform ?? "tiktok",
    screen: p.screen ?? "berjalan",
    omzet: p.omzet === null ? null : { value: p.omzet, rounded: p.rounded ?? false },
    pesanan: null, penontonMasuk: null, komentar: null, keranjang: null,
    impresi: null, pengikutBaru: null, penontonAktif: null, rataNontonDetik: null, durasiDetik: null,
    ...p.extra,
  };
  const r: Report = { messageId: p.id ?? `m${++seq}`, receivedAt: J(p.at), host: p.host, isMati: p.isMati ?? false, reading };
  if (p.effectiveAt) r.effectiveAt = J(p.effectiveAt);
  return r;
}
const opts = { maxGapMenit: 240, liveMulai: "09:00" };
const omzet = (es: ReturnType<typeof buildLedger>) => es.map((e) => e.credit.omzet);

describe("buildLedger — contoh rancangan 6.1a", () => {
  const reports = [
    rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000 }),
    rep({ host: "Brando", at: "2026-11-20T11:10", omzet: 420000, isMati: true, screen: "akhir" }),
    rep({ host: "Brando", at: "2026-11-20T12:00", omzet: 150000 }),
    rep({ host: "Vanna", at: "2026-11-20T13:20", omzet: 500000 }),
  ];

  it("kredit omzet dan host", () => {
    const es = buildLedger(reports, opts);
    expect(omzet(es)).toEqual([300000, 120000, 150000, 350000]);
    expect(es.map((e) => e.host)).toEqual(["Brando", "Brando", "Brando", "Vanna"]);
    expect(es[2]?.flags).toContain("siaran_baru");
  });

  it("siaran, tanggal, intervalStart, dan flag layar akhir", () => {
    const es = buildLedger(reports, opts);
    expect(es.map((e) => e.segment)).toEqual([1, 1, 2, 2]);
    expect(es.map((e) => e.date)).toEqual(["2026-11-20", "2026-11-20", "2026-11-20", "2026-11-20"]);
    expect(es.map((e) => e.intervalStart.getTime())).toEqual(
      [J("2026-11-20T09:00"), J("2026-11-20T10:00"), J("2026-11-20T11:10"), J("2026-11-20T12:00")].map((d) => d.getTime()),
    );
    expect(es.map((e) => e.flags)).toEqual([[], ["layar_akhir"], ["siaran_baru"], []]);
  });
});

describe("buildLedger — siaran dan reset", () => {
  it("reset tanpa layar akhir: kredit penuh, flag siaran_belum_lengkap", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000 }),
      rep({ host: "Vanna", at: "2026-11-20T11:30", omzet: 150000 }),
    ], opts);
    expect(omzet(es)).toEqual([300000, 150000]);
    expect(es[1]?.flags).toEqual(["siaran_baru", "siaran_belum_lengkap"]);
    expect(es[1]?.segment).toBe(2);
    expect(es[1]?.intervalStart).toEqual(J("2026-11-20T10:00"));
  });

  it("layar akhir tanpa caption mati tetap menutup siaran", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000, screen: "akhir" }),
      rep({ host: "Brando", at: "2026-11-20T10:30", omzet: 350000 }),
    ], opts);
    expect(omzet(es)).toEqual([300000, 350000]);
    expect(es[1]?.flags).toEqual(["siaran_baru"]);
  });

  it("caption mati tanpa layar akhir tetap menutup siaran", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000, isMati: true }),
      rep({ host: "Brando", at: "2026-11-20T10:30", omzet: 50000 }),
    ], opts);
    expect(omzet(es)).toEqual([300000, 50000]);
    expect(es[0]?.flags).toEqual(["layar_akhir"]);
    expect(es[1]?.flags).toEqual(["siaran_baru"]);
  });

  it("bacaan identik dua kali: kredit kedua 0", () => {
    const extra = { pesanan: { value: 5, rounded: false }, durasiDetik: 3600 };
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000, extra }),
      rep({ host: "Brando", at: "2026-11-20T10:05", omzet: 300000, extra }),
    ], opts);
    expect(es[1]?.credit).toEqual({ omzet: 0, pesanan: 0, durasiDetik: 0 });
    expect(es[1]?.flags).toEqual([]);
    expect(es[1]?.segment).toBe(1);
  });

  it("platform independen", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 1000000, platform: "tiktok" }),
      rep({ host: "Brando", at: "2026-11-20T10:01", omzet: 200000, platform: "shopee" }),
      rep({ host: "Vanna", at: "2026-11-20T11:00", omzet: 1200000, platform: "tiktok" }),
      rep({ host: "Vanna", at: "2026-11-20T11:01", omzet: 900000, platform: "shopee" }),
    ], opts);
    expect(es.map((e) => [e.platform, e.credit.omzet, e.flags])).toEqual([
      ["tiktok", 1000000, []],
      ["shopee", 200000, []],
      ["tiktok", 200000, []],
      ["shopee", 700000, []],
    ]);
    expect(es[2]?.intervalStart).toEqual(J("2026-11-20T10:00"));
    expect(es[3]?.intervalStart).toEqual(J("2026-11-20T10:01"));
  });

  it("lewat tengah malam: tanggal = tanggal mulai siaran", () => {
    const es = buildLedger([
      rep({ host: "Linda", at: "2026-11-30T21:00", omzet: 200000 }),
      rep({ host: "Linda", at: "2026-12-01T00:10", omzet: 450000 }),
    ], opts);
    expect(es[1]?.date).toBe("2026-11-30");
    expect(es[1]?.credit.omzet).toBe(250000);
    expect(es[1]?.segment).toBe(1);
    expect(es[1]?.flags).toEqual([]);
  });

  it("reset lewat tengah malam: siaran pertama hari itu sebelum liveMulai → intervalStart = laporan itu", () => {
    const es = buildLedger([
      rep({ host: "Linda", at: "2026-11-30T21:00", omzet: 200000 }),
      rep({ host: "Linda", at: "2026-12-01T00:30", omzet: 450000, isMati: true, screen: "akhir" }),
      rep({ host: "Linda", at: "2026-12-01T01:00", omzet: 80000 }),
    ], opts);
    expect(es[2]?.date).toBe("2026-12-01");
    expect(es[2]?.segment).toBe(1);
    expect(es[2]?.intervalStart).toEqual(J("2026-12-01T01:00"));
    expect(es[2]?.flags).toEqual(["siaran_baru"]);
  });

  it("mulai lebih awal dari liveMulai: intervalStart tidak pernah laporan hari sebelumnya", () => {
    const kemarin = rep({ host: "Brando", at: "2026-11-20T21:00", omzet: 900000, isMati: true, screen: "akhir" });
    const pagi = rep({ host: "Vanna", at: "2026-11-21T08:00", omzet: 100000 });
    const denganKemarin = buildLedger([kemarin, pagi], opts)[1];
    const hariItu = buildLedger([pagi], opts)[0];
    expect(denganKemarin?.intervalStart).toEqual(J("2026-11-21T08:00"));
    expect(denganKemarin?.flags).toEqual(["siaran_baru"]);
    expect(hariItu?.intervalStart).toEqual(J("2026-11-21T08:00"));
    expect(hariItu?.flags).toEqual([]);
  });

  it("laporan pertama hari berikutnya: intervalStart = liveMulai, nomor siaran mulai dari 1", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T21:00", omzet: 900000, isMati: true, screen: "akhir" }),
      rep({ host: "Vanna", at: "2026-11-21T10:30", omzet: 300000 }),
    ], { maxGapMenit: 240, liveMulai: "09:00" });
    expect(es[1]?.date).toBe("2026-11-21");
    expect(es[1]?.segment).toBe(1);
    expect(es[1]?.intervalStart).toEqual(J("2026-11-21T09:00"));
    expect(es[1]?.flags).toEqual(["siaran_baru"]);
  });

  it("penontonAktif dan rataNontonDetik tidak pernah dikreditkan", () => {
    const shopee = (at: string, k: number) => rep({
      host: "Brando", at, omzet: 100000 * k, platform: "shopee",
      extra: {
        pesanan: { value: 2 * k, rounded: false }, penontonMasuk: { value: 100 * k, rounded: false },
        komentar: { value: 10 * k, rounded: false }, keranjang: { value: 5 * k, rounded: false },
        penontonAktif: { value: 40 + k, rounded: false }, rataNontonDetik: 30 + k, durasiDetik: 1800 * k,
      },
    });
    const es = buildLedger([shopee("2026-11-20T10:00", 1), shopee("2026-11-20T11:00", 3)], opts);
    for (const e of es) {
      expect(Object.keys(e.credit)).not.toContain("penontonAktif");
      expect(Object.keys(e.credit)).not.toContain("rataNontonDetik");
    }
    expect(es[1]?.credit).toEqual({
      omzet: 200000, pesanan: 4, penontonMasuk: 200, komentar: 20, keranjang: 10, durasiDetik: 3600,
    });
  });

  it("field null di salah satu sisi tidak diberi kredit", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000, extra: { pesanan: null, komentar: { value: 9, rounded: false } } }),
      rep({ host: "Brando", at: "2026-11-20T11:00", omzet: 400000, extra: { pesanan: { value: 4, rounded: false }, komentar: null } }),
    ], opts);
    expect(es[0]?.credit).toEqual({ omzet: 300000, komentar: 9 });
    expect(es[1]?.credit).toEqual({ omzet: 100000 });
  });

  it("selisih negatif field lain dalam satu siaran dijepit ke 0", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000, extra: { komentar: { value: 50, rounded: false } } }),
      rep({ host: "Brando", at: "2026-11-20T11:00", omzet: 400000, extra: { komentar: { value: 45, rounded: false } } }),
    ], opts);
    expect(es[1]?.credit).toEqual({ omzet: 100000, komentar: 0 });
    expect(es[1]?.flags).toEqual([]);
  });

  it("selisih dihitung dari angka tertinggi sejauh ini di siaran (R12)", () => {
    const p = (value: number) => ({ pesanan: { value, rounded: false } });
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 1250000, rounded: true, extra: p(10) }),
      rep({ host: "Brando", at: "2026-11-20T11:00", omzet: 1200000, rounded: true, extra: p(8) }),
      rep({ host: "Vanna", at: "2026-11-20T12:00", omzet: 1300000, rounded: true, extra: p(12) }),
    ], opts);
    expect(es.map((e) => e.credit)).toEqual([
      { omzet: 1250000, pesanan: 10 },
      { omzet: 0, pesanan: 0 },
      { omzet: 50000, pesanan: 2 },
    ]);
    expect(es.map((e) => e.segment)).toEqual([1, 1, 1]);
  });

  it("angka tertinggi tetap dipakai walau laporan sebelumnya null", () => {
    const k = (value: number | null) => ({ komentar: value === null ? null : { value, rounded: false } });
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000, extra: k(9) }),
      rep({ host: "Brando", at: "2026-11-20T11:00", omzet: 400000, extra: k(null) }),
      rep({ host: "Vanna", at: "2026-11-20T12:00", omzet: 500000, extra: k(12) }),
    ], opts);
    expect(es.map((e) => e.credit)).toEqual([
      { omzet: 300000, komentar: 9 },
      { omzet: 100000 },
      { omzet: 100000, komentar: 3 },
    ]);
  });
});

describe("buildLedger — tanggal siaran lewat tengah malam (R13)", () => {
  it("laporan ≥ 06:00 di hari berikutnya ber-date hari itu, siaran tetap sama", () => {
    const es = buildLedger([
      rep({ host: "Linda", at: "2026-11-30T21:00", omzet: 200000 }),
      rep({ host: "Linda", at: "2026-12-01T00:10", omzet: 450000 }),
      rep({ host: "Linda", at: "2026-12-01T05:59", omzet: 500000 }),
      rep({ host: "Brando", at: "2026-12-01T06:00", omzet: 520000 }),
      rep({ host: "Brando", at: "2026-12-01T09:30", omzet: 600000 }),
    ], opts);
    expect(es.map((e) => e.date)).toEqual(["2026-11-30", "2026-11-30", "2026-11-30", "2026-12-01", "2026-12-01"]);
    expect(omzet(es)).toEqual([200000, 250000, 50000, 20000, 80000]);
    expect(es.some((e) => e.flags.includes("siaran_baru"))).toBe(false);
    expect(es[4]?.intervalStart).toEqual(J("2026-12-01T06:00"));
  });

  it("nomor siaran dan onShift mengikuti tanggal entri", () => {
    const calls: string[] = [];
    const onShift = (_host: string, date: string) => { calls.push(date); return true; };
    const es = buildLedger([
      rep({ host: "Linda", at: "2026-11-30T21:00", omzet: 200000 }),
      rep({ host: "Brando", at: "2026-12-01T09:30", omzet: 500000 }),
      rep({ host: "Vanna", at: "2026-12-01T11:00", omzet: 100000 }),
    ], { maxGapMenit: 1000, liveMulai: "09:00", onShift });
    expect(es.map((e) => [e.date, e.segment])).toEqual([["2026-11-30", 1], ["2026-12-01", 1], ["2026-12-01", 2]]);
    expect(es[1]?.flags).toEqual([]);
    expect(es[2]?.flags).toEqual(["siaran_baru", "siaran_belum_lengkap"]);
    expect(es[2]?.intervalStart).toEqual(J("2026-12-01T09:30"));
    expect(calls).toEqual(["2026-11-30", "2026-12-01", "2026-12-01"]);
  });
});

describe("buildLedger — ganti hari tanpa layar akhir dan layar akhir ganda", () => {
  it("ganti tanggal entri + jeda > maxGap tanpa layar akhir: siaran baru belum lengkap (R16)", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T21:00", omzet: 200000 }),
      rep({ host: "Vanna", at: "2026-11-21T11:00", omzet: 450000 }),
    ], opts);
    expect(omzet(es)).toEqual([200000, 450000]);
    expect(es[1]?.flags).toEqual(["siaran_baru", "siaran_belum_lengkap"]);
    expect(es[1]?.date).toBe("2026-11-21");
    expect(es[1]?.segment).toBe(1);
    expect(es[1]?.intervalStart).toEqual(J("2026-11-21T09:00"));
  });

  it("layar akhir terkirim dua kali: kiriman kedua kredit 0 tanpa flag (R17)", () => {
    const extra = { pesanan: { value: 9, rounded: false } };
    const akhir1 = rep({ host: "Brando", at: "2026-11-20T11:10", omzet: 420000, isMati: true, screen: "akhir", extra });
    const akhir2 = rep({ host: "Brando", at: "2026-11-20T11:12", omzet: 420000, isMati: true, screen: "akhir", extra });
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000, extra: { pesanan: { value: 5, rounded: false } } }),
      akhir1,
      akhir2,
      rep({ host: "Brando", at: "2026-11-20T12:00", omzet: 150000 }),
    ], opts);
    expect(es.map((e) => [e.messageId, e.segment, e.credit, e.flags])).toEqual([
      [es[0]?.messageId, 1, { omzet: 300000, pesanan: 5 }, []],
      [akhir1.messageId, 1, { omzet: 120000, pesanan: 4 }, ["layar_akhir"]],
      [akhir2.messageId, 1, { omzet: 0, pesanan: 0 }, []],
      [es[3]?.messageId, 2, { omzet: 150000 }, ["siaran_baru"]],
    ]);
    expect(es[2]?.intervalStart).toEqual(J("2026-11-20T11:12"));
    expect(es[3]?.intervalStart).toEqual(J("2026-11-20T11:10"));
  });

  it("sesudah layar akhir, angka yang beda satu field bukan duplikat", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T11:10", omzet: 420000, isMati: true, screen: "akhir", extra: { komentar: { value: 50, rounded: false } } }),
      rep({ host: "Brando", at: "2026-11-20T12:00", omzet: 420000, extra: { komentar: { value: 51, rounded: false } } }),
    ], opts);
    expect(es[1]?.segment).toBe(2);
    expect(es[1]?.credit).toEqual({ omzet: 420000, komentar: 51 });
    expect(es[1]?.flags).toEqual(["siaran_baru"]);
  });
});

describe("buildLedger — pembulatan", () => {
  it("flag dibulatkan kalau omzet dibulatkan", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 578000, rounded: true }),
      rep({ host: "Brando", at: "2026-11-20T11:00", omzet: 690000 }),
    ], opts);
    expect(es[0]?.flags).toEqual(["dibulatkan"]);
    expect(es[1]?.flags).toEqual([]);
  });

  it("turun ≤ 10% dengan kedua angka dibulatkan: siaran sama, kredit omzet 0, tanpa flag siaran", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 1250000, rounded: true }),
      rep({ host: "Brando", at: "2026-11-20T11:00", omzet: 1200000, rounded: true }),
    ], opts);
    expect(es[1]?.credit).toEqual({ omzet: 0 });
    expect(es[1]?.segment).toBe(1);
    expect(es[1]?.flags).toEqual(["dibulatkan"]);
  });

  it("turun > 10% walau dibulatkan: siaran baru", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 1000000, rounded: true }),
      rep({ host: "Brando", at: "2026-11-20T11:00", omzet: 890000, rounded: true }),
    ], opts);
    expect(es[1]?.credit.omzet).toBe(890000);
    expect(es[1]?.flags).toEqual(["siaran_baru", "siaran_belum_lengkap", "dibulatkan"]);
  });

  it("turun ≤ 10% dengan salah satu dibulatkan: siaran sama, kredit omzet 0 (R9b)", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 1250000, rounded: true }),
      rep({ host: "Brando", at: "2026-11-20T11:00", omzet: 1240000 }),
    ], opts);
    expect(es[1]?.credit).toEqual({ omzet: 0 });
    expect(es[1]?.segment).toBe(1);
    expect(es[1]?.flags).toEqual([]);
  });

  it("koreksi tepat lalu bacaan dibulatkan lebih rendah: siaran sama, kredit 0 (R9b)", () => {
    const rs = [
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 1200000, rounded: true, id: "ra" }),
      rep({ host: "Vanna", at: "2026-11-20T11:00", omzet: 1200000, rounded: true, id: "rb" }),
    ];
    const es = buildLedger(applyCorrections(rs, [{ messageId: "ra", platform: "tiktok", field: "omzet", value: 1243000 }]), opts);
    expect(es.map((e) => [e.segment, e.credit.omzet, e.flags])).toEqual([
      [1, 1243000, []],
      [1, 0, ["dibulatkan"]],
    ]);
  });

  it("derau diukur dari angka tertinggi siaran, bukan laporan sebelumnya (R9b)", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 1000000, rounded: true }),
      rep({ host: "Brando", at: "2026-11-20T10:30", omzet: 920000, rounded: true }),
      rep({ host: "Brando", at: "2026-11-20T11:00", omzet: 850000, rounded: true }),
    ], opts);
    expect(es.map((e) => [e.segment, e.credit.omzet, e.flags])).toEqual([
      [1, 1000000, ["dibulatkan"]],
      [1, 0, ["dibulatkan"]],
      [2, 850000, ["siaran_baru", "siaran_belum_lengkap", "dibulatkan"]],
    ]);
  });

  it("turun kecil dengan kedua angka tepat: siaran baru", () => {
    const es = buildLedger([
      rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 1250000 }),
      rep({ host: "Brando", at: "2026-11-20T11:00", omzet: 1240000 }),
    ], opts);
    expect(es[1]?.credit.omzet).toBe(1240000);
    expect(es[1]?.flags).toEqual(["siaran_baru", "siaran_belum_lengkap"]);
  });
});

describe("buildLedger — jeda tak wajar dan atribusi", () => {
  const a = rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000, extra: { pesanan: { value: 10, rounded: false } } });
  const b = rep({ host: "Vanna", at: "2026-11-20T14:30", omzet: 600000, extra: { pesanan: { value: 16, rounded: false } } });

  it("jeda > 240 menit: entri kedua belum_teratribusi", () => {
    const es = buildLedger([a, b], opts);
    expect(es[0]?.flags).toEqual([]);
    expect(es[1]?.flags).toEqual(["belum_teratribusi"]);
    expect(es[1]?.host).toBe("Vanna");
    expect(es[1]?.credit).toEqual({ omzet: 300000, pesanan: 6 });
  });

  it("jeda tepat 240 menit tidak diberi flag", () => {
    const c = rep({ host: "Vanna", at: "2026-11-20T14:00", omzet: 600000 });
    expect(buildLedger([a, c], opts)[1]?.flags).toEqual([]);
  });

  it("dengan attributions kreditnya terpecah sesuai porsi", () => {
    const attributions = new Map([[`${b.messageId}|tiktok`, [{ host: "Brando", share: 0.5 }, { host: "Vanna", share: 0.5 }]]]);
    const es = buildLedger([a, b], { ...opts, attributions });
    expect(es).toHaveLength(3);
    expect(es.slice(1).map((e) => [e.messageId, e.host, e.credit, e.flags])).toEqual([
      [b.messageId, "Brando", { omzet: 150000, pesanan: 3 }, []],
      [b.messageId, "Vanna", { omzet: 150000, pesanan: 3 }, []],
    ]);
  });

  it("porsi pecahan tidak dibulatkan dan flag lain tetap ada", () => {
    const c = rep({ host: "Vanna", at: "2026-11-20T14:30", omzet: 600001, rounded: true });
    const attributions = new Map([[`${c.messageId}|tiktok`, [{ host: "Brando", share: 1 / 3 }, { host: "Vanna", share: 2 / 3 }]]]);
    const es = buildLedger([a, c], { ...opts, attributions });
    expect(es[1]?.credit.omzet).toBe(300001 * (1 / 3));
    expect(es[2]?.credit.omzet).toBe(300001 * (2 / 3));
    expect(es[1]?.flags).toEqual(["dibulatkan"]);
  });

  it("attributions per messageId|platform: hanya platform itu yang dipecah (R15)", () => {
    const shopee1 = rep({ host: "Brando", at: "2026-11-20T13:00", omzet: 400000, platform: "shopee" });
    const tiktok2 = rep({ host: "Vanna", at: "2026-11-20T14:30", omzet: 900000, platform: "tiktok", id: "z" });
    const shopee2 = rep({ host: "Vanna", at: "2026-11-20T14:30", omzet: 700000, platform: "shopee", id: "z" });
    const reports = [a, shopee1, tiktok2, shopee2];
    expect(buildLedger(reports, opts).map((e) => [e.platform, e.flags])).toEqual([
      ["tiktok", []], ["shopee", []], ["tiktok", ["belum_teratribusi"]], ["shopee", []],
    ]);
    const attributions = new Map([["z|tiktok", [{ host: "Brando", share: 0.5 }, { host: "Vanna", share: 0.5 }]]]);
    const es = buildLedger(reports, { ...opts, attributions });
    expect(es.filter((e) => e.messageId === "z").map((e) => [e.platform, e.host, e.credit.omzet, e.flags])).toEqual([
      ["tiktok", "Brando", 300000, []],
      ["tiktok", "Vanna", 300000, []],
      ["shopee", "Vanna", 300000, []],
    ]);
  });

  it("onShift false: belum_teratribusi, dipanggil dengan tanggal entri", () => {
    const calls: Array<[string, string]> = [];
    const onShift = (host: string, date: string) => { calls.push([host, date]); return host !== "Vanna"; };
    const c = rep({ host: "Vanna", at: "2026-11-20T11:00", omzet: 400000 });
    const es = buildLedger([a, c], { ...opts, onShift });
    expect(es.map((e) => e.flags)).toEqual([[], ["belum_teratribusi"]]);
    expect(calls).toEqual([["Brando", "2026-11-20"], ["Vanna", "2026-11-20"]]);
  });
});

describe("buildLedger — urutan", () => {
  it("diurutkan menurut effectiveAt ?? receivedAt; layar akhir susulan menutup siaran lama", () => {
    const r1 = rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000 });
    const r2 = rep({ host: "Brando", at: "2026-11-20T12:00", omzet: 150000 });
    const akhir = rep({ host: "Brando", at: "2026-11-20T12:30", effectiveAt: "2026-11-20T11:59", omzet: 420000, isMati: true, screen: "akhir" });
    const es = buildLedger([r1, r2, akhir], opts);
    expect(es.map((e) => e.messageId)).toEqual([r1.messageId, akhir.messageId, r2.messageId]);
    expect(omzet(es)).toEqual([300000, 120000, 150000]);
    expect(es[1]?.at).toEqual(J("2026-11-20T11:59"));
    expect(es[2]?.flags).toEqual(["siaran_baru"]);
  });

  it("waktu sama: urutan input dipertahankan", () => {
    const r1 = rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000, platform: "shopee" });
    const r2 = rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 200000, platform: "tiktok" });
    const r3 = rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 350000, platform: "shopee" });
    const es = buildLedger([r1, r2, r3], opts);
    expect(es.map((e) => e.messageId)).toEqual([r1.messageId, r2.messageId, r3.messageId]);
    expect(omzet(es)).toEqual([300000, 200000, 50000]);
  });
});

describe("applyCorrections", () => {
  const reports = [
    rep({ host: "Brando", at: "2026-11-20T10:00", omzet: 300000, id: "k1" }),
    rep({ host: "Vanna", at: "2026-11-20T11:00", omzet: 420000, rounded: true, id: "k2" }),
    rep({ host: "Linda", at: "2026-11-20T12:00", omzet: 500000, id: "k3" }),
    rep({ host: "Vanna", at: "2026-11-20T11:00", omzet: 900000, platform: "shopee", id: "k2" }),
  ];

  it("mengganti omzet bacaan mengubah kredit entri itu dan sesudahnya", () => {
    const tiktok = (es: ReturnType<typeof buildLedger>) => omzet(es.filter((e) => e.platform === "tiktok"));
    expect(tiktok(buildLedger(reports, opts))).toEqual([300000, 120000, 80000]);
    const corrected = applyCorrections(reports, [{ messageId: "k2", platform: "tiktok", field: "omzet", value: 450000 }]);
    const es = buildLedger(corrected, opts);
    expect(tiktok(es)).toEqual([300000, 150000, 50000]);
    expect(es.find((e) => e.messageId === "k2" && e.platform === "tiktok")?.flags).toEqual([]);
    expect(es.find((e) => e.platform === "shopee")?.credit.omzet).toBe(900000);
  });

  it("tidak mengubah input dan mengembalikan objek baru", () => {
    const corrected = applyCorrections(reports, [{ messageId: "k2", platform: "tiktok", field: "omzet", value: 450000 }]);
    expect(reports[1]?.reading.omzet).toEqual({ value: 420000, rounded: true });
    expect(corrected[1]?.reading.omzet).toEqual({ value: 450000, rounded: false });
    expect(corrected[1]).not.toBe(reports[1]);
    expect(corrected[3]?.reading.omzet).toEqual({ value: 900000, rounded: false });
  });

  it("durasiDetik dikoreksi sebagai angka biasa", () => {
    const corrected = applyCorrections(reports, [{ messageId: "k3", platform: "tiktok", field: "durasiDetik", value: 5400 }]);
    expect(corrected[2]?.reading.durasiDetik).toBe(5400);
    expect(reports[2]?.reading.durasiDetik).toBeNull();
  });
});
