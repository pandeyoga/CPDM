import { readFileSync } from "node:fs";
import type { sheets_v4 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import {
  a1ToGrid, formatRequests, gridKolomRequests, kebutuhanKolom, namedRangeRequests, protectionRequests, resolveSheetIds, sheetBlueprint,
  spreadsheetPropsRequest, tabCells, tabCellsTerpisah, tabRequests, validationRequests, valueRanges, NAMED_RANGES, LOCALE_RUMUS,
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
    expect(host.formula).toContain("G2=TRIM(G2)"); // M4: tanpa spasi di awal/akhir atau ganda
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
    expect(tab("Gangguan").editableRanges).toEqual(["B2:D", "G2:G"]); // I5: Mulai/Selesai (C:D) boleh diubah owner
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

  it("spreadsheetPropsRequest: zona dan locale (in_ID tampilan; en_US saat menulis rumus)", () => {
    // Google menolak "id_ID" (Unsupported locale); kode Indonesia di Sheets adalah "in_ID".
    expect(spreadsheetPropsRequest().updateSpreadsheetProperties).toEqual({
      properties: { timeZone: "Asia/Jakarta", locale: "in_ID" }, fields: "timeZone,locale",
    });
    expect(spreadsheetPropsRequest(LOCALE_RUMUS).updateSpreadsheetProperties!.properties!.locale).toBe("en_US");
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
    const r = protectionRequests(bp, ids, ["owner@example.com", "lain@example.com"], [
      { protectedRangeId: 9, description: "CP: Gangguan" }, { protectedRangeId: 10, description: "buatan owner" },
    ]);
    expect(r.filter((x) => x.deleteProtectedRange)).toEqual([{ deleteProtectedRange: { protectedRangeId: 9 } }]);
    const add = r.filter((x) => x.addProtectedRange).map((x) => x.addProtectedRange!.protectedRange!);
    expect(add).toHaveLength(15);
    for (const p of add) {
      expect(p.warningOnly).toBe(false);
      expect(p.editors).toEqual({ users: ["owner@example.com", "lain@example.com"] });
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
    // Batch utama = yang memuat proteksi (batch pertama kini hanya locale en_US).
    const reqs = calls.find((c) => (c.requests as Array<Record<string, unknown>> | undefined)?.some((r) => "addProtectedRange" in r))!.requests as Array<Record<string, unknown>>;
    expect(reqs.some((r) => "deleteProtectedRange" in r)).toBe(true);
    expect(reqs.some((r) => "deleteNamedRange" in r)).toBe(true);
    expect(reqs.some((r) => "addSheet" in r)).toBe(false);
    const ditulis = calls.filter((c) => c.data)[1]!.data!.map((d) => d.range);
    expect(ditulis).not.toContain("'Pengaturan'!B2");
    expect(ditulis).not.toContain("'Dashboard Host'!B2");
    expect(ditulis).toContain("'Dashboard Host'!H2");
    expect(ditulis).toContain("'Pengaturan'!B3");
    expect(ditulis).toContain("'Pengaturan'!B10");
  });
});

describe("invarian tulis ulang", () => {
  const sama = (a: sheets_v4.Schema$GridRange, b: sheets_v4.Schema$GridRange): boolean => {
    const inf = Number.MAX_SAFE_INTEGER;
    return a.startRowIndex! < (b.endRowIndex ?? inf) && b.startRowIndex! < (a.endRowIndex ?? inf) &&
      a.startColumnIndex! < b.endColumnIndex! && b.startColumnIndex! < a.endColumnIndex!;
  };
  it("sel yang ditulis ulang (header, label, rumus) tidak pernah di dalam rentang edit owner", () => {
    for (const t of bp) {
      const edit = t.editableRanges.map((r) => a1ToGrid(r, 1));
      for (const a1 of tabCells(t).keys()) {
        const g = a1ToGrid(a1, 1);
        expect(edit.some((e) => sama(e, g)), `${t.title}!${a1}`).toBe(false);
      }
      for (const a1 of Object.keys(t.defaults ?? {})) expect(Object.keys(t.formulas ?? {})).not.toContain(a1);
    }
  });
  it("hanya string berawalan = yang masuk jalur USER_ENTERED; header '+Omzet' tetap statis (RAW)", () => {
    for (const t of bp) {
      const { statik, rumus } = tabCellsTerpisah(t);
      for (const [a1, v] of statik) if (typeof v === "string") expect(v, `${t.title}!${a1}`).not.toMatch(/^=/);
      for (const v of rumus.values()) expect(String(v).startsWith("=")).toBe(true);
    }
    expect(tabCellsTerpisah(tab("Sesi Live")).statik.get("G1")).toBe("+Omzet");
  });
});

describe("heartbeat.gs", () => {
  const src = readFileSync(new URL("../../apps-script/heartbeat.gs", import.meta.url), "utf8");
  function muat(hb: unknown[], email = "o@example.com", sheetsAda = true, props: Record<string, string> = {}) {
    const mails: string[][] = [];
    const logs: string[] = [];
    const sheet = (nilai: unknown[][]) => ({ getRange: () => ({ getValues: () => nilai }) });
    const tab = new Map([["Heartbeat", sheet([hb])], ["Pengaturan", sheet([["Email owner", email]])]]);
    const env = {
      SpreadsheetApp: { getActive: () => ({ getSheetByName: (n: string) => (sheetsAda ? tab.get(n) ?? null : null) }) },
      MailApp: { sendEmail: (to: string, sub: string) => void mails.push([to, sub]) },
      PropertiesService: { getScriptProperties: () => ({
        getProperty: (k: string) => props[k] ?? null, setProperty: (k: string, v: string) => void (props[k] = v),
        deleteProperty: (k: string) => void delete props[k] }) },
      Logger: { log: (m: string) => void logs.push(m) },
      ScriptApp: {},
    };
    const f = new Function("SpreadsheetApp", "MailApp", "PropertiesService", "Logger", "ScriptApp", `${src}\nreturn { cekDetak, nilaiMasalah_ };`)(
      env.SpreadsheetApp, env.MailApp, env.PropertiesService, env.Logger, env.ScriptApp) as { cekDetak(): void; nilaiMasalah_(a: unknown, b: unknown, n: Date): { status: string } };
    return { f, mails, logs, props };
  }
  const NOW = new Date("2026-11-20T10:00:00Z");

  it("nilaiMasalah_: sehat, basi, WA bukan WORKING, kosong = belum aktif", () => {
    const { f } = muat([]);
    expect(f.nilaiMasalah_("2026-11-20T09:55:00Z", "WORKING", NOW).status).toBe("sehat");
    expect(f.nilaiMasalah_("2026-11-20T09:49:00Z", "WORKING", NOW).status).toBe("masalah");
    expect(f.nilaiMasalah_("2026-11-20T09:55:00Z", "STOPPED", NOW).status).toBe("masalah");
    expect(f.nilaiMasalah_("", "", NOW).status).toBe("belum_aktif");
  });

  it("satu email per kejadian, lalu email pulih", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const props: Record<string, string> = {};
      const basi = muat(["2026-11-20T09:30:00Z", "WORKING"], "o@example.com", true, props);
      basi.f.cekDetak(); basi.f.cekDetak();
      expect(basi.mails).toEqual([["o@example.com", "[CP Live] Bot bermasalah"]]);
      const pulih = muat(["2026-11-20T09:58:00Z", "WORKING"], "o@example.com", true, props);
      pulih.f.cekDetak(); pulih.f.cekDetak();
      expect(pulih.mails).toEqual([["o@example.com", "[CP Live] Bot pulih"]]);
      expect(props).toEqual({});
    } finally { vi.useRealTimers(); }
  });

  it("A2 kosong: tanpa email; tab hilang/email kosong: tidak melempar, dicatat", () => {
    const kosong = muat(["", ""]);
    kosong.f.cekDetak();
    expect(kosong.mails).toEqual([]);
    const hilang = muat(["x", "y"], "o@example.com", false);
    expect(() => hilang.f.cekDetak()).not.toThrow();
    expect(hilang.logs).toHaveLength(1);
    const tanpaEmail = muat(["2020-01-01T00:00:00Z", "WORKING"], "");
    tanpaEmail.f.cekDetak();
    expect(tanpaEmail.mails).toEqual([]);
    expect(tanpaEmail.logs[0]).toMatch(/Email owner/);
  });
});

describe("setupSheet: editor proteksi dan RAW", () => {
  async function jalan(ownerEmail?: string) {
    const { setupSheet } = await import("../scripts/setup-sheet.js");
    const titles = sheetBlueprint().map((t) => t.title);
    const reqs: unknown[][] = [];
    const modes: Array<{ mode: string; data: Array<{ range: string; values: unknown[][] }> }> = [];
    const sheets = { spreadsheets: {
      get: async () => ({ data: { sheets: titles.map((title, i) => ({ properties: { sheetId: 100 + i, title } })) } }),
      batchUpdate: async (a: { requestBody: { requests: unknown[] } }) => void reqs.push(a.requestBody.requests),
      values: { batchGet: async () => ({ data: { valueRanges: [] } }),
        batchUpdate: async (a: { requestBody: { valueInputOption: string; data: Array<{ range: string; values: unknown[][] }> } }) =>
          void modes.push({ mode: a.requestBody.valueInputOption, data: a.requestBody.data }) },
    } };
    const drive = { about: { get: async () => ({ data: { user: { emailAddress: "oauth@example.com" } } }) },
      files: { list: async () => ({ data: { files: [{ id: "F" }] } }) } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setupSheet(sheets as any, drive as any, { spreadsheetId: "S", ...(ownerEmail ? { ownerEmail } : {}) });
    const utama = reqs.find((b) => (b as Array<Record<string, unknown>>).some((r) => "addProtectedRange" in r))!;
    const adds = (utama as Array<{ addProtectedRange?: { protectedRange: { editors: { users: string[] } } } }>).filter((r) => r.addProtectedRange);
    return { users: adds.map((r) => r.addProtectedRange!.protectedRange.editors.users), modes };
  }
  it("editor selalu akun OAuth; OWNER_EMAIL berbeda ditambahkan", async () => {
    expect((await jalan()).users.every((u) => u.length === 1 && u[0] === "oauth@example.com")).toBe(true);
    expect((await jalan("oauth@example.com")).users[0]).toEqual(["oauth@example.com"]);
    expect((await jalan("lain@example.com")).users[0]).toEqual(["oauth@example.com", "lain@example.com"]);
  });
  it("header statis ditulis RAW, rumus USER_ENTERED", async () => {
    const { modes } = await jalan();
    expect(modes.map((m) => m.mode)).toEqual(["RAW", "USER_ENTERED"]);
    const raw = modes[0]!.data.flatMap((d) => d.values[0]!);
    expect(raw).toContain("+Omzet");
    expect(modes[1]!.data.flatMap((d) => d.values[0]!)).not.toContain("+Omzet");
    expect(modes[1]!.data.some((d) => d.range === "'Kontrol'!F2")).toBe(true);
  });
});

describe("validasi host dari DAFTAR_HOST", () => {
  it("Gangguan dan Kehadiran: kolom Host ONE_OF_RANGE", () => {
    const ids = resolveSheetIds(bp, new Map());
    const r = validationRequests(bp, ids).filter((x) => x.setDataValidation?.rule?.condition?.type === "ONE_OF_RANGE");
    expect(r.map((x) => x.setDataValidation!.range!.sheetId).sort()).toEqual([ids.get("Gangguan"), ids.get("Kehadiran")].sort());
    expect(r[0]!.setDataValidation!.rule!.condition!.values![0]!.userEnteredValue).toBe("=Pengaturan!$G$2:$G$11");
  });
});

describe("ukuran grid tab fakta", () => {
  const MIN: Record<string, number> = {
    "Data Kredit": 50_000, "Target Harian": 5_000, "Sesi Live": 20_000, "Log Bot": 20_000, "Koreksi & Atribusi": 5_000,
  };
  const ids = resolveSheetIds(bp, new Map());
  const ubah = (r: ReturnType<typeof tabRequests>) =>
    r.filter((x) => x.updateSheetProperties?.fields === "gridProperties.rowCount").map((x) => x.updateSheetProperties!);

  it("tab fakta baru dibuat langsung dengan jumlah baris yang cukup; tab lain memakai ukuran bawaan", () => {
    const r = tabRequests(bp, ids, new Set());
    for (const [title, baris] of Object.entries(MIN)) {
      const add = r.find((x) => x.addSheet?.properties?.title === title)!;
      expect(add.addSheet!.properties!.gridProperties, title).toEqual({ rowCount: baris });
    }
    expect(r.find((x) => x.addSheet?.properties?.title === "Pengaturan")!.addSheet!.properties!.gridProperties).toBeUndefined();
  });

  it("tab yang sudah ada dan lebih kecil diperbesar; yang sama atau lebih besar tidak disentuh (tidak pernah menyusut)", () => {
    const ada = new Set(bp.map((t) => t.title));
    const jumlah = new Map<string, number>([
      ["Data Kredit", 1_000], ["Target Harian", 5_000], ["Sesi Live", 80_000], ["Log Bot", 19_999], ["Koreksi & Atribusi", 1_000], ["Pengaturan", 1_000],
    ]);
    const u = ubah(tabRequests(bp, ids, ada, jumlah));
    expect(u.map((x) => [x.properties!.sheetId, x.properties!.gridProperties!.rowCount])).toEqual([
      [ids.get("Koreksi & Atribusi"), 5_000], [ids.get("Data Kredit"), 50_000], [ids.get("Log Bot"), 20_000],
    ].sort((a, b) => bp.findIndex((t) => ids.get(t.title) === a![0]) - bp.findIndex((t) => ids.get(t.title) === b![0])));
  });

  it("jumlah baris tidak diketahui: tidak ada perubahan ukuran", () => {
    expect(ubah(tabRequests(bp, ids, new Set(bp.map((t) => t.title))))).toEqual([]);
  });

  async function jalankan(rowCount: (title: string) => number) {
    const { setupSheet } = await import("../scripts/setup-sheet.js");
    const titles = sheetBlueprint().map((t) => t.title);
    const reqs: Array<Record<string, any>> = [];
    let fields = "";
    const sheets = { spreadsheets: {
      get: async (a: { fields: string }) => {
        fields = a.fields;
        return { data: { sheets: titles.map((title, i) => ({ properties: { sheetId: 100 + i, title, gridProperties: { rowCount: rowCount(title) } } })) } };
      },
      batchUpdate: async (a: { requestBody: { requests: Array<Record<string, any>> } }) => void reqs.push(...a.requestBody.requests),
      values: { batchGet: async () => ({ data: { valueRanges: [] } }), batchUpdate: async () => ({}) },
    } };
    const drive = { about: { get: async () => ({ data: { user: { emailAddress: "o@example.com" } } }) },
      files: { list: async () => ({ data: { files: [{ id: "F" }] } }) } };
    await setupSheet(sheets as never, drive as never, { spreadsheetId: "S" });
    return { reqs, fields };
  }

  it("setupSheet (jalan ulang): membaca gridProperties.rowCount dan memperbesar tab fakta yang masih 1.000 baris", async () => {
    const { reqs, fields } = await jalankan(() => 1_000);
    expect(fields).toContain("gridProperties(rowCount,columnCount)");
    const u = reqs.filter((r) => r.updateSheetProperties?.fields === "gridProperties.rowCount").map((r) => r.updateSheetProperties.properties.gridProperties.rowCount);
    expect(u.sort((a, b) => a - b)).toEqual([5_000, 5_000, 20_000, 20_000, 50_000]);
  });

  it("setupSheet: jalan ulang saat tab sudah besar tidak menambah perubahan ukuran", async () => {
    const { reqs } = await jalankan((t) => MIN[t] ?? 1_000);
    expect(reqs.filter((r) => r.updateSheetProperties?.fields === "gridProperties.rowCount")).toEqual([]);
  });
});

describe("setupSheet: rumus ditulis saat locale en_US, lalu locale in_ID", () => {
  // Di locale in_ID Google membaca rumus kiriman API dengan pemisah ";" (diuji di Sheets asli: koma → #ERROR!).
  // Rumus yang sudah tersimpan tetap benar saat locale diganti sesudahnya.
  async function urutan(spreadsheetId?: string) {
    const { setupSheet } = await import("../scripts/setup-sheet.js");
    const titles = sheetBlueprint().map((t) => t.title);
    const log: string[] = [];
    let localeBuat: string | undefined;
    const sheets = {
      spreadsheets: {
        create: async (a: { requestBody: { properties: { locale: string } } }) => { localeBuat = a.requestBody.properties.locale; return { data: { spreadsheetId: "SID" } }; },
        get: async () => ({ data: { sheets: titles.map((title, i) => ({ properties: { sheetId: 100 + i, title } })), namedRanges: [] } }),
        batchUpdate: async (a: { requestBody: { requests: Array<Record<string, any>> } }) => {
          for (const r of a.requestBody.requests) {
            const loc = r.updateSpreadsheetProperties?.properties?.locale;
            if (loc) log.push(`locale:${loc}`);
          }
          log.push("batchUpdate");
        },
        values: {
          batchGet: async () => ({ data: { valueRanges: [] } }),
          batchUpdate: async (a: { requestBody: { valueInputOption: string } }) => void log.push(`values:${a.requestBody.valueInputOption}`),
        },
      },
    };
    const drive = {
      about: { get: async () => ({ data: { user: { emailAddress: "o@example.com" } } }) },
      files: { list: async () => ({ data: { files: [] } }), create: async () => ({ data: { id: "FID" } }) },
    };
    await setupSheet(sheets as never, drive as never, spreadsheetId ? { spreadsheetId, buktiFolderId: "F" } : { buktiFolderId: "F" });
    return { log, localeBuat };
  }

  it("spreadsheet baru dibuat dengan en_US; in_ID dipasang sesudah semua nilai ditulis", async () => {
    const { log, localeBuat } = await urutan();
    expect(localeBuat).toBe("en_US");
    expect(log.indexOf("values:USER_ENTERED")).toBeGreaterThan(-1);
    expect(log.lastIndexOf("locale:in_ID")).toBeGreaterThan(log.indexOf("values:USER_ENTERED"));
    expect(log.indexOf("locale:in_ID")).toBe(log.lastIndexOf("locale:in_ID"));
  });

  it("jalan ulang pada spreadsheet yang sudah in_ID: locale dikembalikan ke en_US sebelum rumus ditulis", async () => {
    const { log } = await urutan("SID");
    expect(log.indexOf("locale:en_US")).toBeGreaterThan(-1);
    expect(log.indexOf("locale:en_US")).toBeLessThan(log.indexOf("values:USER_ENTERED"));
    expect(log[log.length - 2]).toBe("locale:in_ID");
  });
});

describe("Analisis Live: semua angka diberi format (diperiksa di Sheets asli: '62385', '98,33816425')", () => {
  const f = sheetBlueprint().find((t) => t.title === "Analisis Live")!.formats!;
  it("hitungan corong: pemisah ribuan", () => {
    expect(f).toContainEqual({ range: "B7:B10", kind: "bilangan" });
    expect(f).toContainEqual({ range: "E7:E11", kind: "bilangan" });
  });
  it("per host: komentar/jam satu desimal, indeks slot dua desimal", () => {
    expect(f).toContainEqual({ range: "F20:F29", kind: "desimal" });
    expect(f).toContainEqual({ range: "G20:G29", kind: "indeks" });
  });
  it("pola format bilangan dan indeks", () => {
    const ids = resolveSheetIds(sheetBlueprint(), new Map());
    const pola = formatRequests(sheetBlueprint(), ids).map((r) => r.repeatCell!.cell!.userEnteredFormat!.numberFormat!.pattern);
    expect(pola).toContain("#,##0");
    expect(pola).toContain("0.00");
  });
});

describe("setupSheet: lapisan tampilan", () => {
  async function jalankan(cfAda: Record<string, number>) {
    const { setupSheet } = await import("../scripts/setup-sheet.js");
    const titles = sheetBlueprint().map((t) => t.title);
    const log: Array<{ jenis: string; requests?: Array<Record<string, any>>; fields?: string }> = [];
    const sheets = {
      spreadsheets: {
        create: async () => ({ data: { spreadsheetId: "SID" } }),
        get: async (a: { fields: string }) => {
          log.push({ jenis: "get", fields: a.fields });
          return { data: { sheets: titles.map((title, i) => ({
            properties: { sheetId: 100 + i, title },
            conditionalFormats: Array.from({ length: cfAda[title] ?? 0 }, () => ({ ranges: [{ sheetId: 100 + i }] })),
          })), namedRanges: [] } };
        },
        batchUpdate: async (a: { requestBody: { requests: Array<Record<string, any>> } }) => void log.push({ jenis: "batch", requests: a.requestBody.requests }),
        values: {
          batchGet: async () => ({ data: { valueRanges: [] } }),
          batchUpdate: async (a: { requestBody: { valueInputOption: string } }) => void log.push({ jenis: `values:${a.requestBody.valueInputOption}` }),
        },
      },
    };
    const drive = { about: { get: async () => ({ data: { user: { emailAddress: "o@example.com" } } }) } };
    await setupSheet(sheets as never, drive as never, { spreadsheetId: "SID", buktiFolderId: "F" });
    return log;
  }
  const isi = (b: { requests?: Array<Record<string, any>> }, k: string) => (b.requests ?? []).some((r) => k in r);

  it("locale en_US dikirim sendiri lebih dulu, supaya rumus validasi & warna bersyarat dibaca dengan koma", async () => {
    const log = await jalankan({});
    const batch = log.filter((x) => x.jenis === "batch");
    expect(batch[0]!.requests).toHaveLength(1);
    expect(batch[0]!.requests![0]!.updateSpreadsheetProperties.properties.locale).toBe("en_US");
  });

  it("tampilan dikirim sesudah nilai ditulis dan sebelum locale in_ID", async () => {
    const log = await jalankan({});
    const iTampilan = log.findIndex((x) => x.jenis === "batch" && isi(x, "addConditionalFormatRule"));
    const iNilai = log.findIndex((x) => x.jenis === "values:USER_ENTERED");
    const iInId = log.findIndex((x) => x.jenis === "batch" && x.requests!.some((r) => r.updateSpreadsheetProperties?.properties?.locale === "in_ID"));
    expect(iTampilan).toBeGreaterThan(iNilai);
    expect(iInId).toBeGreaterThan(iTampilan);
  });

  it("aturan warna bersyarat lama dihitung dari spreadsheets.get dan dihapus", async () => {
    const log = await jalankan({ "Dashboard Host": 2, "Kehadiran": 1 });
    expect(log.find((x) => x.jenis === "get")!.fields).toContain("conditionalFormats");
    const tampilan = log.find((x) => x.jenis === "batch" && isi(x, "addConditionalFormatRule"))!;
    expect(tampilan.requests!.filter((r) => r.deleteConditionalFormatRule)).toHaveLength(3);
  });
});

describe("ukuran kolom grid (diuji di Sheets asli: spreadsheet baru hanya 26 kolom A–Z)", () => {
  // Regresi: "Range ('Analisis Live'!AA5:AB96) exceeds grid limits. Max rows: 1000, max columns: 26".
  // Klien palsu ini meniru Google: setiap rentang di luar grid ditolak, dan ukuran grid ikut berubah sesuai request.
  async function jalankanSepertiGoogle(opsi: { spreadsheetId?: string; fileLama?: string } = { spreadsheetId: "SID" }) {
    const { setupSheet } = await import("../scripts/setup-sheet.js");
    const titles = sheetBlueprint().map((t) => t.title);
    const idTab = new Map(titles.map((t, i) => [t, 100 + i] as const));
    const kolom = new Map(titles.map((t) => [idTab.get(t)!, 26] as const));
    const baris = new Map(titles.map((t) => [idTab.get(t)!, 1000] as const));
    let dibuat = 0;
    const cek = (sheetId: number, k?: number, b?: number, asal = "") => {
      if (k !== undefined && k > kolom.get(sheetId)!) throw new Error(`${asal} melebihi ${kolom.get(sheetId)} kolom (butuh ${k}) di sheet ${sheetId}`);
      if (b !== undefined && b > baris.get(sheetId)!) throw new Error(`${asal} melebihi ${baris.get(sheetId)} baris (butuh ${b}) di sheet ${sheetId}`);
    };
    const jelajah = (o: unknown, asal: string): void => {
      if (Array.isArray(o)) return o.forEach((x) => jelajah(x, asal));
      if (!o || typeof o !== "object") return;
      const g = o as Record<string, any>;
      if (typeof g.sheetId === "number") {
        cek(g.sheetId, g.endColumnIndex ?? (g.startColumnIndex !== undefined ? g.startColumnIndex + 1 : undefined),
          g.endRowIndex ?? (g.startRowIndex !== undefined ? g.startRowIndex + 1 : undefined), asal);
        if (g.dimension === "COLUMNS") cek(g.sheetId, g.endIndex, undefined, asal);
        if (g.dimension === "ROWS") cek(g.sheetId, undefined, g.endIndex, asal);
      }
      for (const v of Object.values(g)) jelajah(v, asal);
    };
    const kolomDari = (h: string) => [...h].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    const sheets = {
      spreadsheets: {
        create: async () => { dibuat++; return { data: { spreadsheetId: "BARU" } }; },
        get: async () => ({ data: { sheets: titles.map((title) => ({ properties: { sheetId: idTab.get(title)!, title,
          gridProperties: { rowCount: baris.get(idTab.get(title)!), columnCount: kolom.get(idTab.get(title)!) } } })), namedRanges: [] } }),
        batchUpdate: async (a: { requestBody: { requests: Array<Record<string, any>> } }) => {
          for (const r of a.requestBody.requests) {
            const gp = r.updateSheetProperties?.properties?.gridProperties;
            if (gp) {
              const sid = r.updateSheetProperties.properties.sheetId;
              if (gp.columnCount) kolom.set(sid, gp.columnCount);
              if (gp.rowCount) baris.set(sid, gp.rowCount);
              continue;
            }
            jelajah(r, Object.keys(r)[0]!);
          }
        },
        values: {
          batchGet: async () => ({ data: { valueRanges: [] } }),
          batchUpdate: async (a: { requestBody: { data: Array<{ range: string }> } }) => {
            for (const d of a.requestBody.data) {
              const m = /^'(.+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(d.range)!;
              cek(idTab.get(m[1]!)!, kolomDari(m[4] ?? m[2]!), Number(m[5] ?? m[3]), `nilai ${d.range}`);
            }
          },
        },
      },
    };
    const drive = {
      about: { get: async () => ({ data: { user: { emailAddress: "o@example.com" } } }) },
      files: {
        list: async (a: { q: string }) => ({ data: { files: a.q.includes("spreadsheet") && opsi.fileLama ? [{ id: opsi.fileLama }] : [] } }),
        create: async () => ({ data: { id: "FID" } }),
      },
    };
    const hasil = await setupSheet(sheets as never, drive as never, { ...(opsi.spreadsheetId ? { spreadsheetId: opsi.spreadsheetId } : {}), buktiFolderId: "F" });
    return { hasil, kolom, idTab, dibuat };
  }

  it("spreadsheet baru (26 kolom) tidak ditolak: grid diperbesar dulu untuk Analisis Live (AB) dan Tren Bulanan (BD)", async () => {
    const { kolom, idTab } = await jalankanSepertiGoogle();
    expect(kolom.get(idTab.get("Analisis Live")!)).toBeGreaterThanOrEqual(28);
    expect(kolom.get(idTab.get("Tren Bulanan")!)).toBeGreaterThanOrEqual(56);
    // Tab yang cukup dengan 26 kolom tidak diubah.
    expect(kolom.get(idTab.get("Pengaturan")!)).toBe(26);
  });

  it("kebutuhanKolom & gridKolomRequests: hanya memperbesar, tidak pernah menyusutkan", () => {
    const ids = resolveSheetIds(bp, new Map());
    const butuh = kebutuhanKolom(bp, ids, formatRequests(bp, ids));
    expect(butuh.get(ids.get("Analisis Live")!)).toBe(28);
    const r = gridKolomRequests(butuh, new Map([[ids.get("Analisis Live")!, 40]]));
    expect(r.some((x) => x.updateSheetProperties?.properties?.sheetId === ids.get("Analisis Live"))).toBe(false);
    expect(r.every((x) => x.updateSheetProperties!.fields === "gridProperties.columnCount")).toBe(true);
  });

  it("jalan ulang tanpa LIVE_SPREADSHEET_ID memakai spreadsheet buatan bot yang sudah ada (tidak membuat ganda)", async () => {
    const lama = await jalankanSepertiGoogle({ fileLama: "LAMA" });
    expect(lama.hasil.spreadsheetId).toBe("LAMA");
    expect(lama.dibuat).toBe(0);
    const baru = await jalankanSepertiGoogle({});
    expect(baru.hasil.spreadsheetId).toBe("BARU");
    expect(baru.dibuat).toBe(1);
  });
});

describe("Pengaturan: nomor WA berformat teks (Sheets membuang 0 di depan angka: 0812… → 812…)", () => {
  it("kolom No WA host dan sel No WA owner diformat teks (@)", () => {
    const p = tab("Pengaturan");
    const barisOwner = PENGATURAN_KEY_ORDER.indexOf(PENGATURAN_KEYS.ownerWaId) + 2;
    expect(p.formats).toContainEqual({ range: "H2:H11", kind: "teks" });
    expect(p.formats).toContainEqual({ range: `B${barisOwner}`, kind: "teks" });
    const ids = resolveSheetIds(bp, new Map());
    const teks = formatRequests(bp, ids).filter((r) => r.repeatCell!.range!.sheetId === ids.get("Pengaturan"))
      .map((r) => r.repeatCell!.cell!.userEnteredFormat!.numberFormat!).filter((f) => f.pattern === "@");
    expect(teks).toHaveLength(2);
    expect(teks.every((f) => f.type === "TEXT")).toBe(true);
  });
});
