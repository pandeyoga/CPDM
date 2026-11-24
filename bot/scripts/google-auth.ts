import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { google } from "googleapis";
import { parseAuthInput } from "./google-auth-input.js";

/**
 * Sekali jalan: mendapatkan refresh token Google (alur "installed app", redirect loopback).
 * Pakai: GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node dist/scripts/google-auth.js
 * Hanya refresh token yang dicetak ke stdout; simpan sebagai GOOGLE_REFRESH_TOKEN.
 * Mode `--manual` (server tanpa browser): cetak tautan, lalu baca SATU baris dari stdin berisi alamat lengkap
 * tempat browser berhenti (halamannya tidak akan terbuka, itu wajar) atau kodenya saja. stdout hanya
 * `GOOGLE_REFRESH_TOKEN=<token>`; semua petunjuk lewat stderr.
 */
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.file"];

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET wajib diisi");
  process.exit(1);
}

const manual = process.argv.includes("--manual");
const state = randomBytes(16).toString("hex");
let redirectUri: string;
let server: ReturnType<typeof createServer> | undefined;
if (manual) {
  // Tidak ada server yang mendengarkan: browser akan gagal membuka halaman, tetapi alamatnya memuat kode.
  redirectUri = `http://127.0.0.1:${20000 + Math.floor(Math.random() * 40000)}`;
} else {
  server = createServer();
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state });

async function kodeDariLoopback(): Promise<string> {
  console.error(`Buka tautan ini di browser dan setujui akses:\n${url}\n`);
  return new Promise<string>((resolve, reject) => {
    server!.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      if (u.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.end("State tidak cocok.");
        return;
      }
      const kode = u.searchParams.get("code");
      const galat = u.searchParams.get("error");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      if (kode) {
        res.end("Selesai. Kembali ke terminal; jendela ini boleh ditutup.");
        resolve(kode);
      } else {
        res.statusCode = galat ? 400 : 404;
        res.end(galat ? "Akses ditolak." : "Tidak ditemukan.");
        if (galat) reject(new Error(`Otorisasi ditolak: ${galat}`));
      }
    });
  });
}

async function kodeManual(): Promise<string> {
  console.error(
    "1) Buka tautan ini di browser (di HP/laptop Anda), pilih akun Google, lalu klik Izinkan:\n\n" +
      `${url}\n\n` +
      "2) Setelah itu browser menampilkan halaman ERROR / 'tidak dapat dijangkau'. Itu WAJAR.\n" +
      "   Salin SELURUH alamat di kolom alamat browser (diawali http://127.0.0.1:...) lalu tempel di bawah.\n",
  );
  process.stderr.write("Tempel alamat lalu tekan Enter: ");
  const rl = createInterface({ input: process.stdin });
  const baris = await new Promise<string>((resolve) => {
    rl.once("line", resolve);
    rl.once("close", () => resolve(""));
  });
  rl.close();
  const hasil = parseAuthInput(baris, state);
  if (!hasil.ok) {
    console.error(`\n${hasil.reason}`);
    process.exit(1);
  }
  return hasil.code;
}

const code = manual ? await kodeManual() : await kodeDariLoopback();
server?.close();

const { tokens } = await oauth.getToken(code);
if (!tokens.refresh_token) {
  console.error("Google tidak mengembalikan refresh token. Cabut akses aplikasi di akun Google lalu ulangi.");
  process.exit(1);
}
console.log(manual ? `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}` : tokens.refresh_token);
