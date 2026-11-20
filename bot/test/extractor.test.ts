import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeExtractor } from "../src/infra/extractor.js";

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

function fake(result: unknown) {
  const create = async () => {
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
    const s = r.readings.find((x) => x.platform === "shopee")!;
    const t = r.readings.find((x) => x.platform === "tiktok")!;
    expect(s.omzet).toEqual({ value: 1317034, rounded: false });
    expect(s.rataNontonDetik).toBe(38);
    expect(s.durasiDetik).toBe(39632);
    expect(t.omzet).toEqual({ value: 578000, rounded: true });
    expect(t.impresi).toEqual({ value: 23700, rounded: true });
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
    expect(await new ClaudeExtractor(fake(e400)).extract(img, "image/jpeg")).toEqual({ ok: false, reason: "tidak_terbaca" });
  });
});
