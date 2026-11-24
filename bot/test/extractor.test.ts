import { describe, it, expect, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { buatKlienAnthropic, ClaudeExtractor } from "../src/infra/extractor.js";

const KOSONG = {
  penjualan: null, pesanan_dibuat: null, dilihat: null, komentar: null, masukkan_ke_keranjang: null,
  penonton_aktif: null, durasi_rata_rata_menonton: null, gmv_teratribusi: null, produk_terjual: null,
  tayangan: null, impresi_live: null, pengikut_baru: null, durasi: null,
};
const shopee = { ...KOSONG,
  platform: "shopee", screen: "akhir", penjualan: "1.317.034", pesanan_dibuat: "13", dilihat: "952",
  komentar: "215", masukkan_ke_keranjang: "62", penonton_aktif: "73",
  durasi_rata_rata_menonton: "00:38", durasi: "11:00:32",
};
const tiktok = { ...KOSONG,
  platform: "tiktok", screen: "akhir", gmv_teratribusi: "578 rb", produk_terjual: "7", tayangan: "770",
  impresi_live: "23,7 rb", komentar: "213", pengikut_baru: "5", durasi: null,
};

const calls: any[] = [];
function fake(result: unknown) {
  const create = async (args: unknown) => {
    calls.push(args);
    if (result instanceof Error) throw result;
    return result;
  };
  return { beta: { messages: { create } } } as unknown as Anthropic;
}
const ok = (body: unknown) => fake({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(body) }] });
const img = Buffer.from("x");

describe("ClaudeExtractor", () => {
  it("dua platform -> dua readings", async () => {
    const r = await new ClaudeExtractor(ok({ jenis: "layar_live", platforms: [shopee, tiktok] })).extract(img, "image/jpeg");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings).toHaveLength(2);
    const s = r.readings.find((x) => x.platform === "shopee");
    const t = r.readings.find((x) => x.platform === "tiktok");
    expect(s).toEqual({
      platform: "shopee", screen: "akhir", omzet: { value: 1317034, rounded: false },
      pesanan: { value: 13, rounded: false }, penontonMasuk: { value: 952, rounded: false },
      komentar: { value: 215, rounded: false }, keranjang: { value: 62, rounded: false },
      impresi: null, pengikutBaru: null, penontonAktif: { value: 73, rounded: false },
      rataNontonDetik: 38, durasiDetik: 39632,
    });
    expect(t).toEqual({
      platform: "tiktok", screen: "akhir", omzet: { value: 578000, rounded: true },
      pesanan: { value: 7, rounded: false }, penontonMasuk: { value: 770, rounded: false },
      komentar: { value: 213, rounded: false }, keranjang: null,
      impresi: { value: 23700, rounded: true }, pengikutBaru: { value: 5, rounded: false },
      penontonAktif: null, rataNontonDetik: null, durasiDetik: null,
    });
  });
  it("field asing tidak bocor ke platform lain", async () => {
    const r = await new ClaudeExtractor(ok({ jenis: "layar_live", platforms: [{ ...tiktok, dilihat: "999", masukkan_ke_keranjang: "99" }] })).extract(img, "image/jpeg");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings[0]?.penontonMasuk).toEqual({ value: 770, rounded: false });
    expect(r.readings[0]?.keranjang).toBeNull();
  });
  it("dua entri platform sama -> tidak_terbaca", async () => {
    const r = await new ClaudeExtractor(ok({ jenis: "layar_live", platforms: [shopee, shopee] })).extract(img, "image/jpeg");
    expect(r).toEqual({ ok: false, reason: "tidak_terbaca" });
  });
  it("argumen panggilan API", async () => {
    calls.length = 0;
    await new ClaudeExtractor(ok({ jenis: "layar_live", platforms: [shopee] })).extract(img, "image/jpeg");
    const a = calls[0];
    expect(a.model).toBe("claude-sonnet-5-5");
    expect(a.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(a.fallbacks).toBe("default");
    expect(a.output_config.effort).toBe("medium");
    expect(a.messages[0].content.map((c: { type: string }) => c.type)).toEqual(["image", "text"]);
  });
  it("omzet TikTok null -> hanya Shopee", async () => {
    const r = await new ClaudeExtractor(ok({ jenis: "layar_live", platforms: [shopee, { ...tiktok, gmv_teratribusi: null }] })).extract(img, "image/jpeg");
    expect(r.ok && r.readings.map((x) => x.platform)).toEqual(["shopee"]);
  });
  it("tanpa platform tersisa -> tidak_terbaca", async () => {
    const r = await new ClaudeExtractor(ok({ jenis: "layar_live", platforms: [{ ...tiktok, gmv_teratribusi: null }] })).extract(img, "image/jpeg");
    expect(r).toEqual({ ok: false, reason: "tidak_terbaca" });
  });
  it("bukan_layar_live", async () => {
    const r = await new ClaudeExtractor(ok({ jenis: "bukan_layar_live", platforms: [] })).extract(img, "image/jpeg");
    expect(r).toEqual({ ok: false, reason: "bukan_layar_live" });
  });
  it("JSON tidak valid -> tidak_terbaca", async () => {
    const r = await new ClaudeExtractor(ok({ foo: 1 })).extract(img, "image/jpeg");
    expect(r).toEqual({ ok: false, reason: "tidak_terbaca" });
  });
  it("refusal -> ditolak", async () => {
    const r = await new ClaudeExtractor(fake({ stop_reason: "refusal", content: [] })).extract(img, "image/jpeg");
    expect(r).toEqual({ ok: false, reason: "ditolak" });
  });
  it("RateLimitError dilempar ulang", async () => {
    const err = new Anthropic.RateLimitError(429, {}, "rl", new Headers());
    await expect(new ClaudeExtractor(fake(err)).extract(img, "image/jpeg")).rejects.toBe(err);
  });
  it("500 dilempar ulang, 400 -> tidak_terbaca", async () => {
    const e500 = new Anthropic.InternalServerError(500, {}, "x", new Headers());
    await expect(new ClaudeExtractor(fake(e500)).extract(img, "image/jpeg")).rejects.toBe(e500);
    const e400 = new Anthropic.BadRequestError(400, {}, "bad", new Headers());
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await new ClaudeExtractor(fake(e400)).extract(img, "image/jpeg")).toEqual({ ok: false, reason: "tidak_terbaca" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("I1: klien Anthropic", () => {
  it("timeout 120 detik dan maxRetries 2 secara eksplisit", () => {
    const c = buatKlienAnthropic("sk-test");
    expect(c.timeout).toBe(120_000);
    expect(c.maxRetries).toBe(2);
  });
});
