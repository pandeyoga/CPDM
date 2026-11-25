import type { sheets_v4 } from "googleapis";
import { describe, expect, it } from "vitest";
import { formatRequests, resolveSheetIds, sheetBlueprint } from "../src/infra/sheetBlueprint.js";
import { rumusBarProgres, tampilanRequests, WARNA } from "../src/infra/sheetTampilan.js";

const bp = sheetBlueprint();
const ids = resolveSheetIds(bp, new Map());
const id = (t: string) => ids.get(t)!;
type R = sheets_v4.Schema$Request;
const cf = (r: R[], sheetId: number) =>
  r.flatMap((x) => (x.addConditionalFormatRule && x.addConditionalFormatRule.rule!.ranges![0]!.sheetId === sheetId ? [x.addConditionalFormatRule.rule!] : []));
const rumusCf = (rules: sheets_v4.Schema$ConditionalFormatRule[]) =>
  rules.flatMap((r) => (r.booleanRule?.condition?.type === "CUSTOM_FORMULA" ? [r.booleanRule.condition.values![0]!.userEnteredValue!] : []));
const hex = (h: string) => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 });

describe("tampilanRequests", () => {
  const r = tampilanRequests(bp, ids);

  it("aturan warna bersyarat lama dihapus dulu (jalan ulang tidak menumpuk aturan)", () => {
    const ulang = tampilanRequests(bp, ids, new Map([["Dashboard Host", 3], ["Harian per Host", 1]]));
    const hapus = ulang.filter((x) => x.deleteConditionalFormatRule);
    expect(hapus).toHaveLength(4);
    expect(hapus.filter((x) => x.deleteConditionalFormatRule!.sheetId === id("Dashboard Host"))).toHaveLength(3);
    expect(hapus.every((x) => x.deleteConditionalFormatRule!.index === 0)).toBe(true);
    const pertamaTambah = ulang.findIndex((x) => x.addConditionalFormatRule?.rule?.ranges?.[0]?.sheetId === id("Dashboard Host"));
    const terakhirHapus = ulang.map((x) => x.deleteConditionalFormatRule?.sheetId).lastIndexOf(id("Dashboard Host"));
    expect(terakhirHapus).toBeLessThan(pertamaTambah);
    expect(r.some((x) => x.deleteConditionalFormatRule)).toBe(false);
  });

  it("setiap tab diberi warna tab; tab dashboard tanpa garis kisi", () => {
    for (const t of bp) {
      const p = r.find((x) => x.updateSheetProperties?.properties?.sheetId === id(t.title) && x.updateSheetProperties.fields?.includes("tabColorStyle"));
      expect(p, t.title).toBeTruthy();
    }
    const dash = r.find((x) => x.updateSheetProperties?.properties?.sheetId === id("Dashboard Host") && x.updateSheetProperties.fields?.includes("hideGridlines"))!;
    expect(dash.updateSheetProperties!.properties!.gridProperties!.hideGridlines).toBe(true);
    const data = r.find((x) => x.updateSheetProperties?.properties?.sheetId === id("Data Kredit") && x.updateSheetProperties.fields?.includes("hideGridlines"))!;
    expect(data.updateSheetProperties!.properties!.gridProperties!.hideGridlines).toBe(false);
  });

  it("kolom isian owner berwarna biru (sama dengan rentang yang boleh diedit)", () => {
    for (const t of bp.filter((x) => x.editableRanges.length > 0)) {
      const biru = r.filter((x) => x.repeatCell?.range?.sheetId === id(t.title) &&
        JSON.stringify(x.repeatCell.cell?.userEnteredFormat?.backgroundColorStyle?.rgbColor) === JSON.stringify(hex(WARNA.isian)));
      expect(biru.length, t.title).toBeGreaterThanOrEqual(t.editableRanges.length);
    }
  });

  it("Dashboard Host: status ✅/⚠/🔴, posisi jalur, selisih vs Seharusnya (N), disiplin", () => {
    const rules = cf(r, id("Dashboard Host"));
    const awalan = rules.flatMap((x) => (x.booleanRule?.condition?.type === "TEXT_STARTS_WITH" ? [x.booleanRule.condition.values![0]!.userEnteredValue] : []));
    expect(awalan).toEqual(expect.arrayContaining(["✅", "⚠", "🔴"]));
    const f = rumusCf(rules);
    expect(f).toContain('=AND($A8<>"",ISNUMBER($D8),ISNUMBER($E8),$D8>=$E8)');
    expect(f.some((x) => x.includes("0.1*$N8"))).toBe(true);
    expect(f.some((x) => x.includes("$L8>=0.98"))).toBe(true);
  });

  it("rumus warna yang merujuk tab lain selalu lewat INDIRECT (Sheets menolak rujukan lain-tab langsung)", () => {
    for (const t of bp) {
      for (const f of rumusCf(cf(r, id(t.title)))) {
        const tanpaIndirect = f.replace(/INDIRECT\("[^"]*"\)/g, "");
        expect(tanpaIndirect, `${t.title}: ${f}`).not.toMatch(/!/);
      }
    }
    const harian = rumusCf(cf(r, id("Harian per Host")));
    expect(harian).toHaveLength(3);
    expect(harian[0]).toContain("INDIRECT(\"'Target Harian'!C2:C\")");
    expect(harian[0]).toContain("INDIRECT(\"'Target Harian'!D2:D\")");
  });

  it("judul tab dan pilihan Bandingkan tidak terpotong", () => {
    const lebarA = (t: string) => r.find((x) => x.updateDimensionProperties?.range?.sheetId === id(t) &&
      x.updateDimensionProperties.range.dimension === "COLUMNS" && x.updateDimensionProperties.range.startIndex === 0)!
      .updateDimensionProperties!.properties!.pixelSize!;
    // Judul 14pt tebal ("Harian per Host") butuh ±145 px; sel B1 berisi label sehingga judul tidak bisa meluber.
    for (const t of ["Dashboard Host", "Harian per Host", "Analisis Live"]) expect(lebarA(t), t).toBeGreaterThanOrEqual(150);
    // H2 berisi dropdown; teks dropdown tidak meluber ke sel sebelah, jadi dibungkus dan baris 2 dibuat cukup tinggi.
    for (const t of ["Dashboard Host", "Harian per Host", "Analisis Live"]) {
      const h2 = r.find((x) => x.repeatCell?.range?.sheetId === id(t) && x.repeatCell.range.startRowIndex === 1 &&
        x.repeatCell.range.startColumnIndex === 7 && x.repeatCell.range.endColumnIndex === 8)!;
      expect(h2?.repeatCell?.cell?.userEnteredFormat?.wrapStrategy, t).toBe("WRAP");
      const baris2 = r.find((x) => x.updateDimensionProperties?.range?.sheetId === id(t) &&
        x.updateDimensionProperties.range.dimension === "ROWS" && x.updateDimensionProperties.range.startIndex === 1)!;
      expect(baris2.updateDimensionProperties!.properties!.pixelSize, t).toBeGreaterThanOrEqual(40);
    }
    // Analisis Live: kolom H juga kolom jam 06 di peta jam (sempit); harus cukup lebar untuk 2 baris "Bulan lalu / tanggal sama".
    const lebarH = r.filter((x) => x.updateDimensionProperties?.range?.sheetId === id("Analisis Live") &&
      x.updateDimensionProperties.range.dimension === "COLUMNS" && x.updateDimensionProperties.range.startIndex! <= 7 &&
      x.updateDimensionProperties.range.endIndex! > 7).at(-1)!;
    expect(lebarH.updateDimensionProperties!.properties!.pixelSize).toBeGreaterThanOrEqual(130);
  });

  it("Analisis Live: peta jam bergradasi putih → biru", () => {
    const g = cf(r, id("Analisis Live")).find((x) => x.gradientRule)!;
    expect(g.ranges![0]).toMatchObject({ startRowIndex: 32, endRowIndex: 34, startColumnIndex: 1, endColumnIndex: 25 });
    expect(g.gradientRule!.maxpoint!.colorStyle!.rgbColor).toEqual(hex(WARNA.petaTinggi));
  });

  it("Tren Bulanan: % tim dan % tiap host diwarnai", () => {
    const rules = cf(r, id("Tren Bulanan"));
    const pct = rules.map((x) => x.ranges![0]!.startColumnIndex);
    expect(new Set(pct)).toEqual(new Set([3, ...Array.from({ length: 10 }, (_, i) => 8 + 5 * i)]));
    // Baris 6 = bulan berjalan (belum penuh) → tidak diwarnai; baris 7+ = bulan yang sudah selesai.
    expect(rules.every((x) => x.ranges![0]!.startRowIndex === 6)).toBe(true);
    expect(rumusCf(rules)).toContain('=AND($A7<>"",ISNUMBER($D7),$D7>=1)');
    expect(rumusCf(rules).some((f) => f.includes("ISNUMBER(1)") || f.includes("*1)"))).toBe(false);
  });

  it("Keputusan berwarna di Koreksi, Gangguan, Kehadiran", () => {
    const teks = (t: string) => cf(r, id(t)).map((x) => x.booleanRule!.condition!.values![0]!.userEnteredValue);
    expect(teks("Koreksi & Atribusi")).toEqual(expect.arrayContaining(["Setujui", "Menunggu", "Tolak"]));
    expect(teks("Kehadiran")).toEqual(expect.arrayContaining(["Disetujui", "Ditolak", "Tanpa keterangan"]));
    expect(teks("Gangguan")).toEqual(expect.arrayContaining(["Disetujui", "Ditolak"]));
  });
});

describe("bar progres dan format ringkas", () => {
  it("legenda Dashboard Host menjelaskan beda bar (jalur bulan) dan status (target harian)", () => {
    const a6 = String(bp.find((t) => t.title === "Dashboard Host")!.values!.A6);
    expect(a6).toMatch(/bar = % target bulan/i);
    expect(a6).toMatch(/status = hari berturut-turut di bawah target harian/i);
  });

  it("kolom P Dashboard Host berisi SPARKLINE per baris host, warna menurut posisi jalur", () => {
    const dh = bp.find((t) => t.title === "Dashboard Host")!;
    expect(dh.values!.P7).toBe("Progres");
    for (let b = 8; b <= 17; b++) expect(dh.values![`P${b}`]).toBe(rumusBarProgres(b));
    const f = rumusBarProgres(8);
    expect(f).toMatch(/^=IFERROR\(IF\(OR\(\$A8="",NOT\(ISNUMBER\(\$D8\)\)\),"",SPARKLINE\(/);
    expect(f).toContain('IF($D8>=$E8,"#1D7F47",IF($D8>=0.9*$E8,"#E0A21B","#B83325"))');
  });

  it("tab dashboard memakai rupiah ringkas; tab data tetap rupiah penuh", () => {
    const pola = (t: string) => formatRequests(bp, ids).filter((x) => x.repeatCell!.range!.sheetId === id(t)).map((x) => x.repeatCell!.cell!.userEnteredFormat!.numberFormat!.pattern);
    expect(pola("Dashboard Host")).toContain('[>=1000000]"Rp"0.0,," jt";[>=1000]"Rp"0," rb";"Rp"0');
    expect(pola("Dashboard Host")).toContain('[>=1000000]"Rp"0.0,," jt";[<=-1000000]"Rp"0.0,," jt";"Rp"0," rb"');
    expect(pola("Dashboard Host")).not.toContain('"Rp"#,##0');
    expect(pola("Data Kredit")).toContain('"Rp"#,##0');
  });
});
