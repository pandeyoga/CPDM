import { describe, expect, it } from "vitest";
import {
  a1ToGrid, formatRequests, namedRangeRequests, protectionRequests, resolveSheetIds, sheetBlueprint,
  spreadsheetPropsRequest, tabRequests, validationRequests, valueRanges, NAMED_RANGES,
} from "../src/infra/sheetBlueprint.js";
import { dashboardFormulas, type Layout } from "../src/domain/sheetFormulas.js";
import { PRESETS } from "../src/domain/period.js";
import { PENGATURAN_KEY_ORDER, PENGATURAN_KEYS } from "../src/infra/sheets.js";

const bp = sheetBlueprint();
const tab = (t: string) => bp.find((x) => x.title === t)!;
const FILTERED = ["Dashboard Host", "Harian per Host", "Analisis Live"];

describe("sheetBlueprint", () => {
  it("punya 15 tab unik", () => {
    expect(bp).toHaveLength(15);
    expect(new Set(bp.map((t) => t.title)).size).toBe(15);
  });

  it.each(FILTERED)("%s: filter B2/D2/F2/H2, hanya B2:H2 bisa diedit", (t) => {
    const x = tab(t);
    expect(x.editableRanges).toEqual(["B2:H2"]);
    expect(x.editors).toBe("owner");
    const b2 = x.validations!.find((v) => v.range === "B2")!;
    expect(b2.kind).toBe("list");
    expect(b2.values).toEqual([...PRESETS]);
    expect(b2.values).toHaveLength(9);
    expect(x.validations!.find((v) => v.range === "D2")!.kind).toBe("date");
    expect(x.validations!.find((v) => v.range === "F2")!.kind).toBe("date");
    expect(x.validations!.find((v) => v.range === "H2")!.values).toHaveLength(3);
    expect(x.formats!.some((f) => f.range === "J2:K3" && f.kind === "sembunyi")).toBe(true);
  });

  it("rumus identik dengan dashboardFormulas()", () => {
    for (const t of ["Dashboard Host", "Harian per Host", "Analisis Live", "Tren Bulanan", "Kontrol"] as Layout[]) {
      expect(tab(t).formulas).toEqual(dashboardFormulas(t));
    }
  });

  it("Pengaturan: hanya kolom input owner, Jadwal aktif YA/TIDAK, validasi nama host", () => {
    const p = tab("Pengaturan");
    expect(p.editableRanges).toContain("B2:B60");
    expect(p.editableRanges.every((r) => !/^[CFK]/.test(r) && !/^A/.test(r))).toBe(true);
    const baris = PENGATURAN_KEY_ORDER.indexOf(PENGATURAN_KEYS.jadwalAktif) + 2;
    expect(p.validations).toContainEqual({ range: `B${baris}`, kind: "list", values: ["YA", "TIDAK"] });
    const host = p.validations!.find((v) => v.range === "G2:G11")!;
    expect(host.kind).toBe("custom");
    expect(host.formula).toContain('FIND("*",G2)');
    expect(p.defaults![`B${baris}`]).toBe("TIDAK");
    expect(p.defaults!.B7).toBe(240);
    expect(p.defaults!.B8).toBe(6);
  });

  it("tab bot terkunci dan Kontrol tersembunyi", () => {
    for (const t of ["Sesi Live", "Data Kredit", "Target Harian", "Log Bot", "Heartbeat", "Kontrol", "Tren Bulanan"]) {
      expect(tab(t).editableRanges).toEqual([]);
      expect(tab(t).editors).toBe("none");
    }
    expect(tab("Kontrol").hidden).toBe(true);
    expect(bp.filter((t) => t.hidden)).toHaveLength(1);
  });

  it("tab owner: kolom yang boleh diedit", () => {
    expect(tab("Koreksi & Atribusi").editableRanges).toEqual(["F2:G"]);
    expect(tab("Gangguan").editableRanges).toEqual(["B2:B", "G2:G"]);
    expect(tab("Kehadiran").editableRanges).toEqual(["A2:D", "F2:F"]);
    expect(tab("Kalender Live").editableRanges).toEqual(["A2:B"]);
  });

  it("Dashboard Host: header sesuai format-live.png", () => {
    const x = tab("Dashboard Host");
    expect(x.headerRow).toBe(7);
    expect(x.headers.slice(0, 13)).toEqual([
      "Host", "Target bulan", "Realisasi", "Progres (garis = seharusnya)", "% vs seharusnya", "Selisih jalur",
      "Butuh/hari kerja", "vs pembanding", "Jam on-air", "Omzet/jam", "Konversi", "Disiplin lapor", "Status",
    ]);
  });

  it("Kehadiran: kolom dan daftar Jenis/Keputusan", () => {
    const k = tab("Kehadiran");
    expect(k.headers).toEqual(["Tanggal", "Host", "Jenis", "Alasan", "Sumber", "Keputusan"]);
    expect(k.validations!.find((v) => v.range === "C2:C")!.values).toEqual(["Sakit", "Izin", "Cuti", "Telat"]);
    expect(k.validations!.find((v) => v.range === "F2:F")!.values).toContain("Disetujui");
  });
});

describe("penyusun request", () => {
  const ids = resolveSheetIds(bp, new Map([["Pengaturan", 77]]));

  it("resolveSheetIds memakai id yang ada dan membuat id unik untuk tab baru", () => {
    expect(ids.get("Pengaturan")).toBe(77);
    expect(new Set(ids.values()).size).toBe(15);
  });

  it("a1ToGrid", () => {
    expect(a1ToGrid("B2:H2", 5)).toEqual({ sheetId: 5, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 8 });
    expect(a1ToGrid("F2:F", 5)).toEqual({ sheetId: 5, startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 });
    expect(a1ToGrid("G2", 5)).toEqual({ sheetId: 5, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 6, endColumnIndex: 7 });
  });

  it("tabRequests: hanya tab yang belum ada ditambah, Kontrol disembunyikan", () => {
    const r = tabRequests(bp, ids, new Set(["Pengaturan"]));
    expect(r.filter((x) => x.addSheet)).toHaveLength(14);
    expect(r.some((x) => x.addSheet?.properties?.title === "Pengaturan")).toBe(false);
    const h = r.find((x) => x.updateSheetProperties)!;
    expect(h.updateSheetProperties).toMatchObject({ properties: { sheetId: ids.get("Kontrol"), hidden: true }, fields: "hidden" });
  });

  it("spreadsheetPropsRequest: zona dan locale", () => {
    expect(spreadsheetPropsRequest().updateSpreadsheetProperties).toEqual({
      properties: { timeZone: "Asia/Jakarta", locale: "id_ID" }, fields: "timeZone,locale",
    });
  });

  it("named range DAFTAR_HOST dan HARI_INI; yang lama dihapus dulu", () => {
    expect(NAMED_RANGES.map((n) => n.name)).toEqual(["DAFTAR_HOST", "HARI_INI"]);
    const r = namedRangeRequests(ids, [{ name: "HARI_INI", namedRangeId: "abc" }]);
    expect(r[0]).toEqual({ deleteNamedRange: { namedRangeId: "abc" } });
    const dh = r.find((x) => x.addNamedRange?.namedRange?.name === "DAFTAR_HOST")!;
    expect(dh.addNamedRange!.namedRange!.range).toEqual(
      { sheetId: 77, startRowIndex: 1, endRowIndex: 11, startColumnIndex: 6, endColumnIndex: 7 });
    const hi = r.find((x) => x.addNamedRange?.namedRange?.name === "HARI_INI")!;
    expect(hi.addNamedRange!.namedRange!.range!.sheetId).toBe(ids.get("Kontrol"));
  });

  it("validasi: list, tanggal ketat, formula khusus", () => {
    const r = validationRequests(bp, ids);
    const dash = ids.get("Dashboard Host");
    const b2 = r.find((x) => x.setDataValidation?.range?.sheetId === dash && x.setDataValidation?.range?.startColumnIndex === 1)!;
    expect(b2.setDataValidation!.rule).toMatchObject({ condition: { type: "ONE_OF_LIST" }, strict: true, showCustomUi: true });
    expect(b2.setDataValidation!.rule!.condition!.values).toHaveLength(9);
    const d2 = r.find((x) => x.setDataValidation?.range?.sheetId === dash && x.setDataValidation?.range?.startColumnIndex === 3)!;
    expect(d2.setDataValidation!.rule).toMatchObject({ condition: { type: "DATE_IS_VALID" }, strict: true });
    const host = r.find((x) => x.setDataValidation?.rule?.condition?.type === "CUSTOM_FORMULA")!;
    expect(host.setDataValidation!.rule!.condition!.values![0]!.userEnteredValue).toMatch(/^=AND\(/);
  });

  it("format angka: J2:K3 disembunyikan dengan ;;;, Rupiah dan tanggal", () => {
    const r = formatRequests(bp, ids);
    const dash = ids.get("Dashboard Host");
    const hide = r.find((x) => x.repeatCell?.range?.sheetId === dash && x.repeatCell?.range?.startColumnIndex === 9 && x.repeatCell?.range?.endRowIndex === 3)!;
    expect(hide.repeatCell!.cell!.userEnteredFormat!.numberFormat!.pattern).toBe(";;;");
    expect(hide.repeatCell!.fields).toBe("userEnteredFormat.numberFormat");
    const pats = r.map((x) => x.repeatCell?.cell?.userEnteredFormat?.numberFormat?.pattern);
    expect(pats).toContain('"Rp"#,##0');
    expect(pats).toContain("dd/mm/yyyy");
  });

  it("proteksi: semua tab, owner sebagai editor, tanpa peringatan saja, rentang bebas kunci", () => {
    const r = protectionRequests(bp, ids, "owner@example.com", [
      { protectedRangeId: 9, description: "CP: Gangguan" }, { protectedRangeId: 10, description: "buatan owner" },
    ]);
    expect(r.filter((x) => x.deleteProtectedRange)).toEqual([{ deleteProtectedRange: { protectedRangeId: 9 } }]);
    const add = r.filter((x) => x.addProtectedRange).map((x) => x.addProtectedRange!.protectedRange!);
    expect(add).toHaveLength(15);
    for (const p of add) {
      expect(p.warningOnly).toBe(false);
      expect(p.editors).toEqual({ users: ["owner@example.com"] });
      expect(p.range).toEqual({ sheetId: p.range!.sheetId });
    }
    const dash = add.find((p) => p.range!.sheetId === ids.get("Dashboard Host"))!;
    expect(dash.unprotectedRanges).toEqual([a1ToGrid("B2:H2", ids.get("Dashboard Host")!)]);
    expect(add.find((p) => p.range!.sheetId === ids.get("Sesi Live"))!.unprotectedRanges).toBeUndefined();
  });

  it("valueRanges: sel bersebelahan digabung per baris, kutip nama tab", () => {
    const r = valueRanges("Tab X", new Map<string, string | number>([["A1", "a"], ["B1", "b"], ["D1", "d"], ["A2", 5]]));
    expect(r).toEqual([
      { range: "'Tab X'!A1:B1", values: [["a", "b"]] },
      { range: "'Tab X'!D1", values: [["d"]] },
      { range: "'Tab X'!A2", values: [[5]] },
    ]);
  });
});

describe("setupSheet (klien palsu)", () => {
  async function jalankan(sudahAda: boolean, terisi: Record<string, unknown>) {
    const { setupSheet } = await import("../scripts/setup-sheet.js");
    const titles = sheetBlueprint().map((t) => t.title);
    const calls: Array<{ requests?: unknown[]; data?: Array<{ range: string; values: unknown[][] }> }> = [];
    const sheets = {
      spreadsheets: {
        create: async () => ({ data: { spreadsheetId: "SID" } }),
        get: async () => ({
          data: {
            sheets: titles.map((title, i) => ({
              properties: { sheetId: 100 + i, title },
              protectedRanges: sudahAda ? [{ protectedRangeId: 5, description: "CP: Gangguan" }] : [],
            })),
            namedRanges: sudahAda ? [{ name: "HARI_INI", namedRangeId: "n1" }] : [],
          },
        }),
        batchUpdate: async (a: { requestBody: { requests: unknown[] } }) => void calls.push(a.requestBody),
        values: {
          batchGet: async (a: { ranges: string[] }) => ({
            data: { valueRanges: a.ranges.map((r) => ({ values: r in terisi ? [[terisi[r]]] : undefined })) },
          }),
          batchUpdate: async (a: { requestBody: { data: Array<{ range: string; values: unknown[][] }> } }) => void calls.push(a.requestBody),
        },
      },
    };
    const drive = {
      about: { get: async () => ({ data: { user: { emailAddress: "o@example.com" } } }) },
      files: { list: async () => ({ data: { files: [] } }), create: async () => ({ data: { id: "FID" } }) },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasil = await setupSheet(sheets as any, drive as any, { spreadsheetId: "SID" });
    return { hasil, calls };
  }

  it("menulis bawaan Pengaturan hanya ke sel kosong dan mengganti proteksi lama", async () => {
    const { hasil, calls } = await jalankan(true, { "'Pengaturan'!B2": "YA", "'Dashboard Host'!B2": "Kemarin" });
    expect(hasil).toEqual({ spreadsheetId: "SID", buktiFolderId: "FID" });
    const reqs = calls[0]!.requests as Array<Record<string, unknown>>;
    expect(reqs.some((r) => "deleteProtectedRange" in r)).toBe(true);
    expect(reqs.some((r) => "deleteNamedRange" in r)).toBe(true);
    expect(reqs.some((r) => "addSheet" in r)).toBe(false);
    const ditulis = calls[1]!.data!.map((d) => d.range);
    expect(ditulis).not.toContain("'Pengaturan'!B2");
    expect(ditulis).not.toContain("'Dashboard Host'!B2");
    expect(ditulis).toContain("'Dashboard Host'!H2");
    expect(ditulis).toContain("'Pengaturan'!B3");
    expect(ditulis).toContain("'Pengaturan'!B10");
  });
});
