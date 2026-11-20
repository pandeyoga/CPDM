import { pathToFileURL } from "node:url";
import type { drive_v3, sheets_v4 } from "googleapis";
import { klienGoogle, PENGATURAN_KEYS, PENGATURAN_KEY_ORDER, TAB } from "../src/infra/sheets.js";
import {
  formatRequests, namedRangeRequests, protectionRequests, resolveSheetIds, sheetBlueprint, spreadsheetPropsRequest,
  tabCellsTerpisah, tabRequests, validationRequests, valueRanges, LOCALE, ZONA_WAKTU, type CellValue, type TabBlueprint,
} from "../src/infra/sheetBlueprint.js";

/**
 * Membuat (atau memperbarui, idempoten) spreadsheet "CP – Live Tracker" dan folder Drive "Bukti Live".
 *
 * Pakai: GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_REFRESH_TOKEN=… node dist/scripts/setup-sheet.js
 * Opsional: LIVE_SPREADSHEET_ID (perbarui spreadsheet yang ada), BUKTI_FOLDER_ID (pakai folder yang ada),
 * OWNER_EMAIL (kalau tidak diisi, diambil dari akun Google yang masuk).
 * Hanya id yang dicetak ke stdout (LIVE_SPREADSHEET_ID, BUKTI_FOLDER_ID); token tidak pernah dicetak.
 * Isian owner (filter, Pengaturan) tidak pernah ditimpa: nilai bawaan hanya ditulis ke sel yang kosong.
 */

const FOLDER_NAMA = "Bukti Live";
const JUDUL = "CP – Live Tracker";

const kutip = (t: string): string => `'${t}'`;

async function bacaSel(sheets: sheets_v4.Sheets, id: string, bp: TabBlueprint[]): Promise<Map<string, CellValue>> {
  const ranges = bp.flatMap((t) => Object.keys(t.defaults ?? {}).map((a1) => `${kutip(t.title)}!${a1}`));
  const hasil = new Map<string, CellValue>();
  if (ranges.length === 0) return hasil;
  const res = await sheets.spreadsheets.values.batchGet({ spreadsheetId: id, ranges, valueRenderOption: "UNFORMATTED_VALUE" });
  (res.data.valueRanges ?? []).forEach((vr, i) => {
    const v = vr.values?.[0]?.[0];
    if (v !== undefined && v !== "") hasil.set(ranges[i]!, v as CellValue);
  });
  return hasil;
}

export async function setupSheet(
  sheets: sheets_v4.Sheets, drive: drive_v3.Drive,
  env: { spreadsheetId?: string; buktiFolderId?: string; ownerEmail?: string },
): Promise<{ spreadsheetId: string; buktiFolderId: string }> {
  const bp = sheetBlueprint();
  // Editor proteksi selalu akun OAuth (yang dipakai bot menulis) ditambah OWNER_EMAIL bila berbeda.
  const akun = (await drive.about.get({ fields: "user(emailAddress)" })).data.user?.emailAddress;
  if (!akun) throw new Error("Email akun Google tidak terbaca dari Drive");
  const editors = [akun, ...(env.ownerEmail && env.ownerEmail !== akun ? [env.ownerEmail] : [])];
  const email = env.ownerEmail ?? akun;

  let id = env.spreadsheetId;
  if (!id) {
    const baru = await sheets.spreadsheets.create({
      requestBody: { properties: { title: JUDUL, timeZone: ZONA_WAKTU, locale: LOCALE }, sheets: bp.map((t) => ({ properties: { title: t.title } })) },
    });
    id = baru.data.spreadsheetId ?? undefined;
    if (!id) throw new Error("Sheets tidak mengembalikan spreadsheetId");
  }

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: id,
    fields: "sheets(properties(sheetId,title),protectedRanges(protectedRangeId,description)),namedRanges(name,namedRangeId)",
  });
  const ada = new Map((meta.data.sheets ?? []).map((s) => [s.properties!.title!, s.properties!.sheetId!] as const));
  const ids = resolveSheetIds(bp, ada);
  const protectedLama = (meta.data.sheets ?? []).flatMap((s) =>
    (s.protectedRanges ?? []).map((p) => ({ protectedRangeId: p.protectedRangeId!, description: p.description })));
  const namedLama = (meta.data.namedRanges ?? []).map((n) => ({ name: n.name!, namedRangeId: n.namedRangeId! }));

  const requests: sheets_v4.Schema$Request[] = [
    spreadsheetPropsRequest(),
    ...tabRequests(bp, ids, new Set(ada.keys())),
    ...namedRangeRequests(ids, namedLama),
    ...validationRequests(bp, ids),
    ...formatRequests(bp, ids),
    ...protectionRequests(bp, ids, editors, protectedLama),
  ];
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests } });

  // Isi: header, label, rumus selalu ditulis ulang; nilai bawaan hanya ke sel kosong.
  const terisi = await bacaSel(sheets, id, bp);
  const statik: sheets_v4.Schema$ValueRange[] = [];
  const data: sheets_v4.Schema$ValueRange[] = [];
  for (const t of bp) {
    const sel = tabCellsTerpisah(t);
    statik.push(...valueRanges(t.title, sel.statik));
    data.push(...valueRanges(t.title, sel.rumus));
    const kosong = new Map<string, CellValue>();
    for (const [a1, v] of Object.entries(t.defaults ?? {})) if (!terisi.has(`${kutip(t.title)}!${a1}`)) kosong.set(a1, v);
    const emailSel = `B${PENGATURAN_KEY_ORDER.indexOf(PENGATURAN_KEYS.ownerEmail) + 2}`;
    if (t.title === TAB.pengaturan && !terisi.has(`${kutip(t.title)}!${emailSel}`)) kosong.set(emailSel, email);
    data.push(...valueRanges(t.title, kosong));
  }
  // Header/label statis RAW ("+Omzet" tidak boleh dibaca sebagai rumus); rumus dan nilai bawaan USER_ENTERED.
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: id, requestBody: { valueInputOption: "RAW", data: statik } });
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: id, requestBody: { valueInputOption: "USER_ENTERED", data } });

  const buktiFolderId = env.buktiFolderId ?? (await pastikanFolder(drive));
  return { spreadsheetId: id, buktiFolderId };
}

/** Folder dibuat oleh OAuth client yang sama (scope drive.file), supaya bot bisa menulis ke dalamnya. */
async function pastikanFolder(drive: drive_v3.Drive): Promise<string> {
  const q = `name='${FOLDER_NAMA}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const ada = await drive.files.list({ q, fields: "files(id)", pageSize: 1 });
  const id = ada.data.files?.[0]?.id;
  if (id) return id;
  const baru = await drive.files.create({ requestBody: { name: FOLDER_NAMA, mimeType: "application/vnd.google-apps.folder" }, fields: "id" });
  if (!baru.data.id) throw new Error("Drive tidak mengembalikan id folder");
  return baru.data.id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const e = process.env;
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET || !e.GOOGLE_REFRESH_TOKEN) {
    console.error("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, dan GOOGLE_REFRESH_TOKEN wajib diisi");
    process.exit(1);
  }
  const { sheets, drive } = klienGoogle({ clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, refreshToken: e.GOOGLE_REFRESH_TOKEN });
  const hasil = await setupSheet(sheets, drive, {
    ...(e.LIVE_SPREADSHEET_ID ? { spreadsheetId: e.LIVE_SPREADSHEET_ID } : {}),
    ...(e.BUKTI_FOLDER_ID ? { buktiFolderId: e.BUKTI_FOLDER_ID } : {}),
    ...(e.OWNER_EMAIL ? { ownerEmail: e.OWNER_EMAIL } : {}),
  });
  console.log(`LIVE_SPREADSHEET_ID=${hasil.spreadsheetId}`);
  console.log(`BUKTI_FOLDER_ID=${hasil.buktiFolderId}`);
}
