import type { sheets_v4 } from "googleapis";
import { PEMBANDING, PRESETS } from "../domain/period.js";
import {
  dashboardFormulas, DASHBOARD_HOST_KONDISI, KONTROL_RANGE, KREDIT_COLUMNS, TARGET_HARIAN_COLUMNS, type Layout,
} from "../domain/sheetFormulas.js";
import { rumusBarProgres } from "./sheetTampilan.js";
import {
  BARIS_HOST, GANGGUAN_HEADERS, HEARTBEAT_HEADERS, KALENDER_HEADERS, KEHADIRAN_HEADERS, KOREKSI_HEADERS, LOG_HEADERS,
  PENGATURAN_HOST_HEADERS, PENGATURAN_KEYS, PENGATURAN_KEY_ORDER, PENGATURAN_TARGET_HEADERS, SESI_HEADERS, TAB,
} from "./sheets.js";

/**
 * Cetak biru spreadsheet CP – Live Tracker (Task 13): fungsi murni tanpa panggilan Google.
 * Penyusun request batchUpdate di bawah dipakai scripts/setup-sheet.ts.
 */

export type ValidationKind = "list" | "date" | "custom" | "range";
export interface Validation { range: string; kind: ValidationKind; values?: string[]; formula?: string; pesan?: string }
/** ringkas = Rp11,2 jt / Rp137 rb (tab dashboard); selisih = ringkas yang bisa negatif (-Rp2,1 jt / -Rp700 rb). */
export type FormatKind = "rupiah" | "ringkas" | "selisih" | "persen" | "tanggal" | "bulan" | "jam" | "desimal" | "bilangan" | "indeks" | "sembunyi";
export interface TabFormat { range: string; kind: FormatKind }
export type CellValue = string | number;

export interface TabBlueprint {
  title: string;
  headers: string[];
  /** Baris header (1-based), bawaan 1. */
  headerRow?: number;
  /** Rentang A1 (tanpa nama tab) yang boleh diedit owner; "F2:F" = sampai baris terakhir. */
  editableRanges: string[];
  /** "owner" = punya rentang input owner; "none" = terkunci penuh (hanya bot, yang menulis sebagai owner). */
  editors: "owner" | "none";
  formulas?: Record<string, string>;
  /** Label/nilai statis yang selalu ditulis ulang (USER_ENTERED). */
  values?: Record<string, CellValue>;
  /** Nilai awal, hanya ditulis bila sel masih kosong (tidak menimpa isian owner). */
  defaults?: Record<string, CellValue>;
  validations?: Validation[];
  formats?: TabFormat[];
  hidden?: boolean;
}

export const ZONA_WAKTU = "Asia/Jakarta";
/**
 * Locale tampilan: Indonesia (Rp1.234.567, 12,5%, tanggal dd/mm). Kode Sheets untuk Indonesia adalah "in_ID";
 * "id_ID" ditolak API ("Unsupported locale"). Di locale ini Sheets membaca rumus kiriman API dengan pemisah ";",
 * jadi rumus (berpemisah koma) ditulis selagi locale LOCALE_RUMUS, lalu LOCALE dipasang sesudahnya. Rumus yang
 * tersimpan tetap benar saat locale diganti (diuji di Google Sheets asli, 24-11-2026).
 */
export const LOCALE = "in_ID";
export const LOCALE_RUMUS = "en_US";
export const MAX_BARIS_OWNER = 60;
const PROTECT_PREFIX = "CP: ";

const huruf = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : huruf(Math.floor(i / 26) - 1) + huruf(i % 26));
const MODE_PEMBANDING = [PEMBANDING.sebelumnya, PEMBANDING.bulan_lalu, PEMBANDING.tanpa];
const DEFAULT_PERIODE = "Bulan ini";
const DEFAULT_PEMBANDING = PEMBANDING.bulan_lalu;
const MAX_HOST = 10;

/** Baris 1: judul + label filter; baris 2: filter owner; validasi dan format sel filter. */
function filterTab(title: string, layout: Layout): Pick<TabBlueprint, "editableRanges" | "editors" | "formulas" | "validations" | "formats" | "defaults"> & { values: Record<string, CellValue> } {
  return {
    editableRanges: ["B2:H2"],
    editors: "owner",
    formulas: dashboardFormulas(layout),
    values: { A1: title, B1: "Periode", D1: "Dari", F1: "Sampai", H1: "Bandingkan", A3: "Rentang efektif" },
    defaults: { B2: DEFAULT_PERIODE, H2: DEFAULT_PEMBANDING },
    validations: [
      { range: "B2", kind: "list", values: [...PRESETS] },
      { range: "D2", kind: "date" },
      { range: "F2", kind: "date" },
      { range: "H2", kind: "list", values: MODE_PEMBANDING },
    ],
    formats: [
      { range: "D2:D3", kind: "tanggal" }, { range: "F2:F3", kind: "tanggal" }, { range: "H3:I3", kind: "tanggal" },
      { range: "J2:K3", kind: "sembunyi" },
    ],
  };
}

function dashboardHost(): TabBlueprint {
  const t = filterTab(TAB.dashboardHost, "Dashboard Host");
  const k = DASHBOARD_HOST_KONDISI;
  const r0 = k.barisPertama;
  const r1 = r0 + MAX_HOST - 1;
  Object.assign(t.values, {
    A4: "Omzet live", B4: "Target bulan (tim)", C4: "Seharusnya (tim)", D4: "% tercapai", E4: "% seharusnya",
    F4: "Selisih jalur", G4: "Pembanding", H4: "vs pembanding", I4: "TikTok", J4: "Shopee", K4: "Belum teratribusi",
    A6: "Hijau = sesuai/di atas jalur · Kuning = tertinggal ≤10% · Merah = tertinggal >10% · Biru = boleh diisi owner",
    P7: "Progres",
  });
  for (let r = r0; r <= r1; r++) t.values[`P${r}`] = rumusBarProgres(r);
  t.formats!.push(
    { range: "A5:C5", kind: "ringkas" }, { range: "D5:E5", kind: "persen" }, { range: "F5", kind: "selisih" },
    { range: "G5", kind: "ringkas" }, { range: "H5", kind: "persen" }, { range: "I5:K5", kind: "ringkas" },
    { range: `B${r0}:C${r1}`, kind: "ringkas" }, { range: `D${r0}:E${r1}`, kind: "persen" },
    { range: `F${r0}:F${r1}`, kind: "selisih" }, { range: `G${r0}:G${r1}`, kind: "ringkas" }, { range: `H${r0}:H${r1}`, kind: "persen" },
    { range: `I${r0}:I${r1}`, kind: "desimal" }, { range: `J${r0}:J${r1}`, kind: "ringkas" },
    { range: `K${r0}:L${r1}`, kind: "persen" }, { range: `N${r0}:O${r1}`, kind: "ringkas" },
  );
  return {
    title: TAB.dashboardHost,
    headerRow: 7,
    headers: [
      "Host", "Target bulan", "Realisasi", "Progres (garis = seharusnya)", "% vs seharusnya", "Selisih jalur",
      "Butuh/hari kerja", "vs pembanding", "Jam on-air", "Omzet/jam", "Konversi", "Disiplin lapor", "Status",
      "Seharusnya (Rp)", "Realisasi pembanding",
    ],
    ...t,
  };
}

function harianPerHost(): TabBlueprint {
  const t = filterTab("Harian per Host", "Harian per Host");
  t.formats!.push({ range: "A5:A96", kind: "tanggal" }, { range: "B5:K96", kind: "ringkas" });
  return { title: "Harian per Host", headerRow: 4, headers: ["Tanggal"], ...t };
}

/** Kamus metrik di bawah Analisis Live (format-anlive.png), supaya semua orang memakai definisi yang sama. */
const KAMUS_LIVE = [
  "Kamus metrik live",
  "Konversi = pesanan (Shopee) atau produk terjual (TikTok) ÷ penonton yang masuk (dilihat/tayangan)",
  "Add-to-cart rate (Shopee) = masuk keranjang ÷ dilihat · Cart-to-order (Shopee) = pesanan ÷ masuk keranjang",
  "Tap-in rate (TikTok) = tayangan ÷ impresi · AOV = omzet ÷ pesanan · Omzet/jam = omzet ÷ jam on-air",
  "Indeks slot = omzet/jam host ÷ rata-rata semua host di jam yang sama (adil untuk host yang dapat jam sepi)",
  "Peta jam: omzet per jam menurut jam dalam sehari; makin biru makin ramai",
  "Angka TikTok dibulatkan di layar (mis. Rp578rb), jadi omzet TikTok per host adalah perkiraan",
];

function analisisLive(): TabBlueprint {
  const t = filterTab("Analisis Live", "Analisis Live");
  const shopee = ["Omzet", "Pesanan", "Dilihat", "Keranjang", "Komentar", "ATC rate", "Cart-to-order", "Konversi", "AOV", "Omzet/jam", "Komentar ÷ dilihat"];
  const tiktok = ["Omzet", "Terjual", "Tayangan", "Impresi", "Komentar", "Pengikut baru", "Tap-in", "Konversi", "Nilai/produk", "Komentar ÷ tayangan"];
  t.values.A5 = "Corong Shopee"; t.values.D5 = "Corong TikTok";
  shopee.forEach((l, i) => { t.values[`A${6 + i}`] = l; });
  tiktok.forEach((l, i) => { t.values[`D${6 + i}`] = l; });
  t.values.A32 = "Peta jam (omzet/jam)";
  t.values.A33 = "Sen–Kam"; t.values.A34 = "Jum–Min";
  for (let j = 0; j < 24; j++) t.values[`${huruf(1 + j)}32`] = j;
  KAMUS_LIVE.forEach((baris, i) => { t.values[`A${37 + i}`] = baris; });
  t.formats!.push(
    { range: "B6", kind: "ringkas" }, { range: "B11:B13", kind: "persen" }, { range: "B14:B15", kind: "ringkas" }, { range: "B16", kind: "persen" },
    { range: "E6", kind: "ringkas" }, { range: "E12:E13", kind: "persen" }, { range: "E14", kind: "ringkas" }, { range: "E15", kind: "persen" },
    { range: "B7:B10", kind: "bilangan" }, { range: "E7:E11", kind: "bilangan" },
    { range: "B20:C29", kind: "ringkas" }, { range: "D20:E29", kind: "persen" }, { range: "F20:F29", kind: "desimal" },
    { range: "G20:G29", kind: "indeks" }, { range: "B33:Y34", kind: "ringkas" },
    { range: "AA5:AB96", kind: "sembunyi" },
  );
  return {
    title: "Analisis Live",
    headerRow: 19,
    headers: ["Host", "Omzet/jam", "AOV", "Konversi", "Add-to-cart", "Komentar/jam", "Indeks slot"],
    ...t,
  };
}

function trenBulanan(): TabBlueprint {
  const values: Record<string, CellValue> = { A1: "Tren Bulanan", B4: "Tim" };
  const formats: TabFormat[] = [
    { range: "A6:A29", kind: "bulan" }, { range: "B6:C29", kind: "ringkas" }, { range: "D6:D29", kind: "persen" },
    { range: "E6:E29", kind: "ringkas" }, { range: "F6:F29", kind: "persen" },
  ];
  for (let i = 0; i < MAX_HOST; i++) {
    const c = [0, 1, 2, 3, 4].map((j) => huruf(6 + 5 * i + j)) as [string, string, string, string, string];
    ["Realisasi", "Target", "%", "Omzet/jam", "Konversi"].forEach((l, j) => { values[`${c[j]!}5`] = l; });
    formats.push(
      { range: `${c[0]}6:${c[1]}29`, kind: "ringkas" }, { range: `${c[2]}6:${c[2]}29`, kind: "persen" },
      { range: `${c[3]}6:${c[3]}29`, kind: "ringkas" }, { range: `${c[4]}6:${c[4]}29`, kind: "persen" },
    );
  }
  return {
    title: "Tren Bulanan", headerRow: 5, headers: ["Bulan", "Omzet", "Target", "%", "Omzet/jam", "Konversi"],
    editableRanges: [], editors: "none", formulas: dashboardFormulas("Tren Bulanan"), values, formats,
  };
}

const kunci = (title: string, headers: readonly string[], formats: TabFormat[] = []): TabBlueprint => ({
  title, headers: [...headers], editableRanges: [], editors: "none", formats,
});
const daftar = (range: string, values: string[]): Validation => ({ range, kind: "list", values });
/** Daftar host untuk validasi kolom Host (rentang yang sama dengan nama DAFTAR_HOST). */
const DAFTAR_HOST_SUMBER = `=${TAB.pengaturan}!$G$${BARIS_HOST.pertama}:$G$${BARIS_HOST.terakhir}`;
const hostDariDaftar = (range: string): Validation => ({ range, kind: "range", formula: DAFTAR_HOST_SUMBER });
const KEPUTUSAN = ["Menunggu", "Setujui", "Tolak"];
const KEPUTUSAN_LAIN = ["Menunggu", "Disetujui", "Ditolak"];

/** Nama host: tanpa spasi di awal/akhir atau ganda (TRIM); tolak * ? ~ (karakter pola SUMIFS) dan awalan < > = (operator kriteria). */
const FORMULA_NAMA_HOST =
  '=AND(G2=TRIM(G2),ISERROR(FIND("*",G2)),ISERROR(FIND("?",G2)),ISERROR(FIND("~",G2)),OR(LEN(G2)=0,ISERROR(FIND(LEFT(G2,1),"<>="))))';

function pengaturan(): TabBlueprint {
  const values: Record<string, CellValue> = {};
  PENGATURAN_KEY_ORDER.forEach((k, i) => { values[`A${2 + i}`] = k; });
  PENGATURAN_TARGET_HEADERS.forEach((h, i) => { values[`${huruf(3 + i)}1`] = h; });
  PENGATURAN_HOST_HEADERS.forEach((h, i) => { values[`${huruf(6 + i)}1`] = h; });
  ["Hari", "Mulai", "Selesai"].forEach((h, i) => { values[`${huruf(11 + i)}1`] = h; }); // Pola Sesi (belum dipakai)
  const baris = (k: string): number => PENGATURAN_KEY_ORDER.indexOf(k as (typeof PENGATURAN_KEY_ORDER)[number]) + 2;
  const K = PENGATURAN_KEYS;
  return {
    title: TAB.pengaturan,
    headers: ["Pengaturan", "Nilai"],
    editableRanges: [`B2:B${MAX_BARIS_OWNER}`, `D2:E${MAX_BARIS_OWNER}`, `G${BARIS_HOST.pertama}:J${BARIS_HOST.terakhir}`, `L2:N${MAX_BARIS_OWNER}`],
    editors: "owner",
    values,
    defaults: {
      [`B${baris(K.jadwalAktif)}`]: "TIDAK", [`B${baris(K.liveMulai)}`]: "09:00", [`B${baris(K.liveSelesai)}`]: "22:00",
      [`B${baris(K.jamPagi)}`]: "08:00", [`B${baris(K.jamRekap)}`]: "22:30", [`B${baris(K.maxGapMenit)}`]: 240,
      [`B${baris(K.maxPesanPerHari)}`]: 6,
    },
    validations: [
      { range: `B${baris(K.jadwalAktif)}`, kind: "list", values: ["YA", "TIDAK"] },
      { range: `G${BARIS_HOST.pertama}:G${BARIS_HOST.terakhir}`, kind: "custom", formula: FORMULA_NAMA_HOST,
        pesan: "Nama host tanpa spasi di awal/akhir, tidak boleh mengandung * ? ~ atau diawali < > =" },
      { range: `I${BARIS_HOST.pertama}:J${BARIS_HOST.terakhir}`, kind: "date" },
    ],
    formats: [
      { range: `B${baris(K.liveMulai)}:B${baris(K.jamRekap)}`, kind: "jam" },
      { range: `E2:E${MAX_BARIS_OWNER}`, kind: "rupiah" },
      { range: `I${BARIS_HOST.pertama}:J${BARIS_HOST.terakhir}`, kind: "tanggal" },
    ],
  };
}

function kontrol(): TabBlueprint {
  const [, awal, akhir] = /^A(\d+):D(\d+)$/.exec(KONTROL_RANGE) ?? [];
  return {
    ...kunci(TAB.kontrol, ["Host", "Realisasi bulan ini", "Target bulan", "Seharusnya s/d hari ini"],
      [{ range: `B${awal}:D${akhir}`, kind: "rupiah" }]),
    formulas: dashboardFormulas("Kontrol"),
    values: { F1: "HARI_INI", F2: "=TODAY()" },
    hidden: true,
  };
}

/** 15 tab CP – Live Tracker. */
export function sheetBlueprint(): TabBlueprint[] {
  return [
    dashboardHost(),
    harianPerHost(),
    analisisLive(),
    trenBulanan(),
    kunci(TAB.dataKredit, KREDIT_COLUMNS.map((c) => c.header), [
      { range: "B2:B", kind: "tanggal" }, { range: "G2:G", kind: "rupiah" }, { range: "O2:O", kind: "rupiah" },
    ]),
    kunci(TAB.targetHarian, TARGET_HARIAN_COLUMNS.map((c) => c.header), [
      { range: "A2:A", kind: "tanggal" }, { range: "C2:D", kind: "rupiah" },
    ]),
    kontrol(),
    kunci(TAB.sesi, SESI_HEADERS, [{ range: "A2:A", kind: "tanggal" }, { range: "F2:G", kind: "rupiah" }]),
    {
      title: TAB.koreksi, headers: [...KOREKSI_HEADERS], editableRanges: ["F2:G"], editors: "owner",
      validations: [daftar("F2:F", KEPUTUSAN)], formats: [{ range: "A2:A", kind: "tanggal" }],
    },
    {
      // Owner boleh membetulkan Host dan jam Mulai/Selesai (B:D) dan memutuskan (G).
      title: TAB.gangguan, headers: [...GANGGUAN_HEADERS], editableRanges: ["B2:D", "G2:G"], editors: "owner",
      validations: [daftar("G2:G", KEPUTUSAN_LAIN), hostDariDaftar("B2:B")], formats: [{ range: "A2:A", kind: "tanggal" }, { range: "C2:D", kind: "jam" }],
    },
    {
      title: TAB.kehadiran, headers: [...KEHADIRAN_HEADERS], editableRanges: ["A2:D", "F2:F"], editors: "owner",
      validations: [
        hostDariDaftar("B2:B"),
        daftar("C2:C", ["Sakit", "Izin", "Cuti", "Telat"]),
        daftar("F2:F", [...KEPUTUSAN_LAIN, "Tanpa keterangan"]),
        { range: "A2:A", kind: "date" },
      ],
      formats: [{ range: "A2:A", kind: "tanggal" }],
    },
    {
      title: TAB.kalender, headers: [...KALENDER_HEADERS], editableRanges: ["A2:B"], editors: "owner",
      validations: [{ range: "A2:A", kind: "date" }], formats: [{ range: "A2:A", kind: "tanggal" }],
    },
    pengaturan(),
    kunci(TAB.log, LOG_HEADERS),
    kunci(TAB.heartbeat, HEARTBEAT_HEADERS),
  ];
}

/** Nama rentang yang dipakai rumus. HARI_INI = sel =TODAY() di tab Kontrol (tersembunyi). */
export const NAMED_RANGES = [
  { name: "DAFTAR_HOST", tab: TAB.pengaturan, range: `G${BARIS_HOST.pertama}:G${BARIS_HOST.terakhir}` },
  { name: "HARI_INI", tab: TAB.kontrol, range: "F2" },
] as const;

/* ---------- Penyusun request ---------- */

type Request = sheets_v4.Schema$Request;
type GridRange = sheets_v4.Schema$GridRange;

const colIdx = (s: string): number => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** "B2:H2" | "F2:F" (sampai akhir) | "G2" → GridRange. */
export function a1ToGrid(range: string, sheetId: number): GridRange {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/.exec(range);
  if (!m) throw new Error(`Rentang A1 tidak valid: ${range}`);
  const [, c1, r1, c2, r2] = m;
  const grid: GridRange = { sheetId, startRowIndex: Number(r1) - 1, startColumnIndex: colIdx(c1!), endColumnIndex: colIdx(c2 ?? c1!) + 1 };
  if (c2 === undefined) grid.endRowIndex = Number(r1);
  else if (r2 !== undefined) grid.endRowIndex = Number(r2);
  return grid;
}

/** Id sheet: yang sudah ada dipakai ulang; tab baru dapat id bilangan bulat yang belum terpakai. */
export function resolveSheetIds(bp: TabBlueprint[], existing: ReadonlyMap<string, number>): Map<string, number> {
  const ids = new Map<string, number>();
  const used = new Set(existing.values());
  let next = 1;
  for (const t of bp) {
    const ada = existing.get(t.title);
    if (ada !== undefined) { ids.set(t.title, ada); continue; }
    while (used.has(next)) next++;
    used.add(next);
    ids.set(t.title, next);
  }
  return ids;
}

export function spreadsheetPropsRequest(locale: string = LOCALE): Request {
  return { updateSpreadsheetProperties: { properties: { timeZone: ZONA_WAKTU, locale }, fields: "timeZone,locale" } };
}

/**
 * Jumlah baris minimum tab fakta. Sheets menolak values.update di luar grid (bawaan 1.000 baris), sedangkan Data
 * Kredit bertambah ±800 baris per bulan. Anggaran sel: batas 10 juta sel per spreadsheet; 5 tab fakta ≈ 100.000
 * baris × <15 kolom, jauh di bawah batas.
 */
export const MIN_BARIS_TAB: Readonly<Record<string, number>> = {
  [TAB.dataKredit]: 50_000, [TAB.targetHarian]: 5_000, [TAB.sesi]: 20_000, [TAB.log]: 20_000, [TAB.koreksi]: 5_000,
};

/**
 * addSheet untuk tab yang belum ada (tab fakta langsung berukuran MIN_BARIS_TAB); updateSheetProperties untuk tab
 * fakta yang ada tetapi lebih kecil (`rowCounts` dari spreadsheet; tab tanpa angka dilewati; tidak pernah menyusut)
 * dan untuk tab tersembunyi.
 */
export function tabRequests(
  bp: TabBlueprint[], ids: ReadonlyMap<string, number>, existingTitles: ReadonlySet<string>, rowCounts: ReadonlyMap<string, number> = new Map(),
): Request[] {
  const out: Request[] = [];
  for (const t of bp) {
    if (existingTitles.has(t.title)) continue;
    const baris = MIN_BARIS_TAB[t.title];
    out.push({ addSheet: { properties: { sheetId: ids.get(t.title)!, title: t.title, ...(baris ? { gridProperties: { rowCount: baris } } : {}) } } });
  }
  for (const t of bp) {
    const min = MIN_BARIS_TAB[t.title];
    const ada = rowCounts.get(t.title);
    if (existingTitles.has(t.title) && min && ada !== undefined && ada < min) {
      out.push({ updateSheetProperties: { properties: { sheetId: ids.get(t.title)!, gridProperties: { rowCount: min } }, fields: "gridProperties.rowCount" } });
    }
  }
  for (const t of bp) {
    if (t.hidden) out.push({ updateSheetProperties: { properties: { sheetId: ids.get(t.title)!, hidden: true }, fields: "hidden" } });
  }
  return out;
}

export function namedRangeRequests(ids: ReadonlyMap<string, number>, existing: Array<{ name: string; namedRangeId: string }>): Request[] {
  const out: Request[] = [];
  for (const n of NAMED_RANGES) {
    const lama = existing.find((e) => e.name === n.name);
    if (lama) out.push({ deleteNamedRange: { namedRangeId: lama.namedRangeId } });
  }
  for (const n of NAMED_RANGES) {
    out.push({ addNamedRange: { namedRange: { name: n.name, range: a1ToGrid(n.range, ids.get(n.tab)!) } } });
  }
  return out;
}

export function validationRequests(bp: TabBlueprint[], ids: ReadonlyMap<string, number>): Request[] {
  return bp.flatMap((t) =>
    (t.validations ?? []).map((v): Request => {
      const condition: sheets_v4.Schema$BooleanCondition =
        v.kind === "list" ? { type: "ONE_OF_LIST", values: (v.values ?? []).map((x) => ({ userEnteredValue: x })) }
        : v.kind === "range" ? { type: "ONE_OF_RANGE", values: [{ userEnteredValue: v.formula ?? "" }] }
        : v.kind === "date" ? { type: "DATE_IS_VALID" }
        : { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: v.formula ?? "" }] };
      const rule: sheets_v4.Schema$DataValidationRule = { condition, strict: true };
      if (v.kind === "list") rule.showCustomUi = true;
      if (v.pesan) rule.inputMessage = v.pesan;
      return { setDataValidation: { range: a1ToGrid(v.range, ids.get(t.title)!), rule } };
    }));
}

const FORMAT: Record<FormatKind, { type: string; pattern: string }> = {
  rupiah: { type: "NUMBER", pattern: '"Rp"#,##0' },
  // Diuji di Sheets asli (in_ID): 11627070 → "Rp11,6 jt", 137000 → "Rp137 rb", -4257545 → "-Rp4,3 jt".
  ringkas: { type: "NUMBER", pattern: '[>=1000000]"Rp"0.0,," jt";[>=1000]"Rp"0," rb";"Rp"0' },
  selisih: { type: "NUMBER", pattern: '[>=1000000]"Rp"0.0,," jt";[<=-1000000]"Rp"0.0,," jt";"Rp"0," rb"' },
  persen: { type: "PERCENT", pattern: "0.0%" },
  tanggal: { type: "DATE", pattern: "dd/mm/yyyy" },
  bulan: { type: "DATE", pattern: "mmm yyyy" },
  jam: { type: "TIME", pattern: "HH:mm" },
  desimal: { type: "NUMBER", pattern: "#,##0.0" },
  bilangan: { type: "NUMBER", pattern: "#,##0" },
  indeks: { type: "NUMBER", pattern: "0.00" },
  sembunyi: { type: "NUMBER", pattern: ";;;" },
};

export function formatRequests(bp: TabBlueprint[], ids: ReadonlyMap<string, number>): Request[] {
  return bp.flatMap((t) =>
    (t.formats ?? []).map((f): Request => ({
      repeatCell: {
        range: a1ToGrid(f.range, ids.get(t.title)!),
        cell: { userEnteredFormat: { numberFormat: FORMAT[f.kind] } },
        fields: "userEnteredFormat.numberFormat",
      },
    })));
}

/** Setiap tab dilindungi penuh (bukan sekadar peringatan); hanya owner editor; rentang input owner dibebaskan. */
export function protectionRequests(
  bp: TabBlueprint[], ids: ReadonlyMap<string, number>, editorEmails: string[],
  existing: Array<{ protectedRangeId: number; description?: string | null }>,
): Request[] {
  const out: Request[] = existing
    .filter((p) => p.description?.startsWith(PROTECT_PREFIX))
    .map((p) => ({ deleteProtectedRange: { protectedRangeId: p.protectedRangeId } }));
  for (const t of bp) {
    const sheetId = ids.get(t.title)!;
    const protectedRange: sheets_v4.Schema$ProtectedRange = {
      range: { sheetId }, description: `${PROTECT_PREFIX}${t.title}`, warningOnly: false,
      requestingUserCanEdit: true, editors: { users: [...new Set(editorEmails)] },
    };
    if (t.editableRanges.length > 0) protectedRange.unprotectedRanges = t.editableRanges.map((r) => a1ToGrid(r, sheetId));
    out.push({ addProtectedRange: { protectedRange } });
  }
  return out;
}

/** Sel → ValueRange; sel bersebelahan dalam satu baris digabung. */
export function valueRanges(tab: string, cells: ReadonlyMap<string, CellValue>): sheets_v4.Schema$ValueRange[] {
  const parsed = [...cells].map(([a1, v]) => {
    const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
    return { col: colIdx(m[1]!), row: Number(m[2]), v };
  }).sort((a, b) => a.row - b.row || a.col - b.col);
  const out: sheets_v4.Schema$ValueRange[] = [];
  let run: typeof parsed = [];
  const flush = (): void => {
    const first = run[0];
    if (!first) return;
    const a = `${huruf(first.col)}${first.row}`;
    const last = run[run.length - 1]!;
    out.push({ range: `'${tab}'!${run.length > 1 ? `${a}:${huruf(last.col)}${last.row}` : a}`, values: [run.map((c) => c.v)] });
    run = [];
  };
  for (const c of parsed) {
    const prev = run[run.length - 1];
    if (prev && (prev.row !== c.row || prev.col + 1 !== c.col)) flush();
    run.push(c);
  }
  flush();
  return out;
}

/** Semua sel statis tab (header, label, rumus) yang selalu ditulis ulang. Nilai bawaan (`defaults`) tidak termasuk. */
export function tabCells(t: TabBlueprint): Map<string, CellValue> {
  const cells = new Map<string, CellValue>();
  t.headers.forEach((h, i) => cells.set(`${huruf(i)}${t.headerRow ?? 1}`, h));
  for (const [a1, v] of Object.entries(t.values ?? {})) cells.set(a1, v);
  for (const [a1, f] of Object.entries(t.formulas ?? {})) cells.set(a1, f);
  return cells;
}

export const adalahRumus = (v: CellValue): boolean => typeof v === "string" && v.startsWith("=");

/** Pisahkan sel tab: `rumus` (mulai "=") ditulis USER_ENTERED; `statik` (header, label) ditulis RAW supaya "+Omzet" bukan rumus. */
export function tabCellsTerpisah(t: TabBlueprint): { statik: Map<string, CellValue>; rumus: Map<string, CellValue> } {
  const statik = new Map<string, CellValue>();
  const rumus = new Map<string, CellValue>();
  for (const [a1, v] of tabCells(t)) (adalahRumus(v) ? rumus : statik).set(a1, v);
  return { statik, rumus };
}
