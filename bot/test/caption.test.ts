import { describe, it, expect } from "vitest";
import { matchCaption, parseCommand } from "../src/domain/caption.js";

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
