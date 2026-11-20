/**
 * Pemeriksa detak bot CP – Live Tracker.
 *
 * Pasang (sekali, oleh owner):
 *  1. Buka spreadsheet "CP – Live Tracker" > Ekstensi > Apps Script, tempel isi berkas ini.
 *  2. Jalankan fungsi pasangPemicu() satu kali dan setujui izinnya (Spreadsheet, Gmail kirim, Properti).
 *     Ini membuat pemicu waktu cekDetak() setiap 10 menit. (Manual: Pemicu > Tambah pemicu > cekDetak > Berbasis waktu > 10 menit.)
 *
 * Perilaku: membaca tab Heartbeat (A2 = waktu terakhir ISO, B2 = status WA) dan "Email owner" di Pengaturan.
 * Kalau sekarang - waktu terakhir > 10 menit, atau status WA bukan "WORKING", kirim email SATU KALI per kejadian
 * (penanda di PropertiesService). Saat kondisi pulih kirim email "pulih" dan hapus penanda.
 * Hanya memakai SpreadsheetApp, MailApp, PropertiesService, ScriptApp. Tanpa rahasia.
 */
var BATAS_MENIT = 10;
var KUNCI_KEJADIAN = "kejadianDetak";

/** Murni: kembalikan alasan masalah (teks) atau "" kalau sehat. */
function nilaiMasalah_(lastSeen, waStatus, sekarang) {
  var waktu = lastSeen instanceof Date ? lastSeen : new Date(String(lastSeen));
  if (!lastSeen || isNaN(waktu.getTime())) return "Detak bot belum pernah tercatat.";
  var menit = Math.floor((sekarang.getTime() - waktu.getTime()) / 60000);
  if (menit > BATAS_MENIT) return "Detak terakhir " + menit + " menit lalu (batas " + BATAS_MENIT + " menit).";
  if (String(waStatus).trim() !== "WORKING") return "Status WhatsApp: " + (waStatus || "(kosong)") + " (seharusnya WORKING).";
  return "";
}

function emailOwner_(ss) {
  var baris = ss.getSheetByName("Pengaturan").getRange("A1:B60").getValues();
  for (var i = 0; i < baris.length; i++) {
    if (String(baris[i][0]).trim() === "Email owner") return String(baris[i][1]).trim();
  }
  return "";
}

function cekDetak() {
  var ss = SpreadsheetApp.getActive();
  var hb = ss.getSheetByName("Heartbeat").getRange("A2:B2").getValues()[0];
  var email = emailOwner_(ss);
  if (!email) return; // belum ada alamat tujuan
  var props = PropertiesService.getScriptProperties();
  var masalah = nilaiMasalah_(hb[0], hb[1], new Date());
  var sudahKirim = props.getProperty(KUNCI_KEJADIAN);

  if (masalah && !sudahKirim) {
    MailApp.sendEmail(email, "[CP Live] Bot bermasalah", masalah + "\nCek VPS: docker compose ps dan log bot.");
    props.setProperty(KUNCI_KEJADIAN, new Date().toISOString());
  } else if (!masalah && sudahKirim) {
    MailApp.sendEmail(email, "[CP Live] Bot pulih", "Detak bot normal lagi dan WhatsApp berstatus WORKING.");
    props.deleteProperty(KUNCI_KEJADIAN);
  }
}

/** Jalankan sekali: pasang pemicu waktu setiap 10 menit (tidak menggandakan pemicu lama). */
function pasangPemicu() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "cekDetak") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("cekDetak").timeBased().everyMinutes(10).create();
}
