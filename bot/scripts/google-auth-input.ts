/**
 * Membaca jawaban pemilik pada mode `--manual` google-auth: URL lengkap tempat browser berhenti
 * (halamannya memang tidak terbuka) ATAU hanya kodenya. Murni, tanpa efek samping, supaya mudah diuji.
 */
export type HasilMasukan = { ok: true; code: string } | { ok: false; reason: string };

export function parseAuthInput(masukan: string, stateDiharapkan: string): HasilMasukan {
  const t = masukan.trim().replace(/^["'<]+|["'>]+$/g, "");
  if (t === "") return { ok: false, reason: "Tidak ada yang ditempel." };

  if (/^https?:\/\//i.test(t) || t.includes("?")) {
    let params: URLSearchParams;
    try {
      params = new URL(t.startsWith("?") ? `/${t}` : t, "http://x").searchParams;
    } catch {
      return { ok: false, reason: "Tautan yang ditempel tidak bisa dibaca. Tempel seluruh alamat dari browser." };
    }
    const galat = params.get("error");
    if (galat) return { ok: false, reason: `Google menolak akses (${galat}). Ulangi dan klik Izinkan.` };
    const state = params.get("state");
    if (state !== null && state !== stateDiharapkan) {
      return { ok: false, reason: "Kode 'state' tidak cocok. Tempel alamat dari tautan yang BARU dicetak, bukan dari percobaan lama." };
    }
    if (state === null) return { ok: false, reason: "Alamat yang ditempel tidak memuat 'state'. Tempel alamat lengkapnya." };
    const code = params.get("code");
    if (!code) return { ok: false, reason: "Alamat yang ditempel tidak memuat 'code'. Tempel alamat lengkap dari browser." };
    return { ok: true, code };
  }

  // Hanya kode (tanpa state, jadi tidak bisa dicocokkan). Kode Google bisa tertempel dalam bentuk URL-encoded.
  let code = t;
  if (/%[0-9A-Fa-f]{2}/.test(code)) {
    try { code = decodeURIComponent(code); } catch { return { ok: false, reason: "Kode tidak valid." }; }
  }
  if (/\s/.test(code)) return { ok: false, reason: "Tempel hanya satu baris: alamat lengkap atau kodenya." };
  return { ok: true, code };
}
