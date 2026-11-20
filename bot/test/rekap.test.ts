import { describe, expect, it } from "vitest";
import {
  dailyByHost, expectedOmzet, funnel, heatmap, indeksSlot, summarizeHosts, toKreditRows, type HostSummary,
} from "../src/domain/rekap.js";
import { butuhPerHariKerja, computeTargets, type TargetInputs } from "../src/domain/targets.js";
import type { CumulativeField, Flag, LedgerEntry, Platform } from "../src/domain/types.js";

// Waktu Asia/Jakarta, mis. "2026-11-20T10:00".
const J = (dt: string): Date => new Date(`${dt}:00+07:00`);

let seq = 0;
interface EntryInput {
  host: string;
  date: string;
  from: string; // "HH:MM" di tanggal entri, atau "YYYY-MM-DDTHH:MM"
  to: string;
  platform?: Platform;
  omzet?: number;
  credit?: Partial<Record<CumulativeField, number>>;
  flags?: Flag[];
  id?: string;
}
function ent(p: EntryInput): LedgerEntry {
  const waktu = (hm: string): Date => J(hm.includes("T") ? hm : `${p.date}T${hm}`);
  return {
    messageId: p.id ?? `m${++seq}`, host: p.host, platform: p.platform ?? "shopee", date: p.date,
    at: waktu(p.to), intervalStart: waktu(p.from), segment: 1,
    credit: { ...(p.omzet === undefined ? {} : { omzet: p.omzet }), ...p.credit },
    flags: p.flags ?? [],
  };
}

const base = (over: Partial<TargetInputs> = {}): TargetInputs => ({
  month: "2026-11", teamTarget: 60_000_000,
  hosts: [{ name: "Brando" }, { name: "Vanna" }, { name: "Linda" }],
  tanpaLive: [], izin: [], gangguan: [], jadwal: null, jamLive: 13, ...over,
});

interface Opsi { lastMonth?: LedgerEntry[]; today?: string; masalah?: Record<string, number> }
function ringkas(entries: LedgerEntry[], over: Partial<TargetInputs> = {}, o: Opsi = {}): Record<string, HostSummary> {
  const inp = base(over);
  const rows = summarizeHosts(entries, o.lastMonth ?? [], computeTargets(inp), inp, o.today ?? "2026-11-20", o.masalah ?? {});
  return Object.fromEntries(rows.map((r) => [r.host, r]));
}

// Angka asli live Selasa 17 Nov, dibagi ke dua host (satu pesan = dua platform).
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

describe("funnel — angka asli 17 Nov", () => {
  it("corong Shopee dan TikTok", () => {
    const f = funnel(nov17());
    expect(f.shopee).toMatchObject({ omzet: 1_317_034, pesanan: 13, dilihat: 952, keranjang: 62, komentar: 215 });
    expect(f.shopee.atcRate).toBeCloseTo(0.065, 3);
    expect(f.shopee.cartToOrder).toBeCloseTo(0.2097, 4);
    expect(f.shopee.konversi).toBeCloseTo(0.01366, 5);
    expect(f.shopee.aov).toBeCloseTo(101_310, 0);
    expect(f.shopee.komentarPerDilihat).toBeCloseTo(0.2258, 4);
    expect(f.shopee.omzetPerJam).toBeCloseTo(1_317_034 / 11, 2); // 11 jam on-air
    expect(f.tiktok).toMatchObject({ omzet: 578_000, terjual: 7, tayangan: 770, impresi: 23_700, komentar: 213, pengikutBaru: 5 });
    expect(f.tiktok.tapIn).toBeCloseTo(0.0325, 4);
    expect(f.tiktok.konversi).toBeCloseTo(0.00909, 5);
    expect(f.tiktok.nilaiPerProduk).toBeCloseTo(82_571.43, 1);
    expect(f.tiktok.komentarPerTayangan).toBeCloseTo(0.2766, 4);
  });

  it("filter host dan tanggal", () => {
    const f = funnel(nov17(), { host: "Brando" });
    expect(f.shopee.atcRate).toBeCloseTo(30 / 500, 10);
    expect(f.shopee.omzetPerJam).toBeCloseTo(700_000 / 5, 6);
    expect(f.tiktok.tapIn).toBeCloseTo(400 / 12_000, 10);
    const kosong = funnel(nov17(), { from: "2026-11-18", to: "2026-11-30" });
    expect(kosong.shopee).toMatchObject({ omzet: null, dilihat: null, atcRate: null, aov: null, omzetPerJam: null });
    expect(funnel(nov17(), { from: "2026-11-17", to: "2026-11-17" }).shopee.dilihat).toBe(952);
  });

  it("entri belum_teratribusi masuk total platform, tidak masuk filter host mana pun", () => {
    const es = [...nov17(), ent({ host: "Linda", date: "2026-11-17", from: "20:00", to: "21:00",
      flags: ["belum_teratribusi"], credit: { omzet: 50_000, penontonMasuk: 48, keranjang: 10 } })];
    expect(funnel(es).shopee.dilihat).toBe(1000);
    expect(funnel(es, { host: "Linda" }).shopee.dilihat).toBeNull();
  });

  it("rasio hanya dari entri yang punya pembilang dan penyebut", () => {
    const es = [
      ...nov17(),
      ent({ host: "Brando", date: "2026-11-17", from: "20:00", to: "21:00", credit: { keranjang: 5 } }),
      ent({ host: "Brando", date: "2026-11-17", from: "21:00", to: "22:00", credit: { penontonMasuk: 48 } }),
    ];
    const f = funnel(es);
    expect(f.shopee.keranjang).toBe(67);
    expect(f.shopee.dilihat).toBe(1000);
    expect(f.shopee.atcRate).toBeCloseTo(62 / 952, 10);
    const tanpaPenyebut = funnel([ent({ host: "Brando", date: "2026-11-17", from: "09:00", to: "10:00", credit: { keranjang: 5 } })]);
    expect(tanpaPenyebut.shopee.atcRate).toBeNull();
  });
});

describe("summarizeHosts — data contoh mockup per 20/11", () => {
  const mockup = (): LedgerEntry[] => [
    ent({ host: "Brando", date: "2026-11-19", from: "09:00", to: "12:00", omzet: 11_200_000 }),
    ent({ host: "Vanna", date: "2026-11-19", from: "12:00", to: "15:00", omzet: 14_100_000 }),
    ent({ host: "Linda", date: "2026-11-19", from: "15:00", to: "18:00", omzet: 12_600_000 }),
  ];

  it("Brando: target, pace, selisih, status bad", () => {
    const inp = base();
    const r = ringkas(mockup());
    const b = r.Brando!;
    expect(b.target).toBeCloseTo(20_000_000, 4);
    expect(b.realisasi).toBe(11_200_000);
    expect(b.pctTarget).toBeCloseTo(0.56, 10);
    expect(b.seharusnya).toBeCloseTo(13_333_333.33, 1);
    expect(b.selisih).toBeCloseTo(-2_133_333.33, 1);
    expect(b.butuhPerHariKerja).toBeCloseTo(butuhPerHariKerja(computeTargets(inp).Brando!, 11_200_000, inp, "Brando", "2026-11-20"), 6);
    expect(b.streakDiBawah).toBe(0);
    expect(b.status).toBe("bad");
  });

  it("Vanna ok, Linda warn, urutan mengikuti daftar host", () => {
    const rows = summarizeHosts(mockup(), [], computeTargets(base()), base(), "2026-11-20", {});
    expect(rows.map((r) => [r.host, r.status])).toEqual([["Brando", "bad"], ["Vanna", "ok"], ["Linda", "warn"]]);
  });

  it("seharusnya dijepit di 0 setelah izin awal bulan", () => {
    // 1/11: jatah hari 666.667 − gugur izin 777.778 < 0.
    const b = ringkas([], { izin: [{ host: "Brando", date: "2026-11-01" }] }, { today: "2026-11-01" }).Brando!;
    expect(b.seharusnya).toBe(0);
    expect(b.selisih).toBe(0);
    expect(b.status).toBe("ok");
  });

  it("entri belum_teratribusi tidak masuk realisasi maupun menit on-air", () => {
    const es = [...mockup(), ent({ host: "Brando", date: "2026-11-18", from: "09:00", to: "18:00", omzet: 5_000_000, flags: ["belum_teratribusi"] })];
    const b = ringkas(es).Brando!;
    expect(b.realisasi).toBe(11_200_000);
    expect(b.menitOnAir).toBeCloseTo(180, 6);
  });

  it("entri tanggal 30/11 yang dilaporkan 1/12 masuk realisasi November; bulan lain diabaikan", () => {
    const es = [
      ent({ host: "Vanna", date: "2026-11-30", from: "2026-11-30T21:00", to: "2026-12-01T00:10", omzet: 900_000 }),
      ent({ host: "Vanna", date: "2026-10-31", from: "20:00", to: "21:00", omzet: 400_000 }),
      ent({ host: "Vanna", date: "2026-12-01", from: "09:00", to: "10:00", omzet: 300_000 }),
    ];
    const v = ringkas(es, {}, { today: "2026-12-01" }).Vanna!;
    expect(v.realisasi).toBe(900_000);
    expect(v.menitOnAir).toBeCloseTo(190, 6);
  });
});

describe("summarizeHosts — streak di bawah target per hari kerja", () => {
  // perHariKerja tanpa jadwal = 20 jt ÷ (30 × 6/7) ≈ 777.778
  it("3 hari live berturut-turut di bawah target → bad walaupun selisih < 10%", () => {
    const es = [
      ent({ host: "Linda", date: "2026-11-10", from: "09:00", to: "18:00", omzet: 12_000_000 }),
      ent({ host: "Linda", date: "2026-11-17", from: "09:00", to: "12:00", omzet: 300_000 }),
      ent({ host: "Linda", date: "2026-11-18", from: "09:00", to: "12:00", omzet: 300_000 }),
      ent({ host: "Linda", date: "2026-11-19", from: "09:00", to: "12:00", omzet: 300_000 }),
    ];
    const l = ringkas(es).Linda!;
    expect((l.seharusnya - l.realisasi) / l.seharusnya).toBeLessThan(0.1);
    expect(l.streakDiBawah).toBe(3);
    expect(l.status).toBe("bad");
  });

  it("hari izin di tengah tidak memutus dan tidak menambah streak", () => {
    const es = [
      ent({ host: "Linda", date: "2026-11-10", from: "09:00", to: "18:00", omzet: 12_000_000 }),
      ent({ host: "Linda", date: "2026-11-16", from: "09:00", to: "12:00", omzet: 200_000 }),
      ent({ host: "Linda", date: "2026-11-17", from: "09:00", to: "12:00", omzet: 1_000_000 }),
      ent({ host: "Linda", date: "2026-11-18", from: "09:00", to: "12:00", omzet: 200_000 }),
      ent({ host: "Linda", date: "2026-11-19", from: "09:00", to: "12:00", omzet: 200_000 }),
    ];
    const l = ringkas(es, { izin: [{ host: "Linda", date: "2026-11-17" }] }).Linda!;
    expect(l.realisasi).toBeGreaterThanOrEqual(l.seharusnya);
    expect(l.streakDiBawah).toBe(3);
    expect(l.status).toBe("bad");
    expect(ringkas(es).Linda!.streakDiBawah).toBe(2); // tanpa izin, 17/11 memutus
  });

  it("hari tanpa laporan dan hari ini dilewati; tanpa jadwal", () => {
    const es = [
      ent({ host: "Brando", date: "2026-11-14", from: "09:00", to: "12:00", omzet: 100_000 }),
      ent({ host: "Brando", date: "2026-11-17", from: "09:00", to: "12:00", omzet: 100_000 }),
      ent({ host: "Brando", date: "2026-11-20", from: "09:00", to: "12:00", omzet: 100_000 }),
    ];
    expect(ringkas(es).Brando!.streakDiBawah).toBe(2);
  });

  // Hanya Linda punya shift, jadi awal Linda = 60 jt dan perHariKerja = 60 jt ÷ jumlah hari shift.
  const shift = (date: string) => ({ date, host: "Linda", mulai: "09:00", selesai: "22:00" });

  it("dengan jadwal: shift tanpa laporan dihitung kredit 0", () => {
    const jadwal = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"].map(shift);
    const es = [
      ent({ host: "Linda", date: "2026-11-16", from: "09:00", to: "18:00", omzet: 30_000_000 }),
      ent({ host: "Linda", date: "2026-11-17", from: "09:00", to: "12:00", omzet: 10_000 }),
      ent({ host: "Linda", date: "2026-11-19", from: "09:00", to: "12:00", omzet: 10_000 }),
    ];
    // 19/11 di bawah, 18/11 shift tanpa laporan (0), 17/11 di bawah, 16/11 memutus.
    expect(ringkas(es, { jadwal }).Linda!.streakDiBawah).toBe(3);
  });

  it("dengan jadwal: hari tanpa shift dan tanpaLive dilewati walau ada laporan", () => {
    const jadwal = ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-19"].map(shift);
    const es = [
      ent({ host: "Linda", date: "2026-11-14", from: "09:00", to: "18:00", omzet: 30_000_000 }),
      ent({ host: "Linda", date: "2026-11-15", from: "09:00", to: "12:00", omzet: 10_000 }), // tanpaLive
      ent({ host: "Linda", date: "2026-11-16", from: "09:00", to: "12:00", omzet: 10_000 }),
      ent({ host: "Linda", date: "2026-11-18", from: "09:00", to: "12:00", omzet: 10_000 }), // bukan shift
      ent({ host: "Linda", date: "2026-11-19", from: "09:00", to: "12:00", omzet: 10_000 }),
    ];
    // 19/11 di bawah, 18/11 bukan shift, 17/11 bukan shift, 16/11 di bawah, 15/11 tanpaLive, 14/11 memutus.
    expect(ringkas(es, { jadwal, tanpaLive: ["2026-11-15"] }).Linda!.streakDiBawah).toBe(2);
  });

  it("hari di luar rentang aktif host dilewati", () => {
    const es = [
      ent({ host: "Linda", date: "2026-11-16", from: "09:00", to: "12:00", omzet: 100_000 }),
      ent({ host: "Linda", date: "2026-11-18", from: "09:00", to: "12:00", omzet: 100_000 }),
      ent({ host: "Linda", date: "2026-11-19", from: "09:00", to: "12:00", omzet: 100_000 }),
    ];
    const hosts = [{ name: "Brando" }, { name: "Vanna" }, { name: "Linda", aktifMulai: "2026-11-18" }];
    expect(ringkas(es, { hosts }).Linda!.streakDiBawah).toBe(2);
  });
});

describe("summarizeHosts — jam on-air, konversi, disiplin, vs bulan lalu", () => {
  // Pesan x1 memuat dua platform; interval TikTok mulai 5 menit lebih lambat. Pesan x2 hanya TikTok.
  const es = (): LedgerEntry[] => [
    ent({ host: "Brando", date: "2026-11-19", from: "10:00", to: "12:05", platform: "shopee", id: "x1",
      credit: { omzet: 600_000, pesanan: 6, penontonMasuk: 400 } }),
    ent({ host: "Brando", date: "2026-11-19", from: "10:05", to: "12:05", platform: "tiktok", id: "x1",
      credit: { omzet: 400_000, pesanan: 4, penontonMasuk: 600 } }),
    ent({ host: "Brando", date: "2026-11-19", from: "12:05", to: "13:00", platform: "tiktok", id: "x2",
      credit: { pesanan: 2 } }),
  ];

  it("menit on-air = gabungan interval dua platform; omzet per jam; konversi", () => {
    const b = ringkas(es()).Brando!;
    expect(b.menitOnAir).toBeCloseTo(180, 6); // 10:00–13:00
    expect(b.omzetPerJam).toBeCloseTo(1_000_000 / 3, 4);
    expect(b.konversi).toBeCloseTo(10 / 1000, 10);
    const v = ringkas(es()).Vanna!;
    expect(v.menitOnAir).toBe(0);
    expect(v.omzetPerJam).toBeNull();
    expect(v.konversi).toBeNull();
  });

  it("disiplin = 1 − laporan bermasalah ÷ jumlah laporan (messageId) host", () => {
    const r = ringkas(es(), {}, { masalah: { Brando: 1 } });
    expect(r.Brando!.disiplin).toBeCloseTo(0.5, 10);
    expect(r.Vanna!.disiplin).toBeNull();
    expect(ringkas(es()).Brando!.disiplin).toBe(1);
  });

  it("vsBulanLalu: tanggal 1 s/d d bulan lalu; null kalau bulan lalu kosong", () => {
    const lastMonth = [
      ent({ host: "Brando", date: "2026-10-05", from: "09:00", to: "12:00", omzet: 800_000 }),
      ent({ host: "Brando", date: "2026-10-25", from: "09:00", to: "12:00", omzet: 5_000_000 }),
      ent({ host: "Brando", date: "2026-10-06", from: "09:00", to: "12:00", omzet: 900_000, flags: ["belum_teratribusi"] }),
    ];
    const r = ringkas(es(), {}, { lastMonth });
    expect(r.Brando!.vsBulanLalu).toBeCloseTo(1_000_000 / 800_000 - 1, 10);
    expect(r.Vanna!.vsBulanLalu).toBeNull();
    expect(ringkas(es()).Brando!.vsBulanLalu).toBeNull();
  });

  it("vsBulanLalu: d dibatasi akhir bulan lalu", () => {
    const now = [ent({ host: "Brando", date: "2026-12-31", from: "09:00", to: "12:00", omzet: 2_000_000 })];
    const lastMonth = [ent({ host: "Brando", date: "2026-11-30", from: "09:00", to: "12:00", omzet: 1_000_000 })];
    const r = ringkas(now, { month: "2026-12" }, { lastMonth, today: "2026-12-31" });
    expect(r.Brando!.vsBulanLalu).toBeCloseTo(1, 10);
  });
});

describe("indeksSlot", () => {
  // Tiap hari jam 10: Vanna 30 menit Rp56 rb (112 rb/jam), Brando 30 menit Rp44 rb (88 rb/jam). Rata-rata 100 rb/jam.
  const hari = (n: number): LedgerEntry[] =>
    Array.from({ length: n }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`).flatMap((date) => [
      ent({ host: "Vanna", date, from: "10:00", to: "10:30", omzet: 56_000 }),
      ent({ host: "Brando", date, from: "10:30", to: "11:00", omzet: 44_000 }),
    ]);

  it("null kalau data baru 10 hari live", () => {
    expect(indeksSlot(hari(10), "Vanna", "2026-11")).toBeNull();
  });

  it("21 hari: omzet/jam 1,12× rata-rata di jam yang sama → 1,12", () => {
    expect(indeksSlot(hari(21), "Vanna", "2026-11")).toBeCloseTo(1.12, 10);
    expect(indeksSlot(hari(21), "Brando", "2026-11")).toBeCloseTo(0.88, 10);
    expect(indeksSlot(hari(21), "Linda", "2026-11")).toBeNull();
  });

  it("entri belum_teratribusi tidak dihitung sebagai hari live", () => {
    const es = [...hari(20), ent({ host: "Vanna", date: "2026-11-21", from: "10:00", to: "11:00", omzet: 1, flags: ["belum_teratribusi"] })];
    expect(indeksSlot(es, "Vanna", "2026-11")).toBeNull();
  });
});

describe("heatmap", () => {
  it("omzet dan jam dibagi ke jam jam yang dilalui interval, per kelompok hari", () => {
    const h = heatmap([
      ent({ host: "Brando", date: "2026-11-16", from: "10:30", to: "12:00", omzet: 300_000 }), // Senin
      ent({ host: "Vanna", date: "2026-11-20", from: "13:00", to: "14:00", omzet: 150_000 }), // Jumat
    ], "2026-11");
    expect(h["Sen–Kam"][10]).toBeCloseTo(200_000, 6);
    expect(h["Sen–Kam"][11]).toBeCloseTo(200_000, 6);
    expect(h["Sen–Kam"][13]).toBeNull();
    expect(h["Jum–Min"][13]).toBeCloseTo(150_000, 6);
    expect(h["Jum–Min"][10]).toBeNull();
    expect(Object.keys(h["Sen–Kam"])).toHaveLength(24);
  });

  it("dua platform host yang sama dihitung satu jam on-air", () => {
    const h = heatmap([
      ent({ host: "Brando", date: "2026-11-19", from: "10:00", to: "11:00", platform: "shopee", omzet: 100_000 }),
      ent({ host: "Brando", date: "2026-11-19", from: "10:00", to: "11:00", platform: "tiktok", omzet: 50_000 }),
    ], "2026-11");
    expect(h["Sen–Kam"][10]).toBeCloseTo(150_000, 6);
  });

  it("belum_teratribusi dan bulan lain tidak masuk; lewat tengah malam ikut kelompok tanggal entri", () => {
    const h = heatmap([
      ent({ host: "Brando", date: "2026-11-19", from: "10:00", to: "11:00", omzet: 999_000, flags: ["belum_teratribusi"] }),
      ent({ host: "Brando", date: "2026-10-19", from: "10:00", to: "11:00", omzet: 999_000 }),
      ent({ host: "Vanna", date: "2026-11-19", from: "2026-11-19T23:30", to: "2026-11-20T00:30", omzet: 60_000 }), // Kamis
    ], "2026-11");
    expect(h["Sen–Kam"][10]).toBeNull();
    expect(h["Sen–Kam"][23]).toBeCloseTo(60_000, 6);
    expect(h["Sen–Kam"][0]).toBeCloseTo(60_000, 6);
    expect(h["Jum–Min"][0]).toBeNull();
  });
});

describe("expectedOmzet dan toKreditRows", () => {
  const data = (): LedgerEntry[] => [
    ent({ host: "Brando", date: "2026-11-16", from: "10:00", to: "11:00", id: "p1", omzet: 120_000 }),
    ent({ host: "Vanna", date: "2026-11-17", from: "10:00", to: "11:00", id: "p2", omzet: 80_000 }),
    ent({ host: "Linda", date: "2026-11-17", from: "10:00", to: "12:00", platform: "tiktok", id: "p3",
      credit: { omzet: 70_000, pesanan: 2 }, flags: ["belum_teratribusi", "dibulatkan"] }),
    // Satu pesan dua platform, host sama.
    ent({ host: "Brando", date: "2026-11-19", from: "10:00", to: "11:00", platform: "shopee", id: "p4", omzet: 100_000 }),
    ent({ host: "Brando", date: "2026-11-19", from: "10:00", to: "11:00", platform: "tiktok", id: "p4", omzet: 100_000 }),
    // Atribusi pecahan: satu entri ledger per host.
    ent({ host: "Brando", date: "2026-11-21", from: "13:00", to: "14:00", platform: "tiktok", id: "p5", omzet: 30_000 }),
    ent({ host: "Vanna", date: "2026-11-21", from: "13:00", to: "14:00", platform: "tiktok", id: "p5", omzet: 60_000 }),
  ];

  it("omzet harapan = omzet/jam semua host di jam & kelompok hari itu × jam on-air entri", () => {
    // Sen–Kam jam 10: (120 + 80 + 200) rb ÷ (1 + 1 + 1) jam; Jum–Min jam 13: 90 rb ÷ 2 jam (dua host).
    const m = expectedOmzet(data(), "2026-11");
    const r10 = 400_000 / 3;
    expect(m.get("p1|shopee|Brando")).toBeCloseTo(r10, 6);
    expect(m.get("p2|shopee|Vanna")).toBeCloseTo(r10, 6);
    expect(m.get("p4|shopee|Brando")).toBeCloseTo(r10 / 2, 6);
    expect(m.get("p4|tiktok|Brando")).toBeCloseTo(r10 / 2, 6);
    expect(m.get("p3|tiktok|(belum teratribusi)")).toBeCloseTo(r10, 6); // jam 11 tanpa data → 0
    expect(m.get("p5|tiktok|Brando")).toBeCloseTo(45_000, 6);
    expect(m.get("p5|tiktok|Vanna")).toBeCloseTo(45_000, 6);
    expect(m.size).toBe(7);
    expect(expectedOmzet(data(), "2026-10").size).toBe(0);
  });

  it("satu baris per entri, kolom kosong null, belum teratribusi ditandai", () => {
    const es = data();
    const rows = toKreditRows(es, expectedOmzet(es, "2026-11"));
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({
      messageId: "p1", tanggal: "2026-11-16", jam: 10, hariKelompok: "Sen–Kam", host: "Brando", platform: "shopee",
      omzet: 120_000, pesanan: null, penontonMasuk: null, komentar: null, keranjang: null, impresi: null, pengikutBaru: null,
      menitOnAir: 60, omzetHarapan: expect.closeTo(400_000 / 3, 6), status: "dihitung",
    });
    expect(rows[2]).toMatchObject({ host: "(belum teratribusi)", platform: "tiktok", omzet: 70_000, pesanan: 2, menitOnAir: 120, status: "belum_teratribusi" });
    expect(rows[3]!.menitOnAir + rows[4]!.menitOnAir).toBeCloseTo(60, 6);
    expect(rows.slice(5).map((r) => [r.host, r.omzet, r.hariKelompok, r.menitOnAir])).toEqual([
      ["Brando", 30_000, "Jum–Min", 60], ["Vanna", 60_000, "Jum–Min", 60],
    ]);
  });

  it("omzet harapan null kalau tidak ada di peta", () => {
    expect(toKreditRows(data().slice(0, 1), new Map())[0]!.omzetHarapan).toBeNull();
  });
});

describe("dailyByHost", () => {
  it("kredit per host per tanggal, tanpa belum_teratribusi dan bulan lain", () => {
    const d = dailyByHost([
      ent({ host: "Brando", date: "2026-11-19", from: "09:00", to: "10:00", omzet: 100_000 }),
      ent({ host: "Brando", date: "2026-11-19", from: "10:00", to: "11:00", platform: "tiktok", omzet: 50_000 }),
      ent({ host: "Brando", date: "2026-11-18", from: "09:00", to: "10:00", omzet: 70_000, flags: ["belum_teratribusi"] }),
      ent({ host: "Vanna", date: "2026-11-30", from: "2026-11-30T21:00", to: "2026-12-01T00:10", omzet: 900_000 }),
      ent({ host: "Vanna", date: "2026-12-01", from: "09:00", to: "10:00", omzet: 300_000 }),
    ], "2026-11");
    expect(d).toEqual({ Brando: { "2026-11-19": 150_000 }, Vanna: { "2026-11-30": 900_000 } });
  });
});
