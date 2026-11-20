import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
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
  it("M2: media tanpa info / mimetype tak dikenal → gambar tanpa URL (diminta kirim ulang), bukan diabaikan", () => {
    const dasar = { id: "x", timestamp: 1, from: "a@g.us", hasMedia: true };
    for (const media of [undefined, { url: "u" }, { url: "u", mimetype: "" }, { url: "u", mimetype: "application/octet-stream" }]) {
      const m = parseIncoming({ ...dasar, ...(media ? { media } : {}) });
      expect(m?.hasImage, JSON.stringify(media)).toBe(true);
      expect(m?.mediaUrl, JSON.stringify(media)).toBeUndefined();
    }
    expect(parseIncoming({ ...dasar, media: { url: "u", mimetype: "video/mp4" } })?.hasImage).toBe(false);
    expect(parseIncoming({ ...dasar, media: { url: "u", mimetype: "image/png" } })).toMatchObject({ hasImage: true, mediaUrl: "u", mime: "image/png" });
    expect(parseIncoming({ ...dasar, hasMedia: false })?.hasImage).toBe(false);
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
    expect(verifyWahaHmac(body, hex, "")).toBe(false);
    expect(verifyWahaHmac(body, hex + "zz", "kunci")).toBe(false);
    expect(verifyWahaHmac(body, `${hex}00`, "kunci")).toBe(false);
    expect(verifyWahaHmac(body, hex.toUpperCase(), "kunci")).toBe(true);
    const kosongHex = createHmac("sha512", "").update(body).digest("hex");
    expect(verifyWahaHmac(body, kosongHex, "")).toBe(false);
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
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ session: "default", chatId: "1@g.us", text: "hai", reply_to: "m1", mentions: ["628@c.us"] });
    await client(f).sendText("1@g.us", "x");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ session: "default", chatId: "1@g.us", text: "x" });
  });
  it("sendText mengembalikan id pesan terkirim (WAMessage, WEBJS, NOWEB), null bila tidak ada", async () => {
    const kirim = async (body: string): Promise<{ id: string } | null> =>
      client(fake(() => new Response(body, { status: 201 })).f).sendText("1@g.us", "x");
    expect(await kirim(JSON.stringify({ id: "true_1@g.us_3EB0AA" }))).toEqual({ id: "true_1@g.us_3EB0AA" });
    expect(await kirim(JSON.stringify({ id: { fromMe: true, _serialized: "true_1@g.us_3EB0BB" } }))).toEqual({ id: "true_1@g.us_3EB0BB" });
    expect(await kirim(JSON.stringify({ key: { remoteJid: "1@g.us", fromMe: true, id: "3EB0CC" } }))).toEqual({ id: "3EB0CC" });
    expect(await kirim(JSON.stringify({}))).toBeNull();
    expect(await kirim("")).toBeNull();
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
    expect(Object.fromEntries(u.searchParams)).toEqual({ limit: "100", offset: "0", downloadMedia: "true", "filter.timestamp.gte": "50" });
    expect(r.map((m) => m.id)).toEqual(["b", "a"]);
  });
  /**
   * Server palsu: 230 pesan (ts 1..230), offset dihitung dari pesan terbaru (WAHA). `filter` = server menerapkan
   * filter.timestamp.gte sebelum limit; tanpa itu filter diabaikan (kasus terburuk). `urut` = urutan di dalam halaman.
   */
  function server230(urut: "menurun" | "menaik", filter: boolean) {
    const semua = Array.from({ length: 230 }, (_, k) => ({ id: `m${k + 1}`, timestamp: k + 1, from: "1@g.us", body: "x" }));
    return fake((c) => {
      const q = new URL(c.url).searchParams;
      const gte = Number(q.get("filter.timestamp.gte"));
      const terbaru = [...semua].reverse().filter((m) => !filter || m.timestamp >= gte);
      const off = Number(q.get("offset"));
      const halaman = terbaru.slice(off, off + Number(q.get("limit")));
      return json(urut === "menurun" ? halaman : halaman.reverse());
    });
  }
  const offsets = (calls: Call[]): number[] => calls.map((c) => Number(new URL(c.url).searchParams.get("offset")));

  it.each(["menurun", "menaik"] as const)("messagesSince: 230 pesan, urutan %s, filter diabaikan server → paging offset, saring lokal", async (urut) => {
    const { f, calls } = server230(urut, false);
    const r = await client(f).messagesSince("1@g.us", new Date(50_000));
    expect(offsets(calls)).toEqual([0, 100]); // halaman 2 memuat pesan < since → berhenti
    expect(r.map((m) => m.ts.getTime() / 1000)).toEqual(Array.from({ length: 181 }, (_, k) => k + 50));
  });

  it.each(["menurun", "menaik"] as const)("messagesSince: 230 pesan, urutan %s, since 0 → berhenti di halaman pendek", async (urut) => {
    const { f, calls } = server230(urut, false);
    const r = await client(f).messagesSince("1@g.us", new Date(0));
    expect(offsets(calls)).toEqual([0, 100, 200]);
    expect(r).toHaveLength(230);
    expect(r[0]?.id).toBe("m1");
    expect(r.at(-1)?.id).toBe("m230");
  });

  it.each(["menurun", "menaik"] as const)("messagesSince: 230 pesan, urutan %s, server menerapkan filter → sama", async (urut) => {
    const { f, calls } = server230(urut, true);
    const r = await client(f).messagesSince("1@g.us", new Date(50_000));
    expect(offsets(calls)).toEqual([0, 100]);
    expect(r).toHaveLength(181);
  });

  it("messagesSince: pesan bot sendiri (fromMe) tidak dipakai, tapi tetap menggeser offset", async () => {
    const page = Array.from({ length: 100 }, (_, k) => ({ id: `m${k}`, timestamp: 1000 - k, from: "1@g.us", fromMe: k % 2 === 0 }));
    let n = 0;
    const { f, calls } = fake(() => json(n++ === 0 ? page : []));
    const r = await client(f).messagesSince("1@g.us", new Date(0));
    expect(offsets(calls)).toEqual([0, 100]);
    expect(r).toHaveLength(50);
    expect(new URL(calls[0]!.url).searchParams.has("filter.fromMe")).toBe(false);
  });

  it("messagesSince: paling banyak 50 halaman", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const { f, calls } = fake(() => json(Array.from({ length: 100 }, () => ({ id: `m${n++}`, timestamp: 5000, from: "1@g.us" }))));
    const r = await client(f).messagesSince("1@g.us", new Date(0));
    expect(calls).toHaveLength(50);
    expect(r).toHaveLength(5000);
  });

  it("messageById: tautan media segar untuk satu pesan", async () => {
    const { f, calls } = fake(() => json({
      id: "false_1@g.us_3EB0AA_628@c.us", timestamp: 10, from: "1@g.us", body: "Brando", hasMedia: true,
      media: { url: "http://localhost:3000/api/files/baru.jpg", mimetype: "image/jpeg" },
    }));
    const m = await client(f).messageById("1@g.us", "false_1@g.us_3EB0AA_628@c.us");
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/api/default/chats/1%40g.us/messages/false_1%40g.us_3EB0AA_628%40c.us");
    expect(u.searchParams.get("downloadMedia")).toBe("true");
    expect((calls[0]?.init.headers as Record<string, string>)["X-Api-Key"]).toBe("RAHASIA");
    expect(m).toMatchObject({ mediaUrl: "http://localhost:3000/api/files/baru.jpg", mime: "image/jpeg", hasImage: true });
  });
  it("sessionStatus", async () => {
    const { f, calls } = fake(() => json({ name: "default", status: "WORKING" }));
    expect(await client(f).sessionStatus()).toBe("WORKING");
    expect(calls[0]?.url).toBe("http://waha:3000/api/sessions/default");
  });
});
