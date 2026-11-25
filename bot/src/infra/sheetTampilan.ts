import type { sheets_v4 } from "googleapis";
import { a1ToGrid, type TabBlueprint } from "./sheetBlueprint.js";
import { TAB } from "./sheets.js";

/**
 * Lapisan tampilan CP – Live Tracker (format-live.png, format-anlive.png): warna header, kolom isian biru, lebar
 * kolom, baris beku, kotak KPI, warna bersyarat hijau/kuning/merah, peta jam bergradasi, warna tab, garis tabel.
 * Fungsi murni; setup-sheet mengirimnya dalam batchUpdate tersendiri SELAGI locale en_US (rumus warna bersyarat
 * ikut locale, sama seperti rumus sel). Idempoten: aturan warna bersyarat lama dihapus dulu (jumlah per tab dari
 * spreadsheets.get), sisanya menimpa nilai yang sama.
 */

type Request = sheets_v4.Schema$Request;
type Warna = { red: number; green: number; blue: number };

const hex = (h: string): Warna => ({
  red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255,
});

export const WARNA = {
  judul: "#1F3A5F", header: "#E9EAE6", isian: "#DCE8FB", kpi: "#F4F6F8", abu: "#6B7280", garis: "#D6D9DE",
  okBg: "#E3F4E8", okTeks: "#1D7F47", warnBg: "#FFF4D6", warnTeks: "#946000", badBg: "#FBE3DF", badTeks: "#B83325",
  petaRendah: "#FFFFFF", petaTinggi: "#5B8DEF", tabDashboard: "#1F3A5F", tabIsian: "#2F6FDB", tabData: "#9AA3AD",
} as const;

/** Warna bar progres SPARKLINE (teks hex di dalam rumus). */
export const WARNA_BAR = { ok: WARNA.okTeks, warn: "#E0A21B", bad: WARNA.badTeks, sisa: "#E6E9ED" } as const;

const DASHBOARD: readonly string[] = [TAB.dashboardHost, "Harian per Host", "Analisis Live", "Tren Bulanan"];
const ISIAN: readonly string[] = [TAB.pengaturan, TAB.koreksi, TAB.gangguan, TAB.kehadiran, TAB.kalender];

const huruf = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : huruf(Math.floor(i / 26) - 1) + huruf(i % 26));
const kolom = (s: string): number => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function gaya(sheetId: number, a1: string, f: { bg?: string; teks?: string; tebal?: boolean; miring?: boolean; ukuran?: number; rata?: "LEFT" | "CENTER" | "RIGHT"; bungkus?: boolean }): Request {
  const fmt: sheets_v4.Schema$CellFormat = {};
  const fields: string[] = [];
  if (f.bg) { fmt.backgroundColorStyle = { rgbColor: hex(f.bg) }; fields.push("backgroundColorStyle"); }
  const tf: sheets_v4.Schema$TextFormat = {};
  if (f.teks) tf.foregroundColorStyle = { rgbColor: hex(f.teks) };
  if (f.tebal !== undefined) tf.bold = f.tebal;
  if (f.miring !== undefined) tf.italic = f.miring;
  if (f.ukuran) tf.fontSize = f.ukuran;
  if (Object.keys(tf).length > 0) {
    fmt.textFormat = tf;
    fields.push(...Object.keys(tf).map((k) => `textFormat.${k}`));
  }
  if (f.rata) { fmt.horizontalAlignment = f.rata; fields.push("horizontalAlignment"); }
  if (f.bungkus) { fmt.wrapStrategy = "WRAP"; fields.push("wrapStrategy"); }
  return { repeatCell: { range: a1ToGrid(a1, sheetId), cell: { userEnteredFormat: fmt }, fields: fields.map((x) => `userEnteredFormat.${x}`).join(",") } };
}

const lebar = (sheetId: number, dari: string, sampai: string, px: number): Request => ({
  updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: kolom(dari), endIndex: kolom(sampai) + 1 }, properties: { pixelSize: px }, fields: "pixelSize" },
});
const tinggi = (sheetId: number, baris: number, px: number): Request => ({
  updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: baris - 1, endIndex: baris }, properties: { pixelSize: px }, fields: "pixelSize" },
});
const beku = (sheetId: number, baris: number, kol = 0): Request => ({
  updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: baris, frozenColumnCount: kol } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" },
});
const tab = (sheetId: number, warna: string, tanpaGaris: boolean): Request => ({
  updateSheetProperties: {
    properties: { sheetId, tabColorStyle: { rgbColor: hex(warna) }, gridProperties: { hideGridlines: tanpaGaris } },
    fields: "tabColorStyle,gridProperties.hideGridlines",
  },
});
const garis = (sheetId: number, a1: string): Request => {
  const s = { style: "SOLID", width: 1, colorStyle: { rgbColor: hex(WARNA.garis) } };
  return { updateBorders: { range: a1ToGrid(a1, sheetId), top: s, bottom: s, left: s, right: s, innerHorizontal: s, innerVertical: s } };
};

type Nada = "ok" | "warn" | "bad";
const NADA: Record<Nada, { bg: string; teks: string }> = {
  ok: { bg: WARNA.okBg, teks: WARNA.okTeks }, warn: { bg: WARNA.warnBg, teks: WARNA.warnTeks }, bad: { bg: WARNA.badBg, teks: WARNA.badTeks },
};
const formatNada = (n: Nada): sheets_v4.Schema$CellFormat => ({
  backgroundColorStyle: { rgbColor: hex(NADA[n].bg) }, textFormat: { foregroundColorStyle: { rgbColor: hex(NADA[n].teks) }, bold: true },
});
/** Warna bersyarat dengan rumus (relatif ke sel kiri-atas rentang). Rumus memakai sintaks en_US. */
const cfRumus = (sheetId: number, a1: string, rumus: string, n: Nada): Request => ({
  addConditionalFormatRule: { index: 0, rule: { ranges: [a1ToGrid(a1, sheetId)], booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: rumus }] }, format: formatNada(n) } } },
});
const cfAwalan = (sheetId: number, a1: string, awalan: string, n: Nada): Request => ({
  addConditionalFormatRule: { index: 0, rule: { ranges: [a1ToGrid(a1, sheetId)], booleanRule: { condition: { type: "TEXT_STARTS_WITH", values: [{ userEnteredValue: awalan }] }, format: formatNada(n) } } },
});
const cfSama = (sheetId: number, a1: string, teks: string, n: Nada): Request => ({
  addConditionalFormatRule: { index: 0, rule: { ranges: [a1ToGrid(a1, sheetId)], booleanRule: { condition: { type: "TEXT_EQ", values: [{ userEnteredValue: teks }] }, format: formatNada(n) } } },
});
const cfGradien = (sheetId: number, a1: string): Request => ({
  addConditionalFormatRule: {
    index: 0,
    rule: {
      ranges: [a1ToGrid(a1, sheetId)],
      gradientRule: {
        minpoint: { type: "MIN", colorStyle: { rgbColor: hex(WARNA.petaRendah) } },
        maxpoint: { type: "MAX", colorStyle: { rgbColor: hex(WARNA.petaTinggi) } },
      },
    },
  },
});

/**
 * Bar progres Dashboard Host (kolom P): porsi target bulan yang tercapai (D), diwarnai menurut posisi terhadap
 * garis seharusnya (E): hijau ≥ garis, kuning tertinggal ≤ 10%, merah > 10%. Rumus sintaks en_US.
 */
export function rumusBarProgres(baris: number): string {
  const d = `$D${baris}`, e = `$E${baris}`;
  const p = `MIN(1,MAX(0,${d}))`;
  return `=IFERROR(IF(OR($A${baris}="",NOT(ISNUMBER(${d}))),"",SPARKLINE({${p},1-${p}},` +
    `{"charttype","bar";"max",1;"color1",IF(${d}>=${e},"${WARNA_BAR.ok}",IF(${d}>=0.9*${e},"${WARNA_BAR.warn}","${WARNA_BAR.bad}"));"color2","${WARNA_BAR.sisa}"})),"")`;
}

/** Filter baris 1–3 (Dashboard Host, Harian per Host, Analisis Live). */
function gayaFilter(id: number): Request[] {
  return [
    gaya(id, "A1", { teks: WARNA.judul, tebal: true, ukuran: 14 }),
    gaya(id, "B1:H1", { teks: WARNA.abu, tebal: true, ukuran: 9 }),
    gaya(id, "B2:H2", { bg: WARNA.isian, tebal: true }),
    // H2 = dropdown Bandingkan; teks dropdown tidak meluber ke sel sebelah, jadi dibungkus (baris 2 cukup untuk 2 baris).
    gaya(id, "H2", { bungkus: true }),
    gaya(id, "A3:I3", { teks: WARNA.abu, miring: true, ukuran: 9 }),
    tinggi(id, 2, 40),
  ];
}

/** Rumus pembanding persen (realisasi vs garis): hijau ≥ garis, kuning tertinggal ≤ 10%, merah > 10%. */
/** Hijau ≥ garis, kuning ≥ 90% garis, merah di bawahnya. `garis` boleh sel ("$E8") atau angka tetap (1 = 100%). */
function cfJalur(id: number, a1: string, nilai: string, garis: string | number, syaratIsi: string): Request[] {
  const tetap = typeof garis === "number";
  const cek = `${syaratIsi},ISNUMBER(${nilai})${tetap ? "" : `,ISNUMBER(${garis})`}`;
  const sembilanPuluh = tetap ? String(Math.round(0.9 * garis * 1e6) / 1e6) : `0.9*${garis}`;
  return [
    cfRumus(id, a1, `=AND(${cek},${nilai}>=${garis})`, "ok"),
    cfRumus(id, a1, `=AND(${cek},${nilai}<${garis},${nilai}>=${sembilanPuluh})`, "warn"),
    cfRumus(id, a1, `=AND(${cek},${nilai}<${sembilanPuluh})`, "bad"),
  ];
}
const cfTanda = (id: number, a1: string, sel: string): Request[] => [
  cfRumus(id, a1, `=AND(ISNUMBER(${sel}),${sel}>=0)`, "ok"),
  cfRumus(id, a1, `=AND(ISNUMBER(${sel}),${sel}<0)`, "bad"),
];

function dashboardHost(id: number): Request[] {
  return [
    ...gayaFilter(id),
    gaya(id, "A4:K4", { bg: WARNA.kpi, teks: WARNA.abu, tebal: true, ukuran: 9, bungkus: true }),
    gaya(id, "A5:K5", { bg: WARNA.kpi, tebal: true, ukuran: 13 }),
    tinggi(id, 4, 32), tinggi(id, 5, 38),
    garis(id, "A4:K5"),
    gaya(id, "A6", { teks: WARNA.abu, miring: true, ukuran: 9 }),
    gaya(id, "P7", { bg: WARNA.header, tebal: true }),
    gaya(id, "A8:A17", { tebal: true }),
    garis(id, "A7:P17"),
    ...cfJalur(id, "D5", "D5", "E5", "TRUE"),
    ...cfTanda(id, "F5", "F5"), ...cfTanda(id, "H5", "H5"),
    ...cfJalur(id, "D8:D17", "$D8", "$E8", "$A8<>\"\""),
    // Selisih jalur: dibandingkan dengan "Seharusnya (Rp)" (kolom N) supaya kuning = tertinggal ≤ 10%.
    cfRumus(id, "F8:F17", "=AND($A8<>\"\",ISNUMBER($F8),$F8>=0)", "ok"),
    cfRumus(id, "F8:F17", "=AND($A8<>\"\",ISNUMBER($F8),$F8<0,-$F8<=0.1*$N8)", "warn"),
    cfRumus(id, "F8:F17", "=AND($A8<>\"\",ISNUMBER($F8),-$F8>0.1*$N8)", "bad"),
    ...cfTanda(id, "H8:H17", "$H8"),
    cfRumus(id, "L8:L17", "=AND(ISNUMBER($L8),$L8>=0.98)", "ok"),
    cfRumus(id, "L8:L17", "=AND(ISNUMBER($L8),$L8<0.98,$L8>=0.85)", "warn"),
    cfRumus(id, "L8:L17", "=AND(ISNUMBER($L8),$L8<0.85)", "bad"),
    cfAwalan(id, "M8:M17", "✅", "ok"), cfAwalan(id, "M8:M17", "⚠", "warn"), cfAwalan(id, "M8:M17", "🔴", "bad"),
    lebar(id, "A", "A", 150), lebar(id, "B", "C", 110), lebar(id, "D", "E", 100), lebar(id, "F", "H", 105),
    lebar(id, "I", "I", 85), lebar(id, "J", "J", 100), lebar(id, "K", "L", 90), lebar(id, "M", "M", 250),
    lebar(id, "N", "O", 120), lebar(id, "P", "P", 150),
  ];
}

/** Target bersih host per tanggal = Σ Target − Σ Gugur (gugur dicatat sebagai baris terpisah di Target Harian). */
const TARGET_BERSIH = (tgl: string, host: string): string =>
  `(SUMIFS(INDIRECT("'${TAB.targetHarian}'!C2:C"),INDIRECT("'${TAB.targetHarian}'!A2:A"),${tgl},INDIRECT("'${TAB.targetHarian}'!B2:B"),${host})` +
  `-SUMIFS(INDIRECT("'${TAB.targetHarian}'!D2:D"),INDIRECT("'${TAB.targetHarian}'!A2:A"),${tgl},INDIRECT("'${TAB.targetHarian}'!B2:B"),${host}))`;

function harianPerHost(id: number): Request[] {
  // Warna rentang lain-sheet harus lewat INDIRECT (aturan warna bersyarat tidak boleh merujuk tab lain langsung).
  const t = TARGET_BERSIH("$A5", "B$4");
  const isi = "ISNUMBER(B5),B$4<>\"\"";
  return [
    ...gayaFilter(id),
    gaya(id, "A4:K4", { bg: WARNA.header, tebal: true, rata: "CENTER" }),
    gaya(id, "A5:A96", { tebal: true }),
    garis(id, "A4:K96"),
    cfRumus(id, "B5:K96", `=AND(${isi},${t}>0,B5>=${t})`, "ok"),
    cfRumus(id, "B5:K96", `=AND(${isi},${t}>0,B5<${t},B5>=0.9*${t})`, "warn"),
    cfRumus(id, "B5:K96", `=AND(${isi},${t}>0,B5<0.9*${t})`, "bad"),
    lebar(id, "A", "A", 150), lebar(id, "B", "K", 105),
    beku(id, 4, 1),
  ];
}

function analisisLive(id: number): Request[] {
  return [
    ...gayaFilter(id),
    // Corong sebagai dua kartu (format-anlive.png): judul gelap, omzet besar, rasio corong disorot.
    gaya(id, "A5:B5", { bg: WARNA.judul, teks: "#FFFFFF", tebal: true, ukuran: 11 }),
    gaya(id, "D5:E5", { bg: WARNA.judul, teks: "#FFFFFF", tebal: true, ukuran: 11 }),
    gaya(id, "A6:A16", { teks: WARNA.abu }), gaya(id, "D6:D15", { teks: WARNA.abu }),
    gaya(id, "B6:B16", { tebal: true }), gaya(id, "E6:E15", { tebal: true }),
    gaya(id, "B6", { ukuran: 13 }), gaya(id, "E6", { ukuran: 13 }), tinggi(id, 6, 28),
    gaya(id, "A11:B13", { bg: WARNA.kpi }), gaya(id, "B11:B13", { teks: WARNA.judul }),
    gaya(id, "D12:E13", { bg: WARNA.kpi }), gaya(id, "E12:E13", { teks: WARNA.judul }),
    garis(id, "A5:B16"), garis(id, "D5:E15"),
    gaya(id, "A20:A29", { tebal: true }), garis(id, "A19:G29"),
    cfRumus(id, "G20:G29", "=AND(ISNUMBER($G20),$G20>=1.05)", "ok"),
    cfRumus(id, "G20:G29", "=AND(ISNUMBER($G20),$G20<0.95)", "warn"),
    gaya(id, "A32:Y32", { bg: WARNA.header, tebal: true, rata: "CENTER" }),
    gaya(id, "A33:A34", { tebal: true }),
    garis(id, "A32:Y34"),
    cfGradien(id, "B33:Y34"),
    gaya(id, "A37", { teks: WARNA.judul, tebal: true, ukuran: 11 }),
    gaya(id, "A38:A44", { teks: WARNA.abu }),
    lebar(id, "A", "A", 170), lebar(id, "B", "C", 110), lebar(id, "D", "D", 165), lebar(id, "E", "G", 105),
    lebar(id, "H", "Y", 62),
    // H2 (dropdown Bandingkan) ada di kolom H = kolom jam 06 peta jam; jam 06 hampir selalu kosong, jadi aman dilebarkan.
    lebar(id, "H", "H", 130),
  ];
}

function trenBulanan(id: number, jumlahHost: number): Request[] {
  const out: Request[] = [
    gaya(id, "A1", { teks: WARNA.judul, tebal: true, ukuran: 14 }),
    gaya(id, "A4:BA4", { tebal: true, teks: WARNA.judul }),
    garis(id, `A5:${huruf(5 + 5 * jumlahHost)}29`),
    gaya(id, "A6:A29", { tebal: true }),
    // Baris 6 = bulan berjalan (angka belum sebulan penuh) sengaja tidak diwarnai; jalurnya ada di Dashboard Host.
    ...cfJalur(id, "D7:D29", "$D7", 1, "$A7<>\"\""),
    lebar(id, "A", "A", 95), lebar(id, "B", huruf(5 + 5 * jumlahHost), 105),
    beku(id, 5, 1),
  ];
  for (let i = 0; i < jumlahHost; i++) {
    const c = huruf(6 + 5 * i + 2);
    out.push(...cfJalur(id, `${c}7:${c}29`, `$${c}7`, 1, "$A7<>\"\""));
  }
  return out;
}

function pengaturan(id: number): Request[] {
  return [
    gaya(id, "D1:E1", { bg: WARNA.header, tebal: true }), gaya(id, "G1:J1", { bg: WARNA.header, tebal: true }),
    gaya(id, "L1:N1", { bg: WARNA.header, tebal: true }),
    lebar(id, "A", "A", 240), lebar(id, "B", "B", 150), lebar(id, "C", "C", 24), lebar(id, "D", "D", 90),
    lebar(id, "E", "E", 140), lebar(id, "F", "F", 24), lebar(id, "G", "H", 130), lebar(id, "I", "J", 110),
    lebar(id, "K", "K", 24), lebar(id, "L", "N", 90),
  ];
}

const keputusan = (id: number, a1: string, setuju: string, tolak: string[]): Request[] => [
  cfSama(id, a1, setuju, "ok"), cfSama(id, a1, "Menunggu", "warn"), ...tolak.map((t) => cfSama(id, a1, t, "bad")),
];

/** Jumlah aturan warna bersyarat yang sudah ada per tab (judul → jumlah), untuk dihapus dulu. */
export type JumlahCfLama = ReadonlyMap<string, number>;

export function tampilanRequests(bp: TabBlueprint[], ids: ReadonlyMap<string, number>, cfLama: JumlahCfLama = new Map(), jumlahHost = 10): Request[] {
  const out: Request[] = [];
  for (const t of bp) {
    const id = ids.get(t.title)!;
    const n = cfLama.get(t.title) ?? 0;
    for (let i = 0; i < n; i++) out.push({ deleteConditionalFormatRule: { sheetId: id, index: 0 } });
    const dash = DASHBOARD.includes(t.title);
    out.push(tab(id, dash ? WARNA.tabDashboard : ISIAN.includes(t.title) ? WARNA.tabIsian : WARNA.tabData, dash));
    const hr = t.headerRow ?? 1;
    if (t.headers.length > 0) {
      out.push(gaya(id, `A${hr}:${huruf(t.headers.length - 1)}${hr}`, { bg: WARNA.header, tebal: true, bungkus: true }));
    }
    for (const r of t.editableRanges) out.push(gaya(id, r, { bg: WARNA.isian }));
    if (!dash && t.title !== TAB.pengaturan) {
      out.push(beku(id, hr));
      out.push(lebar(id, "A", huruf(Math.max(0, t.headers.length - 1)), 120));
    }
    if (t.title === TAB.dashboardHost) out.push(...dashboardHost(id));
    if (t.title === "Harian per Host") out.push(...harianPerHost(id));
    if (t.title === "Analisis Live") out.push(...analisisLive(id));
    if (t.title === "Tren Bulanan") out.push(...trenBulanan(id, jumlahHost));
    if (t.title === TAB.pengaturan) out.push(...pengaturan(id));
    if (t.title === TAB.koreksi) out.push(...keputusan(id, "F2:F", "Setujui", ["Tolak"]));
    if (t.title === TAB.gangguan) out.push(...keputusan(id, "G2:G", "Disetujui", ["Ditolak"]));
    if (t.title === TAB.kehadiran) out.push(...keputusan(id, "F2:F", "Disetujui", ["Ditolak", "Tanpa keterangan"]));
    if (t.title === TAB.sesi) out.push(lebar(id, "I", "I", 170), lebar(id, "J", "K", 200));
    if (t.title === TAB.log) out.push(lebar(id, "C", "C", 420));
  }
  return out;
}
