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

/** Verifikasi X-Webhook-Hmac (HMAC-SHA512 hex dari body mentah). */
export function verifyWahaHmac(rawBody: Buffer | string, headerHex: string | undefined, key: string): boolean {
  if (!headerHex) return false;
  const expected = createHmac("sha512", key).update(rawBody).digest();
  const given = Buffer.from(headerHex.trim(), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

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
    const res = await this.f(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new Error(`WAHA ${method} ${endpoint} gagal: HTTP ${res.status}`);
    return res;
  }

  async sendText(chatId: string, text: string, replyToId?: string, mentions?: string[]): Promise<void> {
    const body: Obj = { session: this.opts.session, chatId, text };
    if (replyToId) body.reply_to = replyToId;
    if (mentions && mentions.length > 0) body.mentions = mentions;
    await this.call("POST", "/api/sendText", `${this.base}/api/sendText`, body);
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

  async messagesSince(chatId: string, since: Date): Promise<Incoming[]> {
    const endpoint = `/api/${this.opts.session}/chats/${chatId}/messages`;
    const qs = new URLSearchParams({
      limit: "100",
      downloadMedia: "true",
      "filter.timestamp.gte": String(Math.floor(since.getTime() / 1000)),
      "filter.fromMe": "false",
    });
    const url = `${this.base}/api/${encodeURIComponent(this.opts.session)}/chats/${encodeURIComponent(chatId)}/messages?${qs}`;
    const data: unknown = await (await this.call("GET", endpoint, url)).json();
    if (!Array.isArray(data)) return [];
    return data
      .map(parseIncoming)
      .filter((m): m is Incoming => m !== null)
      .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }

  async sessionStatus(): Promise<string> {
    const endpoint = `/api/sessions/${this.opts.session}`;
    const data: unknown = await (await this.call("GET", endpoint, `${this.base}/api/sessions/${encodeURIComponent(this.opts.session)}`)).json();
    return isObj(data) && typeof data.status === "string" ? data.status : "UNKNOWN";
  }
}
