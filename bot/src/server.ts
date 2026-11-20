import { realpathSync } from "node:fs";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { startScheduler, terima } from "./app/scheduler.js";
import { loadConfig } from "./config.js";
import { openDb } from "./infra/db.js";
import { ClaudeExtractor } from "./infra/extractor.js";
import { SheetsGateway, type Invalid } from "./infra/sheets.js";
import { parseIncoming, verifyWahaHmac, WahaClient, type Incoming } from "./infra/waha.js";

/*
 * Titik masuk bot. POST /webhook/waha: X-Webhook-Hmac (HMAC-SHA512 body mentah, kunci WAHA_HMAC_KEY) diverifikasi;
 * gagal → 401. Berhasil → 200 segera, lalu pesan diproses di antrean satu-per-satu penjadwal.
 * GET /health → 200 {ok, waStatus}.
 */

export interface AppDeps {
  hmacKey: string;
  terima: (m: Incoming) => Promise<void>;
  waStatus: () => string;
}

const BATAS_BODY = "10mb";

export function createApp(d: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.post("/webhook/waha", express.raw({ type: () => true, limit: BATAS_BODY }), (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyWahaHmac(body, req.get("X-Webhook-Hmac"), d.hmacKey)) {
      res.sendStatus(401);
      return;
    }
    res.sendStatus(200);
    let m: Incoming | null;
    try {
      m = parseIncoming(JSON.parse(body.toString("utf8")));
    } catch {
      console.error("webhook: body bukan JSON, diabaikan");
      return;
    }
    if (m) d.terima(m).catch((e: unknown) => console.error(`webhook: pesan ${m.id} gagal: ${pesanError(e)}`));
  });
  app.get("/health", (_req, res) => {
    res.json({ ok: true, waStatus: d.waStatus() });
  });
  return app;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = openDb(config.DB_PATH);
  const waha = new WahaClient({ baseUrl: config.WAHA_URL, apiKey: config.WAHA_API_KEY, session: config.WAHA_SESSION });
  const extractor = new ClaudeExtractor(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }));
  const invalid: Invalid[] = [];
  const gateway = new SheetsGateway(config, undefined, (items) => void invalid.push(...items));
  const { rt, siap, stop } = startScheduler({
    config, db, waha, extractor, gateway, dataDir: config.DATA_DIR, now: () => new Date(), invalid,
  });
  const app = createApp({ hmacKey: config.WAHA_HMAC_KEY, terima: (m) => terima(rt, m), waStatus: () => rt.waStatus });
  const server: Server = app.listen(config.PORT, () => console.log(`bot: mendengarkan di port ${config.PORT}`));
  void siap.then(() => console.log("bot: urutan awal selesai (catch-up, refresh, detak)"));

  const berhenti = async (sinyal: string): Promise<void> => {
    console.log(`bot: ${sinyal}, berhenti`);
    await stop();
    server.close();
    // Pesan, tugas, dan antrean Sheets yang sedang berjalan diselesaikan dulu sebelum db ditutup.
    await rt.pesan(async () => undefined);
    await rt.tugas(async () => undefined);
    await rt.flush;
    db.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void berhenti("SIGTERM"));
  process.once("SIGINT", () => void berhenti("SIGINT"));
}

const pesanError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  main().catch((e: unknown) => {
    console.error(`bot: gagal mulai: ${pesanError(e)}`);
    process.exit(1);
  });
}
