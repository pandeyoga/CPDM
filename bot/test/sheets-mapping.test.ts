import { describe, expect, it } from "vitest";
import { KREDIT_COLUMNS } from "../src/domain/sheetFormulas.js";
import type { KreditRow } from "../src/domain/rekap.js";
import type { LedgerEntry } from "../src/domain/types.js";
import {
  fromSettingsRows, GOOGLE_TIMEOUT_MS, klienGoogle, mergeKredit, parseAtribusi, parseAtribusiRows, parseGangguanRows, parseKalenderRows,
  parseJadwalRows, parseKehadiranRows, parseKoreksiMenunggu, parseKoreksiRows, mergeTargetHarian, tailClearRange, SheetsGateway, toKreditSheetRows, toSesiRows, toTargetHarianRows,
  type SheetOp,
} from "../src/infra/sheets.js";

const hosts = [{ name: "Brando" }, { name: "Vanna" }, { name: "Linda" }];

describe("fromSettingsRows", () => {
  const rows: unknown[][] = [
    ["Pengaturan", "Nilai", "", "Bulan", "Target", "", "Nama", "No WA", "Aktif mulai", "Aktif selesai"],
    ["Jadwal aktif", "TIDAK", "", "2026-10", 50000000, "", "Brando", "0811-1111-111", "2026-01-01", ""],
    ["Jam live mulai", "09:00", "", "2026-11", "Rp60.000.000", "", "Vanna", 628222222222, 46023, 46100],
    ["Jam live selesai", 0.9166666667, "", "", "", "", "", "", "", ""],
    ["Jam update pagi", "08:30"],
    ["Jam rekap", "22:30"],
    ["Batas jeda (menit)", 180],
    ["Batas pesan per orang per hari", "5"],
    ["No WA owner", "081234567890"],
    ["Email owner", "owner@example.com"],
  ];
  it("membaca nilai", () => {
    const { value: s, invalid } = fromSettingsRows(rows);
    expect(invalid).toEqual([]);
    expect(s.jadwalAktif).toBe(false);
    expect(s.teamTarget).toEqual({ "2026-10": 50000000, "2026-11": 60000000 });
    expect(s).toMatchObject({ liveMulai: "09:00", liveSelesai: "22:00", jamPagi: "08:30", jamRekap: "22:30", maxGapMenit: 180, maxPesanPerHari: 5, ownerEmail: "owner@example.com", ownerWaId: "6281234567890@c.us" });
    expect(s.hosts).toEqual([
      { name: "Brando", waId: "628111111111@c.us", aktifMulai: "2026-01-01", row: 2 },
      { name: "Vanna", waId: "628222222222@c.us", aktifMulai: "2026-01-01", aktifSelesai: "2026-03-19", row: 3 },
    ]);
  });
  it("YA menjadi true; kosong memakai bawaan", () => {
    expect(fromSettingsRows([["x", "y"], ["Jadwal aktif", "YA"]]).value.jadwalAktif).toBe(true);
    expect(fromSettingsRows([])).toEqual({ invalid: [], value: {
      teamTarget: {}, jadwalAktif: false, liveMulai: "09:00", liveSelesai: "22:00", jamPagi: "08:00", jamRekap: "22:30",
      maxGapMenit: 240, maxPesanPerHari: 6, hosts: [], ownerWaId: "", ownerEmail: "",
    } });
  });
});

describe("fromSettingsRows: input tak valid", () => {
  const pengaturan = (key: string, v: unknown): unknown[][] => [["Pengaturan", "Nilai"], [key, v]];
  it.each([["Jam live mulai", "24:00"], ["Jam live mulai", "25:99"], ["Jam live mulai", 9], ["Jam rekap", "abc"], ["Batas jeda (menit)", "1,5"], ["Batas jeda (menit)", 0], ["Jadwal aktif", "mungkin"], ["No WA owner", "12"]])(
    "%s = %s → bawaan + dilaporkan", (key, v) => {
      const { value, invalid } = fromSettingsRows(pengaturan(key, v));
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).toMatchObject({ tab: "Pengaturan", row: 2 });
      expect(value).toEqual(fromSettingsRows([]).value);
    });
  it("tanggal/bulan/target/host tak valid", () => {
    const rows: unknown[][] = [
      ["h"],
      ["", "", "", "2026-13-01", 1, "", "A", "x1", "2026-13-45", "2026-02-30"],
      ["", "", "", "2026-11", "1,317"],
      ["", "", "", "2026-12", "1e3"],
    ];
    const { value, invalid } = fromSettingsRows(rows);
    expect(value.teamTarget).toEqual({});
    expect(value.hosts).toEqual([{ name: "A", row: 2 }]);
    expect(invalid.map((i) => i.row)).toEqual([2, 2, 2, 2, 3, 4]);
  });
  it("melebihi 10 host dilaporkan", () => {
    const rows: unknown[][] = [["h"], ...Array.from({ length: 11 }, (_, i) => ["", "", "", "", "", "", `H${i}`])];
    const { value, invalid } = fromSettingsRows(rows);
    expect(value.hosts).toHaveLength(10);
    expect(invalid).toHaveLength(1);
  });
});

describe("parseAtribusi", () => {
  it("satu nama", () => expect(parseAtribusi("Brando", hosts)).toEqual([{ host: "Brando", share: 1 }]));
  it("pecahan, tidak peka huruf besar", () =>
    expect(parseAtribusi("brando 50, VANNA 50", hosts)).toEqual([{ host: "Brando", share: 0.5 }, { host: "Vanna", share: 0.5 }]));
  it("tolak yang tidak valid", () => {
    expect(parseAtribusi("Brando 50, Vanna 40", hosts)).toBeNull();
    expect(parseAtribusi("Budi", hosts)).toBeNull();
    expect(parseAtribusi("", hosts)).toBeNull();
    expect(parseAtribusi("Brando 50", hosts)).toBeNull();
    expect(parseAtribusi("Brando, Vanna", hosts)).toBeNull();
    expect(parseAtribusi("Brando 50, Brando 50", hosts)).toBeNull();
  });
});

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  messageId: "m1", host: "Brando", platform: "tiktok", date: "2026-11-20",
  at: new Date("2026-11-20T05:02:00Z"), intervalStart: new Date("2026-11-20T04:00:00Z"), segment: 1,
  credit: { omzet: 410000, pesanan: 5 }, flags: [], ...over,
});

describe("toSesiRows", () => {
  it("kolom dan keterangan", () => {
    const rows = toSesiRows([
      entry({ flags: ["dibulatkan"] }),
      entry({ messageId: "m2", platform: "shopee", credit: { omzet: 284500 }, flags: ["layar_akhir"] }),
      entry({ messageId: "m3", platform: "shopee", segment: 2, flags: ["siaran_baru"] }),
      entry({ messageId: "m4", flags: [] }),
      entry({ messageId: "m5", flags: ["belum_teratribusi"] }),
    ], { angkaLayar: new Map([["m1|tiktok", 410000]]), bukti: new Map([["m1", "https://drive/x"]]) });
    expect(rows[0]).toEqual([46346, "12:02", "Brando", "TikTok", "#1", 410000, 410000, 5, "dibulatkan", "https://drive/x", "m1"]);
    expect(rows[1]).toEqual([46346, "12:02", "Brando", "Shopee", "#1 akhir", "", 284500, "", "live mati – layar akhir", "", "m2"]);
    expect(rows[2]?.[8]).toBe("siaran baru");
    expect(rows[3]?.[8]).toBe("OK");
    expect(rows[4]?.[2]).toBe("(belum teratribusi)");
  });
});

const kredit = (over: Partial<KreditRow>): KreditRow => ({
  messageId: "m1", tanggal: "2026-11-20", jam: 12, hariKelompok: "Jum–Min", host: "Brando", platform: "tiktok",
  omzet: 100, pesanan: null, penontonMasuk: null, komentar: null, keranjang: null, impresi: null, pengikutBaru: null,
  menitOnAir: 30, omzetHarapan: null, status: "dihitung", ...over,
});

describe("toKreditSheetRows / toTargetHarianRows", () => {
  it("null menjadi string kosong, tanggal serial", () => {
    const [r] = toKreditSheetRows([kredit({})]);
    expect(r).toHaveLength(KREDIT_COLUMNS.length);
    expect(r?.[1]).toBe(46346);
    expect(r?.[7]).toBe("");
    expect(toTargetHarianRows([{ tanggal: "2026-11-20", host: "Brando", target: 1, gugur: 0, sebab: "" }])).toEqual([[46346, "Brando", 1, 0, ""]]);
  });
});

describe("mergeKredit", () => {
  it("ganti kunci sama, buang baris basi, tambah baru", () => {
    const existing = toKreditSheetRows([
      kredit({ jam: 11, omzet: 1 }), kredit({ jam: 12, omzet: 2 }), kredit({ messageId: "m9", omzet: 9 }),
    ]);
    const merged = mergeKredit(existing, [kredit({ jam: 12, omzet: 20 }), kredit({ jam: 13, omzet: 30 })]);
    expect(merged.map((r) => [r[0], r[2], r[6]])).toEqual([["m1", 12, 20], ["m9", 12, 9], ["m1", 13, 30]]);
  });
});

describe("parser tab owner", () => {
  it("koreksi dan atribusi", () => {
    const rows: unknown[][] = [
      ["h"],
      [46346, "Linda", "x", 1, 2, "Setujui", "", "m1", "shopee", "koreksi", "omzet", 1350000],
      [46346, "Linda", "x", 1, 2, "Tunggu", "", "m2", "shopee", "koreksi", "omzet", 5],
      [46346, "", "x", 1, 2, "Setujui", "Brando 50, Vanna 50", "m3", "tiktok", "atribusi", "", ""],
      [46346, "", "x", 1, 2, "Setujui", "Budi", "m4", "tiktok", "atribusi", "", ""],
    ];
    expect(parseKoreksiRows(rows).value).toEqual([{ messageId: "m1", platform: "shopee", field: "omzet", value: 1350000 }]);
    const { value: a, invalid } = parseAtribusiRows(rows, hosts);
    expect(invalid).toEqual([{ tab: "Koreksi & Atribusi", row: 5, reason: expect.stringContaining("Budi") }]);
    expect([...a.keys()]).toEqual(["m3|tiktok"]);
    expect(a.get("m3|tiktok")).toEqual([{ host: "Brando", share: 0.5 }, { host: "Vanna", share: 0.5 }]);
  });
  it("kehadiran, gangguan, kalender", () => {
    const k = parseKehadiranRows([["h"], [46346, "Brando", "Sakit", "", "bot", "Disetujui"], [46346, "Vanna", "Telat", "", "", "Disetujui"], [46347, "Linda", "Izin", "", "", "Menunggu"]]);
    expect(k).toEqual({ value: [{ host: "Brando", date: "2026-11-20" }], invalid: [] });
    const g = parseGangguanRows([["h"], [46346, "Vanna", "14:00", "16:00", "listrik", "bot", "Disetujui"], [46346, "Vanna", 0.5, 0.5416666667, "", "", "Menunggu"]]);
    expect(g).toEqual({ value: [{ host: "Vanna", date: "2026-11-20", menit: 120 }], invalid: [] });
    expect(parseKalenderRows([["h"], [46346, "libur"], ["2026-12-25", ""], ["", ""]])).toEqual({ value: ["2026-11-20", "2026-12-25"], invalid: [] });
  });
  it("baris tak valid dilaporkan dengan nomor baris", () => {
    const k = parseKehadiranRows([["h"], ["2026-13-45", "Brando", "Sakit", "", "", "Disetujui"], [46346, "", "Izin", "", "", "Disetujui"], [46346, "A", "Libur", "", "", "Disetujui"]]);
    expect(k.value).toEqual([]);
    expect(k.invalid.map((i) => [i.tab, i.row])).toEqual([["Kehadiran", 2], ["Kehadiran", 3], ["Kehadiran", 4]]);
    const g = parseGangguanRows([["h"], [46346, "V", "24:00", "16:00", "", "", "Disetujui"], [46346, "V", "16:00", "14:00", "", "", "Disetujui"]]);
    expect(g.invalid.map((i) => i.row)).toEqual([2, 3]);
    expect(parseKalenderRows([["h"], ["bukan tanggal"], [46346]]).invalid).toHaveLength(1);
    expect(parseJadwalRows([["h"], [46346, "A", "09:00", "12:00"], [46346, "A", 9, "12:00"]])).toMatchObject({ value: [{ host: "A" }], invalid: [{ row: 3 }] });
  });
  it("koreksi: field tidak peka huruf besar; angka ketat", () => {
    const row = (nilai: unknown, field = "Omzet"): unknown[] => [46346, "L", "x", 1, 2, "Setujui", "", "m1", "Shopee", "Koreksi", field, nilai];
    expect(parseKoreksiRows([["h"], row(1350000)]).value).toEqual([{ messageId: "m1", platform: "shopee", field: "omzet", value: 1350000 }]);
    expect(parseKoreksiRows([["h"], row("Rp1.350.000")]).value[0]?.value).toBe(1350000);
    expect(parseKoreksiRows([["h"], row("1350.5")]).value[0]?.value).toBe(1350.5);
    for (const bad of ["1,317", "1,5", "1e3", "0x10", "abc"]) {
      const r = parseKoreksiRows([["h"], row(bad)]);
      expect(r.value, bad).toEqual([]);
      expect(r.invalid, bad).toHaveLength(1);
    }
    expect(parseKoreksiRows([["h"], row(5, "ngawur")]).invalid).toHaveLength(1);
  });
});

describe("fungsi murni tabel", () => {
  it("mergeTargetHarian dan tailClearRange", () => {
    const old = [[46300, "A", 1, 0, ""], [46346, "A", 1, 0, ""], ["x", "A", 1, 0, ""]];
    expect(mergeTargetHarian(old, "2026-11", [])).toEqual([old[0], old[2]]);
    expect(tailClearRange("T", 5, 2, 5)).toBe("'T'!A4:E6");
    expect(tailClearRange("T", 5, 5, 5)).toBeNull();
    expect(tailClearRange("T", 5, 0, 1)).toBe("'T'!A2:E2");
  });
});

describe("apply dispatch", () => {
  function fakeSheets(rows: unknown[][] = [["m1", 46346, 11, "Jum–Min", "Brando", "tiktok"]]): { sheets: never; calls: Array<[string, unknown]> } {
    const calls: Array<[string, unknown]> = [];
    const rec = (n: string, data: unknown = {}) => async (p: unknown) => { calls.push([n, p]); return { data }; };
    const sheets = {
      spreadsheets: { values: {
        get: rec("get", { values: rows }),
        update: rec("update"), append: rec("append"), clear: rec("clear"), batchUpdate: rec("batchUpdate"),
      } },
    } as never;
    return { sheets, calls };
  }
  const gw = (sheets: never): SheetsGateway =>
    new SheetsGateway({ LIVE_SPREADSHEET_ID: "SS", BUKTI_FOLDER_ID: "F" }, { sheets, drive: {} as never });

  it("appendSesi memakai append RAW ke Sesi Live", async () => {
    const { sheets, calls } = fakeSheets();
    await gw(sheets).apply({ type: "appendSesi", rows: [[1, "a"]] } satisfies SheetOp);
    expect(calls[0]?.[0]).toBe("append");
    expect(calls[0]?.[1]).toMatchObject({ spreadsheetId: "SS", range: "'Sesi Live'!A:A", valueInputOption: "RAW", requestBody: { values: [[1, "a"]] } });
  });
  it("upsertKredit menulis ulang tabel dan menghapus ekor", async () => {
    const { sheets, calls } = fakeSheets();
    await gw(sheets).apply({ type: "upsertKredit", rows: [kredit({ jam: 12 })] });
    expect(calls.map((c) => c[0])).toEqual(["get", "update"]);
    expect(calls[1]?.[1]).toMatchObject({ range: "'Data Kredit'!A2", valueInputOption: "RAW" });
  });
  it("upsertKredit: baris tertulis dan rentang clear tepat", async () => {
    const lama = toKreditSheetRows([kredit({ jam: 11, omzet: 1 }), kredit({ jam: 12, omzet: 2 }), kredit({ messageId: "m9", omzet: 9 })]);
    const { sheets, calls } = fakeSheets(lama as unknown[][]);
    await gw(sheets).apply({ type: "upsertKredit", rows: [kredit({ jam: 12, omzet: 20 })] });
    expect(calls.map((c) => c[0])).toEqual(["get", "update", "clear"]);
    expect(calls[0]?.[1]).toMatchObject({ range: "'Data Kredit'!A2:P" });
    const u = calls[1]?.[1] as { requestBody: { values: unknown[][] } };
    expect(u.requestBody.values.map((r) => [r[0], r[2], r[6]])).toEqual([["m1", 12, 20], ["m9", 12, 9]]);
    expect(calls[2]?.[1]).toMatchObject({ range: "'Data Kredit'!A4:P4" });
  });
  it("writeTargetHarian: bulan lain dipertahankan, bulan ini diganti, ekor dihapus", async () => {
    const okt = [46300, "Brando", 5, 0, ""]; // 2026-10-05
    const nov1 = [46346, "Brando", 1, 0, ""];
    const nov2 = [46347, "Brando", 1, 0, ""];
    const { sheets, calls } = fakeSheets([okt, nov1, nov2]);
    await gw(sheets).apply({ type: "writeTargetHarian", month: "2026-11", rows: [{ tanggal: "2026-11-20", host: "Brando", target: 9, gugur: 0, sebab: "" }] });
    expect(calls.map((c) => c[0])).toEqual(["get", "update", "clear"]);
    expect((calls[1]?.[1] as { requestBody: { values: unknown[][] } }).requestBody.values).toEqual([okt, [46346, "Brando", 9, 0, ""]]);
    expect(calls[2]?.[1]).toMatchObject({ range: "'Target Harian'!A4:E4" });
  });
  it("writeHeartbeat dan appendLog", async () => {
    const { sheets, calls } = fakeSheets();
    await gw(sheets).apply({ type: "writeHeartbeat", at: new Date("2026-11-20T05:00:00Z"), waStatus: "WORKING" });
    await gw(sheets).apply({ type: "appendLog", at: new Date("2026-11-20T05:00:00Z"), level: "info", pesan: "x" });
    expect(calls[0]?.[1]).toMatchObject({ range: "Heartbeat!A2:B2", requestBody: { values: [["2026-11-20T05:00:00.000Z", "WORKING"]] } });
    expect(calls[1]?.[1]).toMatchObject({ range: "'Log Bot'!A:A", requestBody: { values: [["2026-11-20T05:00:00.000Z", "info", "x"]] } });
  });
  it("writeKondisi menulis kolom G, L:M", async () => {
    const { sheets, calls } = fakeSheets();
    await gw(sheets).apply({ type: "writeKondisi", rows: [{ host: "Brando", butuhPerHariKerja: 1000, disiplin: 0.94, status: "tertinggal 3 hari" }] });
    expect(calls[0]?.[0]).toBe("batchUpdate");
    const data = (calls[0]?.[1] as { requestBody: { data: Array<{ range: string; values: unknown[][] }> } }).requestBody.data;
    expect(data.map((d) => d.range)).toEqual(["'Dashboard Host'!G8:G17", "'Dashboard Host'!L8:M17"]);
    expect(data[1]?.values[0]).toEqual([0.94, "tertinggal 3 hari"]);
    expect(data[1]?.values).toHaveLength(10);
  });
  it("appendKoreksi/Gangguan/Kehadiran dan writeTargetHarian", async () => {
    const { sheets, calls } = fakeSheets();
    const g = gw(sheets);
    await g.apply({ type: "appendKoreksi", row: { tanggal: "2026-11-20", host: "Linda", masalah: "Koreksi", angkaBot: "1", usulan: "2", jenis: "koreksi", messageId: "m1", platform: "shopee", field: "omzet", value: 2 } });
    await g.apply({ type: "appendGangguan", row: { tanggal: "2026-11-20", host: "Vanna", mulai: "14:00", selesai: "16:00", alasan: "listrik", sumber: "bot" } });
    await g.apply({ type: "appendKehadiran", row: { tanggal: "2026-11-20", host: "Brando", jenis: "Sakit", alasan: "", sumber: "bot" } });
    expect(calls.map((c) => (c[1] as { range: string }).range)).toEqual(["'Koreksi & Atribusi'!A:A", "'Gangguan'!A:A", "'Kehadiran'!A:A"]);
    expect((calls[0]?.[1] as { requestBody: { values: unknown[][] } }).requestBody.values[0]).toEqual([46346, "Linda", "Koreksi", "1", "2", "Menunggu", "", "m1", "shopee", "koreksi", "omzet", 2]);
    await g.apply({ type: "writeTargetHarian", month: "2026-11", rows: [{ tanggal: "2026-11-20", host: "Brando", target: 1, gugur: 0, sebab: "" }] });
    expect(calls.at(-1)?.[0]).toBe("update");
  });
});

describe("Task 12: koreksi menunggu, atribusi dengan host tersimpan", () => {
  const rows: unknown[][] = [
    ["h"],
    [46346, "Linda", "x", 1, 2, "Menunggu", "", "m1", "shopee", "koreksi", "omzet", 1],
    [46346, "Linda", "x", 1, 2, "menunggu", "", "m2", "shopee", "koreksi", "omzet", 1],
    [46346, "Linda", "x", 1, 2, "Setujui", "", "m3", "shopee", "koreksi", "omzet", 1],
    [46346, "", "x", 1, 2, "Menunggu", "", "m4", "tiktok", "atribusi", "", ""],
  ];
  it("parseKoreksiMenunggu menghitung koreksi berstatus Menunggu saja", () => {
    expect(parseKoreksiMenunggu(rows)).toBe(2);
  });
  it("readAtribusi(hosts) tidak membaca Pengaturan lagi", async () => {
    const ranges: string[] = [];
    const sheets = { spreadsheets: { values: { get: async (p: { range: string }) => { ranges.push(p.range); return { data: { values: rows } }; } } } } as never;
    const g = new SheetsGateway({ LIVE_SPREADSHEET_ID: "SS", BUKTI_FOLDER_ID: "F" }, { sheets, drive: {} as never });
    await g.readAtribusi(hosts);
    expect(ranges).toEqual(["'Koreksi & Atribusi'!A:L"]);
    expect(await g.readKoreksiMenunggu()).toBe(2);
  });
});

describe("fix round 1: baris host di Pengaturan, Kondisi per posisi, timeout Google", () => {
  it("G3 kosong: host membawa nomor barisnya; host di luar G2:G11 dilaporkan", () => {
    const rows: unknown[][] = [
      ["h"],
      ["", "", "", "", "", "", "Brando"],
      ["", "", "", "", "", "", ""],
      ["", "", "", "", "", "", "Vanna"],
      ...Array.from({ length: 7 }, () => ["", "", "", "", "", "", ""]),
      ["", "", "", "", "", "", "Linda"], // baris 12
    ];
    const { value, invalid } = fromSettingsRows(rows);
    expect(value.hosts.map((h) => [h.name, h.row])).toEqual([["Brando", 2], ["Vanna", 4], ["Linda", 12]]);
    expect(invalid).toEqual([{ tab: "Pengaturan", row: 12, reason: expect.stringContaining("G2:G11") }]);
  });

  it("writeKondisi menulis per posisi; baris kosong di antaranya tetap kosong; posisi di luar 0–9 tidak ditulis", async () => {
    const calls: Array<{ requestBody: { data: Array<{ range: string; values: unknown[][] }> } }> = [];
    const sheets = { spreadsheets: { values: { batchUpdate: async (p: (typeof calls)[number]) => { calls.push(p); return {}; } } } } as never;
    const g = new SheetsGateway({ LIVE_SPREADSHEET_ID: "SS", BUKTI_FOLDER_ID: "F" }, { sheets, drive: {} as never });
    await g.apply({ type: "writeKondisi", rows: [
      { host: "Brando", butuhPerHariKerja: 100, disiplin: 1, status: "ok", posisi: 0 },
      { host: "Vanna", butuhPerHariKerja: 200, disiplin: 0.5, status: "warn", posisi: 2 },
      { host: "Linda", butuhPerHariKerja: 300, disiplin: 0.1, status: "bad", posisi: 10 },
    ] });
    const [butuh, lm] = calls[0]!.requestBody.data;
    expect(butuh!.values.slice(0, 3)).toEqual([[100], [""], [200]]);
    expect(lm!.values.slice(0, 3)).toEqual([[1, "ok"], ["", ""], [0.5, "warn"]]);
    expect(butuh!.values.flat()).not.toContain(300);
  });

  it("klien OAuth, Sheets, dan Drive memakai timeout 30 detik", () => {
    expect(GOOGLE_TIMEOUT_MS).toBe(30_000);
    const k = klienGoogle({ clientId: "id", clientSecret: "rahasia", refreshToken: "rt" });
    expect(k.sheets.context._options.timeout).toBe(30_000);
    expect(k.drive.context._options.timeout).toBe(30_000);
    expect((k.auth.transporter as unknown as { defaults: { timeout?: number } }).defaults.timeout).toBe(30_000);
  });
});
