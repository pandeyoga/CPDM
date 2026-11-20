import { describe, it, expect } from "vitest";
import { matchCaption, parseCommand, parseKoreksi } from "../src/domain/caption.js";

const hosts = ["Brando", "Vanna", "Linda"];

describe("matchCaption", () => {
  it("nama persis", () => expect(matchCaption("Brando", hosts)).toEqual({ host: "Brando", isMati: false }));
  it("tanpa beda huruf besar-kecil", () => expect(matchCaption("brando sesi 2", hosts)).toEqual({ host: "Brando", isMati: false }));
  it("mati di awal dan akhir", () => {
    expect(matchCaption("mati Brando 🙏", hosts)).toEqual({ host: "Brando", isMati: true });
    expect(matchCaption("Brando mati", hosts)).toEqual({ host: "Brando", isMati: true });
  });
  it("typo", () => {
    expect(matchCaption("Brnado", hosts)).toEqual({ host: "Brando", isMati: false });
    expect(matchCaption("Vana", hosts)).toEqual({ host: "Vanna", isMati: false });
  });
  it("nama pendek persis", () => {
    expect(matchCaption("Ani", ["Ani", "Vanna"])).toEqual({ host: "Ani", isMati: false });
    expect(matchCaption("mati ani", ["Ani", "Vanna"])).toEqual({ host: "Ani", isMati: true });
  });
  it("kata umum tidak cocok nama mirip", () => expect(matchCaption("pindah lokasi", hosts)).toEqual({ error: "tidak_dikenal" }));
  it("kosong", () => expect(matchCaption("", hosts)).toEqual({ error: "kosong" }));
  it("tidak dikenal", () => expect(matchCaption("Rina", hosts)).toEqual({ error: "tidak_dikenal" }));
  it("token pendek tidak cocok", () => expect(matchCaption("Vi", hosts)).toEqual({ error: "tidak_dikenal" }));
  it("ganda", () => expect(matchCaption("Brando Vanna", hosts)).toEqual({ error: "ganda" }));
  it("seri jarak dua host ganda", () => expect(matchCaption("Vanda", ["Vanna", "Vando"])).toEqual({ error: "ganda" }));
  it("persis menang atas fuzzy", () => expect(matchCaption("Vanna Vando", ["Vanna", "Brando"])).toEqual({ host: "Vanna", isMati: false }));
});

describe("parseCommand", () => {
  const today = "2026-11-20";
  it("gangguan semua", () => expect(parseCommand("#gangguan listrik", today)).toEqual({ kind: "gangguan", scope: "semua", alasan: "listrik" }));
  it("gangguan shopee", () => expect(parseCommand("#Gangguan SHOPEE", today)).toEqual({ kind: "gangguan", scope: "shopee", alasan: "" }));
  it("gangguan tiktok dengan alasan", () => expect(parseCommand("#gangguan tiktok error", today)).toEqual({ kind: "gangguan", scope: "tiktok", alasan: "error" }));
  it("normal", () => expect(parseCommand("#normal", today)).toEqual({ kind: "normal" }));
  it("izin hari ini", () => expect(parseCommand("#izin sakit", today)).toEqual({ kind: "izin", date: "2026-11-20", alasan: "sakit" }));
  it("izin dengan tanggal", () => expect(parseCommand("#izin 25/11 keperluan keluarga", today)).toEqual({ kind: "izin", date: "2026-11-25", alasan: "keperluan keluarga" }));
  it("izin d/m", () => expect(parseCommand("#izin 5/1 acara", today)).toEqual({ kind: "izin", date: "2026-01-05", alasan: "acara" }));
  it("tanggal tidak valid", () => expect(parseCommand("#izin 31/02 x", today)).toBeNull());
  it("bukan perintah", () => expect(parseCommand("halo", today)).toBeNull());
});

describe("parseKoreksi", () => {
  it("platform + angka → omzet", () => {
    expect(parseKoreksi("koreksi shopee 1.350.000")).toEqual({ platform: "shopee", field: "omzet", value: 1350000 });
    expect(parseKoreksi("Shopee Rp1.350.000")).toEqual({ platform: "shopee", field: "omzet", value: 1350000 });
    expect(parseKoreksi("koreksi shopee Rp 1.350.000")).toEqual({ platform: "shopee", field: "omzet", value: 1350000 });
    expect(parseKoreksi("koreksi tiktok 1,2jt")).toEqual({ platform: "tiktok", field: "omzet", value: 1200000 });
  });
  it("kata field", () => {
    expect(parseKoreksi("tiktok pesanan 9")).toEqual({ platform: "tiktok", field: "pesanan", value: 9 });
    expect(parseKoreksi("koreksi shopee dilihat 1.020")).toEqual({ platform: "shopee", field: "penontonMasuk", value: 1020 });
    expect(parseKoreksi("koreksi tiktok tayangan 800")).toEqual({ platform: "tiktok", field: "penontonMasuk", value: 800 });
    expect(parseKoreksi("koreksi shopee penonton 952")).toEqual({ platform: "shopee", field: "penontonMasuk", value: 952 });
    expect(parseKoreksi("shopee komentar 215")).toEqual({ platform: "shopee", field: "komentar", value: 215 });
    expect(parseKoreksi("shopee keranjang 62")).toEqual({ platform: "shopee", field: "keranjang", value: 62 });
    expect(parseKoreksi("tiktok impresi 23,7rb")).toEqual({ platform: "tiktok", field: "impresi", value: 23700 });
    expect(parseKoreksi("TIKTOK PENGIKUT 5")).toEqual({ platform: "tiktok", field: "pengikutBaru", value: 5 });
    expect(parseKoreksi("koreksi shopee omzet 1.350.000")).toEqual({ platform: "shopee", field: "omzet", value: 1350000 });
  });
  it("tidak terbaca → null, tidak menebak", () => {
    expect(parseKoreksi("koreksi 1.350.000")).toBeNull();
    expect(parseKoreksi("shopee harusnya 1.350.000")).toBeNull();
    expect(parseKoreksi("shopee 1.350.000 ya")).toBeNull();
    expect(parseKoreksi("koreksi shopee")).toBeNull();
    expect(parseKoreksi("1.350.000 shopee")).toBeNull();
    expect(parseKoreksi("shopee 1,317")).toBeNull();
  });
});
