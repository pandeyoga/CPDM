import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { google } from "googleapis";

/**
 * Sekali jalan: mendapatkan refresh token Google (alur "installed app", redirect loopback).
 * Pakai: GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node dist/scripts/google-auth.js
 * Hanya refresh token yang dicetak ke stdout; simpan sebagai GOOGLE_REFRESH_TOKEN.
 */
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.file"];

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET wajib diisi");
  process.exit(1);
}

const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const redirectUri = `http://127.0.0.1:${port}`;
const state = randomBytes(16).toString("hex");
const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state });
console.error(`Buka tautan ini di browser dan setujui akses:\n${url}\n`);

const code = await new Promise<string>((resolve, reject) => {
  server.on("request", (req, res) => {
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
server.close();

const { tokens } = await oauth.getToken(code);
if (!tokens.refresh_token) {
  console.error("Google tidak mengembalikan refresh token. Cabut akses aplikasi di akun Google lalu ulangi.");
  process.exit(1);
}
console.log(tokens.refresh_token);
