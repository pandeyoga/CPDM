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

/** Satuan dipilih sesudah pembulatan: 999.950 → "Rp1 jt", bukan "Rp1.000 rb". */
export function rpRingkas(n: number): string {
  const abs = Math.abs(n);
  const tanda = n < 0 ? "−" : "";
  const ribu = Math.round(abs / 1_000);
  if (ribu >= 1_000) return `${tanda}Rp${satuDesimal(abs / 1_000_000)} jt`;
  if (Math.round(abs) >= 1_000) return `${tanda}Rp${titik(ribu)} rb`;
  return rp(n);
}

const persen = (fraksi: number): string => `${satuDesimal(fraksi * 100)}%`;
/** Perubahan bertanda satu desimal: 0,05 → "+5,0%", −0,032 → "−3,2%". */
const persenBertanda = (fraksi: number): string =>
  `${fraksi > 0 ? "+" : fraksi < 0 ? "−" : ""}${(Math.abs(fraksi) * 100).toFixed(1).replace(".", ",")}%`;

const tgl = (date: string): string => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const tglPenuh = (date: string): string => `${tgl(date)}/${date.slice(0, 4)}`;

export function mention(host: HostConfig): string {
  if (host.waId) return `@${host.waId.split("@")[0] ?? host.waId}`;
  return `@${host.name}`;
}

/**
 * Update pagi per host: realisasi bulan berjalan, % vs seharusnya, selisih kurang/lebih, vs bulan lalu, jam shift
 * (`shift[host]`, hanya saat Jadwal aktif dan diketahui), kebutuhan per hari kerja (atau ucapan selamat bila target
 * sudah tercapai). Host ⚠️/🔴 mendapat satu baris yang lebih tegas, tanpa mempermalukan.
 */
export function msgPagi(date: string, rows: HostSummary[], gangguanKemarin: string[], shift: Record<string, string> = {}): string {
  const baris = rows.map((r) => {
    const adaTarget = r.target > 0;
    const out = [adaTarget
      ? `${IKON[r.status]} *${r.host}*: ${rpRingkas(r.realisasi)} dari target ${rpRingkas(r.target)} (${persen(r.pctTarget)})`
      : `${IKON[r.status]} *${r.host}*: ${rpRingkas(r.realisasi)} bulan ini · target bulan belum diisi`];
    const rincian: string[] = [];
    if (adaTarget && r.seharusnya > 0) {
      rincian.push(`${persen(r.realisasi / r.seharusnya)} dari yang seharusnya`);
      rincian.push(r.selisih < 0 ? `kurang ${rpRingkas(-r.selisih)}` : r.selisih > 0 ? `lebih ${rpRingkas(r.selisih)}` : "pas sesuai jalur");
    }
    rincian.push(`${r.vsBulanLalu === null ? "–" : persenBertanda(r.vsBulanLalu)} vs bulan lalu`);
    out.push(`   ${rincian.join(" · ")}`);
    if (shift[r.host]) out.push(`   Shift ${shift[r.host]}`);
    if (adaTarget) {
      if (r.butuhPerHariKerja > 0) {
        out.push(`   Ayo kejar ${rpRingkas(r.butuhPerHariKerja)} per hari kerja`);
        if (r.status !== "ok") out.push("   Perlu dikejar hari ini, semangat!");
      } else {
        out.push("   Target bulan ini sudah tercapai, selamat! 🎉");
      }
    }
    return out.join("\n");
  });
  const out = [`Selamat pagi tim! Update target ${tgl(date)}`, "", ...baris];
  if (gangguanKemarin.length > 0) out.push("", `Catatan: kemarin ada gangguan di ${gangguanKemarin.join(", ")}.`);
  out.push("", "Semangat live hari ini!");
  return out.join("\n");
}

export function msgTanda(
  host: HostConfig,
  perPlatform: Array<{ platform: Platform; kredit: number | null; rounded: boolean }>,
  flags: Flag[],
): string {
  // Kredit null = omzet tidak terbaca (sel kosong bukan 0).
  const bagian = perPlatform.map((p) =>
    p.kredit === null ? `${NAMA_PLATFORM[p.platform]} omzet belum terbaca` : `${NAMA_PLATFORM[p.platform]} +${rp(p.kredit)}${p.rounded ? "*" : ""}`);
  const baris = [`✅ Tercatat — ${host.name} · ${bagian.join(" · ")} · Balas kalau angka salah`];
  if (perPlatform.some((p) => p.rounded)) baris.push("*angka TikTok dibulatkan");
  if (flags.includes("siaran_baru")) baris.push("Siaran baru tercatat");
  if (flags.includes("layar_akhir")) baris.push("Layar akhir tercatat");
  return baris.join("\n");
}

export function msgSiapa(): string {
  return "Ini laporan siapa?";
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

const barisEskalasi = (nama: string): string =>
  `${IKON.bad} ${nama} sudah 3 hari live berturut-turut di bawah target per hari kerja. Perlu ditindaklanjuti.`;

export function msgOwner(
  date: string,
  info: { bolong: string[]; belumLengkap: number; belumTeratribusi: number; koreksiMenunggu: number; eskalasi: string[] },
): string {
  const out = [`Ringkasan owner ${tgl(date)}`];
  if (info.bolong.length > 0) out.push(`Jeda laporan tidak wajar: ${info.bolong.join(", ")}`);
  if (info.belumLengkap > 0) out.push(`Siaran belum lengkap: ${info.belumLengkap}`);
  if (info.belumTeratribusi > 0) out.push(`Belum teratribusi: ${info.belumTeratribusi}`);
  if (info.koreksiMenunggu > 0) out.push(`Koreksi menunggu persetujuan: ${info.koreksiMenunggu}`);
  for (const nama of info.eskalasi) out.push(barisEskalasi(nama));
  if (out.length === 1) out.push("Tidak ada hal yang perlu ditindaklanjuti.");
  return out.join("\n");
}

export function msgAckKoreksi(platform: Platform): string {
  return `Koreksi ${NAMA_PLATFORM[platform]} dicatat, menunggu persetujuan owner.`;
}

/** Laporan tercatat atas nama host yang salah ("koreksi host Vanna"). */
export function msgAckAtribusi(host: string): string {
  return `Atribusi ke ${host} dicatat, menunggu persetujuan owner.`;
}

export function msgKoreksiTanpaPlatform(platform: Platform): string {
  return `Laporan itu tidak memuat angka ${NAMA_PLATFORM[platform]}, jadi koreksinya tidak dicatat.`;
}

export function msgFormatKoreksi(): string {
  return "Koreksinya belum terbaca. Balas tanda terima dengan format: koreksi shopee 1.350.000 (atau misalnya: koreksi tiktok pesanan 9). Kalau laporannya tercatat atas nama host yang salah: koreksi host <nama host>.";
}

export function msgAckPerintah(cmd: Command): string {
  switch (cmd.kind) {
    case "gangguan":
      return `Gangguan ${cmd.scope === "semua" ? "semua platform" : NAMA_PLATFORM[cmd.scope]} dicatat (${cmd.alasan}), menunggu persetujuan owner.`;
    case "normal":
      return "Kembali normal dicatat.";
    case "izin":
      return `Izin ${tglPenuh(cmd.date)} dicatat (${cmd.alasan}), menunggu persetujuan owner.`;
  }
}

/* ---------- Penjadwal (Task 12) ---------- */

/** Pesan pribadi ke owner saat streak 3 hari di bawah target per hari kerja baru dimulai. */
export function msgEskalasi(nama: string[]): string {
  return nama.map(barisEskalasi).join("\n");
}

/** Satu tag di grup untuk host yang masuk shift tapi belum lapor sama sekali (hanya Jadwal aktif = YA). */
export function msgBelumLapor(hosts: HostConfig[]): string {
  return `${hosts.map(mention).join(" ")} shift hari ini sudah selesai, tapi laporan live-nya belum masuk. Mohon kirim screenshot layar data live ya.`;
}

/** Pengecekan silang malam: tab Kontrol berbeda lebih dari Rp1 dari hitungan bot. */
export function msgTidakCocok(hosts: string[]): string {
  return `Angka dashboard tidak cocok untuk ${hosts.join(", ")}, sedang dicek`;
}

const MAKS_INPUT_TIDAK_VALID = 10;

export function msgInputTidakValid(items: Array<{ tab: string; row: number; reason: string }>): string {
  const sisa = items.length - MAKS_INPUT_TIDAK_VALID;
  return [
    "Ada isian spreadsheet yang tidak valid, jadi diabaikan bot:",
    ...items.slice(0, MAKS_INPUT_TIDAK_VALID).map((i) => `- ${i.tab} baris ${i.row}: ${i.reason}`),
    ...(sisa > 0 ? [`dan ${sisa} lainnya (lihat Log Bot)`] : []),
    "Mohon diperbaiki di spreadsheet.",
  ].join("\n");
}

export function msgGangguanDitutup(rows: Array<{ tanggal: string; host: string; mulai: string; selesai: string }>): string {
  return [
    "Gangguan belum ditutup dengan #normal, jadi bot mencatat jam selesainya otomatis di jam selesai live (menunggu persetujuan di tab Gangguan):",
    ...rows.map((r) => `- ${r.host || "(host belum diisi)"} ${tgl(r.tanggal)} ${r.mulai}–${r.selesai}`),
    "Kalau gangguannya masih berlangsung, kirim #gangguan lagi di grup.",
  ].join("\n");
}

/** Jadwal aktif = YA tapi jadwal kosong atau tak terbaca: bot sementara memakai mode tanpa jadwal (sekali per hari). */
export function msgJadwalTidakTerbaca(): string {
  return "Jadwal aktif = YA, tapi jadwal kosong atau tidak terbaca. Sementara bot memakai mode tanpa jadwal: tidak ada tag akhir shift dan target dibagi rata. Mohon cek tab Data Jadwal (header Tanggal, Nama, Shift, Mulai, Selesai; Nama sama dengan nama host).";
}

/** Gambar tertunda yang tidak bisa diunduh lagi setelah 24 jam (berkas lokal hilang) dibuang. */
export function msgGambarHilang(host: string, tanggal: string, jam: string): string {
  return `Laporan ${host} ${tgl(tanggal)} pukul ${jam} tidak bisa diproses: gambarnya sudah tidak bisa diunduh lagi. Mohon minta host mengirim ulang screenshot-nya di grup.`;
}

/** Kolom Status "kondisi saat ini" di Dashboard Host. */
export function teksStatus(s: Pick<HostSummary, "status" | "streakDiBawah">): string {
  if (s.status === "bad" && s.streakDiBawah >= 3) return `${IKON.bad} ${s.streakDiBawah} hari berturut-turut di bawah target`;
  if (s.status === "ok") return `${IKON.ok} sesuai jalur`;
  return s.status === "warn" ? `${IKON.warn} sedikit tertinggal` : `${IKON.bad} tertinggal`;
}
