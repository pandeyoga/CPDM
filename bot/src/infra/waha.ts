import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Klien WAHA (WhatsApp HTTP API). PROVISIONAL: path dan bentuk payload diambil dari kode sumber WAHA
 * (devlikeapro/waha @ c42f68ab), bukan dari server nyata. Task 0 harus mencocokkannya dengan WAHA di VPS.
 *   POST /api/sendText                                   {session, chatId, text, reply_to?, mentions?}
 *   GET  /api/{session}/chats/{chatId}/messages?limit&downloadMedia&filter.timestamp.gte&filter.fromMe
 *   GET  /api/sessions/{session}                         → {name, status}
 * Autentikasi: header X-Api-Key (juga untuk URL media).
 */

export interface Incoming {
  id: string;
  chatId: string;
  from: string;
  ts: Date;
  text: string;
  hasImage: boolean;
  mediaUrl?: string;
  replyToId?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Menerima amplop webhook ({event, payload}) atau WAMessage polos. Null bila bukan pesan masuk yang bisa dipakai. */
export function parseIncoming(payload: unknown): Incoming | null {
  if (!isObj(payload)) return null;
  let msg: Obj = payload;
  if ("event" in payload && "payload" in payload) {
    if (payload.event !== "message" && payload.event !== "message.any") return null;
    if (!isObj(payload.payload)) return null;
    msg = payload.payload;
  }
  const id = str(msg.id);
  const chatId = str(msg.from);
  const timestamp = msg.timestamp;
  if (!id || !chatId || typeof timestamp !== "number") return null;
  if (msg.fromMe === true) return null;
  const media = isObj(msg.media) ? msg.media : undefined;
  const mime = str(media?.mimetype);
  const mediaUrl = str(media?.url);
  const replyToId = isObj(msg.replyTo) ? str(msg.replyTo.id) : undefined;
  const incoming: Incoming = {
    id,
    chatId,
    from: str(msg.participant) ?? chatId,
    ts: new Date(timestamp * 1000),
    text: str(msg.body) ?? "",
    hasImage: msg.hasMedia === true && (mime?.startsWith("image/") ?? false),
  };
  if (mediaUrl) incoming.mediaUrl = mediaUrl;
  if (replyToId) incoming.replyToId = replyToId;
  return incoming;
}

/**
 * Id pesan dari respons sendText. Kontrak WAHA: WAMessage {id: string}; PROVISIONAL (Task 0): mesin WEBJS
 * mengembalikan objek whatsapp-web.js {id: {_serialized}}, NOWEB proto Baileys {key: {id}}.
 */
function sentId(data: unknown): { id: string } | null {
  if (!isObj(data)) return null;
  const id = str(data.id) ?? (isObj(data.id) ? str(data.id._serialized) : undefined) ?? (isObj(data.key) ? str(data.key.id) : undefined);
  return id ? { id } : null;
}

/** Verifikasi X-Webhook-Hmac (HMAC-SHA512 hex dari body mentah). */
export function verifyWahaHmac(rawBody: Buffer | string, headerHex: string | undefined, key: string): boolean {
  if (!key || !headerHex || !/^[0-9a-f]{128}$/i.test(headerHex)) return false;
  const expected = createHmac("sha512", key).update(rawBody).digest();
  const given = Buffer.from(headerHex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export type FetchLike = typeof fetch;

export interface WahaOptions { baseUrl: string; apiKey: string; session: string; fetch?: FetchLike }

export class WahaClient {
  private readonly base: string;
  private readonly f: FetchLike;

  constructor(private readonly opts: WahaOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch;
  }

  private async call(method: string, endpoint: string, url: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { "X-Api-Key": this.opts.apiKey };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.f(url, { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new Error(`WAHA ${method} ${endpoint} gagal: HTTP ${res.status}`);
    return res;
  }

  /** Mengembalikan id pesan yang dibuat (untuk melacak balasan ke pesan bot), atau null bila respons tidak memuatnya. */
  async sendText(chatId: string, text: string, replyToId?: string, mentions?: string[]): Promise<{ id: string } | null> {
    const body: Obj = { session: this.opts.session, chatId, text };
    if (replyToId) body.reply_to = replyToId;
    if (mentions && mentions.length > 0) body.mentions = mentions;
    const res = await this.call("POST", "/api/sendText", `${this.base}/api/sendText`, body);
    return sentId(await res.json().catch(() => null));
  }

  /**
   * URL media dari WAHA memuat host internal (mis. http://localhost:3000); hanya path-nya dipakai dan
   * selalu diarahkan ke baseUrl, sehingga API key tidak pernah terkirim ke host lain.
   */
  async download(mediaUrl: string): Promise<{ buf: Buffer; mime: string }> {
    const u = new URL(mediaUrl, `${this.base}/`);
    const res = await this.call("GET", u.pathname, `${this.base}${u.pathname}${u.search}`);
    const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]?.trim() ?? "";
    return { buf: Buffer.from(await res.arrayBuffer()), mime };
  }

  /**
   * Menarik halaman 100 pesan sampai satu halaman berisi < 100. Urutan respons dibaca dari timestamp: menurun
   * (terbaru dulu) → halaman berikut memakai filter.timestamp.lte = timestamp terkecil; menaik → gte = terbesar.
   * Batas inklusif supaya pesan dengan detik sama tidak hilang; duplikat dibuang menurut id.
   */
  async messagesSince(chatId: string, since: Date): Promise<Incoming[]> {
    const endpoint = `/api/${this.opts.session}/chats/${chatId}/messages`;
    const dasar = `${this.base}/api/${encodeURIComponent(this.opts.session)}/chats/${encodeURIComponent(chatId)}/messages`;
    const gte0 = Math.floor(since.getTime() / 1000);
    const hasil = new Map<string, Incoming>();
    let gte = gte0;
    let lte: number | undefined;
    for (let halaman = 0; halaman < MAX_PAGES; halaman++) {
      const qs = new URLSearchParams({
        limit: String(PAGE_SIZE), downloadMedia: "true", "filter.timestamp.gte": String(gte), "filter.fromMe": "false",
      });
      if (lte !== undefined) qs.set("filter.timestamp.lte", String(lte));
      const data: unknown = await (await this.call("GET", endpoint, `${dasar}?${qs}`)).json();
      if (!Array.isArray(data)) break;
      const sebelum = hasil.size;
      for (const m of data) {
        const p = parseIncoming(m);
        if (p) hasil.set(p.id, p);
      }
      if (data.length < PAGE_SIZE) break;
      const ts = data.flatMap((m) => (isObj(m) && typeof m.timestamp === "number" ? [m.timestamp] : []));
      const pertama = ts[0];
      const terakhir = ts[ts.length - 1];
      if (pertama === undefined || terakhir === undefined || hasil.size === sebelum) break;
      if (pertama >= terakhir) lte = Math.min(...ts);
      else gte = Math.max(...ts);
    }
    return [...hasil.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }

  async sessionStatus(): Promise<string> {
    const endpoint = `/api/sessions/${this.opts.session}`;
    const data: unknown = await (await this.call("GET", endpoint, `${this.base}/api/sessions/${encodeURIComponent(this.opts.session)}`)).json();
    return isObj(data) && typeof data.status === "string" ? data.status : "UNKNOWN";
  }
}
