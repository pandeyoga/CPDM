import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIncoming, verifyWahaHmac, WahaClient } from "../src/infra/waha.js";

const fx = (n: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/waha/${n}.provisional.json`, import.meta.url), "utf8"));

describe("parseIncoming", () => {
  it("foto bercaption", () => {
    const m = parseIncoming(fx("group-image-caption"));
    expect(m).toMatchObject({ chatId: "120363000000000000@g.us", from: "628111111111@c.us", text: "Brando", hasImage: true });
    expect(m?.mediaUrl).toContain("/api/files/");
    expect(m?.ts.toISOString()).toBe("2025-11-20T07:02:00.000Z");
  });
  it("teks", () => {
    const m = parseIncoming(fx("group-text"));
    expect(m).toMatchObject({ hasImage: false, text: "Brando sesi 2" });
    expect(m?.mediaUrl).toBeUndefined();
  });
  it("balasan membawa replyToId", () => {
    expect(parseIncoming(fx("group-reply"))?.replyToId).toBe("true_120363000000000000@g.us_3EB0DDDD4444");
  });
  it("WAMessage polos dan chat lain tetap diparsing; direct memakai from", () => {
    const m = parseIncoming({ id: "x", timestamp: 1, from: "628333@c.us", body: "halo", hasMedia: false, fromMe: false });
    expect(m).toMatchObject({ chatId: "628333@c.us", from: "628333@c.us" });
    const env = fx("group-text") as { payload: { from: string } };
    env.payload.from = "999@g.us";
    expect(parseIncoming(env)?.chatId).toBe("999@g.us");
  });
  it("abaikan fromMe, event lain, sampah, dan media non-gambar", () => {
    expect(parseIncoming({ id: "x", timestamp: 1, from: "a@c.us", fromMe: true })).toBeNull();
    expect(parseIncoming(fx("session-status"))).toBeNull();
    expect(parseIncoming(null)).toBeNull();
    expect(parseIncoming({ foo: 1 })).toBeNull();
    const pdf = parseIncoming({ id: "x", timestamp: 1, from: "a@g.us", hasMedia: true, media: { mimetype: "application/pdf", url: "u" } });
    expect(pdf?.hasImage).toBe(false);
  });
});

describe("verifyWahaHmac", () => {
  const body = '{"a":1}';
  const hex = createHmac("sha512", "kunci").update(body).digest("hex");
  it("valid, salah, kosong", () => {
    expect(verifyWahaHmac(body, hex, "kunci")).toBe(true);
    expect(verifyWahaHmac(Buffer.from(body), hex, "kunci")).toBe(true);
    expect(verifyWahaHmac(body, hex, "lain")).toBe(false);
    expect(verifyWahaHmac(body + " ", hex, "kunci")).toBe(false);
    expect(verifyWahaHmac(body, undefined, "kunci")).toBe(false);
    expect(verifyWahaHmac(body, "zz", "kunci")).toBe(false);
  });
});

interface Call { url: string; init: RequestInit }
function fake(respond: (c: Call) => Response): { f: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    return respond(c);
  }) as typeof fetch;
  return { f, calls };
}
const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status });
const client = (f: typeof fetch): WahaClient => new WahaClient({ baseUrl: "http://waha:3000/", apiKey: "RAHASIA", session: "default", fetch: f });

describe("WahaClient", () => {
  it("sendText", async () => {
    const { f, calls } = fake(() => json({}));
    await client(f).sendText("1@g.us", "hai", "m1", ["628@c.us"]);
    expect(calls[0]?.url).toBe("http://waha:3000/api/sendText");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["X-Api-Key"]).toBe("RAHASIA");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ session: "default", chatId: "1@g.us", text: "hai", reply_to: "m1", mentions: ["628@c.us"] });
    await client(f).sendText("1@g.us", "x");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ session: "default", chatId: "1@g.us", text: "x" });
  });
  it("non-2xx melempar error tanpa API key", async () => {
    const { f } = fake(() => json({}, 500));
    const err = await client(f).sendText("1@g.us", "x").catch((e: Error) => e);
    expect((err as Error).message).toContain("/api/sendText");
    expect((err as Error).message).toContain("500");
    expect((err as Error).message).not.toContain("RAHASIA");
  });
  it("download mengarahkan ke baseUrl dengan header", async () => {
    const { f, calls } = fake(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg; charset=x" } }));
    const r = await client(f).download("http://localhost:3000/api/files/a.jpg");
    expect(calls[0]?.url).toBe("http://waha:3000/api/files/a.jpg");
    expect((calls[0]?.init.headers as Record<string, string>)["X-Api-Key"]).toBe("RAHASIA");
    expect(r.mime).toBe("image/jpeg");
    expect([...r.buf]).toEqual([1, 2, 3]);
  });
  it("messagesSince: query, filter, urut ts", async () => {
    const a = { id: "a", timestamp: 200, from: "1@g.us", body: "b" };
    const b = { id: "b", timestamp: 100, from: "1@g.us", body: "a" };
    const { f, calls } = fake(() => json([a, { bukan: "pesan" }, b]));
    const r = await client(f).messagesSince("1@g.us", new Date(50_900));
    const u = new URL(calls[0]?.url ?? "");
    expect(u.pathname).toBe("/api/default/chats/1%40g.us/messages");
    expect(Object.fromEntries(u.searchParams)).toEqual({ limit: "100", downloadMedia: "true", "filter.timestamp.gte": "50", "filter.fromMe": "false" });
    expect(r.map((m) => m.id)).toEqual(["b", "a"]);
  });
  it("sessionStatus", async () => {
    const { f, calls } = fake(() => json({ name: "default", status: "WORKING" }));
    expect(await client(f).sessionStatus()).toBe("WORKING");
    expect(calls[0]?.url).toBe("http://waha:3000/api/sessions/default");
  });
});
