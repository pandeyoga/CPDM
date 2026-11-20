import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMessage, retryPendingExtract, type HandleDeps } from "../src/app/handleMessage.js";
import { buildLedger } from "../src/domain/ledger.js";
import {
  msgAckKoreksi, msgAckPerintah, msgDiproses, msgFormatKoreksi, msgKirimUlang, msgKoreksiTanpaPlatform, msgMintaRiwayat,
  msgSiapa,
} from "../src/domain/messages.js";
import { jakartaDateTime } from "../src/domain/time.js";
import type { ExtractResult, PlatformReading, Settings } from "../src/domain/types.js";
import { openDb, type Db, type OutboxOp } from "../src/infra/db.js";
import { SheetsGateway, type SheetOp } from "../src/infra/sheets.js";
import type { Incoming } from "../src/infra/waha.js";

const GROUP = "120363000000000000@g.us";
const WA = { Brando: "628111111111@c.us", Vanna: "628222222222@c.us", asing: "628999000000@c.us" };

const settings: Settings = {
  teamTarget: { "2026-11": 60_000_000 }, jadwalAktif: false, liveMulai: "09:00", liveSelesai: "22:00",
  jamPagi: "08:00", jamRekap: "22:30", maxGapMenit: 240, maxPesanPerHari: 6,
  hosts: [{ name: "Brando", waId: WA.Brando }, { name: "Vanna", waId: WA.Vanna }, { name: "Linda" }, { name: "Maya" }, { name: "Lisa" }],
  ownerWaId: "628000000000@c.us", ownerEmail: "owner@example.com",
};

const kosong = {
  pesanan: null, penontonMasuk: null, komentar: null, keranjang: null, impresi: null, pengikutBaru: null,
  penontonAktif: null, rataNontonDetik: null, durasiDetik: null,
};
const tiktok = (omzet: number, over: Partial<PlatformReading> = {}): PlatformReading => ({
  ...kosong, platform: "tiktok", screen: "berjalan", omzet: { value: omzet, rounded: true },
  pesanan: { value: 7, rounded: false }, ...over,
});
const shopee = (omzet: number, over: Partial<PlatformReading> = {}): PlatformReading => ({
  ...kosong, platform: "shopee", screen: "berjalan", omzet: { value: omzet, rounded: false },
  pesanan: { value: 13, rounded: false }, ...over,
});
const ok = (...readings: PlatformReading[]): ExtractResult => ({ ok: true, readings });

const jam = (hm: string, detik = 0): Date => new Date(jakartaDateTime("2026-11-20", hm).getTime() + detik * 1000);

let seq = 0;
function img(text: string, ts: Date, over: Partial<Incoming> = {}): Incoming {
  const id = `false_${GROUP}_3EB0IMG${++seq}_${WA.Brando}`;
  return { id, chatId: GROUP, from: WA.Brando, ts, text, hasImage: true, mediaUrl: `http://localhost:3000/api/files/${seq}.jpg`, ...over };
}
function txt(text: string, ts: Date, over: Partial<Incoming> = {}): Incoming {
  return { id: `false_${GROUP}_3EB0TXT${++seq}_${WA.Brando}`, chatId: GROUP, from: WA.Brando, ts, text, hasImage: false, ...over };
}

interface Sent { chatId: string; text: string; replyTo: string | undefined; mentions: string[] | undefined; id: string }

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "handle-test-"));
  dirs.push(dir);
  const dbPath = join(dir, "bot.sqlite");
  const db = openDb(dbPath);
  dbs.push(db);
  const sent: Sent[] = [];
  const gagal = { kirim: false, unduh: false };
  let n = 0;
  const waha = {
    async sendText(chatId: string, text: string, replyTo?: string, mentions?: string[]) {
      if (gagal.kirim) throw new Error("WAHA POST /api/sendText gagal: HTTP 500");
      // Id serialisasi seperti WAHA; balasan grup bisa merujuk id polos (3EB0BOTn) atau serialisasi.
      const id = `true_${GROUP}_3EB0BOT${++n}`;
      sent.push({ chatId, text, replyTo, mentions, id });
      return { id };
    },
    async download(url: string) {
      if (gagal.unduh) throw new Error("WAHA GET /api/files gagal: HTTP 502");
      return { buf: Buffer.from(`gambar ${url}`), mime: "image/jpeg" };
    },
  };
  const hasil: Array<ExtractResult | Error | Promise<ExtractResult>> = [];
  const extractor = {
    calls: 0,
    async extract(_buf: Buffer, _mime: string): Promise<ExtractResult> {
      extractor.calls++;
      const r = hasil.shift();
      if (r === undefined) throw new Error("extractor palsu kehabisan hasil");
      if (r instanceof Error) throw r;
      return r;
    },
  };
  let sekarang = jam("10:00");
  const maju = (menit: number): void => void (sekarang = new Date(sekarang.getTime() + menit * 60_000));
  const deps: HandleDeps = { config: { LIVE_GROUP_ID: GROUP }, db, waha, extractor, settings, dataDir: dir, now: () => sekarang };
  const ops = (): OutboxOp[] => db.outbox.next(100).map((i) => i.op);
  const terakhir = (): Sent => sent[sent.length - 1]!;
  const bukti = (m: Incoming): string => join(dir, "bukti", `${m.id}.jpg`);
  return { dir, dbPath, db, sent, gagal, hasil, extractor, deps, maju, ops, terakhir, bukti };
}

/** Sheets palsu: SheetsGateway asli dengan klien googleapis palsu; antrean di-flush lewat apply(). */
async function flushKeSheets(ops: OutboxOp[]): Promise<Array<{ range: string; values: unknown[][] }>> {
  const append: Array<{ range: string; values: unknown[][] }> = [];
  const sheets = {
    spreadsheets: { values: { append: async (p: { range: string; requestBody: { values: unknown[][] } }) => {
      append.push({ range: p.range, values: p.requestBody.values });
      return {};
    } } },
  };
  const gw = new SheetsGateway({ LIVE_SPREADSHEET_ID: "SS", BUKTI_FOLDER_ID: "F" }, { sheets: sheets as never, drive: {} as never });
  for (const op of ops) await gw.apply(op as SheetOp);
  return append;
}

const SERIAL_20_NOV = 46346; // 2026-11-20 sebagai serial tanggal Sheets

describe("handleMessage: gambar", () => {
  it("(a) foto bercaption Brando → 2 laporan dan 1 tanda terima memuat Brando", async () => {
    const t = setup();
    t.hasil.push(ok(shopee(1_317_034), tiktok(578_000)));
    const m = img("Brando", jam("10:00"));
    await handleMessage(m, t.deps);

    const reps = t.db.reports("2026-11");
    expect(reps.map((r) => r.reading.platform)).toEqual(["shopee", "tiktok"]);
    expect(reps.every((r) => r.host === "Brando" && r.messageId === m.id && !r.isMati)).toBe(true);
    expect(reps[0]?.receivedAt).toEqual(m.ts);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ chatId: GROUP, replyTo: m.id });
    expect(t.sent[0]?.text).toContain("Brando");
    expect(t.sent[0]?.text).toContain("Shopee +Rp1.317.034");
    expect(t.sent[0]?.text).toContain("TikTok +Rp578.000*");

    const path = join(t.dir, "bukti", `${m.id}.jpg`);
    expect(t.ops()).toEqual([{ type: "uploadBukti", messageId: m.id, path }]);
    expect(existsSync(path)).toBe(true);
  });

  it("(b) foto tanpa caption → msgSiapa; balasan Vanna → laporan atas nama Vanna", async () => {
    const t = setup();
    const m = img("", jam("10:00"));
    await handleMessage(m, t.deps);
    expect(t.sent).toEqual([expect.objectContaining({ text: msgSiapa(), replyTo: m.id })]);
    expect(t.extractor.calls).toBe(0);
    expect(t.db.reports("2026-11")).toEqual([]);

    t.hasil.push(ok(shopee(1_317_034)));
    // Balasan WA merujuk id polos pesan bot.
    await handleMessage(txt("Vanna", jam("10:03"), { replyToId: "3EB0BOT1" }), t.deps);
    const reps = t.db.reports("2026-11");
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ messageId: m.id, host: "Vanna", receivedAt: m.ts });
    expect(t.terakhir()).toMatchObject({ replyTo: m.id });
    expect(t.terakhir().text).toContain("Vanna");
    expect(t.db.problemCounts("2026-11")).toEqual({ Vanna: 1 });

    // Balasan berikutnya ke pertanyaan yang sama tidak memproses ulang.
    await handleMessage(txt("Brando", jam("10:04"), { replyToId: t.sent[0]!.id }), t.deps);
    expect(t.extractor.calls).toBe(1);
    expect(t.db.reports("2026-11")).toHaveLength(1);
  });

  it("balasan ke msgSiapa yang tidak menyebut host dikenal → ditanya lagi, lalu bisa dijawab", async () => {
    const t = setup();
    const m = img("Brando Vanna", jam("10:00"));
    await handleMessage(m, t.deps);
    expect(t.sent.map((s) => s.text)).toEqual([msgSiapa()]);

    await handleMessage(txt("yang tadi", jam("10:01"), { replyToId: t.sent[0]!.id }), t.deps);
    expect(t.sent.map((s) => s.text)).toEqual([msgSiapa(), msgSiapa()]);
    expect(t.extractor.calls).toBe(0);

    t.hasil.push(ok(tiktok(578_000)));
    await handleMessage(txt("brando mati", jam("10:02"), { replyToId: t.sent[1]!.id }), t.deps);
    expect(t.db.reports("2026-11")).toEqual([expect.objectContaining({ messageId: m.id, host: "Brando", isMati: true })]);
  });

  it("(c) extractor bukan_layar_live → msgKirimUlang, tidak ada laporan atau antrean", async () => {
    const t = setup();
    t.hasil.push({ ok: false, reason: "bukan_layar_live" });
    const m = img("Brando", jam("10:00"));
    await handleMessage(m, t.deps);
    expect(t.sent).toEqual([expect.objectContaining({ text: msgKirimUlang("bukan_layar_live"), replyTo: m.id })]);
    expect(t.db.reports("2026-11")).toEqual([]);
    expect(t.ops()).toEqual([]);
    expect(t.db.pendingExtract.all()).toEqual([]);
    expect(existsSync(t.bukti(m))).toBe(false);
  });

  it("(d) extractor melempar error → pendingExtract dan msgDiproses; proses ulang menyelesaikannya", async () => {
    const t = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    t.hasil.push(new Error("529 overloaded"));
    const m = img("Brando", jam("10:00"));
    await expect(handleMessage(m, t.deps)).resolves.toBeUndefined();
    const path = join(t.dir, "bukti", `${m.id}.jpg`);
    expect(t.db.pendingExtract.all()).toEqual([{ msgId: m.id, imagePath: path, caption: "Brando" }]);
    expect(t.sent).toEqual([expect.objectContaining({ text: msgDiproses(), replyTo: m.id })]);
    expect(t.db.reports("2026-11")).toEqual([]);
    expect(log).toHaveBeenCalledOnce();

    // Belum 5 menit: belum diambil ulang.
    await retryPendingExtract(t.deps);
    expect(t.extractor.calls).toBe(1);

    // Masih gagal: tetap di antrean, tidak ada pesan baru.
    t.maju(6);
    t.hasil.push(new Error("529 overloaded"));
    await retryPendingExtract(t.deps);
    expect(t.extractor.calls).toBe(2);
    expect(t.db.pendingExtract.all()).toHaveLength(1);
    expect(t.sent).toHaveLength(1);

    t.hasil.push(ok(shopee(1_317_034)));
    await retryPendingExtract(t.deps);
    expect(t.db.pendingExtract.all()).toEqual([]);
    expect(t.db.reports("2026-11")).toEqual([expect.objectContaining({ messageId: m.id, host: "Brando", receivedAt: m.ts })]);
    expect(t.terakhir()).toMatchObject({ replyTo: m.id });
    expect(t.terakhir().text).toContain("Shopee +Rp1.317.034");
  });

  it("(e) ID pesan yang sama dua kali hanya diproses sekali", async () => {
    const t = setup();
    t.hasil.push(ok(shopee(1_317_034)));
    const m = img("Brando", jam("10:00"));
    await handleMessage(m, t.deps);
    await handleMessage({ ...m }, t.deps);
    expect(t.extractor.calls).toBe(1);
    expect(t.sent).toHaveLength(1);
    expect(t.db.reports("2026-11")).toHaveLength(1);
  });

  it("(i) pesan dari grup lain diabaikan", async () => {
    const t = setup();
    t.hasil.push(ok(shopee(1_317_034)));
    const lain = { chatId: "999999@g.us" };
    await handleMessage(img("Brando", jam("10:00"), lain), t.deps);
    await handleMessage(txt("#izin sakit", jam("10:01"), lain), t.deps);
    expect(t.extractor.calls).toBe(0);
    expect(t.sent).toEqual([]);
    expect(t.ops()).toEqual([]);
    expect(t.db.lastProcessedTs()).toBeNull();
  });

  it("(j) TikTok lalu Shopee dalam 1 menit, host sama → dua tanda terima, kredit tiap platform sekali", async () => {
    const t = setup();
    t.hasil.push(ok(tiktok(578_000)), ok(shopee(1_317_034)));
    await handleMessage(img("Brando", jam("10:00")), t.deps);
    await handleMessage(img("Brando", jam("10:00", 50)), t.deps);

    expect(t.sent).toHaveLength(2);
    expect(t.sent[0]?.text).toContain("TikTok +Rp578.000");
    expect(t.sent[0]?.text).not.toContain("Shopee");
    expect(t.sent[1]?.text).toContain("Shopee +Rp1.317.034");
    expect(t.sent[1]?.text).not.toContain("TikTok");

    const entries = buildLedger(t.db.reports("2026-11"), { maxGapMenit: 240, liveMulai: "09:00" });
    const total = (p: string): number => entries.filter((e) => e.platform === p).reduce((a, e) => a + (e.credit.omzet ?? 0), 0);
    expect(entries).toHaveLength(2);
    expect(total("tiktok")).toBe(578_000);
    expect(total("shopee")).toBe(1_317_034);
  });

  it("R14: ledger tanda terima memuat laporan hari sebelumnya (lintas bulan)", async () => {
    const t = setup();
    t.hasil.push(ok(shopee(1_000_000)), ok(shopee(300_000)));
    await handleMessage(img("Brando", jakartaDateTime("2026-11-30", "21:00")), t.deps);
    await handleMessage(img("Vanna", jakartaDateTime("2026-12-01", "10:00")), t.deps);
    expect(t.sent.map((s) => s.text)).toEqual([
      expect.stringContaining("Brando · Shopee +Rp1.000.000"),
      expect.stringContaining("Vanna · Shopee +Rp300.000"),
      msgMintaRiwayat(settings.hosts[0]!, "shopee"),
    ]);
  });

  it("omzet turun tanpa layar akhir → msgMintaRiwayat menag host sebelumnya; foto balasan = layar akhir 1 detik sebelum siaran baru", async () => {
    const t = setup();
    t.hasil.push(ok(shopee(1_000_000)), ok(shopee(200_000)));
    await handleMessage(img("Brando", jam("10:00")), t.deps);
    const baru = img("Vanna", jam("12:00"));
    await handleMessage(baru, t.deps);

    const brando = settings.hosts[0]!;
    expect(t.sent).toHaveLength(3);
    expect(t.sent[1]?.text).toContain("Vanna · Shopee +Rp200.000");
    expect(t.sent[2]).toMatchObject({ text: msgMintaRiwayat(brando, "shopee"), mentions: [WA.Brando] });

    t.hasil.push(ok(shopee(1_200_000, { screen: "akhir" }), tiktok(900_000)));
    const riwayat = img("", jam("12:20"), { replyToId: t.sent[2]!.id });
    await handleMessage(riwayat, t.deps);

    const akhir = t.db.reports("2026-11").filter((r) => r.messageId === riwayat.id);
    expect(akhir).toEqual([expect.objectContaining({
      host: "Brando", isMati: true, receivedAt: riwayat.ts, effectiveAt: jam("11:59", 59),
      reading: expect.objectContaining({ platform: "shopee" }),
    })]);
    expect(t.terakhir()).toMatchObject({ replyTo: riwayat.id });
    expect(t.terakhir().text).toContain("Brando · Shopee +Rp200.000");
    expect(t.terakhir().text).toContain("Layar akhir tercatat");

    const entries = buildLedger(t.db.reports("2026-11"), { maxGapMenit: 240, liveMulai: "09:00" });
    const eBaru = entries.find((e) => e.messageId === baru.id);
    expect(eBaru?.flags).toContain("siaran_baru");
    expect(eBaru?.flags).not.toContain("siaran_belum_lengkap");

    // Permintaan riwayat sudah terjawab: foto balasan berikutnya diproses sebagai laporan biasa (caption kosong).
    await handleMessage(img("", jam("12:30"), { replyToId: t.sent[2]!.id }), t.deps);
    expect(t.terakhir().text).toBe(msgSiapa());
  });
});

describe("handleMessage: perintah", () => {
  it("(f) #izin sakit dari Brando → appendKehadiran berstatus Menunggu", async () => {
    const t = setup();
    const m = txt("#izin sakit", jam("08:15"));
    await handleMessage(m, t.deps);
    expect(t.ops()).toEqual([{
      type: "appendKehadiran",
      row: { tanggal: "2026-11-20", host: "Brando", jenis: "Sakit", alasan: "sakit", sumber: "Grup WA" },
    }]);
    expect(t.sent).toEqual([expect.objectContaining({
      text: msgAckPerintah({ kind: "izin", date: "2026-11-20", alasan: "sakit" }), replyTo: m.id,
    })]);
    expect(await flushKeSheets(t.ops())).toEqual([{
      range: "'Kehadiran'!A:A", values: [[SERIAL_20_NOV, "Brando", "Sakit", "sakit", "Grup WA", "Menunggu"]],
    }]);
  });

  it("R34: host dari nama di teks perintah (HP bersama), lalu nomor pengirim, lalu kosong", async () => {
    const t = setup();
    await handleMessage(txt("#izin 25/11 Vanna keperluan keluarga", jam("08:15"), { from: WA.asing }), t.deps);
    await handleMessage(txt("#izin cuti", jam("08:16"), { from: WA.Vanna }), t.deps);
    await handleMessage(txt("#izin telat", jam("08:17"), { from: WA.asing }), t.deps);
    expect(t.ops()).toEqual([
      { type: "appendKehadiran", row: { tanggal: "2026-11-25", host: "Vanna", jenis: "Izin", alasan: "keperluan keluarga", sumber: "Grup WA" } },
      { type: "appendKehadiran", row: { tanggal: "2026-11-20", host: "Vanna", jenis: "Cuti", alasan: "cuti", sumber: "Grup WA" } },
      { type: "appendKehadiran", row: { tanggal: "2026-11-20", host: "", jenis: "Telat", alasan: "telat", sumber: "Grup WA" } },
    ]);
    expect(t.sent[0]?.text).toBe(msgAckPerintah({ kind: "izin", date: "2026-11-25", alasan: "keperluan keluarga" }));
  });

  it("(g) #gangguan listrik lalu #normal → gangguanAktif terisi lalu kosong; baris Gangguan dengan mulai/selesai", async () => {
    const t = setup();
    await handleMessage(txt("#gangguan listrik", jam("13:00")), t.deps);
    expect(t.db.getKv("gangguanAktif")).toBeTruthy();
    expect(t.ops()).toEqual([]);
    await handleMessage(txt("#gangguan shopee Linda akun dibatasi", jam("13:10"), { from: WA.asing }), t.deps);
    await handleMessage(txt("#normal", jam("13:45")), t.deps);
    expect(t.db.getKv("gangguanAktif")).toBe("");
    expect(t.ops()).toEqual([
      { type: "appendGangguan", row: { tanggal: "2026-11-20", host: "Brando", mulai: "13:00", selesai: "13:45", alasan: "listrik", sumber: "Grup WA" } },
      { type: "appendGangguan", row: { tanggal: "2026-11-20", host: "Linda", mulai: "13:10", selesai: "13:45", alasan: "Shopee: akun dibatasi", sumber: "Grup WA" } },
    ]);
    expect(t.sent.map((s) => s.text)).toEqual([
      msgAckPerintah({ kind: "gangguan", scope: "semua", alasan: "listrik" }),
      msgAckPerintah({ kind: "gangguan", scope: "shopee", alasan: "akun dibatasi" }),
      msgAckPerintah({ kind: "normal" }),
    ]);
    expect((await flushKeSheets(t.ops()))[0]).toEqual({
      range: "'Gangguan'!A:A", values: [[SERIAL_20_NOV, "Brando", "13:00", "13:45", "listrik", "Grup WA", "Menunggu"]],
    });
  });

  it("gangguan lewat tengah malam dipecah per tanggal", async () => {
    const t = setup();
    await handleMessage(txt("#gangguan internet", jam("23:30")), t.deps);
    await handleMessage(txt("#normal", new Date(jakartaDateTime("2026-11-21", "00:20").getTime())), t.deps);
    expect(t.ops().map((o) => o.row)).toEqual([
      expect.objectContaining({ tanggal: "2026-11-20", mulai: "23:30", selesai: "23:59" }),
      expect.objectContaining({ tanggal: "2026-11-21", mulai: "00:00", selesai: "00:20" }),
    ]);
  });

  it("teks biasa dan balasan ke pesan tak dikenal diabaikan diam-diam", async () => {
    const t = setup();
    await handleMessage(txt("semangat live hari ini", jam("09:00")), t.deps);
    await handleMessage(txt("koreksi shopee 1.350.000", jam("09:01"), { replyToId: "3EB0LAIN" }), t.deps);
    expect(t.sent).toEqual([]);
    expect(t.ops()).toEqual([]);
  });
});

describe("handleMessage: koreksi", () => {
  async function adaTandaTerima() {
    const t = setup();
    t.hasil.push(ok(shopee(1_317_034), tiktok(578_000)));
    const m = img("Brando", jam("10:00"));
    await handleMessage(m, t.deps);
    const tanda = t.sent[0]!;
    const ops0 = t.ops().length;
    const opsBaru = (): OutboxOp[] => t.ops().slice(ops0);
    return { ...t, m, tanda, opsBaru };
  }

  it("(h) balasan 'koreksi shopee 1.350.000' ke tanda terima → appendKoreksi Menunggu", async () => {
    const t = await adaTandaTerima();
    const balas = txt("koreksi shopee 1.350.000", jam("10:05"), { replyToId: t.tanda.id });
    await handleMessage(balas, t.deps);
    expect(t.opsBaru()).toEqual([{
      type: "appendKoreksi",
      row: {
        tanggal: "2026-11-20", host: "Brando", masalah: 'Koreksi dari grup: "koreksi shopee 1.350.000"',
        angkaBot: 1_317_034, usulan: 1_350_000, jenis: "koreksi",
        messageId: t.m.id, platform: "shopee", field: "omzet", value: 1_350_000,
      },
    }]);
    expect(t.terakhir()).toMatchObject({ text: msgAckKoreksi("shopee"), replyTo: balas.id });
    const [baris] = await flushKeSheets(t.opsBaru());
    expect(baris?.range).toBe("'Koreksi & Atribusi'!A:A");
    expect(baris?.values[0]?.[5]).toBe("Menunggu");
  });

  it("balasan ke screenshot asli juga diterima; tanpa kata koreksi/platform diabaikan; format salah dijawab format", async () => {
    const t = await adaTandaTerima();
    // Balasan ke foto asli; WA bisa merujuk id polos ("3EB0IMGn") dari id serialisasi.
    await handleMessage(txt("tiktok pesanan 9", jam("10:06"), { replyToId: t.m.id.split("_")[2] }), t.deps);
    expect(t.opsBaru()).toEqual([expect.objectContaining({
      type: "appendKoreksi",
      row: expect.objectContaining({ messageId: t.m.id, platform: "tiktok", field: "pesanan", angkaBot: 7, usulan: 9, value: 9 }),
    })]);

    const n = t.sent.length;
    await handleMessage(txt("siap makasih", jam("10:07"), { replyToId: t.tanda.id }), t.deps);
    expect(t.sent).toHaveLength(n);

    await handleMessage(txt("harusnya 1.350.000", jam("10:08"), { replyToId: t.tanda.id }), t.deps);
    expect(t.sent).toHaveLength(n);

    await handleMessage(txt("koreksi 1.350.000", jam("10:09"), { replyToId: t.tanda.id }), t.deps);
    expect(t.terakhir().text).toBe(msgFormatKoreksi());
    await handleMessage(txt("shopee kurang", jam("10:10"), { replyToId: t.tanda.id }), t.deps);
    expect(t.sent.slice(n).map((s) => s.text)).toEqual([msgFormatKoreksi(), msgFormatKoreksi()]);
    expect(t.opsBaru()).toHaveLength(1);
  });

  it("platform yang tidak ada di laporan itu → pesan singkat tersendiri, tidak dicatat", async () => {
    const t = setup();
    t.hasil.push(ok(shopee(1_317_034)));
    const m = img("Brando", jam("10:00"));
    await handleMessage(m, t.deps);
    const n = t.ops().length;
    await handleMessage(txt("koreksi tiktok 600rb", jam("10:05"), { replyToId: t.sent[0]!.id }), t.deps);
    expect(t.terakhir().text).toBe(msgKoreksiTanpaPlatform("tiktok"));
    expect(t.terakhir().text).not.toBe(msgFormatKoreksi());
    expect(t.ops()).toHaveLength(n);
  });
});

describe("handleMessage: perintah (fix round 1)", () => {
  it("R34b: hanya token nama host persis; tanpa itu nomor pengirim, lalu kosong", async () => {
    const t = setup();
    await handleMessage(txt("#izin saya sakit", jam("08:15"), { from: WA.Brando }), t.deps);
    await handleMessage(txt("#izin gak bisa live", jam("08:16"), { from: WA.asing }), t.deps);
    await handleMessage(txt("#izin VANNA, sakit", jam("08:17"), { from: WA.Brando }), t.deps);
    expect(t.ops().map((o) => o.row)).toEqual([
      { tanggal: "2026-11-20", host: "Brando", jenis: "Sakit", alasan: "saya sakit", sumber: "Grup WA" },
      { tanggal: "2026-11-20", host: "", jenis: "Izin", alasan: "gak bisa live", sumber: "Grup WA" },
      { tanggal: "2026-11-20", host: "Vanna", jenis: "Sakit", alasan: "sakit", sumber: "Grup WA" },
    ]);
  });

  it("gambar bercaption perintah → jalur perintah, bukan msgSiapa", async () => {
    const t = setup();
    const m = img("#gangguan tiktok akun dibatasi", jam("14:00"));
    await handleMessage(m, t.deps);
    expect(JSON.parse(t.db.getKv("gangguanAktif") ?? "[]")).toEqual([
      { tanggal: "2026-11-20", mulai: "14:00", host: "Brando", alasan: "akun dibatasi", scope: "tiktok" },
    ]);
    expect(t.sent.map((s) => s.text)).toEqual([msgAckPerintah({ kind: "gangguan", scope: "tiktok", alasan: "akun dibatasi" })]);
    expect(t.extractor.calls).toBe(0);
    expect(t.db.problemCounts("2026-11")).toEqual({});
    expect(t.db.pendingCaption.take(m.id)).toBeNull();
  });
});

describe("handleMessage: tanda terima (fix round 1)", () => {
  it("omzet null → 'omzet belum terbaca', bukan +Rp0", async () => {
    const t = setup();
    t.hasil.push(ok(shopee(0, { omzet: null }), tiktok(578_000)));
    await handleMessage(img("Brando", jam("10:00")), t.deps);
    expect(t.sent[0]?.text).toContain("Shopee omzet belum terbaca");
    expect(t.sent[0]?.text).toContain("TikTok +Rp578.000*");
    expect(t.sent[0]?.text).not.toContain("+Rp0");
  });
});

describe("handleMessage: riwayat (fix round 1)", () => {
  async function adaPermintaan() {
    const t = setup();
    t.hasil.push(ok(shopee(1_000_000)), ok(shopee(200_000)));
    await handleMessage(img("Brando", jam("10:00")), t.deps);
    await handleMessage(img("Vanna", jam("12:00")), t.deps);
    const minta = t.sent[2]!;
    expect(minta.text).toBe(msgMintaRiwayat(settings.hosts[0]!, "shopee"));
    return { ...t, minta };
  }

  it("probe: balasan bercaption host lain (omzet di bawah puncak) → laporan biasa host itu; permintaan tetap terbuka", async () => {
    const t = await adaPermintaan();
    t.hasil.push(ok(shopee(450_000)));
    const probe = img("Vanna", jam("12:30"), { replyToId: t.minta.id });
    await handleMessage(probe, t.deps);
    const r = t.db.reports("2026-11").find((x) => x.messageId === probe.id);
    expect(r).toMatchObject({ host: "Vanna", isMati: false, receivedAt: probe.ts });
    expect(r && "effectiveAt" in r).toBe(false);
    expect(t.terakhir().text).toContain("Vanna · Shopee +Rp250.000");

    // Layar akhir yang sah masih bisa dikirim sesudahnya.
    t.hasil.push(ok(shopee(1_200_000, { screen: "akhir" })));
    const akhir = img("", jam("12:40"), { replyToId: t.minta.id });
    await handleMessage(akhir, t.deps);
    expect(t.db.reports("2026-11").find((x) => x.messageId === akhir.id)).toMatchObject({
      host: "Brando", isMati: true, effectiveAt: jam("11:59", 59),
    });
  });

  it("balasan tanpa nama host dengan omzet di bawah puncak siaran lama → bukan layar akhir, diproses sebagai gambar biasa", async () => {
    const t = await adaPermintaan();
    t.hasil.push(ok(shopee(450_000)));
    const probe = img("", jam("12:30"), { replyToId: t.minta.id });
    await handleMessage(probe, t.deps);
    expect(t.db.reports("2026-11").some((x) => x.messageId === probe.id)).toBe(false);
    expect(t.terakhir()).toMatchObject({ text: msgSiapa(), replyTo: probe.id });
    expect(t.db.pendingExtract.all()).toEqual([]);
  });

  it("siaran kemarin tanpa layar akhir: layar akhir riwayat dipasang tepat sesudah laporan terakhirnya (tidak dobel)", async () => {
    const t = setup();
    t.hasil.push(ok(shopee(1_000_000)), ok(shopee(300_000)));
    const kemarin = img("Brando", jakartaDateTime("2026-11-19", "21:00"));
    await handleMessage(kemarin, t.deps);
    await handleMessage(img("Vanna", jam("10:00")), t.deps);
    const minta = t.terakhir();
    expect(minta.text).toBe(msgMintaRiwayat(settings.hosts[0]!, "shopee"));

    t.hasil.push(ok(shopee(1_100_000, { screen: "akhir" })));
    const akhir = img("", jam("10:20"), { replyToId: minta.id });
    await handleMessage(akhir, t.deps);
    expect(t.db.reports("2026-11").find((x) => x.messageId === akhir.id)).toMatchObject({
      host: "Brando", isMati: true, effectiveAt: new Date(kemarin.ts.getTime() + 1000),
    });
    expect(t.terakhir().text).toContain("Brando · Shopee +Rp100.000");
    const entries = buildLedger(t.db.reports("2026-11"), { maxGapMenit: 240, liveMulai: "09:00" });
    expect(entries.reduce((a, e) => a + (e.credit.omzet ?? 0), 0)).toBe(1_400_000);
  });
});

describe("handleMessage: ketahanan (fix round 1)", () => {
  it("crash setelah markMessage: gambar tetap di antrean; proses ulang (≥5 menit, bukan in-flight) memulihkannya", async () => {
    const t = setup();
    t.hasil.push(new Promise<ExtractResult>(() => {})); // proses "mati" di tengah ekstraksi
    const m = img("Brando", jam("10:00"));
    void handleMessage(m, t.deps);
    await vi.waitFor(() => expect(t.extractor.calls).toBe(1));
    expect(t.db.pendingExtract.all()).toEqual([{ msgId: m.id, imagePath: t.bukti(m), caption: "Brando" }]);

    // "Restart": modul baru (set in-flight kosong) dan koneksi db baru ke berkas yang sama.
    vi.resetModules();
    const baru = await import("../src/app/handleMessage.js");
    const db2 = openDb(t.dbPath);
    dbs.push(db2);
    const deps2: HandleDeps = { ...t.deps, db: db2 };
    t.maju(2);
    await baru.handleMessage({ ...m }, deps2); // catch-up mengirim ulang pesan → diabaikan markMessage
    await baru.retryPendingExtract(deps2); // baru 2 menit → belum diambil
    expect(t.extractor.calls).toBe(1);

    t.maju(4);
    await retryPendingExtract(t.deps); // proses lama: masih in-flight → tidak diambil dobel
    expect(t.extractor.calls).toBe(1);

    t.hasil.push(ok(shopee(1_317_034)));
    await baru.retryPendingExtract(deps2);
    expect(t.extractor.calls).toBe(2);
    expect(db2.pendingExtract.all()).toEqual([]);
    expect(db2.reports("2026-11")).toEqual([expect.objectContaining({ messageId: m.id, host: "Brando", receivedAt: m.ts })]);
    expect(t.terakhir()).toMatchObject({ replyTo: m.id });
    expect(t.terakhir().text).toContain("Brando · Shopee +Rp1.317.034");
  });

  it("unduhan gagal → tetap di antrean (URL media disimpan), msgDiproses; proses ulang mengunduh lagi", async () => {
    const t = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    t.gagal.unduh = true;
    const m = img("Brando", jam("10:00"));
    await handleMessage(m, t.deps);
    expect(t.db.pendingExtract.all()).toEqual([{ msgId: m.id, imagePath: "", caption: "Brando" }]);
    expect(t.sent.map((s) => s.text)).toEqual([msgDiproses()]);
    expect(t.extractor.calls).toBe(0);
    expect(log).toHaveBeenCalled();

    t.gagal.unduh = false;
    t.maju(6);
    t.hasil.push(ok(shopee(1_317_034)));
    await retryPendingExtract(t.deps);
    expect(t.db.pendingExtract.all()).toEqual([]);
    expect(existsSync(t.bukti(m))).toBe(true);
    expect(t.terakhir().text).toContain("Shopee +Rp1.317.034");
  });

  it("berkas lokal hilang → diunduh ulang saat proses ulang, tidak hilang", async () => {
    const t = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.hasil.push(new Error("timeout"));
    const m = img("Brando", jam("10:00"));
    await handleMessage(m, t.deps);
    rmSync(t.bukti(m));
    t.maju(6);
    t.hasil.push(ok(shopee(1_317_034)));
    await retryPendingExtract(t.deps);
    expect(existsSync(t.bukti(m))).toBe(true);
    expect(t.db.reports("2026-11")).toHaveLength(1);
    expect(t.db.pendingExtract.all()).toEqual([]);
  });

  it("sendText melempar → handler tidak melempar, data tetap tersimpan; msgSiapa gagal → gambar tetap tertunda", async () => {
    const t = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    t.gagal.kirim = true;
    t.hasil.push(ok(shopee(1_317_034)));
    const m = img("Brando", jam("10:00"));
    await expect(handleMessage(m, t.deps)).resolves.toBeUndefined();
    expect(t.db.reports("2026-11")).toHaveLength(1);
    expect(t.ops()).toEqual([{ type: "uploadBukti", messageId: m.id, path: t.bukti(m) }]);
    expect(t.db.pendingExtract.all()).toEqual([]);

    const tanpaNama = img("", jam("10:05"));
    await expect(handleMessage(tanpaNama, t.deps)).resolves.toBeUndefined();
    expect(log.mock.calls.some((c) => String(c[0]).includes(`${tanpaNama.id} tetap menunggu nama host`))).toBe(true);
    expect(t.db.getKv(`gambar:${tanpaNama.id}`)).not.toBeNull();
    expect(existsSync(t.bukti(tanpaNama))).toBe(true);
    expect(t.db.pendingCaption.take(tanpaNama.id)).not.toBeNull();
  });

  it("gambar tanpa URL media diabaikan dengan log", async () => {
    const t = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(handleMessage(img("Brando", jam("10:00"), { mediaUrl: undefined }), t.deps)).resolves.toBeUndefined();
    expect(t.sent).toEqual([]);
    expect(t.db.pendingExtract.all()).toEqual([]);
    expect(t.extractor.calls).toBe(0);
    expect(log).toHaveBeenCalledOnce();
  });

  it("proses ulang tanpa konteks gambar → item dibuang dengan log", async () => {
    const t = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    t.db.pendingExtract.put("hilang", "", "");
    t.maju(6);
    await retryPendingExtract(t.deps);
    expect(t.db.pendingExtract.all()).toEqual([]);
    expect(t.extractor.calls).toBe(0);
    expect(log).toHaveBeenCalledOnce();
  });
});
