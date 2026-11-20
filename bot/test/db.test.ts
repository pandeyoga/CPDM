import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/infra/db.js";
import { jakartaDateTime } from "../src/domain/time.js";
import type { PlatformReading, Report } from "../src/domain/types.js";

const dirs: string[] = [];
const dbs: Db[] = [];
function open(opts?: { now?: () => Date }): Db {
  const dir = mkdtempSync(join(tmpdir(), "db-test-"));
  dirs.push(dir);
  const db = openDb(join(dir, "t.sqlite"), opts);
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const reading = (over: Partial<PlatformReading> = {}): PlatformReading => ({
  platform: "tiktok", screen: "berjalan",
  omzet: { value: 1500000, rounded: true }, pesanan: { value: 3, rounded: false },
  penontonMasuk: null, komentar: null, keranjang: null, impresi: null,
  pengikutBaru: null, penontonAktif: null, rataNontonDetik: 42, durasiDetik: null, ...over,
});
const rep = (id: string, at: Date, eff?: Date): Report => ({
  messageId: id, receivedAt: at, ...(eff ? { effectiveAt: eff } : {}),
  host: "Ani", isMati: false, reading: reading(),
});

describe("db", () => {
  it("markMessage idempotent", () => {
    const db = open();
    expect(db.markMessage("a", new Date("2026-11-01T01:00:00Z"))).toBe(true);
    expect(db.markMessage("a", new Date("2026-11-01T02:00:00Z"))).toBe(false);
  });

  it("laporan round-trip dengan Date, Num dan null utuh", () => {
    const db = open();
    const r = rep("m1", jakartaDateTime("2026-11-10", "20:00"), jakartaDateTime("2026-11-10", "19:55"));
    db.saveReport(r);
    expect(db.reports("2026-11")).toEqual([r]);
    const r2 = rep("m2", jakartaDateTime("2026-11-11", "20:00"));
    db.saveReport(r2);
    expect(db.reports("2026-11")[1]).toEqual(r2);
    expect("effectiveAt" in db.reports("2026-11")[1]!).toBe(false);
  });

  it("satu pesan dua platform tersimpan dua laporan; simpan ulang platform sama mengganti", () => {
    const db = open();
    const at = jakartaDateTime("2026-11-10", "20:00");
    const tiktok = rep("m1", at);
    const shopee: Report = { ...rep("m1", at), reading: reading({ platform: "shopee", omzet: { value: 1317034, rounded: false } }) };
    db.saveReport(tiktok);
    db.saveReport(shopee);
    expect(db.reports("2026-11")).toEqual([tiktok, shopee]);
    const tiktok2: Report = { ...tiktok, host: "Budi" };
    db.saveReport(tiktok2);
    expect(db.reports("2026-11")).toHaveLength(2);
    expect(db.reports("2026-11").find((r) => r.reading.platform === "tiktok")?.host).toBe("Budi");
  });

  it("reports(month): batas bulan", () => {
    const db = open();
    db.saveReport(rep("prevLast", jakartaDateTime("2026-10-31", "10:00")));
    db.saveReport(rep("prevEarly", jakartaDateTime("2026-10-30", "23:00")));
    db.saveReport(rep("in", jakartaDateTime("2026-11-15", "10:00")));
    db.saveReport(rep("nextEarly", jakartaDateTime("2026-12-01", "05:59")));
    db.saveReport(rep("nextLate", jakartaDateTime("2026-12-01", "06:00")));
    // effectiveAt menang atas receivedAt
    db.saveReport(rep("eff", jakartaDateTime("2026-12-01", "07:00"), jakartaDateTime("2026-11-30", "23:30")));
    expect(db.reports("2026-11").map((r) => r.messageId)).toEqual(["prevLast", "in", "eff", "nextEarly"]);
  });

  it("pendingCaption: take sekali lalu hilang", () => {
    const db = open();
    db.pendingCaption.put("m1", "img-ref", "cap");
    expect(db.pendingCaption.take("m1")).toEqual({ msgId: "m1", imageRef: "img-ref", caption: "cap" });
    expect(db.pendingCaption.take("m1")).toBeNull();
    expect(db.pendingCaption.take("zzz")).toBeNull();
  });

  it("pendingCaption.all urut masuk; take mengeluarkan", () => {
    const db = open();
    db.pendingCaption.put("m2", "url-2", "");
    db.pendingCaption.put("m1", "url-1", "Brando Vanna");
    expect(db.pendingCaption.all()).toEqual([
      { msgId: "m2", imageRef: "url-2", caption: "" },
      { msgId: "m1", imageRef: "url-1", caption: "Brando Vanna" },
    ]);
    db.pendingCaption.take("m2");
    expect(db.pendingCaption.all().map((p) => p.msgId)).toEqual(["m1"]);
  });

  it("pendingExtract put/all/done", () => {
    const db = open();
    db.pendingExtract.put("m1", "/p/1.jpg", "c1");
    db.pendingExtract.put("m2", "/p/2.jpg", "c2");
    expect(db.pendingExtract.all().map((x) => x.msgId)).toEqual(["m1", "m2"]);
    expect(db.pendingExtract.all()[0]).toEqual({ msgId: "m1", imagePath: "/p/1.jpg", caption: "c1" });
    db.pendingExtract.done("m1");
    expect(db.pendingExtract.all().map((x) => x.msgId)).toEqual(["m2"]);
  });

  it("outbox FIFO, fail backoff 1,2,4..30 menit, ack menghapus", () => {
    let t = new Date("2026-11-10T00:00:00Z");
    const db = open({ now: () => t });
    db.outbox.push({ type: "a", x: 1 });
    db.outbox.push({ type: "b" });
    const first = db.outbox.next(10);
    expect(first.map((i) => i.op.type)).toEqual(["a", "b"]);
    expect(first[0]!.attempts).toBe(0);
    expect(first[0]!.op).toEqual({ type: "a", x: 1 });
    expect(db.outbox.next(1)).toHaveLength(1);

    db.outbox.fail(first[0]!.id);
    expect(db.outbox.next(10).map((i) => i.op.type)).toEqual(["b"]);
    t = new Date(t.getTime() + 60_000);
    const again = db.outbox.next(10);
    expect(again.map((i) => i.op.type)).toEqual(["a", "b"]);
    expect(again[0]!.attempts).toBe(1);
    expect(again[0]!.nextAttemptAt).toEqual(new Date("2026-11-10T00:01:00Z"));

    // gagal berturut-turut: 2, 4, 8, 16, 32->30
    const expected = [2, 4, 8, 16, 30, 30];
    for (const m of expected) {
      db.outbox.fail(first[0]!.id);
      const item = db.outbox.next(10).find((i) => i.id === first[0]!.id);
      expect(item).toBeUndefined();
      t = new Date(t.getTime() + m * 60_000 - 1000);
      expect(db.outbox.next(10).find((i) => i.id === first[0]!.id)).toBeUndefined();
      t = new Date(t.getTime() + 1000);
      expect(db.outbox.next(10).find((i) => i.id === first[0]!.id)).toBeDefined();
    }

    db.outbox.ack(first[0]!.id);
    expect(db.outbox.next(10).map((i) => i.op.type)).toEqual(["b"]);
  });

  it("sentCount/logSent per waId dan tanggal", () => {
    const db = open();
    expect(db.sentCount("w1", "2026-11-10")).toBe(0);
    db.logSent("w1", "2026-11-10");
    db.logSent("w1", "2026-11-10");
    db.logSent("w1", "2026-11-11");
    db.logSent("w2", "2026-11-10");
    expect(db.sentCount("w1", "2026-11-10")).toBe(2);
    expect(db.sentCount("w1", "2026-11-11")).toBe(1);
  });

  it("lastProcessedTs = terbesar, null bila kosong", () => {
    const db = open();
    expect(db.lastProcessedTs()).toBeNull();
    db.markMessage("a", new Date("2026-11-01T05:00:00Z"));
    db.markMessage("b", new Date("2026-11-01T09:00:00Z"));
    db.markMessage("c", new Date("2026-11-01T07:00:00Z"));
    expect(db.lastProcessedTs()).toEqual(new Date("2026-11-01T09:00:00Z"));
  });

  it("kv", () => {
    const db = open();
    expect(db.getKv("k")).toBeNull();
    db.setKv("k", "v1");
    db.setKv("k", "v2");
    expect(db.getKv("k")).toBe("v2");
  });

  it("data bertahan setelah dibuka ulang (skema idempoten)", () => {
    const dir = mkdtempSync(join(tmpdir(), "db-test-"));
    dirs.push(dir);
    const p = join(dir, "x.sqlite");
    const a = openDb(p);
    a.setKv("k", "v");
    a.close();
    const b = openDb(p);
    dbs.push(b);
    expect(b.getKv("k")).toBe("v");
  });

  it("problem log: idempoten, setProblemHost, problemCounts per bulan", () => {
    const db = open();
    db.logProblem("m1", "Ani", "2026-11-03", "caption");
    db.logProblem("m1", "Ani", "2026-11-03", "caption");
    db.logProblem("m1", "Ani", "2026-11-03", "belum_lengkap");
    db.logProblem("m2", "Budi", "2026-11-04", "caption");
    db.logProblem("m3", null, "2026-11-05", "belum_teratribusi");
    db.logProblem("m4", "Ani", "2026-12-01", "caption");
    expect(db.problemCounts("2026-11")).toEqual({ Ani: 2, Budi: 1 });
    db.setProblemHost("m3", "Budi");
    expect(db.problemCounts("2026-11")).toEqual({ Ani: 2, Budi: 2 });
    expect(db.problemCounts("2026-12")).toEqual({ Ani: 1 });
    expect(db.problemCounts("2027-01")).toEqual({});
  });
});
