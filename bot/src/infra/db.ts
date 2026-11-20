import Database from "better-sqlite3";
import { addDays, jakartaDateTime } from "../domain/time.js";
import type { PlatformReading, Report } from "../domain/types.js";

export type OutboxOp = { type: string; [k: string]: unknown };
export type ProblemKind = "caption" | "belum_lengkap" | "belum_teratribusi";
export interface OutboxItem { id: number; op: OutboxOp; attempts: number; nextAttemptAt: Date }

export interface Db {
  markMessage(id: string, ts: Date): boolean;
  /** Satu laporan per (messageId, platform): satu gambar bisa memuat dua platform. Simpan ulang mengganti. */
  saveReport(r: Report): void;
  reports(month: string): Report[];
  pendingCaption: {
    put(msgId: string, imageRef: string, caption: string): void;
    take(msgId: string): { msgId: string; imageRef: string; caption: string } | null;
  };
  pendingExtract: {
    put(msgId: string, imagePath: string, caption: string): void;
    all(): { msgId: string; imagePath: string; caption: string }[];
    done(msgId: string): void;
  };
  outbox: {
    push(op: OutboxOp): void;
    next(n: number): OutboxItem[];
    ack(id: number): void;
    fail(id: number): void;
  };
  sentCount(waId: string, date: string): number;
  logSent(waId: string, date: string): void;
  lastProcessedTs(): Date | null;
  setKv(k: string, v: string): void;
  getKv(k: string): string | null;
  logProblem(messageId: string, host: string | null, date: string, kind: ProblemKind): void;
  setProblemHost(messageId: string, host: string): void;
  problemCounts(month: string): Record<string, number>;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS processed (id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports (
  message_id TEXT NOT NULL, platform TEXT NOT NULL, received_ms INTEGER NOT NULL, effective_ms INTEGER,
  eff_ms INTEGER NOT NULL, host TEXT NOT NULL, is_mati INTEGER NOT NULL, reading TEXT NOT NULL,
  PRIMARY KEY (message_id, platform)
);
CREATE INDEX IF NOT EXISTS reports_eff ON reports (eff_ms);
CREATE TABLE IF NOT EXISTS pending_caption (msg_id TEXT PRIMARY KEY, image_ref TEXT NOT NULL, caption TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending_extract (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT NOT NULL UNIQUE, image_path TEXT NOT NULL, caption TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sent (wa_id TEXT NOT NULL, date TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (wa_id, date));
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS problems (
  message_id TEXT NOT NULL, kind TEXT NOT NULL, host TEXT, date TEXT NOT NULL,
  PRIMARY KEY (message_id, kind)
);
`;

export function openDb(path: string, opts: { now?: () => Date } = {}): Db {
  const now = opts.now ?? (() => new Date());
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const q = {
    mark: db.prepare("INSERT OR IGNORE INTO processed (id, ts) VALUES (?, ?)"),
    lastTs: db.prepare("SELECT MAX(ts) AS ts FROM processed"),
    saveReport: db.prepare(
      `INSERT OR REPLACE INTO reports (message_id, platform, received_ms, effective_ms, eff_ms, host, is_mati, reading)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    reports: db.prepare(
      "SELECT * FROM reports WHERE eff_ms >= ? AND eff_ms < ? ORDER BY eff_ms, rowid"),
    capPut: db.prepare("INSERT OR REPLACE INTO pending_caption (msg_id, image_ref, caption) VALUES (?, ?, ?)"),
    capGet: db.prepare("SELECT msg_id, image_ref, caption FROM pending_caption WHERE msg_id = ?"),
    capDel: db.prepare("DELETE FROM pending_caption WHERE msg_id = ?"),
    exPut: db.prepare("INSERT OR REPLACE INTO pending_extract (msg_id, image_path, caption) VALUES (?, ?, ?)"),
    exAll: db.prepare("SELECT msg_id, image_path, caption FROM pending_extract ORDER BY seq"),
    exDel: db.prepare("DELETE FROM pending_extract WHERE msg_id = ?"),
    obPush: db.prepare("INSERT INTO outbox (op, next_attempt_ms) VALUES (?, ?)"),
    obNext: db.prepare(
      "SELECT id, op, attempts, next_attempt_ms FROM outbox WHERE next_attempt_ms <= ? ORDER BY id LIMIT ?"),
    obAck: db.prepare("DELETE FROM outbox WHERE id = ?"),
    obFail: db.prepare(
      "UPDATE outbox SET attempts = attempts + 1, next_attempt_ms = ? WHERE id = ?"),
    obAttempts: db.prepare("SELECT attempts FROM outbox WHERE id = ?"),
    sentGet: db.prepare("SELECT n FROM sent WHERE wa_id = ? AND date = ?"),
    sentLog: db.prepare(
      "INSERT INTO sent (wa_id, date, n) VALUES (?, ?, 1) ON CONFLICT (wa_id, date) DO UPDATE SET n = n + 1"),
    kvSet: db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)"),
    kvGet: db.prepare("SELECT v FROM kv WHERE k = ?"),
    probLog: db.prepare("INSERT OR IGNORE INTO problems (message_id, kind, host, date) VALUES (?, ?, ?, ?)"),
    probHost: db.prepare("UPDATE problems SET host = ? WHERE message_id = ?"),
    probCount: db.prepare(
      "SELECT host, COUNT(*) AS n FROM problems WHERE host IS NOT NULL AND substr(date, 1, 7) = ? GROUP BY host"),
  };

  return {
    markMessage(id, ts) {
      return q.mark.run(id, ts.getTime()).changes > 0;
    },
    saveReport(r) {
      const eff = (r.effectiveAt ?? r.receivedAt).getTime();
      q.saveReport.run(
        r.messageId, r.reading.platform, r.receivedAt.getTime(), r.effectiveAt ? r.effectiveAt.getTime() : null,
        eff, r.host, r.isMati ? 1 : 0, JSON.stringify(r.reading));
    },
    reports(month) {
      const [y, m] = month.split("-").map(Number) as [number, number];
      const first = `${month}-01`;
      const nextFirst = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
      const from = jakartaDateTime(addDays(first, -1), "00:00").getTime();
      const to = jakartaDateTime(nextFirst, "06:00").getTime();
      const rows = q.reports.all(from, to) as {
        message_id: string; received_ms: number; effective_ms: number | null;
        host: string; is_mati: number; reading: string;
      }[];
      return rows.map((row): Report => ({
        messageId: row.message_id,
        receivedAt: new Date(row.received_ms),
        ...(row.effective_ms !== null ? { effectiveAt: new Date(row.effective_ms) } : {}),
        host: row.host,
        isMati: row.is_mati === 1,
        reading: JSON.parse(row.reading) as PlatformReading,
      }));
    },
    pendingCaption: {
      put(msgId, imageRef, caption) { q.capPut.run(msgId, imageRef, caption); },
      take(msgId) {
        const row = q.capGet.get(msgId) as { msg_id: string; image_ref: string; caption: string } | undefined;
        if (!row) return null;
        q.capDel.run(msgId);
        return { msgId: row.msg_id, imageRef: row.image_ref, caption: row.caption };
      },
    },
    pendingExtract: {
      put(msgId, imagePath, caption) { q.exPut.run(msgId, imagePath, caption); },
      all() {
        return (q.exAll.all() as { msg_id: string; image_path: string; caption: string }[])
          .map((r) => ({ msgId: r.msg_id, imagePath: r.image_path, caption: r.caption }));
      },
      done(msgId) { q.exDel.run(msgId); },
    },
    outbox: {
      push(op) { q.obPush.run(JSON.stringify(op), now().getTime()); },
      next(n) {
        return (q.obNext.all(now().getTime(), n) as
          { id: number; op: string; attempts: number; next_attempt_ms: number }[])
          .map((r) => ({
            id: r.id, op: JSON.parse(r.op) as OutboxOp, attempts: r.attempts,
            nextAttemptAt: new Date(r.next_attempt_ms),
          }));
      },
      ack(id) { q.obAck.run(id); },
      fail(id) {
        const cur = q.obAttempts.get(id) as
          { attempts: number } | undefined;
        if (!cur) return;
        const attempts = cur.attempts + 1;
        const delayMin = Math.min(2 ** (attempts - 1), 30);
        q.obFail.run(now().getTime() + delayMin * 60_000, id);
      },
    },
    sentCount(waId, date) {
      const row = q.sentGet.get(waId, date) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    logSent(waId, date) { q.sentLog.run(waId, date); },
    lastProcessedTs() {
      const row = q.lastTs.get() as { ts: number | null };
      return row.ts === null ? null : new Date(row.ts);
    },
    setKv(k, v) { q.kvSet.run(k, v); },
    getKv(k) {
      const row = q.kvGet.get(k) as { v: string } | undefined;
      return row?.v ?? null;
    },
    logProblem(messageId, host, date, kind) { q.probLog.run(messageId, kind, host, date); },
    setProblemHost(messageId, host) { q.probHost.run(host, messageId); },
    problemCounts(month) {
      const out: Record<string, number> = {};
      for (const r of q.probCount.all(month) as { host: string; n: number }[]) out[r.host] = r.n;
      return out;
    },
    close() { db.close(); },
  };
}
