import { describe, expect, it } from "vitest";
import {
  mention, msgAckAtribusi, msgAckKoreksi, msgAckPerintah, msgBelumLapor, msgEskalasi, msgFormatKoreksi, msgGambarHilang, msgGangguanDitutup,
  msgInputTidakValid, msgKirimUlang, msgKoreksiTanpaPlatform, msgMintaRiwayat, msgOwner, msgPagi, msgRekap, msgSiapa, msgTanda,
  msgTidakCocok, rp,
  rpRingkas, teksStatus,
} from "../src/domain/messages.js";
import type { HostSummary } from "../src/domain/rekap.js";

const sum = (host: string, o: Partial<HostSummary>): HostSummary => ({
  host, target: 10_000_000, realisasi: 5_600_000, seharusnya: 8_400_000, pctTarget: 0.56, selisih: -2_800_000,
  butuhPerHariKerja: 350_000, vsBulanLalu: null, menitOnAir: 0, omzetPerJam: null, konversi: null, disiplin: null,
  streakDiBawah: 0, status: "warn", ...o,
});

describe("format uang", () => {
  it("rp", () => {
    expect(rp(1317034)).toBe("Rp1.317.034");
    expect(rp(-1500)).toBe("−Rp1.500");
  });
  it("rpRingkas", () => {
    expect(rpRingkas(2133333)).toBe("Rp2,1 jt");
    expect(rpRingkas(20_000_000)).toBe("Rp20 jt");
    expect(rpRingkas(578000)).toBe("Rp578 rb");
    expect(rpRingkas(500)).toBe("Rp500");
  });
});

describe("pesan", () => {
  const rows = [
    sum("Brando", { status: "warn" }),
    sum("Rina", { status: "bad", pctTarget: 0.667, realisasi: 5_600_000 }),
    sum("Dewi", { status: "ok" }),
  ];
  it("msgPagi", () => {
    const t = msgPagi("2026-11-20", rows, []);
    for (const n of ["Brando", "Rina", "Dewi", "56%", "66,7%", "⚠️", "🔴", "✅"]) expect(t).toContain(n);
    expect(t.toLowerCase()).not.toMatch(/teguran|malas/);
    expect(t.length).toBeLessThan(1000);
  });
  it("msgOwner eskalasi", () => {
    const t = msgOwner("2026-11-20", { bolong: [], belumLengkap: 0, belumTeratribusi: 0, koreksiMenunggu: 1, eskalasi: ["Brando"] });
    expect(t).toContain("Brando");
    expect(t).toContain("3 hari");
  });
  it("msgTanda", () => {
    const t = msgTanda({ name: "Brando" }, [
      { platform: "tiktok", kredit: 410000, rounded: true },
      { platform: "shopee", kredit: 620500, rounded: false },
    ], ["siaran_baru", "layar_akhir"]);
    expect(t).toContain("✅ Tercatat — Brando · TikTok +Rp410.000* · Shopee +Rp620.500 · Balas kalau angka salah");
    expect(t).toContain("*angka TikTok dibulatkan");
    expect(t).toContain("Siaran baru tercatat");
    expect(t).toContain("Layar akhir tercatat");
  });
  it("lainnya", () => {
    expect(mention({ name: "Brando", waId: "6281@c.us" })).toBe("@6281");
    expect(mention({ name: "Brando" })).toBe("@Brando");
    expect(new Set(["bukan_layar_live", "tidak_terbaca", "ditolak"].map((r) => msgKirimUlang(r as never))).size).toBe(3);
    expect(msgMintaRiwayat({ name: "Brando", waId: "6281@c.us" }, "shopee")).toContain("@6281");
    expect(msgAckPerintah({ kind: "izin", date: "2026-11-25", alasan: "sakit" })).toContain("25/11");
    expect(msgAckPerintah({ kind: "gangguan", scope: "tiktok", alasan: "x" })).toContain("menunggu persetujuan owner");
    expect(msgAckKoreksi("shopee")).toBe("Koreksi Shopee dicatat, menunggu persetujuan owner.");
    expect(msgFormatKoreksi()).toContain("koreksi shopee 1.350.000");
    expect(msgKoreksiTanpaPlatform("tiktok")).toContain("TikTok");
    const nol = msgTanda({ name: "Brando" }, [{ platform: "shopee", kredit: null, rounded: false }, { platform: "tiktok", kredit: 0, rounded: true }], []);
    expect(nol).toContain("Shopee omzet belum terbaca");
    expect(nol).toContain("TikTok +Rp0*");
    expect(msgRekap("2026-11-20", rows, { Brando: 1_000_000 })).toContain("Rp1 jt");
  });
});

describe("pesan penjadwal (Task 12)", () => {
  it("pengecekan silang: teks persis", () => {
    expect(msgTidakCocok(["Brando"])).toBe("Angka dashboard tidak cocok untuk Brando, sedang dicek");
    expect(msgTidakCocok(["Brando", "Linda"])).toBe("Angka dashboard tidak cocok untuk Brando, Linda, sedang dicek");
  });
  it("eskalasi memakai baris yang sama dengan ringkasan owner", () => {
    const owner = msgOwner("2026-11-20", { bolong: [], belumLengkap: 0, belumTeratribusi: 0, koreksiMenunggu: 0, eskalasi: ["Brando"] });
    expect(owner.split("\n")).toContain(msgEskalasi(["Brando"]));
    expect(msgEskalasi(["Brando", "Vanna"]).split("\n")).toHaveLength(2);
  });
  it("tag akhir shift menag host; teks status kondisi", () => {
    expect(msgBelumLapor([{ name: "Brando", waId: "628111111111@c.us" }])).toMatch(/^@628111111111 shift/);
    expect(msgBelumLapor([{ name: "Brando", waId: "628111111111@c.us" }, { name: "Linda" }])).toMatch(/^@628111111111 @Linda shift/);
    expect(teksStatus(sum("A", { status: "ok" }))).toBe("✅ sesuai jalur");
    expect(teksStatus(sum("A", { status: "warn" }))).toBe("⚠️ sedikit tertinggal");
    expect(teksStatus(sum("A", { status: "bad" }))).toBe("🔴 tertinggal");
    expect(teksStatus(sum("A", { status: "bad", streakDiBawah: 4 }))).toBe("🔴 4 hari berturut-turut di bawah target");
  });
  it("input tak valid, gangguan ditutup, gambar hilang", () => {
    const inv = msgInputTidakValid([{ tab: "Pengaturan", row: 3, reason: "Jam rekap tidak valid" }]);
    expect(inv).toContain("Pengaturan baris 3: Jam rekap tidak valid");
    const g = msgGangguanDitutup([{ tanggal: "2026-11-20", host: "Brando", mulai: "14:00", selesai: "22:00" }]);
    expect(g).toContain("Brando 20/11 14:00–22:00");
    expect(msgGangguanDitutup([{ tanggal: "2026-11-20", host: "", mulai: "14:00", selesai: "22:00" }]))
      .toContain("(host belum diisi)");
    expect(msgGambarHilang("Brando", "2026-11-20", "10:00")).toContain("Brando 20/11 pukul 10:00");
  });
});

describe("fix wave: format dan pesan", () => {
  it("I3: rpRingkas membawa batas satuan (999.950 → Rp1 jt)", () => {
    expect(rpRingkas(999_950)).toBe("Rp1 jt");
    expect(rpRingkas(999_499)).toBe("Rp999 rb");
    expect(rpRingkas(999.6)).toBe("Rp1 rb");
    expect(rpRingkas(-999_950)).toBe("−Rp1 jt");
  });

  it("I3: pesan pagi per host: realisasi, % vs seharusnya, selisih Rp, vs bulan lalu, jam shift", () => {
    const t = msgPagi("2026-11-20", [
      sum("Brando", { status: "warn", vsBulanLalu: 0.05 }),
      sum("Vanna", { status: "ok", realisasi: 9_000_000, pctTarget: 0.9, selisih: 600_000, vsBulanLalu: null }),
    ], [], { Brando: "09:00–17:00" });
    const blok = t.slice(t.indexOf("*Brando*"), t.indexOf("*Vanna*"));
    expect(blok).toContain("Rp5,6 jt");
    expect(blok).toContain("66,7% dari yang seharusnya");
    expect(blok).toContain("kurang Rp2,8 jt");
    expect(blok).toContain("+5,0% vs bulan lalu");
    expect(blok).toContain("Shift 09:00–17:00");
    expect(blok).toContain("Ayo kejar Rp350 rb per hari kerja");
    const vanna = t.slice(t.indexOf("*Vanna*"));
    expect(vanna).toContain("lebih Rp600 rb");
    expect(vanna).toContain("– vs bulan lalu");
    expect(vanna).not.toContain("Shift");
  });

  it("I3: status warn/bad dapat satu baris lebih tegas (tidak mempermalukan); ok tidak", () => {
    const t = msgPagi("2026-11-20", [sum("Brando", { status: "warn" }), sum("Rina", { status: "bad" }), sum("Dewi", { status: "ok" })], []);
    expect(t.match(/Perlu dikejar hari ini/g)).toHaveLength(2);
    expect(t.slice(t.indexOf("*Dewi*"))).not.toContain("Perlu dikejar");
    expect(t.toLowerCase()).not.toMatch(/teguran|malas|payah|buruk/);
  });

  it("I3: butuh ≤ 0 → ucapan selamat, bukan 'Ayo kejar Rp0'; target bulan 0 → 'target bulan belum diisi'", () => {
    const capai = msgPagi("2026-11-20", [sum("Brando", { status: "ok", realisasi: 10_500_000, pctTarget: 1.05, selisih: 2_100_000, butuhPerHariKerja: 0 })], []);
    expect(capai).not.toContain("Ayo kejar");
    expect(capai).not.toContain("Rp0");
    expect(capai).toContain("Target bulan ini sudah tercapai, selamat!");

    const tanpa = msgPagi("2026-11-20", [sum("Brando", { status: "ok", target: 0, seharusnya: 0, pctTarget: 0, selisih: 5_600_000, butuhPerHariKerja: 0 })], []);
    expect(tanpa).toContain("target bulan belum diisi");
    expect(tanpa).not.toContain("dari Rp0");
    expect(tanpa).not.toContain("(0%)");
    expect(tanpa).not.toContain("Ayo kejar");
    expect(tanpa).not.toContain("selamat");
  });

  it("W11: pertanyaan caption persis 'Ini laporan siapa?'", () => {
    expect(msgSiapa()).toBe("Ini laporan siapa?");
  });

  it("M7: input tak valid paling banyak 10 baris + 'dan N lainnya'", () => {
    const items = Array.from({ length: 13 }, (_, i) => ({ tab: "Kehadiran", row: i + 2, reason: "Host kosong" }));
    const t = msgInputTidakValid(items);
    expect(t.split("\n").filter((b) => b.startsWith("- "))).toHaveLength(10);
    expect(t).toContain("dan 3 lainnya");
    expect(t).not.toContain("baris 12:");
    expect(msgInputTidakValid(items.slice(0, 10))).not.toContain("lainnya");
  });

  it("M6: ack izin menampilkan dd/mm/yyyy", () => {
    expect(msgAckPerintah({ kind: "izin", date: "2027-01-05", alasan: "acara" })).toContain("05/01/2027");
  });

  it("I4: ack atribusi ulang", () => {
    expect(msgAckAtribusi("Vanna")).toBe("Atribusi ke Vanna dicatat, menunggu persetujuan owner.");
    expect(msgFormatKoreksi()).toContain("koreksi host");
  });
});
