import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Correction } from "../src/domain/ledger.js";
import { jakartaDateTime } from "../src/domain/time.js";
import type { ExtractResult, Platform, PlatformReading, Report, Settings } from "../src/domain/types.js";
import { openDb, type Db, type OutboxOp } from "../src/infra/db.js";
import type { Invalid, SheetOp } from "../src/infra/sheets.js";
import type { Incoming } from "../src/infra/waha.js";

/* Fake bersama untuk tes refresh/penjadwal: WAHA, gateway Sheets, ekstraktor, db SQLite sementara. */

export const GROUP = "120363000000000000@g.us";
export const OWNER = "628000000000@c.us";
export const WA = { Brando: "628111111111@c.us", Vanna: "628222222222@c.us" };

export const settingsDasar = (over: Partial<Settings> = {}): Settings => ({
  teamTarget: { "2026-11": 60_000_000, "2026-12": 60_000_000 }, jadwalAktif: false, liveMulai: "09:00", liveSelesai: "22:00",
  jamPagi: "08:00", jamRekap: "22:30", maxGapMenit: 240, maxPesanPerHari: 6,
  hosts: [{ name: "Brando", waId: WA.Brando }, { name: "Vanna", waId: WA.Vanna }, { name: "Linda" }],
  ownerWaId: OWNER, ownerEmail: "owner@example.com", ...over,
});

/** Waktu Asia/Jakarta: J("2026-11-20", "10:00"). */
export const J = (date: string, hm: string): Date => jakartaDateTime(date, hm);

const kosong = {
  pesanan: null, penontonMasuk: null, komentar: null, keranjang: null, impresi: null, pengikutBaru: null,
  penontonAktif: null, rataNontonDetik: null, durasiDetik: null,
};
export const bacaan = (platform: Platform, omzet: number, over: Partial<PlatformReading> = {}): PlatformReading => ({
  ...kosong, platform, screen: "berjalan", omzet: { value: omzet, rounded: false }, ...over,
});

export function laporan(
  messageId: string, host: string, at: Date, omzet: number, o: { platform?: Platform; isMati?: boolean } = {},
): Report {
  return { messageId, receivedAt: at, host, isMati: o.isMati ?? false, reading: bacaan(o.platform ?? "shopee", omzet) };
}

export interface Terkirim { chatId: string; text: string; replyTo: string | undefined; mentions: string[] | undefined; id: string }

export function fakeWaha() {
  const w = {
    sent: [] as Terkirim[],
    n: 0,
    status: "WORKING",
    statusGagal: false,
    gagalKirim: false,
    riwayat: [] as Incoming[],
    sinceArgs: [] as Array<{ chatId: string; since: Date }>,
    async sendText(chatId: string, text: string, replyTo?: string, mentions?: string[]) {
      if (w.gagalKirim) throw new Error("WAHA POST /api/sendText gagal: HTTP 500");
      const id = `true_${chatId}_3EB0BOT${++w.n}`;
      w.sent.push({ chatId, text, replyTo, mentions, id });
      return { id };
    },
    async download(url: string) {
      return { buf: Buffer.from(`gambar ${url}`), mime: "image/jpeg" };
    },
    async messagesSince(chatId: string, since: Date) {
      w.sinceArgs.push({ chatId, since });
      return [...w.riwayat];
    },
    async sessionStatus() {
      if (w.statusGagal) throw new Error("WAHA GET /api/sessions/default gagal: HTTP 502");
      return w.status;
    },
    ke: (chatId: string) => w.sent.filter((s) => s.chatId === chatId),
  };
  return w;
}

export function fakeGateway(invalid: Invalid[]) {
  const g = {
    settings: settingsDasar(),
    koreksi: [] as Correction[],
    atribusi: new Map<string, Array<{ host: string; share: number }>>(),
    kehadiran: [] as Array<{ host: string; date: string }>,
    gangguan: [] as Array<{ host: string; date: string; menit: number }>,
    kalender: [] as string[],
    jadwal: [] as Array<{ date: string; host: string; mulai: string; selesai: string }>,
    kontrol: {} as Record<string, number>,
    koreksiMenunggu: 0,
    /** Dilaporkan ke onInvalid setiap readSettings. */
    invalidSettings: [] as Invalid[],
    gagalBaca: null as Error | null,
    gagalApply: null as Error | null,
    applied: [] as SheetOp[],
    uploads: [] as Array<{ name: string; size: number }>,
    bacaJadwal: 0,
    async readSettings() {
      if (g.gagalBaca) throw g.gagalBaca;
      invalid.push(...g.invalidSettings);
      return g.settings;
    },
    async readKoreksiKeputusan() { return g.koreksi; },
    async readAtribusi(_hosts?: Array<{ name: string }>) { return g.atribusi; },
    async readKehadiran() { return g.kehadiran; },
    async readGangguan() { return g.gangguan; },
    async readKalenderLive() { return g.kalender; },
    async readJadwal() {
      g.bacaJadwal++;
      return g.jadwal;
    },
    async readKontrol() { return g.kontrol; },
    async readKoreksiMenunggu() { return g.koreksiMenunggu; },
    async apply(op: SheetOp) {
      if (g.gagalApply) throw g.gagalApply;
      g.applied.push(op);
    },
    async uploadBukti(buf: Buffer, name: string) {
      if (g.gagalApply) throw g.gagalApply;
      g.uploads.push({ name, size: buf.length });
      return `https://drive.google.com/file/d/${name}/view`;
    },
  };
  return g;
}

export function fakeExtractor() {
  const e = {
    hasil: [] as Array<ExtractResult | Error | Promise<ExtractResult>>,
    calls: 0,
    async extract(_buf: Buffer, _mime: string): Promise<ExtractResult> {
      e.calls++;
      const r = e.hasil.shift();
      if (r === undefined) throw new Error("extractor palsu kehabisan hasil");
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return e;
}

export const ok = (...readings: PlatformReading[]): ExtractResult => ({ ok: true, readings });

export function gambar(id: string, text: string, ts: Date, from = WA.Brando): Incoming {
  return { id, chatId: GROUP, from, ts, text, hasImage: true, mediaUrl: `http://localhost:3000/api/files/${id}.jpg` };
}

/** Folder dan db sementara; bersihkan() di afterEach. */
export function tempat() {
  const dirs: string[] = [];
  const dbs: Db[] = [];
  return {
    buat(): { dir: string; db: Db } {
      const dir = mkdtempSync(join(tmpdir(), "bot-test-"));
      dirs.push(dir);
      const db = openDb(join(dir, "bot.sqlite"));
      dbs.push(db);
      return { dir, db };
    },
    bersihkan(): void {
      for (const d of dbs.splice(0)) d.close();
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}

/** Operasi antrean yang sudah jatuh tempo (tanpa menghapus). */
export function semuaOp(db: Db): OutboxOp[] {
  return db.outbox.next(10_000).map((i) => i.op);
}
