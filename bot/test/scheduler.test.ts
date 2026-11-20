import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buatRuntime, catchUp, cekSilang, detak, flushOutbox, jalankanRefresh, prosesUlang, sendCapped, startScheduler, terima, tiapMenit,
  waktuRekap, type SchedulerDeps,
} from "../src/app/scheduler.js";
import { KV_GANGGUAN_AKTIF } from "../src/app/handleMessage.js";
import { msgBelumLapor, msgTidakCocok } from "../src/domain/messages.js";
import { addDays } from "../src/domain/time.js";
import type { ExtractResult } from "../src/domain/types.js";
import type { OutboxOp } from "../src/infra/db.js";
import type { GangguanRow, Invalid } from "../src/infra/sheets.js";
import {
  bacaan, fakeExtractor, fakeGateway, fakeWaha, gambar, GROUP, J, laporan, ok, OWNER, semuaOp, settingsDasar, tempat, WA,
} from "./fakes.js";

const t = tempat();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  t.bersihkan();
});

function setup(over: Parameters<typeof settingsDasar>[0] = {}) {
  const { db, dir } = t.buat();
  const invalid: Invalid[] = [];
  const g = fakeGateway(invalid);
  g.settings = settingsDasar(over);
  const w = fakeWaha();
  const ex = fakeExtractor();
  const deps: SchedulerDeps = {
    config: { LIVE_GROUP_ID: GROUP }, db, waha: w, extractor: ex, gateway: g, dataDir: dir, now: () => new Date(), invalid,
  };
  const rt = buatRuntime(deps);
  /** Semua operasi Sheets: yang sudah diterapkan gateway dan yang masih di antrean. */
  const semua = (): OutboxOp[] => [...g.applied, ...semuaOp(db)];
  const log = (teks: string): string[] =>
    semua().filter((o) => o.type === "appendLog" && String(o.pesan).includes(teks)).map((o) => String(o.pesan));
  return { db, dir, g, w, ex, rt, deps, semua, log };
}
type Setup = ReturnType<typeof setup>;

/** Jam palsu hanya untuk Date (setImmediate/setTimeout tetap asli). */
function jam(d: Date): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(d);
}

/** Jalankan tiapMenit setiap menit dari..sampai (inklusif); catat jam tiap pesan grup/owner baru. */
async function menit(s: Setup, tanggal: string, dari: string, sampai: string, sebelum?: (hm: string) => void) {
  const terkirim: Array<{ hm: string; chatId: string; text: string }> = [];
  let t0 = J(tanggal, dari).getTime();
  const t1 = J(tanggal, sampai).getTime() + (sampai < dari ? 86_400_000 : 0);
  for (; t0 <= t1; t0 += 60_000) {
    const now = new Date(t0);
    jam(now);
    const hm = new Date(t0 + 7 * 3600_000).toISOString().slice(11, 16);
    sebelum?.(hm);
    const n = s.w.sent.length;
    await tiapMenit(s.rt);
    for (const m of s.w.sent.slice(n)) terkirim.push({ hm, chatId: m.chatId, text: m.text });
  }
  return terkirim;
}

const tunggu = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("pesan pagi", () => {
  it("dikirim tepat 08:00 dan hanya sekali, juga setelah restart", async () => {
    const s = setup();
    const kirim = await menit(s, "2026-11-20", "07:55", "08:20");
    const pagi = kirim.filter((k) => k.chatId === GROUP);
    expect(pagi.map((k) => k.hm)).toEqual(["08:00"]);
    expect(pagi[0]!.text).toMatch(/^Selamat pagi tim! Update target 20\/11/);
    for (const h of ["Brando", "Vanna", "Linda"]) expect(pagi[0]!.text).toContain(h);
    expect(s.w.sent.find((m) => m.chatId === GROUP)!.mentions).toEqual([WA.Brando, WA.Vanna]);

    const baru = { ...s, rt: buatRuntime(s.deps) };
    expect(await menit(baru, "2026-11-20", "08:21", "08:30")).toEqual([]);
  });

  it("jadwal aktif: hanya host yang masuk shift hari itu", async () => {
    const s = setup({ jadwalAktif: true });
    s.g.jadwal = [{ date: "2026-11-20", host: "Vanna", mulai: "09:00", selesai: "15:00" }];
    const kirim = await menit(s, "2026-11-20", "07:59", "08:01");
    expect(kirim).toHaveLength(1);
    expect(kirim[0]!.text).toContain("Vanna");
    expect(kirim[0]!.text).not.toContain("Brando");
    expect(s.w.sent[0]!.mentions).toEqual([WA.Vanna]);
  });

  it("lewat cron node-cron (zona Asia/Jakarta) dengan timer palsu", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(J("2026-11-20", "07:59"));
    const s = setup();
    const jalan = startScheduler(s.deps);
    await jalan.siap;
    expect(s.w.ke(GROUP)).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.w.ke(GROUP)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(s.w.ke(GROUP)).toHaveLength(1);
    expect(s.g.applied.filter((o) => o.type === "writeHeartbeat").length).toBeGreaterThanOrEqual(7);
    await jalan.stop();
  });
});

describe("gangguan dan jadwal", () => {
  const jadwal = [
    { date: "2026-11-20", host: "Brando", mulai: "09:00", selesai: "15:00" },
    { date: "2026-11-20", host: "Vanna", mulai: "15:00", selesai: "22:00" },
  ];

  it("selama gangguanAktif tidak ada pesan pagi atau tagihan; setelah normal tagihan jalan lagi", async () => {
    const s = setup({ jadwalAktif: true });
    s.g.jadwal = jadwal;
    s.db.setKv(KV_GANGGUAN_AKTIF, JSON.stringify([{ tanggal: "2026-11-20", mulai: "07:30", host: "Brando", alasan: "listrik", scope: "semua" }]));
    expect(await menit(s, "2026-11-20", "07:59", "08:05")).toEqual([]);
    expect(await menit(s, "2026-11-20", "14:59", "15:05")).toEqual([]);
    s.db.setKv(KV_GANGGUAN_AKTIF, "");
    const kirim = await menit(s, "2026-11-20", "15:06", "15:10");
    expect(kirim.map((k) => k.text)).toEqual([msgBelumLapor({ name: "Brando", waId: WA.Brando })]);
  });

  it("jadwal aktif: tag tepat di akhir shift hanya untuk host yang belum lapor; jadwal tidak aktif: tidak ada tag", async () => {
    const s = setup({ jadwalAktif: true });
    s.g.jadwal = jadwal;
    s.db.saveReport(laporan("v1", "Vanna", J("2026-11-20", "18:00"), 400_000));
    const kirim = await menit(s, "2026-11-20", "14:58", "15:03");
    expect(kirim).toEqual([{ hm: "15:00", chatId: GROUP, text: msgBelumLapor({ name: "Brando", waId: WA.Brando }) }]);
    expect(s.w.sent.at(-1)!.mentions).toEqual([WA.Brando]);
    expect((await menit(s, "2026-11-20", "21:59", "22:05")).filter((k) => k.chatId === GROUP)).toEqual([]);

    const tanpa = setup({ jadwalAktif: false });
    tanpa.g.jadwal = jadwal;
    expect((await menit(tanpa, "2026-11-20", "14:59", "15:05"))).toEqual([]);
    expect(tanpa.g.bacaJadwal).toBe(0);
  });
});

describe("rekap malam", () => {
  it("waktuRekap = jamRekap, atau 30 menit setelah laporan terakhir kalau lebih lambat", () => {
    expect(waktuRekap("2026-11-20", "22:30", null)).toEqual(J("2026-11-20", "22:30"));
    expect(waktuRekap("2026-11-20", "22:30", J("2026-11-20", "21:00"))).toEqual(J("2026-11-20", "22:30"));
    expect(waktuRekap("2026-11-20", "22:30", J("2026-11-20", "23:05"))).toEqual(J("2026-11-20", "23:35"));
  });

  it("dikirim 22:30: rekap ke grup dan ringkasan pribadi ke owner, sekali", async () => {
    const s = setup();
    s.db.saveReport(laporan("b1", "Brando", J("2026-11-20", "10:00"), 1_000_000));
    s.db.saveReport(laporan("v1", "Vanna", J("2026-11-20", "21:00"), 1_500_000));
    s.g.koreksiMenunggu = 2;
    const kirim = await menit(s, "2026-11-20", "22:00", "22:50");
    expect(kirim.map((k) => [k.hm, k.chatId])).toEqual([["22:30", GROUP], ["22:30", OWNER]]);
    expect(kirim[0]!.text).toMatch(/^Rekap malam 20\/11/);
    expect(kirim[0]!.text).toContain("hari ini Rp1 jt");
    expect(kirim[1]!.text).toMatch(/^Ringkasan owner 20\/11/);
    expect(kirim[1]!.text).toContain("Koreksi menunggu persetujuan: 2");
  });

  it("laporan terakhir 23:05 → rekap mundur ke 23:35", async () => {
    const s = setup();
    const masuk: Record<string, number> = { "22:15": 500_000, "22:40": 900_000, "23:05": 1_200_000 };
    const kirim = await menit(s, "2026-11-20", "22:00", "23:50", (hm) => {
      const omzet = masuk[hm];
      if (omzet !== undefined) s.db.saveReport(laporan(`m${hm}`, "Brando", J("2026-11-20", hm), omzet));
    });
    expect(kirim.filter((k) => k.chatId === GROUP).map((k) => k.hm)).toEqual(["23:35"]);
  });

  it("gangguan yang masih aktif ditutup saat rekap di jam selesai live (atau laporan terakhir sesudah mulai)", async () => {
    const s = setup();
    s.db.saveReport(laporan("v1", "Vanna", J("2026-11-20", "13:00"), 400_000));
    s.db.setKv(KV_GANGGUAN_AKTIF, JSON.stringify([{ tanggal: "2026-11-20", mulai: "14:00", host: "Brando", alasan: "listrik", scope: "semua" }]));
    const kirim = await menit(s, "2026-11-20", "22:29", "22:31");
    const rows = s.semua().filter((o) => o.type === "appendGangguan").map((o) => o.row as GangguanRow);
    expect(rows).toEqual([{ tanggal: "2026-11-20", host: "Brando", mulai: "14:00", selesai: "22:00", alasan: "listrik", sumber: "Grup WA" }]);
    expect(s.db.getKv(KV_GANGGUAN_AKTIF)).toBe("");
    const owner = kirim.filter((k) => k.chatId === OWNER).map((k) => k.text);
    expect(owner).toHaveLength(2);
    expect(owner[1]).toContain("Brando");
    expect(owner[1]).toContain("14:00–22:00");

    const s2 = setup();
    s2.db.saveReport(laporan("v1", "Vanna", J("2026-11-20", "20:00"), 400_000));
    s2.db.setKv(KV_GANGGUAN_AKTIF, JSON.stringify([{ tanggal: "2026-11-20", mulai: "14:00", host: "Brando", alasan: "listrik", scope: "semua" }]));
    await menit(s2, "2026-11-20", "22:30", "22:31");
    expect(s2.semua().filter((o) => o.type === "appendGangguan").map((o) => (o.row as GangguanRow).selesai)).toEqual(["20:00"]);
  });
});

describe("sendCapped", () => {
  it("berhenti setelah 6 pesan per penerima per hari; sisanya dicatat ke Log Bot; besok mulai lagi", async () => {
    const s = setup();
    jam(J("2026-11-20", "10:00"));
    await jalankanRefresh(s.rt);
    const hasil: boolean[] = [];
    for (let i = 1; i <= 7; i++) hasil.push(await sendCapped(s.rt, GROUP, `pesan ${i}`));
    expect(hasil).toEqual([true, true, true, true, true, true, false]);
    expect(s.w.ke(GROUP).map((m) => m.text)).toEqual(["pesan 1", "pesan 2", "pesan 3", "pesan 4", "pesan 5", "pesan 6"]);
    expect(s.log("batas 6 pesan")).toEqual([expect.stringContaining("pesan 7")]);
    expect(await sendCapped(s.rt, OWNER, "untuk owner")).toBe(true);

    jam(J(addDays("2026-11-20", 1), "10:00"));
    expect(await sendCapped(s.rt, GROUP, "pesan besok")).toBe(true);
  });
});

describe("catch-up", () => {
  it("tiga pesan saat bot mati, satu sudah ditandai: dua sisanya diproses berurutan, tidak dobel", async () => {
    const s = setup();
    jam(J("2026-11-20", "10:20"));
    await jalankanRefresh(s.rt);
    const a = gambar("A", "Brando", J("2026-11-20", "10:00"));
    const b = gambar("B", "Vanna", J("2026-11-20", "10:05"));
    const c = gambar("C", "Brando", J("2026-11-20", "10:10"));
    s.db.markMessage(a.id, a.ts);
    s.w.riwayat = [c, a, b];
    s.ex.hasil.push(ok(bacaan("shopee", 500_000)), ok(bacaan("shopee", 900_000)));

    await catchUp(s.rt);
    expect(s.w.sinceArgs).toEqual([{ chatId: GROUP, since: J("2026-11-20", "09:55") }]);
    expect(s.ex.calls).toBe(2);
    expect(s.db.reports("2026-11").map((r) => [r.messageId, r.host])).toEqual([["B", "Vanna"], ["C", "Brando"]]);
    expect(s.w.ke(GROUP).map((m) => m.replyTo)).toEqual(["B", "C"]);

    await catchUp(s.rt);
    await terima(s.rt, b);
    expect(s.ex.calls).toBe(2);
    expect(s.w.ke(GROUP)).toHaveLength(2);
  });

  it("WAHA belum siap: catch-up diulang di menit berikutnya", async () => {
    const s = setup();
    jam(J("2026-11-20", "10:20"));
    await jalankanRefresh(s.rt);
    s.db.markMessage("lama", J("2026-11-20", "10:00"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const asli = s.w.messagesSince;
    s.w.messagesSince = async () => { throw new Error("WAHA GET messages gagal: HTTP 502"); };
    await catchUp(s.rt);
    expect(err).toHaveBeenCalled();
    s.w.messagesSince = asli;
    s.w.riwayat = [gambar("B", "Vanna", J("2026-11-20", "10:05"))];
    s.ex.hasil.push(ok(bacaan("shopee", 500_000)));
    jam(J("2026-11-20", "10:21"));
    await tiapMenit(s.rt);
    expect(s.db.reports("2026-11").map((r) => r.messageId)).toEqual(["B"]);
  });
});

describe("serialisasi", () => {
  it("handleMessage satu per satu; proses ulang tidak tumpang tindih", async () => {
    const s = setup();
    jam(J("2026-11-20", "10:00"));
    await jalankanRefresh(s.rt);
    let lepas!: (r: ExtractResult) => void;
    s.ex.hasil.push(new Promise<ExtractResult>((r) => { lepas = r; }), ok(bacaan("shopee", 900_000)));
    const p1 = terima(s.rt, gambar("X", "Brando", J("2026-11-20", "10:00")));
    const p2 = terima(s.rt, gambar("Y", "Brando", J("2026-11-20", "10:01")));
    for (let i = 0; i < 5; i++) await tunggu();
    expect(s.ex.calls).toBe(1);
    lepas(ok(bacaan("shopee", 500_000)));
    await Promise.all([p1, p2]);
    expect(s.ex.calls).toBe(2);
    expect(s.db.reports("2026-11").map((r) => r.messageId)).toEqual(["X", "Y"]);

    // Ekstraksi gagal → tertunda; proses ulang dua kali bersamaan hanya mengekstrak sekali.
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.ex.hasil.push(new Error("529 overloaded"));
    await terima(s.rt, gambar("Z", "Vanna", J("2026-11-20", "10:02")));
    expect(s.db.pendingExtract.all()).toHaveLength(1);
    jam(J("2026-11-20", "10:10"));
    let lepas2!: (r: ExtractResult) => void;
    s.ex.hasil.push(new Promise<ExtractResult>((r) => { lepas2 = r; }));
    const u1 = prosesUlang(s.rt);
    let u2Selesai = false;
    const u2 = prosesUlang(s.rt).then(() => { u2Selesai = true; });
    for (let i = 0; i < 5; i++) await tunggu();
    expect(u2Selesai).toBe(true); // tidak menumpuk di belakang yang sedang jalan
    lepas2(ok(bacaan("shopee", 1_000_000)));
    await Promise.all([u1, u2]);
    expect(s.ex.calls).toBe(4);
    expect(s.db.pendingExtract.all()).toEqual([]);
  });
});

describe("pengecekan silang 23:50", () => {
  it("selisih Rp1 tidak memicu; selisih lebih memicu satu pesan owner dan satu baris Log Bot", async () => {
    const s = setup();
    jam(J("2026-11-20", "23:50"));
    s.db.saveReport(laporan("b1", "Brando", J("2026-11-20", "10:00"), 11_200_000));
    s.g.kontrol = { Brando: 11_200_001, Vanna: 0, Linda: 0 };
    await cekSilang(s.rt);
    expect(s.w.ke(OWNER)).toEqual([]);
    expect(s.log("Pengecekan silang")).toEqual([]);

    s.g.kontrol = { Brando: 11_300_000, Vanna: 0, Linda: 0 };
    await cekSilang(s.rt);
    expect(s.w.ke(OWNER).map((m) => m.text)).toEqual(["Angka dashboard tidak cocok untuk Brando, sedang dicek"]);
    expect(s.log("Pengecekan silang")).toHaveLength(1);
    expect(s.log("Pengecekan silang")[0]).toContain("Brando");
  });

  it("host yang hilang dari Kontrol (sel error) dihitung tidak cocok", async () => {
    const s = setup();
    jam(J("2026-11-20", "23:50"));
    s.g.kontrol = { Brando: 0, Vanna: 0 };
    await cekSilang(s.rt);
    expect(s.w.ke(OWNER).map((m) => m.text)).toEqual([msgTidakCocok(["Linda"])]);
  });

  it("dilewati selama Data Kredit terbaru belum terkirim ke spreadsheet", async () => {
    const s = setup();
    jam(J("2026-11-20", "23:50"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.db.saveReport(laporan("b1", "Brando", J("2026-11-20", "10:00"), 11_200_000));
    s.g.gagalApply = new Error("Sheets 503");
    s.g.kontrol = { Brando: 0, Vanna: 0, Linda: 0 };
    await cekSilang(s.rt);
    expect(s.w.ke(OWNER)).toEqual([]);
    expect(s.log("Pengecekan silang dilewati")).toHaveLength(1);
  });
});

describe("antrean ke Sheets", () => {
  it("uploadBukti: tautan disimpan di kv, dedupe per messageId; berkas hilang dicatat; Sesi Live memakai tautan", async () => {
    const s = setup();
    jam(J("2026-11-20", "10:30"));
    const dir = join(s.dir, "bukti");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "m1.jpg");
    writeFileSync(path, Buffer.from("jpeg"));
    s.db.saveReport(laporan("m1", "Brando", J("2026-11-20", "10:00"), 1_000_000));
    s.db.outbox.push({ type: "uploadBukti", messageId: "m1", path });
    s.db.outbox.push({ type: "uploadBukti", messageId: "m1", path });
    s.db.outbox.push({ type: "uploadBukti", messageId: "m2", path: join(dir, "hilang.jpg") });
    await flushOutbox(s.rt);
    expect(s.g.uploads).toEqual([{ name: "m1.jpg", size: 4 }]);
    expect(s.db.getKv("bukti:m1")).toBe("https://drive.google.com/file/d/m1.jpg/view");
    expect(s.db.getKv("bukti:m2")).toBe("");
    expect(s.log("m2")).toHaveLength(1);

    await jalankanRefresh(s.rt);
    await flushOutbox(s.rt);
    const sesi = s.g.applied.find((o) => o.type === "appendSesi");
    expect(sesi && sesi.type === "appendSesi" && sesi.rows[0]).toContain("https://drive.google.com/file/d/m1.jpg/view");
  });

  it("gagal: backoff 1 menit, log hanya err.message; tanggal appendLog dipulihkan", async () => {
    const s = setup();
    jam(J("2026-11-20", "10:00"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    s.g.gagalApply = Object.assign(new Error("Request failed with status code 503"), {
      config: { headers: { Authorization: "Bearer rahasia-token" } },
    });
    s.db.outbox.push({ type: "appendLog", at: new Date(), level: "INFO", pesan: "halo" });
    await flushOutbox(s.rt);
    const tercetak = err.mock.calls.flat().map(String).join("\n");
    expect(tercetak).toContain("Request failed with status code 503");
    expect(tercetak).not.toContain("rahasia-token");
    expect(s.db.outbox.next(10)).toEqual([]);

    s.g.gagalApply = null;
    jam(J("2026-11-20", "10:01"));
    await flushOutbox(s.rt);
    expect(s.g.applied).toHaveLength(1);
    const op = s.g.applied[0]!;
    expect(op.type === "appendLog" && op.at instanceof Date && op.at.getTime()).toBe(J("2026-11-20", "10:00").getTime());
  });

  it("upsertKredit lama yang gagal tidak menimpa versi lebih baru saat dicoba ulang", async () => {
    const s = setup();
    jam(J("2026-11-20", "10:30"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.db.saveReport(laporan("m1", "Brando", J("2026-11-20", "10:00"), 1_000_000));
    s.g.gagalApply = new Error("Sheets 503");
    await jalankanRefresh(s.rt);
    await flushOutbox(s.rt);
    s.g.gagalApply = null;
    s.db.saveReport(laporan("m2", "Brando", J("2026-11-20", "10:20"), 1_500_000));
    await jalankanRefresh(s.rt);
    jam(J("2026-11-20", "10:40"));
    await flushOutbox(s.rt);
    const kredit = s.g.applied.filter((o) => o.type === "upsertKredit");
    expect(kredit).toHaveLength(1);
    expect(kredit[0]!.type === "upsertKredit" && kredit[0]!.rows.map((r) => r.messageId)).toContain("m2");
    expect(semuaOp(s.db).filter((o) => o.type === "upsertKredit")).toEqual([]);
  });
});

describe("detak dan refresh", () => {
  it("detak menulis Heartbeat dengan status WA; WAHA tak terjangkau → UNREACHABLE", async () => {
    const s = setup();
    jam(J("2026-11-20", "10:00"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await detak(s.rt);
    expect(s.g.applied).toEqual([{ type: "writeHeartbeat", at: J("2026-11-20", "10:00"), waStatus: "WORKING" }]);
    expect(s.rt.waStatus).toBe("WORKING");
    s.w.statusGagal = true;
    await detak(s.rt);
    expect(s.g.applied.at(-1)).toMatchObject({ waStatus: "UNREACHABLE" });
    expect(s.rt.waStatus).toBe("UNREACHABLE");
  });

  it("pesan owner dari refresh (input tak valid) dikirim pribadi sekali; koreksi disetujui sampai ke tanda terima", async () => {
    const s = setup();
    jam(J("2026-11-20", "10:30"));
    s.g.invalidSettings = [{ tab: "Pengaturan", row: 4, reason: "Jam rekap tidak valid" }];
    await jalankanRefresh(s.rt);
    await jalankanRefresh(s.rt);
    expect(s.w.ke(OWNER)).toHaveLength(1);
    expect(s.w.ke(OWNER)[0]!.text).toContain("Pengaturan baris 4");

    s.db.saveReport(laporan("m1", "Brando", J("2026-11-20", "10:00"), 1_000_000));
    s.g.koreksi = [{ messageId: "m1", platform: "shopee", field: "omzet", value: 1_100_000 }];
    await jalankanRefresh(s.rt);
    s.ex.hasil.push(ok(bacaan("shopee", 1_300_000)));
    await terima(s.rt, gambar("m2", "Brando", J("2026-11-20", "10:31")));
    expect(s.w.ke(GROUP).at(-1)!.text).toContain("Shopee +Rp200.000");
  });

  it("tanpa input owner sama sekali (Sheets mati saat pertama jalan): pesan menunggu catch-up setelah refresh berhasil", async () => {
    const s = setup();
    jam(J("2026-11-20", "10:00"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.g.gagalBaca = new Error("Sheets 503");
    await jalankanRefresh(s.rt);
    expect(s.rt.input).toBeNull();
    s.db.markMessage("lama", J("2026-11-20", "09:00"));
    const m = gambar("B", "Brando", J("2026-11-20", "10:00"));
    await terima(s.rt, m);
    expect(s.db.reports("2026-11")).toEqual([]);

    s.g.gagalBaca = null;
    s.w.riwayat = [m];
    s.ex.hasil.push(ok(bacaan("shopee", 500_000)));
    jam(J("2026-11-20", "10:01"));
    await tiapMenit(s.rt);
    expect(s.db.reports("2026-11").map((r) => r.messageId)).toEqual(["B"]);

    // Salinan input owner bertahan di db untuk restart berikutnya.
    expect(buatRuntime(s.deps).input?.settings.hosts.map((h) => h.name)).toEqual(["Brando", "Vanna", "Linda"]);
  });
});
