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

/**
 * Murni: { status: "belum_aktif" | "sehat" | "masalah", alasan }.
 * lastSeen kosong = bot belum pernah jalan ("belum_aktif": tidak ada email).
 */
function nilaiMasalah_(lastSeen, waStatus, sekarang) {
  if (lastSeen === "" || lastSeen === null || lastSeen === undefined) return { status: "belum_aktif", alasan: "" };
  var waktu = lastSeen instanceof Date ? lastSeen : new Date(String(lastSeen));
  if (isNaN(waktu.getTime())) return { status: "masalah", alasan: "Waktu detak tidak terbaca: " + lastSeen };
  var menit = Math.floor((sekarang.getTime() - waktu.getTime()) / 60000);
  if (menit > BATAS_MENIT) return { status: "masalah", alasan: "Detak terakhir " + menit + " menit lalu (batas " + BATAS_MENIT + " menit)." };
  if (String(waStatus).trim() !== "WORKING") {
    return { status: "masalah", alasan: "Status WhatsApp: " + (waStatus || "(kosong)") + " (seharusnya WORKING)." };
  }
  return { status: "sehat", alasan: "" };
}

function emailOwner_(sheet) {
  var baris = sheet.getRange("A1:B60").getValues();
  for (var i = 0; i < baris.length; i++) {
    if (String(baris[i][0]).trim() === "Email owner") return String(baris[i][1]).trim();
  }
  return "";
}

function cekDetak() {
  try {
    var ss = SpreadsheetApp.getActive();
    var tabHb = ss.getSheetByName("Heartbeat");
    var tabPeng = ss.getSheetByName("Pengaturan");
    if (!tabHb || !tabPeng) { Logger.log("Tab Heartbeat atau Pengaturan tidak ditemukan"); return; }
    var email = emailOwner_(tabPeng);
    if (!email) { Logger.log("Email owner belum diisi di Pengaturan; tidak ada email dikirim"); return; }
    var hb = tabHb.getRange("A2:B2").getValues()[0];
    var hasil = nilaiMasalah_(hb[0], hb[1], new Date());
    if (hasil.status === "belum_aktif") return;
    var props = PropertiesService.getScriptProperties();
    var sudahKirim = props.getProperty(KUNCI_KEJADIAN);

    if (hasil.status === "masalah" && !sudahKirim) {
      MailApp.sendEmail(email, "[CP Live] Bot bermasalah", hasil.alasan + "\nCek VPS: docker compose ps dan log bot.");
      props.setProperty(KUNCI_KEJADIAN, new Date().toISOString());
    } else if (hasil.status === "sehat" && sudahKirim) {
      MailApp.sendEmail(email, "[CP Live] Bot pulih", "Detak bot normal lagi dan WhatsApp berstatus WORKING.");
      props.deleteProperty(KUNCI_KEJADIAN);
    }
  } catch (e) {
    Logger.log("cekDetak gagal: " + e);
  }
}

/** Jalankan sekali: pasang pemicu waktu setiap 10 menit (tidak menggandakan pemicu lama). */
function pasangPemicu() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "cekDetak") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("cekDetak").timeBased().everyMinutes(10).create();
}
