import { PEMBANDING, type Preset } from "./period.js";
import { MIN_HARI_INDEKS, type HariKelompok, type KreditRow } from "./rekap.js";
import type { targetHarianRows } from "./targets.js";

/**
 * Rumus tab dashboard CP – Live Tracker, dihitung dari tabel fakta Data Kredit dan Target Harian (R24).
 *
 * Nama rentang yang dipakai rumus (dibuat blueprint Task 13):
 * - `HARI_INI`: satu sel berisi =TODAY() (zona spreadsheet Asia/Jakarta). Rumus tidak memanggil TODAY() langsung.
 * - `DAFTAR_HOST`: daftar nama host vertikal (Pengaturan); dashboard menampilkan maksimal 10 host.
 *
 * Tab berfilter (Dashboard Host, Harian per Host, Analisis Live), baris 2–3:
 * - Input owner: B2 Periode, D2 Dari, F2 Sampai (dipakai hanya untuk Custom), H2 Bandingkan.
 * - Tersembunyi: J2/K2 rentang efektif, J3/K3 rentang pembanding (serial tanggal; "" kalau tidak valid/tanpa).
 * - Terlihat: B3 status ("Tanggal tidak valid" untuk Custom tanpa tanggal atau Dari > Sampai), D3/F3 rentang
 *   efektif, H3/I3 rentang pembanding (format tanggal). Kalau rentang tidak valid semua angka "" (kosong, bukan 0).
 *
 * Dashboard Host:
 * - Baris 5 (tim): A omzet live, B target bulan tim (Σ target harian tanpa gugur, bulan-bulan yang dilalui
 *   rentang), C seharusnya tim (s/d min(sampai, hari ini)), D % tercapai, E % seharusnya, F selisih jalur,
 *   G realisasi pembanding, H vs pembanding, I TikTok, J Shopee, K belum teratribusi.
 * - Baris 8–17 (host ke-1…10 DAFTAR_HOST): A Host, B Target bulan (setelah gugur), C Realisasi, D Progres
 *   (C÷B), E % seharusnya (N÷B), F Selisih jalur (C−N), H vs pembanding, I Jam on-air, J Omzet/jam, K Konversi,
 *   N Seharusnya (Rp, s/d hari ini, ≥ 0), O Realisasi pembanding. G, L, M ditulis bot (DASHBOARD_HOST_KONDISI).
 * Harian per Host: B3 juga memberi catatan bila rentang > 92 hari; B4:K4 host; A5:A96 tanggal; B5:K96 realisasi
 *   per host per tanggal ("" bila tidak ada data).
 * Analisis Live: B6:B16 corong Shopee (omzet, pesanan, dilihat, keranjang, komentar, ATC rate, cart-to-order,
 *   konversi, AOV, omzet/jam, komentar÷dilihat); E6:E15 corong TikTok (omzet, terjual, tayangan, impresi,
 *   komentar, pengikut baru, tap-in, konversi, nilai/produk, komentar÷tayangan); baris 20–29 per host
 *   (A Host, B omzet/jam, C AOV, D konversi, E add-to-cart, F komentar/jam, G indeks slot); B33:Y34 peta jam
 *   (baris Sen–Kam, Jum–Min; kolom jam 0–23); AA5:AA96 dan AB5 pembantu tersembunyi (hari live di rentang).
 * Tren Bulanan: A6:A29 awal bulan (bulan ini di atas, 24 bulan); B:F tim; mulai G, blok 5 kolom per host
 *   (nama di baris 4): Realisasi, Target, %, Omzet/jam, Konversi.
 * Kontrol: KONTROL_RANGE.
 */

export const LAYOUTS = ["Dashboard Host", "Harian per Host", "Analisis Live", "Tren Bulanan", "Kontrol"] as const;
export type Layout = (typeof LAYOUTS)[number];

export type TargetHarianRow = ReturnType<typeof targetHarianRows>[number];
export type NilaiSel = string | number | null;

/**
 * Kolom tab Data Kredit (baris 1 header, data mulai baris 2), satu baris per KreditRow. Tulis lewat kreditCells():
 * - tanggal: nilai tanggal Sheets = serial hari sejak 30-12-1899 (2026-11-20 → 46346), bukan teks; rumus
 *   membandingkannya secara numerik (">="&tanggal).
 * - jam: angka 0–23 (jam irisan Asia/Jakarta). hariKelompok: "Sen–Kam" | "Jum–Min".
 * - kolom angka null → sel kosong, bukan 0; rasio melewati sel kosong dengan kriteria "<>". Lewat Sheets API kirim
 *   "" (null dalam `values` dilewati API sehingga nilai lama bisa tertinggal saat baris ditimpa).
 * - status "dihitung" | "belum_teratribusi" (host "(belum teratribusi)").
 */
export const KREDIT_COLUMNS = [
  { key: "messageId", header: "ID Pesan" },
  { key: "tanggal", header: "Tanggal" },
  { key: "jam", header: "Jam" },
  { key: "hariKelompok", header: "Kelompok Hari" },
  { key: "host", header: "Host" },
  { key: "platform", header: "Platform" },
  { key: "omzet", header: "Omzet" },
  { key: "pesanan", header: "Pesanan" },
  { key: "penontonMasuk", header: "Penonton Masuk" },
  { key: "komentar", header: "Komentar" },
  { key: "keranjang", header: "Keranjang" },
  { key: "impresi", header: "Impresi" },
  { key: "pengikutBaru", header: "Pengikut Baru" },
  { key: "menitOnAir", header: "Menit On-air" },
  { key: "omzetHarapan", header: "Omzet Harapan" },
  { key: "status", header: "Status" },
] as const satisfies ReadonlyArray<{ key: keyof KreditRow; header: string }>;

/** Kolom tab Target Harian (baris 1 header), satu baris per targetHarianRows(); tanggal sebagai serial tanggal. */
export const TARGET_HARIAN_COLUMNS = [
  { key: "tanggal", header: "Tanggal" },
  { key: "host", header: "Host" },
  { key: "target", header: "Target" },
  { key: "gugur", header: "Gugur" },
  { key: "sebab", header: "Sebab" },
] as const satisfies ReadonlyArray<{ key: keyof TargetHarianRow; header: string }>;

/** Dashboard Host baris host 8–17 (urutan DAFTAR_HOST): kolom "kondisi saat ini" yang ditulis bot, tidak ikut filter. */
export const DASHBOARD_HOST_KONDISI = { barisPertama: 8, butuhPerHariKerja: "G", disiplin: "L", status: "M" } as const;
/** Tab Kontrol (pengecekan silang malam): Host | Realisasi bulan ini | Target bulan | Seharusnya s/d hari ini. */
export const KONTROL_RANGE = "A2:D11";

const EPOCH_SHEETS = Date.UTC(1899, 11, 30);
/** Serial tanggal Google Sheets (dan HyperFormula): hari sejak 30-12-1899. */
export function serialTanggal(date: string): number {
  return (Date.parse(`${date}T00:00:00.000Z`) - EPOCH_SHEETS) / 86_400_000;
}

export function kreditCells(row: KreditRow): NilaiSel[] {
  return KREDIT_COLUMNS.map(({ key }) => (key === "tanggal" ? serialTanggal(row.tanggal) : row[key]));
}

export function targetHarianCells(row: TargetHarianRow): NilaiSel[] {
  return TARGET_HARIAN_COLUMNS.map(({ key }) => (key === "tanggal" ? serialTanggal(row.tanggal) : row[key]));
}

// ---------- Penyusun rumus ----------

const MAX_HOST = 10;
const MAX_HARI = 92;
const JUMLAH_BULAN = 24;

const huruf = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : huruf(Math.floor(i / 26) - 1) + huruf(i % 26));
const kolomPenuh = (tab: string, i: number): string => `'${tab}'!$${huruf(i)}:$${huruf(i)}`;
type KolomKredit = (typeof KREDIT_COLUMNS)[number]["key"];
type KolomTarget = (typeof TARGET_HARIAN_COLUMNS)[number]["key"];
const kr = (k: KolomKredit): string => kolomPenuh("Data Kredit", KREDIT_COLUMNS.findIndex((c) => c.key === k));
const th = (k: KolomTarget): string => kolomPenuh("Target Harian", TARGET_HARIAN_COLUMNS.findIndex((c) => c.key === k));

type Syarat = readonly [rentang: string, kriteria: string];
const pasangan = (s: readonly Syarat[]): string => s.map(([r, k]) => `${r},${k}`).join(",");
const sumifs = (jumlah: string, s: readonly Syarat[]): string => `SUMIFS(${jumlah},${pasangan(s)})`;
const countifs = (s: readonly Syarat[]): string => `COUNTIFS(${pasangan(s)})`;
const banding = (op: string, expr: string): string => `"${op}"&${/^[$A-Z0-9_]+$/.test(expr) ? expr : `(${expr})`}`;
const antara = (kolom: string, dari: string, sampai: string): Syarat[] => [[kolom, banding(">=", dari)], [kolom, banding("<=", sampai)]];

const dihitung: Syarat = [kr("status"), '"dihitung"'];
const ada = (k: KolomKredit): Syarat => [kr(k), '"<>"'];
const sama = (k: KolomKredit, v: string): Syarat => [kr(k), v];
const hostKredit = (ref: string): Syarat => [kr("host"), ref];
const hostTarget = (ref: string): Syarat => [th("host"), ref];
const tglKredit = (dari: string, sampai: string): Syarat[] => antara(kr("tanggal"), dari, sampai);
const tglTarget = (dari: string, sampai: string): Syarat[] => antara(th("tanggal"), dari, sampai);

const omzet = (s: readonly Syarat[]): string => sumifs(kr("omzet"), s);
const jamOnAir = (s: readonly Syarat[]): string => `(${sumifs(kr("menitOnAir"), s)}/60)`;
/** Σ target − Σ gugur (target pribadi setelah gugur). */
const targetBersih = (s: readonly Syarat[]): string => `${sumifs(th("target"), s)}-${sumifs(th("gugur"), s)}`;
/** Jumlah field; "" kalau tidak ada baris yang punya field itu (null bukan 0). */
const total = (k: KolomKredit, s: readonly Syarat[]): string => `IF(${countifs([ada(k), ...s])}=0,"",${sumifs(kr(k), s)})`;
/** Rasio berpasangan: hanya baris yang punya pembilang dan penyebut; "" kalau penyebut 0. */
const rasio = (a: KolomKredit, b: KolomKredit, s: readonly Syarat[]): string => {
  const p = [ada(a), ada(b), ...s];
  return `IFERROR(${sumifs(kr(a), p)}/${sumifs(kr(b), p)},"")`;
};
/** =IF(salah satu kondisi kosong,"",expr) */
const kecuali = (kosong: string[], expr: string): string =>
  `=IF(${kosong.length === 1 ? `${kosong[0]}=""` : `OR(${kosong.map((k) => `${k}=""`).join(",")})`},"",${expr})`;
/** Nama host ke-i DAFTAR_HOST, TRIM: spasi berlebih di Pengaturan tidak membuat kriteria SUMIFS meleset (bot memangkas nama). */
const namaHost = (i: number): string => `=IFERROR(TRIM(INDEX(DAFTAR_HOST,${i})&""),"")`;

// ---------- Filter periode (logika sama dengan periodRange / comparisonRange) ----------

const H = "HARI_INI";
const DARI = "$J$2";
const SAMPAI = "$K$2";
const PB_DARI = "$J$3";
const PB_SAMPAI = "$K$3";
type PresetTetap = Exclude<Preset, "Custom">;
const PRESET_DARI: Record<PresetTetap, string> = {
  "Hari ini": H, "Kemarin": `${H}-1`, "7 hari terakhir": `${H}-6`, "30 hari terakhir": `${H}-29`,
  "Minggu ini": `${H}-WEEKDAY(${H},2)+1`, "Minggu lalu": `${H}-WEEKDAY(${H},2)-6`,
  "Bulan ini": `EOMONTH(${H},-1)+1`, "Bulan lalu": `EOMONTH(${H},-2)+1`,
};
const PRESET_SAMPAI: Record<PresetTetap, string> = {
  "Hari ini": H, "Kemarin": `${H}-1`, "7 hari terakhir": H, "30 hari terakhir": H,
  "Minggu ini": H, "Minggu lalu": `${H}-WEEKDAY(${H},2)`, "Bulan ini": H, "Bulan lalu": `EOMONTH(${H},-1)`,
};
const pilihPreset = (tabel: Record<PresetTetap, string>, lain: string): string =>
  Object.entries(tabel).reduceRight((sisa, [p, f]) => `IF($B$2="${p}",${f},${sisa})`, lain);
const STATUS_TIDAK_VALID = `IF($B$2="Custom","Tanggal tidak valid","Pilih periode")`;

function blokFilter(status: string): Record<string, string> {
  const sebelumnya = `$H$2="${PEMBANDING.sebelumnya}"`;
  const bulanLalu = `$H$2="${PEMBANDING.bulan_lalu}"`;
  // Bulan lalu tanggal sama (R25): tanggal x sebulan sebelumnya, hari dijepit ke panjang bulan itu.
  const bulanSebelumnya = (x: string): string =>
    `EOMONTH(${x},-2)+MIN(${x}-EOMONTH(${x},-1),EOMONTH(${x},-1)-EOMONTH(${x},-2))`;
  return {
    J2: `=${pilihPreset(PRESET_DARI, `IF(AND($B$2="Custom",$D$2<>"",$F$2<>"",$D$2<=$F$2),$D$2,"")`)}`,
    K2: `=IF(${DARI}="","",${pilihPreset(PRESET_SAMPAI, "$F$2")})`,
    J3: `=IF(${DARI}="","",IF(${sebelumnya},2*${DARI}-${SAMPAI}-1,IF(${bulanLalu},${bulanSebelumnya(DARI)},"")))`,
    K3: `=IF(${DARI}="","",IF(${sebelumnya},${DARI}-1,IF(${bulanLalu},${bulanSebelumnya(SAMPAI)},"")))`,
    B3: `=${status}`,
    D3: `=${DARI}`, F3: `=${SAMPAI}`, H3: `=${PB_DARI}`, I3: `=${PB_SAMPAI}`,
  };
}
const statusUmum = `IF(${DARI}<>"","",${STATUS_TIDAK_VALID})`;

// ---------- Tab ----------

function dashboardHost(): Record<string, string> {
  const f = blokFilter(statusUmum);
  const rentang = tglKredit(DARI, SAMPAI);
  const pembanding = tglKredit(PB_DARI, PB_SAMPAI);
  const bulanPenuh = tglTarget(`EOMONTH(${DARI},-1)+1`, `EOMONTH(${SAMPAI},0)`);
  const sampaiHariIni = tglTarget(DARI, `MIN(${SAMPAI},${H})`);
  const platform = (p: string): string => kecuali([DARI], omzet([dihitung, sama("platform", `"${p}"`), ...rentang]));

  Object.assign(f, {
    A5: kecuali([DARI], omzet([dihitung, ...rentang])),
    B5: kecuali([DARI], sumifs(th("target"), bulanPenuh)),
    C5: kecuali([DARI], sumifs(th("target"), sampaiHariIni)),
    D5: kecuali([DARI], "IF($B$5>0,$A$5/$B$5,0)"),
    E5: kecuali([DARI], "IF($B$5>0,$C$5/$B$5,0)"),
    F5: kecuali([DARI], "$A$5-$C$5"),
    G5: kecuali([PB_DARI], omzet([dihitung, ...pembanding])),
    H5: '=IF($G$5="","",IF($G$5>0,$A$5/$G$5-1,""))',
    I5: platform("tiktok"),
    J5: platform("shopee"),
    K5: kecuali([DARI], omzet([sama("status", '"belum_teratribusi"'), ...rentang])),
  });

  for (let i = 1; i <= MAX_HOST; i++) {
    const r = DASHBOARD_HOST_KONDISI.barisPertama + i - 1;
    const h = `$A${r}`;
    const kosong = [DARI, h];
    const milik = [hostKredit(h), dihitung, ...rentang];
    Object.assign(f, {
      [`A${r}`]: namaHost(i),
      [`B${r}`]: kecuali(kosong, targetBersih([hostTarget(h), ...bulanPenuh])),
      [`C${r}`]: kecuali(kosong, omzet(milik)),
      [`D${r}`]: kecuali(kosong, `IF($B${r}>0,$C${r}/$B${r},0)`),
      [`E${r}`]: kecuali(kosong, `IF($B${r}>0,$N${r}/$B${r},0)`),
      [`F${r}`]: kecuali(kosong, `$C${r}-$N${r}`),
      [`H${r}`]: `=IF($O${r}="","",IF($O${r}>0,$C${r}/$O${r}-1,""))`,
      [`I${r}`]: kecuali(kosong, jamOnAir(milik)),
      [`J${r}`]: kecuali(kosong, `IF($I${r}>0,$C${r}/$I${r},"")`),
      [`K${r}`]: kecuali(kosong, rasio("pesanan", "penontonMasuk", milik)),
      [`N${r}`]: kecuali(kosong, `MAX(0,${targetBersih([hostTarget(h), ...sampaiHariIni])})`),
      [`O${r}`]: kecuali([PB_DARI, h], omzet([hostKredit(h), dihitung, ...pembanding])),
    });
  }
  return f;
}

function harianPerHost(): Record<string, string> {
  const f = blokFilter(
    `IF(${DARI}="",${STATUS_TIDAK_VALID},IF(${SAMPAI}-${DARI}+1>${MAX_HARI},"Hanya ${MAX_HARI} hari pertama ditampilkan",""))`,
  );
  for (let i = 1; i <= MAX_HOST; i++) f[`${huruf(i)}4`] = namaHost(i);
  for (let k = 0; k < MAX_HARI; k++) {
    const r = 5 + k;
    const tgl = k === 0 ? DARI : `${DARI}+${k}`;
    f[`A${r}`] = `=IF(${DARI}="","",IF(${tgl}>${SAMPAI},"",${tgl}))`;
    for (let i = 1; i <= MAX_HOST; i++) {
      const h = `${huruf(i)}$4`;
      f[`${huruf(i)}${r}`] = kecuali([`$A${r}`, h], total("omzet", [hostKredit(h), dihitung, sama("tanggal", `$A${r}`)]));
    }
  }
  return f;
}

function analisisLive(): Record<string, string> {
  const f = blokFilter(statusUmum);
  const rentang = tglKredit(DARI, SAMPAI);
  const nilai = (expr: string): string => kecuali([DARI], expr);

  // A. Corong per platform: semua baris (termasuk belum teratribusi), seperti funnel() tanpa filter host.
  const shopee = [sama("platform", '"shopee"'), ...rentang];
  const tiktok = [sama("platform", '"tiktok"'), ...rentang];
  (["omzet", "pesanan", "penontonMasuk", "keranjang", "komentar"] as const).forEach((k, i) => {
    f[`B${6 + i}`] = nilai(total(k, shopee));
  });
  Object.assign(f, {
    B11: nilai(rasio("keranjang", "penontonMasuk", shopee)),
    B12: nilai(rasio("pesanan", "keranjang", shopee)),
    B13: nilai(rasio("pesanan", "penontonMasuk", shopee)),
    B14: nilai(rasio("omzet", "pesanan", shopee)),
    // Omzet Shopee ÷ jam on-air semua baris di rentang (kedua platform berjalan bersama).
    B15: nilai(`IF($B$6="","",IFERROR($B$6/${jamOnAir(rentang)},""))`),
    B16: nilai(rasio("komentar", "penontonMasuk", shopee)),
  });
  (["omzet", "pesanan", "penontonMasuk", "impresi", "komentar", "pengikutBaru"] as const).forEach((k, i) => {
    f[`E${6 + i}`] = nilai(total(k, tiktok));
  });
  Object.assign(f, {
    E12: nilai(rasio("penontonMasuk", "impresi", tiktok)),
    E13: nilai(rasio("pesanan", "penontonMasuk", tiktok)),
    E14: nilai(rasio("omzet", "pesanan", tiktok)),
    E15: nilai(rasio("komentar", "penontonMasuk", tiktok)),
  });

  // B. Per host. Indeks slot = Σ omzet ÷ Σ omzet harapan, hanya kalau rentang punya ≥ 21 hari live.
  for (let i = 1; i <= MAX_HOST; i++) {
    const r = 19 + i;
    const h = `$A${r}`;
    const milik = [hostKredit(h), dihitung, ...rentang];
    const kosong = [DARI, h];
    const adaKomentar = [ada("komentar"), ...milik];
    const adaOmzet = [ada("omzet"), ...milik];
    Object.assign(f, {
      [`A${r}`]: namaHost(i),
      [`B${r}`]: kecuali(kosong, `IFERROR(${omzet(milik)}/${jamOnAir(milik)},"")`),
      [`C${r}`]: kecuali(kosong, rasio("omzet", "pesanan", milik)),
      [`D${r}`]: kecuali(kosong, rasio("pesanan", "penontonMasuk", milik)),
      [`E${r}`]: kecuali(kosong, rasio("keranjang", "penontonMasuk", milik)),
      [`F${r}`]: kecuali(kosong, `IFERROR(${sumifs(kr("komentar"), adaKomentar)}/${jamOnAir(adaKomentar)},"")`),
      [`G${r}`]: kecuali(kosong,
        `IF($AB$5<${MIN_HARI_INDEKS},"",IFERROR(${omzet(adaOmzet)}/${sumifs(kr("omzetHarapan"), adaOmzet)},""))`),
    });
  }

  // C. Peta jam ramai: omzet ÷ jam on-air baris yang punya omzet, per kelompok hari dan jam irisan.
  const kelompok: HariKelompok[] = ["Sen–Kam", "Jum–Min"];
  kelompok.forEach((kel, i) => {
    for (let jam = 0; jam < 24; jam++) {
      const s = [ada("omzet"), dihitung, sama("hariKelompok", `"${kel}"`), sama("jam", String(jam)), ...rentang];
      f[`${huruf(1 + jam)}${33 + i}`] = nilai(`IFERROR(${omzet(s)}/${jamOnAir(s)},"")`);
    }
  });

  // Pembantu: 1 bila tanggal ke-k rentang punya baris dihitung; AB5 = jumlah hari live.
  for (let k = 0; k < MAX_HARI; k++) {
    const tgl = k === 0 ? DARI : `${DARI}+${k}`;
    f[`AA${5 + k}`] = `=IF(${DARI}="","",IF(${tgl}>${SAMPAI},"",IF(${countifs([dihitung, sama("tanggal", tgl)])}>0,1,0)))`;
  }
  f.AB5 = `=IF(${DARI}="","",COUNTIFS($AA$5:$AA$${4 + MAX_HARI},1))`;
  return f;
}

function trenBulanan(): Record<string, string> {
  const f: Record<string, string> = {};
  const blok = (i: number): string[] => [0, 1, 2, 3, 4].map((j) => huruf(6 + 5 * (i - 1) + j));
  for (let i = 1; i <= MAX_HOST; i++) f[`${blok(i)[0]}4`] = namaHost(i);
  for (let m = 0; m < JUMLAH_BULAN; m++) {
    const r = 6 + m;
    const bulanKredit = tglKredit(`$A${r}`, `EOMONTH($A${r},0)`);
    const bulanTarget = tglTarget(`$A${r}`, `EOMONTH($A${r},0)`);
    f[`A${r}`] = `=EOMONTH(${H},${-m - 1})+1`;

    // Tim: target tim = Σ target harian tanpa gugur (target tim tidak berubah karena gangguan/izin).
    const tim = [dihitung, ...bulanKredit];
    Object.assign(f, {
      [`B${r}`]: `=IF(${countifs(bulanKredit)}+${countifs(bulanTarget)}=0,"",${omzet(tim)})`,
      [`C${r}`]: kecuali([`$B${r}`], sumifs(th("target"), bulanTarget)),
      [`D${r}`]: kecuali([`$B${r}`], `IF($C${r}>0,$B${r}/$C${r},0)`),
      [`E${r}`]: kecuali([`$B${r}`], `IFERROR($B${r}/${jamOnAir(tim)},"")`),
      [`F${r}`]: kecuali([`$B${r}`], rasio("pesanan", "penontonMasuk", tim)),
    });

    for (let i = 1; i <= MAX_HOST; i++) {
      const [R, T, P, O, K] = blok(i) as [string, string, string, string, string];
      const h = `${R}$4`;
      const milik = [hostKredit(h), dihitung, ...bulanKredit];
      // IF bersarang (bukan OR) supaya blok host kosong tidak menghitung COUNTIFS: OR di Sheets tidak malas.
      const adaData = `${countifs([hostKredit(h), ...bulanKredit])}+${countifs([hostTarget(h), ...bulanTarget])}>0`;
      Object.assign(f, {
        [`${R}${r}`]: `=IF(${h}="","",IF(${adaData},${omzet(milik)},""))`,
        [`${T}${r}`]: kecuali([`$${R}${r}`], targetBersih([hostTarget(h), ...bulanTarget])),
        [`${P}${r}`]: kecuali([`$${R}${r}`], `IF($${T}${r}>0,$${R}${r}/$${T}${r},0)`),
        [`${O}${r}`]: kecuali([`$${R}${r}`], `IFERROR($${R}${r}/${jamOnAir(milik)},"")`),
        [`${K}${r}`]: kecuali([`$${R}${r}`], rasio("pesanan", "penontonMasuk", milik)),
      });
    }
  }
  return f;
}

function kontrol(): Record<string, string> {
  const f: Record<string, string> = {};
  const awal = `EOMONTH(${H},-1)+1`;
  for (let i = 1; i <= MAX_HOST; i++) {
    const r = 1 + i;
    const h = `$A${r}`;
    Object.assign(f, {
      [`A${r}`]: namaHost(i),
      [`B${r}`]: kecuali([h], omzet([hostKredit(h), dihitung, ...tglKredit(awal, H)])),
      [`C${r}`]: kecuali([h], targetBersih([hostTarget(h), ...tglTarget(awal, `EOMONTH(${H},0)`)])),
      [`D${r}`]: kecuali([h], `MAX(0,${targetBersih([hostTarget(h), ...tglTarget(awal, H)])})`),
    });
  }
  return f;
}

/** Rumus per sel A1 untuk satu tab dashboard. */
export function dashboardFormulas(layout: Layout): Record<string, string> {
  switch (layout) {
    case "Dashboard Host": return dashboardHost();
    case "Harian per Host": return harianPerHost();
    case "Analisis Live": return analisisLive();
    case "Tren Bulanan": return trenBulanan();
    case "Kontrol": return kontrol();
  }
}
