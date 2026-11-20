import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeExtractor } from "../src/infra/extractor.js";
import type { PlatformReading } from "../src/domain/types.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("dilewati: ANTHROPIC_API_KEY tidak ada");
  process.exit(0);
}

const ACUAN: Record<"shopee" | "tiktok", Record<string, number>> = {
  shopee: { omzet: 1317034, pesanan: 13, penontonMasuk: 952, keranjang: 62, komentar: 215, penontonAktif: 73, rataNontonDetik: 38, durasiDetik: 39632 },
  tiktok: { omzet: 578000, pesanan: 7, penontonMasuk: 770, impresi: 23700, komentar: 213, pengikutBaru: 5 },
};

function nilai(r: PlatformReading, k: string): number | null {
  const v = (r as unknown as Record<string, unknown>)[k];
  if (v === null || v === undefined) return null;
  return typeof v === "number" ? v : (v as { value: number }).value;
}

const image = readFileSync(new URL("../../test/fixtures/screens/live-17nov.jpg", import.meta.url));
const hasil = await new ClaudeExtractor(new Anthropic()).extract(image, "image/jpeg");
console.log(JSON.stringify(hasil, null, 2));
if (!hasil.ok) { console.error(`GAGAL: ${hasil.reason}`); process.exit(1); }

let lulus = true;
for (const platform of ["shopee", "tiktok"] as const) {
  const r = hasil.readings.find((x) => x.platform === platform);
  if (!r) { console.error(`GAGAL: ${platform} tidak terbaca`); lulus = false; continue; }
  for (const [k, harap] of Object.entries(ACUAN[platform])) {
    const got = nilai(r, k);
    const cocok = got === harap;
    if (!cocok) lulus = false;
    console.log(`${cocok ? "OK   " : "BEDA "} ${platform}.${k}: dapat ${got}, acuan ${harap}, selisih ${got === null ? "n/a" : got - harap}`);
  }
}
console.log(lulus ? "LULUS: semua field cocok" : "GAGAL: ada field berbeda");
process.exit(lulus ? 0 : 1);
