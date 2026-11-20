import { describe, expect, it } from "vitest";
import {
  mention, msgAckPerintah, msgKirimUlang, msgMintaRiwayat, msgOwner, msgPagi, msgRekap, msgTanda, rp, rpRingkas,
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
    expect(msgRekap("2026-11-20", rows, { Brando: 1_000_000 })).toContain("Rp1 jt");
  });
});
