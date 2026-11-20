import { afterEach, describe, expect, it, vi } from "vitest";
import { refresh, type RefreshDeps } from "../src/app/refresh.js";
import { msgEskalasi } from "../src/domain/messages.js";
import type { KreditRow } from "../src/domain/rekap.js";
import type { Db, OutboxOp } from "../src/infra/db.js";
import type { Invalid, KoreksiRow } from "../src/infra/sheets.js";
import { fakeGateway, J, laporan, tempat } from "./fakes.js";

const t = tempat();
afterEach(() => {
  vi.restoreAllMocks();
  t.bersihkan();
});

function setup(awal: Date) {
  const { db, dir } = t.buat();
  const invalid: Invalid[] = [];
  const g = fakeGateway(invalid);
  let sekarang = awal;
  const deps: RefreshDeps = { db, gateway: g, now: () => sekarang, invalid };
  const pada = (d: Date): void => void (sekarang = d);
  /** Operasi baru sejak panggilan sebelumnya (antrean dikosongkan). */
  const opsBaru = (): OutboxOp[] => {
    const items = db.outbox.next(10_000);
    for (const i of items) db.outbox.ack(i.id);
    return items.map((i) => i.op);
  };
  return { db, dir, g, deps, pada, opsBaru, invalid };
}

const ringkasan = (r: Awaited<ReturnType<typeof refresh>>, host: string) => r.summaries.find((s) => s.host === host)!;
const kreditTerakhir = (ops: OutboxOp[], bulan: string): KreditRow[] | undefined =>
  (ops.filter((o) => o.type === "upsertKredit") as unknown as Array<{ rows: KreditRow[] }>)
    .map((o) => o.rows).filter((rows) => rows.every((r) => r.tanggal.startsWith(bulan))).at(-1);
const jumlahOmzet = (rows: KreditRow[], host?: string): number =>
  rows.filter((r) => host === undefined || r.host === host).reduce((a, r) => a + (r.omzet ?? 0), 0);

function simpan(db: Db, ...rs: ReturnType<typeof laporan>[]): void {
  for (const r of rs) db.saveReport(r);
}

describe("refresh: eskalasi", () => {
  it("dikirim sekali per awal streak 3 hari; esok harinya streak sama tidak dikirim lagi; streak baru dikirim lagi", async () => {
    const s = setup(J("2026-11-20", "07:00"));
    // Layar akhir harian Brando di bawah target per hari kerja (≈ Rp777.778).
    simpan(s.db,
      laporan("b17", "Brando", J("2026-11-17", "12:00"), 100_000, { isMati: true }),
      laporan("b18", "Brando", J("2026-11-18", "12:00"), 110_000, { isMati: true }),
      laporan("b19", "Brando", J("2026-11-19", "12:00"), 120_000, { isMati: true }));

    // Sebelum jam update pagi: belum dicatat, supaya owner tidak dikirimi pesan tengah malam.
    let r = await refresh(s.deps, "2026-11-20");
    expect(ringkasan(r, "Brando").streakDiBawah).toBe(3);
    expect(r.eskalasiBaru).toEqual([]);
    expect(r.pesanOwner).toEqual([]);

    s.pada(J("2026-11-20", "10:00"));
    r = await refresh(s.deps, "2026-11-20");
    expect(r.eskalasiBaru).toEqual(["Brando"]);
    expect(r.pesanOwner).toEqual([msgEskalasi(["Brando"])]);

    s.pada(J("2026-11-20", "10:15"));
    r = await refresh(s.deps, "2026-11-20");
    expect(r.eskalasiBaru).toEqual([]);
    expect(r.pesanOwner).toEqual([]);

    simpan(s.db, laporan("b20", "Brando", J("2026-11-20", "12:00"), 130_000, { isMati: true }));
    s.pada(J("2026-11-21", "10:00"));
    r = await refresh(s.deps, "2026-11-21");
    expect(ringkasan(r, "Brando").streakDiBawah).toBe(4);
    expect(ringkasan(r, "Brando").status).toBe("bad");
    expect(r.eskalasiBaru).toEqual([]);
    expect(r.pesanOwner).toEqual([]);

    // 21/11 di atas target memutus streak; 22–24/11 di bawah lagi → streak baru.
    simpan(s.db,
      laporan("b21", "Brando", J("2026-11-21", "12:00"), 2_000_000, { isMati: true }),
      laporan("b22", "Brando", J("2026-11-22", "12:00"), 140_000, { isMati: true }),
      laporan("b23", "Brando", J("2026-11-23", "12:00"), 150_000, { isMati: true }),
      laporan("b24", "Brando", J("2026-11-24", "12:00"), 160_000, { isMati: true }));
    s.pada(J("2026-11-25", "09:00"));
    r = await refresh(s.deps, "2026-11-25");
    expect(r.eskalasiBaru).toEqual(["Brando"]);
    expect(s.db.getKv("eskalasi:Brando")).toBe("2026-11-22");
  });
});

describe("refresh: koreksi dan atribusi", () => {
  it("koreksi yang disetujui mengubah realisasi dan Data Kredit", async () => {
    const s = setup(J("2026-11-20", "11:00"));
    simpan(s.db, laporan("m1", "Brando", J("2026-11-20", "10:00"), 1_317_034));
    let r = await refresh(s.deps, "2026-11-20");
    expect(ringkasan(r, "Brando").realisasi).toBe(1_317_034);
    expect(jumlahOmzet(kreditTerakhir(s.opsBaru(), "2026-11")!)).toBe(1_317_034);

    s.g.koreksi = [{ messageId: "m1", platform: "shopee", field: "omzet", value: 1_350_000 }];
    r = await refresh(s.deps, "2026-11-20");
    expect(ringkasan(r, "Brando").realisasi).toBe(1_350_000);
    expect(r.input.koreksi).toEqual(s.g.koreksi);
    expect(jumlahOmzet(kreditTerakhir(s.opsBaru(), "2026-11")!)).toBe(1_350_000);
  });

  it("laporan pergantian terlewat: masalah dicatat ke pelapor sebelumnya, baris atribusi sekali; atribusi disetujui memecah kredit", async () => {
    const s = setup(J("2026-11-20", "16:00"));
    simpan(s.db,
      laporan("m1", "Brando", J("2026-11-20", "10:00"), 500_000),
      laporan("m2", "Vanna", J("2026-11-20", "15:00"), 1_500_000)); // jeda 300 menit > 240
    let r = await refresh(s.deps, "2026-11-20");
    expect(ringkasan(r, "Brando").realisasi).toBe(500_000);
    expect(ringkasan(r, "Vanna").realisasi).toBe(0);
    expect(s.db.problemCounts("2026-11")).toEqual({ Brando: 1 });
    const koreksi = s.opsBaru().filter((o) => o.type === "appendKoreksi").map((o) => o.row as KoreksiRow);
    expect(koreksi).toEqual([expect.objectContaining({
      tanggal: "2026-11-20", host: "Vanna", jenis: "atribusi", messageId: "m2", platform: "shopee",
      angkaBot: 1_000_000, usulan: "Brando 50, Vanna 50",
    })]);

    await refresh(s.deps, "2026-11-20");
    expect(s.opsBaru().filter((o) => o.type === "appendKoreksi")).toEqual([]);

    s.g.atribusi = new Map([["m2|shopee", [{ host: "Brando", share: 0.5 }, { host: "Vanna", share: 0.5 }]]]);
    r = await refresh(s.deps, "2026-11-20");
    expect(ringkasan(r, "Brando").realisasi).toBe(1_000_000);
    expect(ringkasan(r, "Vanna").realisasi).toBe(500_000);
    const kredit = kreditTerakhir(s.opsBaru(), "2026-11")!;
    expect(jumlahOmzet(kredit, "Vanna")).toBe(500_000);
    expect(kredit.every((k) => k.status === "dihitung")).toBe(true);
    expect(s.db.problemCounts("2026-11")).toEqual({ Brando: 1 }); // tetap tercatat
  });

  it("siaran belum lengkap dicatat ke host laporan terakhir sebelum reset; ditunda selama ada gambar menunggu ekstraksi", async () => {
    const s = setup(J("2026-11-20", "13:00"));
    simpan(s.db,
      laporan("m1", "Brando", J("2026-11-20", "10:00"), 800_000),
      laporan("m2", "Vanna", J("2026-11-20", "12:00"), 300_000)); // omzet turun tanpa layar akhir
    s.db.pendingExtract.put("m9", "", "Linda");
    await refresh(s.deps, "2026-11-20");
    expect(s.db.problemCounts("2026-11")).toEqual({});
    s.db.pendingExtract.done("m9");
    await refresh(s.deps, "2026-11-20");
    expect(s.db.problemCounts("2026-11")).toEqual({ Brando: 1 });
  });
});

describe("refresh: operasi tulis", () => {
  it("hanya mengantrekan tabel yang berubah; Sesi Live sekali per entri setelah bukti terunggah; Kondisi urut daftar host", async () => {
    const s = setup(J("2026-11-20", "11:00"));
    simpan(s.db, laporan("m1", "Brando", J("2026-11-20", "10:00"), 1_000_000));
    await refresh(s.deps, "2026-11-20");
    const ops = s.opsBaru();
    expect(ops.map((o) => [o.type, o.month ?? ""]).sort()).toEqual([
      ["upsertKredit", ""], ["writeKondisi", ""], ["writeTargetHarian", "2026-10"], ["writeTargetHarian", "2026-11"],
    ]);
    const kondisi = ops.find((o) => o.type === "writeKondisi")!.rows as Array<{ host: string; status: string }>;
    expect(kondisi.map((k) => k.host)).toEqual(["Brando", "Vanna", "Linda"]);
    expect(kondisi[0]!.status).not.toBe("");

    // Tidak ada perubahan → tidak ada operasi baru.
    await refresh(s.deps, "2026-11-20");
    expect(s.opsBaru()).toEqual([]);

    // Bukti terunggah → satu baris Sesi Live dengan tautan; tidak diulang.
    s.db.setKv("bukti:m1", "https://drive.google.com/file/d/x/view");
    await refresh(s.deps, "2026-11-20");
    const sesi = s.opsBaru();
    expect(sesi.map((o) => o.type)).toEqual(["appendSesi"]);
    const rows = sesi[0]!.rows as unknown[][];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("https://drive.google.com/file/d/x/view");
    expect(rows[0]).toContain("m1");
    await refresh(s.deps, "2026-11-20");
    expect(s.opsBaru()).toEqual([]);

    // Input target bulan ini berubah → Target Harian bulan ini saja.
    s.g.kalender = ["2026-11-25"];
    await refresh(s.deps, "2026-11-20");
    const ubah = s.opsBaru();
    expect(ubah.filter((o) => o.type === "writeTargetHarian").map((o) => o.month)).toEqual(["2026-11"]);
    expect(ubah.some((o) => o.type === "upsertKredit")).toBe(false);
  });

  it("pergantian bulan: laporan 1/12 00:10 masuk Data Kredit November; koreksi bulan lalu mengantrekan ulang November", async () => {
    const s = setup(J("2026-12-01", "00:20"));
    simpan(s.db,
      laporan("m1", "Brando", J("2026-11-30", "21:00"), 300_000),
      laporan("m2", "Brando", J("2026-12-01", "00:10"), 500_000));
    const r = await refresh(s.deps, "2026-12-01");
    expect(ringkasan(r, "Brando").realisasi).toBe(0);
    const ops = s.opsBaru();
    const nov = kreditTerakhir(ops, "2026-11")!;
    expect(jumlahOmzet(nov)).toBeCloseTo(500_000, 6); // irisan per jam
    expect(new Set(nov.map((k) => k.messageId))).toEqual(new Set(["m1", "m2"]));
    expect(ops.filter((o) => o.type === "upsertKredit")).toHaveLength(1); // Desember belum punya entri

    s.g.koreksi = [{ messageId: "m2", platform: "shopee", field: "omzet", value: 550_000 }];
    await refresh(s.deps, "2026-12-01");
    expect(jumlahOmzet(kreditTerakhir(s.opsBaru(), "2026-11")!)).toBeCloseTo(550_000, 6);
  });
});

describe("refresh: input owner tidak valid", () => {
  it("baris Log Bot per item dan satu pesan owner per refresh, hanya untuk yang baru", async () => {
    const s = setup(J("2026-11-20", "11:00"));
    const a: Invalid = { tab: "Pengaturan", row: 3, reason: "Jam rekap: nilai \"25:00\" tidak valid, memakai bawaan" };
    const b: Invalid = { tab: "Pengaturan", row: 9, reason: "No WA host Linda tidak valid" };
    s.g.invalidSettings = [a];
    let r = await refresh(s.deps, "2026-11-20");
    const log = (): string[] => s.opsBaru().filter((o) => o.type === "appendLog").map((o) => o.pesan as string);
    expect(log()).toEqual([expect.stringContaining("Pengaturan baris 3")]);
    expect(r.pesanOwner).toHaveLength(1);
    expect(r.pesanOwner[0]).toContain("Pengaturan baris 3");

    r = await refresh(s.deps, "2026-11-20");
    expect(log()).toEqual([]);
    expect(r.pesanOwner).toEqual([]);

    s.g.invalidSettings = [a, b];
    r = await refresh(s.deps, "2026-11-20");
    expect(log()).toEqual([expect.stringContaining("Pengaturan baris 9")]);
    expect(r.pesanOwner).toHaveLength(1);
    expect(r.pesanOwner[0]).toContain("Linda");
    expect(r.pesanOwner[0]).not.toContain("baris 3");
    expect(s.invalid).toEqual([]); // dikuras
  });

  it("jadwal hanya dibaca bila Jadwal aktif = YA", async () => {
    const s = setup(J("2026-11-20", "11:00"));
    let r = await refresh(s.deps, "2026-11-20");
    expect(s.g.bacaJadwal).toBe(0);
    expect(r.input.jadwal).toBeNull();
    s.g.settings = { ...s.g.settings, jadwalAktif: true };
    s.g.jadwal = [{ date: "2026-11-20", host: "Brando", mulai: "09:00", selesai: "15:00" }];
    r = await refresh(s.deps, "2026-11-20");
    expect(s.g.bacaJadwal).toBe(1);
    expect(r.input.jadwal).toEqual(s.g.jadwal);
  });

  it("gagal membaca input owner: memakai salinan cadangan bila ada, kalau tidak melempar", async () => {
    const s = setup(J("2026-11-20", "11:00"));
    simpan(s.db, laporan("m1", "Brando", J("2026-11-20", "10:00"), 1_000_000));
    const awal = await refresh(s.deps, "2026-11-20");
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.g.gagalBaca = new Error("Sheets 503");
    await expect(refresh(s.deps, "2026-11-20")).rejects.toThrow("Sheets 503");
    const r = await refresh(s.deps, "2026-11-20", awal.input);
    expect(ringkasan(r, "Brando").realisasi).toBe(1_000_000);
  });
});

