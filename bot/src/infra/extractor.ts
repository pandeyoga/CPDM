import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { parseDurasi, parseNum } from "../domain/numbers.js";
import type { ExtractResult, PlatformReading } from "../domain/types.js";

export interface Extractor {
  extract(image: Buffer, mime: string): Promise<ExtractResult>;
}

const Str = z.string().nullable();
const PlatformSchema = z.object({
  platform: z.enum(["shopee", "tiktok"]),
  screen: z.enum(["berjalan", "akhir"]),
  // Shopee
  penjualan: Str, pesanan_dibuat: Str, dilihat: Str, komentar: Str, masukkan_ke_keranjang: Str,
  penonton_aktif: Str, durasi_rata_rata_menonton: Str,
  // TikTok
  gmv_teratribusi: Str, produk_terjual: Str, tayangan: Str, impresi_live: Str, pengikut_baru: Str,
  // keduanya
  durasi: Str,
});
const Schema = z.object({
  jenis: z.enum(["layar_live", "bukan_layar_live", "tidak_terbaca"]),
  platforms: z.array(PlatformSchema),
});
type Raw = z.infer<typeof PlatformSchema>;

const PROMPT = `Gambar ini mungkin berisi layar statistik TikTok Shop LIVE dan/atau Shopee Live (satu atau dua ponsel/layar).

Isi "jenis": "layar_live" jika ada layar statistik LIVE TikTok/Shopee; "bukan_layar_live" jika gambar lain; "tidak_terbaca" jika layar LIVE ada tapi tidak bisa dibaca.
Untuk setiap platform yang terlihat, isi satu entri di "platforms". "screen": "akhir" untuk layar akhir siaran (Shopee "Live Streaming Berakhir", TikTok "LIVE luar biasa!" / ringkasan LIVE), "berjalan" untuk layar saat siaran masih berlangsung.

Label Shopee: Penjualan -> penjualan; Pesanan Dibuat -> pesanan_dibuat; Dilihat -> dilihat; Komentar -> komentar; Masukkan ke Keranjang -> masukkan_ke_keranjang; Penonton Aktif -> penonton_aktif; Durasi Rata-rata Menonton -> durasi_rata_rata_menonton; Durasi -> durasi.
Label TikTok: GMV Teratribusi -> gmv_teratribusi; Produk terjual teratribusi -> produk_terjual; Tayangan -> tayangan; Impresi LIVE -> impresi_live; Komentar -> komentar; Pengikut baru -> pengikut_baru; Durasi (jika terlihat) -> durasi.

Aturan:
- Salin angka PERSIS seperti tertulis di layar, termasuk "rb", "jt", "K", titik, dan koma. Jangan mengubah atau menghitung ulang.
- Durasi disalin seperti tertulis (mis. 00:38 atau 11:00:32).
- Isi null jika nilai tidak terlihat atau tidak terbaca. Jangan pernah menebak.
- Abaikan bagian "Sistem Pemberian Hadiah" / hadiah / reward dan semua nominal dalam $.
- Field yang bukan milik platform itu diisi null.`;

function num(s: string | null) { return s === null ? null : parseNum(s); }
function dur(s: string | null) { return s === null ? null : parseDurasi(s); }

function toReading(p: Raw): PlatformReading {
  const shopee = p.platform === "shopee";
  return {
    platform: p.platform,
    screen: p.screen,
    omzet: num(shopee ? p.penjualan : p.gmv_teratribusi),
    pesanan: num(shopee ? p.pesanan_dibuat : p.produk_terjual),
    penontonMasuk: num(shopee ? p.dilihat : p.tayangan),
    komentar: num(p.komentar),
    keranjang: shopee ? num(p.masukkan_ke_keranjang) : null,
    impresi: shopee ? null : num(p.impresi_live),
    pengikutBaru: shopee ? null : num(p.pengikut_baru),
    penontonAktif: shopee ? num(p.penonton_aktif) : null,
    rataNontonDetik: shopee ? dur(p.durasi_rata_rata_menonton) : null,
    durasiDetik: dur(p.durasi),
  };
}

export class ClaudeExtractor implements Extractor {
  constructor(private readonly client: Anthropic) {}

  async extract(image: Buffer, mime: string): Promise<ExtractResult> {
    let response;
    try {
      response = await this.client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: zodOutputFormat(Schema) },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime as "image/jpeg", data: image.toString("base64") } },
            { type: "text", text: PROMPT },
          ],
        }],
      });
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError) return { ok: false, reason: "tidak_terbaca" };
      // RateLimitError, APIConnectionError, dan status >= 500: biarkan pemanggil mengantrekan.
      throw err;
    }

    if (response.stop_reason === "refusal") return { ok: false, reason: "ditolak" };

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return { ok: false, reason: "tidak_terbaca" };
    let json: unknown;
    try { json = JSON.parse(block.text); } catch { return { ok: false, reason: "tidak_terbaca" }; }
    const parsed = Schema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: "tidak_terbaca" };

    if (parsed.data.jenis === "bukan_layar_live") return { ok: false, reason: "bukan_layar_live" };
    const readings = parsed.data.platforms.map(toReading).filter((r) => r.omzet !== null);
    if (parsed.data.jenis === "tidak_terbaca" || readings.length === 0) return { ok: false, reason: "tidak_terbaca" };
    return { ok: true, readings };
  }
}
