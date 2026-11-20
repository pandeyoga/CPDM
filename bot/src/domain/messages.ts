import type { Command } from "./caption.js";
import type { HostSummary } from "./rekap.js";
import type { Flag, HostConfig, Platform } from "./types.js";

const IKON = { ok: "✅", warn: "⚠️", bad: "🔴" } as const;
const NAMA_PLATFORM: Record<Platform, string> = { tiktok: "TikTok", shopee: "Shopee" };

const titik = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

export function rp(n: number): string {
  const bulat = Math.round(Math.abs(n));
  return `${n < 0 && bulat > 0 ? "−" : ""}Rp${titik(bulat)}`;
}

// Satu desimal dengan koma; ",0" dibuang.
function satuDesimal(x: number): string {
  const s = (Math.round(x * 10) / 10).toFixed(1).replace(".", ",");
  return s.endsWith(",0") ? s.slice(0, -2) : s;
}

export function rpRingkas(n: number): string {
  const abs = Math.abs(n);
  const tanda = n < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${tanda}Rp${satuDesimal(abs / 1_000_000)} jt`;
  if (abs >= 1_000) return `${tanda}Rp${titik(Math.round(abs / 1_000))} rb`;
  return rp(n);
}

const persen = (fraksi: number): string => `${satuDesimal(fraksi * 100)}%`;

const tgl = (date: string): string => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

export function mention(host: HostConfig): string {
  if (host.waId) return `@${host.waId.split("@")[0] ?? host.waId}`;
  return `@${host.name}`;
}

export function msgPagi(date: string, rows: HostSummary[], gangguanKemarin: string[]): string {
  const baris = rows.map((r) => {
    const pctSeharusnya = r.seharusnya > 0 ? ` · ${persen(r.realisasi / r.seharusnya)} dari yang seharusnya` : "";
    return `${IKON[r.status]} *${r.host}*: ${rpRingkas(r.realisasi)} dari ${rpRingkas(r.target)} (${persen(r.pctTarget)})${pctSeharusnya}\n   Ayo kejar ${rpRingkas(Math.max(0, r.butuhPerHariKerja))} per hari kerja`;
  });
  const out = [`Selamat pagi tim! Update target ${tgl(date)}`, "", ...baris];
  if (gangguanKemarin.length > 0) out.push("", `Catatan: kemarin ada gangguan di ${gangguanKemarin.join(", ")}.`);
  out.push("", "Semangat live hari ini!");
  return out.join("\n");
}

export function msgTanda(
  host: HostConfig,
  perPlatform: Array<{ platform: Platform; kredit: number; rounded: boolean }>,
  flags: Flag[],
): string {
  const bagian = perPlatform.map((p) => `${NAMA_PLATFORM[p.platform]} +${rp(p.kredit)}${p.rounded ? "*" : ""}`);
  const baris = [`✅ Tercatat — ${host.name} · ${bagian.join(" · ")} · Balas kalau angka salah`];
  if (perPlatform.some((p) => p.rounded)) baris.push("*angka TikTok dibulatkan");
  if (flags.includes("siaran_baru")) baris.push("Siaran baru tercatat");
  if (flags.includes("layar_akhir")) baris.push("Layar akhir tercatat");
  return baris.join("\n");
}

export function msgSiapa(): string {
  return "Laporan ini dari siapa? Balas dengan nama host ya.";
}

export function msgKirimUlang(reason: "bukan_layar_live" | "tidak_terbaca" | "ditolak"): string {
  switch (reason) {
    case "bukan_layar_live":
      return "Gambar ini bukan layar data live. Mohon kirim ulang screenshot layar data live.";
    case "tidak_terbaca":
      return "Angkanya belum terbaca jelas. Mohon kirim ulang screenshot layar data live yang lebih jelas.";
    case "ditolak":
      return "Gambar ini belum bisa diproses. Mohon kirim ulang screenshot layar data live yang lebih jelas.";
  }
}

export function msgDiproses(): string {
  return "Laporan diterima, sedang diproses.";
}

export function msgMintaRiwayat(host: HostConfig, platform: Platform): string {
  return `${mention(host)} mohon kirim screenshot layar akhir dari riwayat live ${NAMA_PLATFORM[platform]} di aplikasi, dengan membalas pesan ini.`;
}

export function msgRekap(date: string, rows: HostSummary[], harian: Record<string, number>): string {
  const baris = rows.map(
    (r) => `${IKON[r.status]} *${r.host}*: hari ini ${rpRingkas(harian[r.host] ?? 0)} · bulan ini ${rpRingkas(r.realisasi)} (${persen(r.pctTarget)} dari target)`,
  );
  const total = rows.reduce((a, r) => a + r.realisasi, 0);
  const totalHari = Object.values(harian).reduce((a, v) => a + v, 0);
  return [
    `Rekap malam ${tgl(date)}`,
    "",
    ...baris,
    "",
    `Total tim: hari ini ${rpRingkas(totalHari)} · bulan ini ${rpRingkas(total)}`,
    "Terima kasih, istirahat yang cukup!",
  ].join("\n");
}

export function msgOwner(
  date: string,
  info: { bolong: string[]; belumLengkap: number; belumTeratribusi: number; koreksiMenunggu: number; eskalasi: string[] },
): string {
  const out = [`Ringkasan owner ${tgl(date)}`];
  if (info.bolong.length > 0) out.push(`Jeda laporan tidak wajar: ${info.bolong.join(", ")}`);
  if (info.belumLengkap > 0) out.push(`Siaran belum lengkap: ${info.belumLengkap}`);
  if (info.belumTeratribusi > 0) out.push(`Belum teratribusi: ${info.belumTeratribusi}`);
  if (info.koreksiMenunggu > 0) out.push(`Koreksi menunggu persetujuan: ${info.koreksiMenunggu}`);
  for (const nama of info.eskalasi) out.push(`🔴 ${nama} sudah 3 hari live berturut-turut di bawah target per hari kerja. Perlu ditindaklanjuti.`);
  if (out.length === 1) out.push("Tidak ada hal yang perlu ditindaklanjuti.");
  return out.join("\n");
}

export function msgAckKoreksi(platform: Platform): string {
  return `Koreksi ${NAMA_PLATFORM[platform]} dicatat, menunggu persetujuan owner.`;
}

export function msgFormatKoreksi(): string {
  return "Koreksinya belum terbaca. Balas tanda terima dengan format: koreksi shopee 1.350.000 (atau misalnya: koreksi tiktok pesanan 9).";
}

export function msgAckPerintah(cmd: Command): string {
  switch (cmd.kind) {
    case "gangguan":
      return `Gangguan ${cmd.scope === "semua" ? "semua platform" : NAMA_PLATFORM[cmd.scope]} dicatat (${cmd.alasan}), menunggu persetujuan owner.`;
    case "normal":
      return "Kembali normal dicatat.";
    case "izin":
      return `Izin ${tgl(cmd.date)} dicatat (${cmd.alasan}), menunggu persetujuan owner.`;
  }
}
