import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cariBukti, deteksiMime, pilihMime, simpanBukti, unduhBukti } from "../src/app/bukti.js";
import type { Incoming } from "../src/infra/waha.js";

const dirs: string[] = [];
const folder = (): string => {
  const d = mkdtempSync(join(tmpdir(), "bukti-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const GIF = Buffer.from("GIF89a....");

describe("M3: MIME gambar untuk ekstraktor", () => {
  it("deteksi magic bytes JPEG/PNG/WEBP/GIF; selain itu null", () => {
    expect(deteksiMime(JPEG)).toBe("image/jpeg");
    expect(deteksiMime(PNG)).toBe("image/png");
    expect(deteksiMime(WEBP)).toBe("image/webp");
    expect(deteksiMime(GIF)).toBe("image/gif");
    expect(deteksiMime(Buffer.from("bukan gambar"))).toBeNull();
    expect(deteksiMime(Buffer.alloc(0))).toBeNull();
  });

  it("utamakan media.mimetype yang didukung; selain itu magic bytes; tidak pernah application/octet-stream", () => {
    expect(pilihMime("image/png", JPEG)).toBe("image/png");
    expect(pilihMime(undefined, JPEG)).toBe("image/jpeg");
    expect(pilihMime("application/octet-stream", PNG)).toBe("image/png");
    expect(pilihMime("image/heic", WEBP)).toBe("image/webp");
    expect(pilihMime(undefined, Buffer.from("x"))).toBeNull();
    expect(pilihMime("application/octet-stream", Buffer.from("x"))).toBeNull();
  });

  it("simpanBukti menamai berkas menurut MIME; cariBukti menemukannya lagi (juga setelah restart)", () => {
    const dir = folder();
    const id = "false_1@g.us_3EB0AA_628@c.us";
    const b = simpanBukti(dir, id, PNG, "image/png");
    expect(b).toEqual({ path: join(dir, "bukti", "false_1@g.us_3EB0AA_628@c.us.png"), mime: "image/png" });
    expect(readFileSync(b.path)).toEqual(PNG);
    expect(cariBukti(dir, id)).toEqual(b);
    expect(cariBukti(dir, "lain")).toBeNull();
    const tak = simpanBukti(dir, "x", Buffer.from("?"), null);
    expect(tak).toEqual({ path: join(dir, "bukti", "x.bin"), mime: "" });
    expect(cariBukti(dir, "x")).toEqual(tak);
  });
});

describe("I1: unduhBukti", () => {
  const sumber = { messageId: "M1", chatId: "1@g.us", mediaUrl: "http://localhost:3000/api/files/lama.jpg", mimeMedia: "image/jpeg" };

  it("unduh dan simpan; MIME dari media.mimetype", async () => {
    const dir = folder();
    const waha = {
      download: vi.fn(async () => ({ buf: JPEG, mime: "application/octet-stream" })),
      messageById: vi.fn(),
    };
    const b = await unduhBukti(waha, dir, sumber);
    expect(b).toEqual({ path: join(dir, "bukti", "M1.jpg"), mime: "image/jpeg", mediaUrl: sumber.mediaUrl });
    expect(existsSync(b.path)).toBe(true);
    expect(waha.messageById).not.toHaveBeenCalled();
  });

  it("tautan kedaluwarsa → pesan diambil ulang menurut id (tautan segar) lalu diunduh", async () => {
    const dir = folder();
    const segar: Incoming = {
      id: "M1", chatId: "1@g.us", from: "x", ts: new Date(0), text: "", hasImage: true,
      mediaUrl: "http://localhost:3000/api/files/baru.jpg", mime: "image/jpeg",
    };
    const waha = {
      download: vi.fn(async (url: string) => {
        if (url.endsWith("lama.jpg")) throw new Error("WAHA GET /api/files/lama.jpg gagal: HTTP 404");
        return { buf: JPEG, mime: "image/jpeg" };
      }),
      messageById: vi.fn(async () => segar),
    };
    const b = await unduhBukti(waha, dir, sumber);
    expect(waha.messageById).toHaveBeenCalledWith("1@g.us", "M1");
    expect(b.mediaUrl).toBe(segar.mediaUrl);
    expect(existsSync(b.path)).toBe(true);
  });

  it("ambil ulang gagal / tanpa tautan → error unduhan asli dilempar", async () => {
    const dir = folder();
    const gagal = async (): Promise<never> => { throw new Error("HTTP 404 lama"); };
    await expect(unduhBukti({ download: gagal, messageById: async () => null }, dir, sumber)).rejects.toThrow("HTTP 404 lama");
    await expect(unduhBukti({ download: gagal, messageById: async () => { throw new Error("502"); } }, dir, sumber))
      .rejects.toThrow("HTTP 404 lama");
  });
});
