import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server.js";
import type { Incoming } from "../src/infra/waha.js";

const KEY = "kunci-hmac-uji";
const body = readFileSync(new URL("./fixtures/waha/group-image-caption.provisional.json", import.meta.url), "utf8");
const hmac = (b: string, key = KEY): string => createHmac("sha512", key).update(b).digest("hex");

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.close();
    await once(s, "close");
  }
});

async function mulai() {
  const diterima: Incoming[] = [];
  const terima = vi.fn(async (m: Incoming) => { diterima.push(m); });
  const server = createApp({ hmacKey: KEY, terima, waStatus: () => "WORKING" }).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const kirim = (b: string, header?: string) =>
    fetch(`${url}/webhook/waha`, {
      method: "POST", body: b,
      headers: { "Content-Type": "application/json", ...(header === undefined ? {} : { "X-Webhook-Hmac": header }) },
    });
  return { url, terima, diterima, kirim };
}

describe("POST /webhook/waha", () => {
  it("HMAC salah atau tidak ada → 401, tidak diproses", async () => {
    const s = await mulai();
    expect((await s.kirim(body, hmac(body, "kunci-lain"))).status).toBe(401);
    expect((await s.kirim(body)).status).toBe(401);
    expect((await s.kirim(`${body} `, hmac(body))).status).toBe(401); // body diubah
    expect(s.terima).not.toHaveBeenCalled();
  });

  it("HMAC benar atas body mentah → 200 lalu pesan diteruskan ke antrean", async () => {
    const s = await mulai();
    const res = await s.kirim(body, hmac(body));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(s.terima).toHaveBeenCalledOnce());
    expect(s.diterima[0]).toMatchObject({
      id: "false_120363000000000000@g.us_3EB0AAAA1111_628111111111@c.us", text: "Brando", hasImage: true,
    });
  });

  it("event lain atau body bukan JSON → 200 tanpa diproses", async () => {
    const s = await mulai();
    const status = JSON.stringify({ event: "session.status", payload: { status: "WORKING" } });
    expect((await s.kirim(status, hmac(status))).status).toBe(200);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await s.kirim("bukan json", hmac("bukan json"))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.terima).not.toHaveBeenCalled();
  });
});

describe("GET /health", () => {
  it("200 {ok, waStatus}", async () => {
    const s = await mulai();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, waStatus: "WORKING" });
  });
});

describe("Dockerfile (M11)", () => {
  it("HEALTHCHECK memanggil GET /health di port PORT", () => {
    const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const baris = docker.split("\n").filter((b) => /^HEALTHCHECK\b/.test(b) || /^\s+CMD\b/.test(b)).join(" ");
    expect(baris).toMatch(/^HEALTHCHECK /);
    expect(baris).toContain("/health");
    expect(baris).toContain("process.env.PORT");
  });
});
