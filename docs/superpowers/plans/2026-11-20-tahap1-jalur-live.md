# Tahap 1 — Jalur Live: Rencana Implementasi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host cukup mengirim screenshot live ke grup WA. Setelah itu sistem mencatat penjualan per sesi per host di CP – Live Tracker, menghitung target dan pace, mengirim update pagi, rekap malam dan eskalasi, serta tetap benar walaupun ada kondisi tidak ideal.

**Architecture:**
- **Satu layanan Node.js/TypeScript (`bot/`) di VPS**, berjalan berdampingan dengan WAHA dalam docker-compose.
- **SQLite di VPS adalah sumber data utama.** Di sana tersimpan semua laporan, antrean, dan penanda pesan yang sudah diproses.
- **Google Sheets adalah antarmuka.** Owner mengisi input di sana. Bot menulis tabel data rinci (Data Kredit dan Target Harian), lalu tab dashboard menghitung dari tabel itu memakai rumus yang dikendalikan sel filter periode. Karena itu filter tanggal langsung berlaku.
- **Logika bisnis ditulis sebagai fungsi murni di `src/domain/`**, yang bisa dites tanpa jaringan. Semua akses ke WAHA, Claude, dan Google ada di `src/infra/` di balik interface.
- **Pemeriksa detak** adalah Apps Script kecil di spreadsheet.

**Tech Stack:**
- Node 20, TypeScript (ESM), vitest
- express (webhook)
- better-sqlite3
- node-cron (zona `Asia/Jakarta`)
- googleapis (Sheets + Drive, OAuth refresh token milik owner)
- `@anthropic-ai/sdk` + zod (`zodOutputFormat`)
- WAHA Core (Docker)
- HyperFormula, hanya sebagai devDependency untuk menguji rumus spreadsheet

**Spec:** `/home/user/cp-sistem/rancangan-sistem.md`. Yang relevan untuk tahap ini: bagian 3, 5, 6 (termasuk 6.1a, 6.1b, 6.7), 8a bagian Analisis Live, 8b, 12, dan 15. Format tab mengikuti `format-live.png` dan `format-anlive.png`.

## Global Constraints

- **Bahasa dan format:** semua pesan bot dalam bahasa Indonesia. Format uang `Rp1.317.034` untuk angka penuh dan `Rp2,1 jt` / `Rp578 rb` untuk ringkasan. Zona waktu selalu `Asia/Jakarta`.
- **Definisi omzet target:** TikTok "GMV teratribusi" + Shopee "Penjualan", kotor, sesuai yang tampil di screenshot.
- **Pembagian target:** target tim dibagi rata ke host aktif, sebanding dengan hari aktif masing-masing. Target tim tidak pernah berubah karena gangguan atau izin. Yang berkurang hanya target pribadi (lihat "gugur" di Task 5).
- **Saklar `Jadwal aktif`** default `TIDAK`. Selama `TIDAK`, tidak ada tag atau teguran berbasis jadwal.
- **Angka hasil bacaan AI langsung berlaku** ("diam = setuju"). Koreksi dari host baru berlaku setelah owner memilih `Setujui` di tab Koreksi & Atribusi.
- **Teguran dan eskalasi hanya dikirim pribadi ke owner**, tidak pernah di grup.
- **Sel kosong berarti data belum ada, bukan 0.** `null` tidak boleh dijumlahkan sebagai 0 di metrik rasio.
- **Ambang status:**
  - ✅ jika realisasi ≥ seharusnya
  - ⚠️ jika kurang dari seharusnya, dengan selisih ≤ 10% dari seharusnya
  - 🔴 jika selisih > 10%, atau ada ≥ 3 hari live berturut-turut di bawah target per hari kerja
- **Nilai bawaan Pengaturan** (semuanya bisa diubah di tab Pengaturan):
  - Live 09:00–22:00
  - Update pagi 08:00
  - Rekap 22:30, atau 30 menit setelah laporan terakhir kalau lewat 22:00
  - Batas jeda laporan tidak wajar 240 menit
  - Batas pesan bot per orang per hari 6. Balasan konfirmasi tidak ikut dihitung.
- **Model Claude:** `claude-opus-5-5`, `output_config.effort: "medium"`. Dipanggil lewat `client.beta.messages.create` dengan `betas: ["server-side-fallback-2026-07-01"]` dan `fallbacks: "default"`. Cek `stop_reason === "refusal"` sebelum membaca isi.
- **Rahasia** (API key, refresh token, key WAHA) hanya ada di `.env` di VPS. Tidak pernah masuk ke git atau chat.
- **Laporan pergantian dibuat per platform.** Satu gambar bisa berisi satu atau dua platform.
- **Filter periode di setiap tab dashboard dan analisis** (rancangan 8a-2):
  - Pilihan: `Hari ini`, `Kemarin`, `7 hari terakhir`, `30 hari terakhir`, `Minggu ini` (Senin–Minggu), `Minggu lalu`, `Bulan ini`, `Bulan lalu`, `Custom` (memakai sel Dari dan Sampai).
  - Pembanding: `Periode sebelumnya`, `Bulan lalu tanggal sama`, `Tanpa pembanding`.
  - Default `Bulan ini` dengan pembanding `Bulan lalu tanggal sama`.
- **Data tidak pernah dihapus atau di-reset per bulan.** Target bulanan disimpan di tabel Pengaturan dengan kolom Bulan dan Target.
- **Rumus spreadsheet hanya boleh memakai fungsi yang didukung Google Sheets dan HyperFormula:** `SUMIFS`, `COUNTIFS`, `IF`, `IFERROR`, `MIN`, `MAX`, `DATE`, `TODAY`, `EOMONTH`, `WEEKDAY`, `INDEX`, `MATCH`, `AND`, `OR`. Tanpa `QUERY`, `FILTER`, `ARRAYFORMULA`, dan `LET`.

## Review Focus

1. **Foto layar HP, bukan screenshot.** Contoh asli dari user adalah foto dua HP dalam satu gambar, ada pantulan cahaya, dan angkanya bisa terpotong. Ekstraktor harus mengembalikan bacaan per platform yang terlihat. Platform yang angka omzetnya tidak terbaca harus ditandai tidak terbaca, bukan ditebak. → Task 9: tes "satu gambar dua platform" dan "omzet tidak terbaca".
2. **Screenshot yang sama terkirim dua kali, atau TikTok dan Shopee dikirim terpisah dalam 1–2 menit.** Kredit tidak boleh dobel. Bacaan identik menghasilkan selisih 0, dan pesan dengan ID sama diabaikan. → Task 4: tes bacaan identik. Task 11: tes ID pesan dobel dan dua pesan beruntun.
3. **Lewat tengah malam dan pergantian bulan.** Siaran yang mulai 30 Nov dan dilaporkan 1 Des 00:10 tetap masuk tanggal 30 Nov, dan masuk ke target November. → Task 4 dan Task 6.
4. **Variasi caption.** Contohnya huruf kecil, `brando sesi 2`, emoji, `mati Brando`, salah ketik ringan, atau dua nama sekaligus. Kalau ada dua nama, bot harus bertanya, bukan memilih. → Task 3.
5. **Bot restart di tengah banyak pesan.** Proses catch-up tidak boleh memproses pesan dua kali atau melewatkan pesan, dan urutannya mengikuti timestamp. → Task 11 dan Task 12.

---

## Struktur file

```
cp-sistem/
  bot/
    package.json, tsconfig.json, vitest.config.ts, Dockerfile
    src/config.ts                 env → Config (zod)
    src/domain/types.ts           tipe bersama (lihat Task 1)
    src/domain/numbers.ts         "Rp578rb" → {value, rounded}; durasi
    src/domain/caption.ts         nama host + "mati" dari caption; perintah #gangguan/#normal/#izin
    src/domain/ledger.ts          laporan → kredit per host (siaran, reset, jeda, atribusi)
    src/domain/targets.ts         target bulan → per host → per hari; gugur
    src/domain/rekap.ts           angka dashboard, streak, status, analisis live
    src/domain/period.ts          preset periode → rentang tanggal, rentang pembanding
    src/domain/sheetFormulas.ts   rumus dashboard berbasis filter (diuji dengan HyperFormula)
    src/domain/messages.ts        teks semua pesan bot + format Rupiah
    src/infra/db.ts               SQLite: messages, reports, outbox, sent_log
    src/infra/extractor.ts        Claude vision → ExtractResult
    src/infra/waha.ts             klien WAHA
    src/infra/sheets.ts           baca input owner, tulis tab, unggah bukti
    src/app/handleMessage.ts      orkestrasi satu pesan grup
    src/app/refresh.ts            hitung ulang dan tulis dashboard
    src/app/scheduler.ts          cron + catch-up + detak + flush antrean
    src/server.ts                 POST /webhook/waha, GET /health
    scripts/google-auth.ts        sekali jalan: refresh token owner
    scripts/setup-sheet.ts        buat CP – Live Tracker + proteksi + folder Bukti Live
    scripts/smoke-extract.ts      uji ekstraktor ke API asli
    test/...                      satu file tes per modul
    test/fixtures/waha/*.json     payload asli dari Task 0
    test/fixtures/screens/live-17nov.jpg   foto asli dari user
  apps-script/heartbeat.gs
  deploy/docker-compose.yml, deploy/.env.example
  docs/panduan-vps.md, docs/uji-skenario.md
```

Repo git diinisialisasi di `cp-sistem/`. Kontainer sesi ini tidak permanen, jadi kode harus didorong ke repo GitHub privat milik user secepatnya (lihat Task 15).

---

### Task 0: Uji WAHA di VPS dan rekam payload asli (bersama user)

**Files:**
- Create: `deploy/docker-compose.yml` (hanya service `waha`), `deploy/.env.example`, `docs/panduan-vps.md` (bagian 1: pasang Docker dan WAHA)
- Create: `bot/test/fixtures/waha/group-image-caption.json`, `group-text.json`, `group-reply.json`, `session-status.json`

**Interfaces:**
- Produces: bentuk payload webhook dan pesan WAHA yang dipakai Task 10 dan 11. Isinya chat id grup (`...@g.us`), id pengirim, `caption`/`body`, `hasMedia`, URL media, dan id pesan yang di-reply.

- [ ] **Step 1:** Tulis `docs/panduan-vps.md` bagian 1 dalam bahasa Indonesia, berisi perintah salin-tempel untuk:
  - mengecek OS
  - memasang Docker
  - `docker compose up -d waha` dengan `WAHA_API_KEY` dari `.env`
  - membuka dashboard WAHA lewat SSH tunnel, bukan port publik
  - scan QR dengan HP nomor bot
- [ ] **Step 2:** User menjalankan panduan, membuat grup **CP Live**, memasukkan nomor bot, lalu mengirim tiga hal ke grup:
  1. foto `live-17nov.jpg` dengan caption `Brando`
  2. teks `#izin sakit`
  3. balasan (reply) ke pesan foto itu
- [ ] **Step 3:** User menjalankan `curl` dari panduan untuk mengambil pesan grup dan status sesi. Hasil JSON disimpan sebagai fixture dengan nomor telepon disamarkan (`628xxx`).
  - **Lulus kalau:** fixture foto memuat caption `Brando` dan media gambar yang bisa diunduh dengan header `X-Api-Key`.
  - **Kalau WAHA tidak menerima gambar dari grup:** berhenti dan laporkan ke user sebelum lanjut.
- [ ] **Step 4:** Commit fixture dan dokumen.

---

### Task 1: Kerangka proyek, config, dan tipe bersama

**Files:**
- Create: `bot/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/config.ts`, `src/domain/types.ts`
- Test: `bot/test/config.test.ts`

**Interfaces:**
- Produces, di `src/domain/types.ts`:

```ts
export type Platform = "tiktok" | "shopee";
export interface Num { value: number; rounded: boolean }
export interface PlatformReading {
  platform: Platform;
  screen: "berjalan" | "akhir";
  omzet: Num | null;          // TikTok GMV teratribusi | Shopee Penjualan
  pesanan: Num | null;        // TikTok produk terjual | Shopee pesanan dibuat
  penontonMasuk: Num | null;  // TikTok tayangan | Shopee dilihat
  komentar: Num | null;
  keranjang: Num | null;      // Shopee
  impresi: Num | null;        // TikTok
  pengikutBaru: Num | null;   // TikTok
  penontonAktif: Num | null;  // Shopee, sesaat (tidak dikurangkan)
  rataNontonDetik: number | null; // Shopee, sesaat
  durasiDetik: number | null;
}
export type CumulativeField = "omzet"|"pesanan"|"penontonMasuk"|"komentar"|"keranjang"|"impresi"|"pengikutBaru"|"durasiDetik";
export type ExtractResult =
  | { ok: true; readings: PlatformReading[] }
  | { ok: false; reason: "bukan_layar_live" | "tidak_terbaca" | "ditolak" };
export interface Report {
  messageId: string; receivedAt: Date; effectiveAt?: Date;
  host: string; isMati: boolean; reading: PlatformReading;
}
export type Flag = "dibulatkan"|"siaran_baru"|"layar_akhir"|"siaran_belum_lengkap"|"belum_teratribusi";
export interface LedgerEntry {
  messageId: string; host: string; platform: Platform;
  date: string;              // YYYY-MM-DD tanggal mulai siaran
  at: Date; intervalStart: Date; segment: number;
  credit: Partial<Record<CumulativeField, number>>;
  flags: Flag[];
}
export interface HostConfig { name: string; waId?: string; aktifMulai?: string; aktifSelesai?: string }
export interface Settings {
  teamTarget: Record<string, number>;   // "2026-11" → rupiah
  jadwalAktif: boolean; liveMulai: string; liveSelesai: string;
  jamPagi: string; jamRekap: string; maxGapMenit: number; maxPesanPerHari: number;
  hosts: HostConfig[]; ownerWaId: string; ownerEmail: string;
}
```

- `loadConfig(env: NodeJS.ProcessEnv): Config`. Variabel wajib:
  - `WAHA_URL`, `WAHA_API_KEY`, `WAHA_SESSION`
  - `LIVE_GROUP_ID`
  - `ANTHROPIC_API_KEY`
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
  - `LIVE_SPREADSHEET_ID`, `BUKTI_FOLDER_ID`
  - `DB_PATH`

  Variabel opsional: `JADWAL_SPREADSHEET_ID`.

- [ ] **Step 1:** Tes `loadConfig`:
  - melempar error yang menyebut nama variabel yang hilang, misalnya `LIVE_GROUP_ID`
  - mengembalikan objek bertipe kalau semua variabel ada
- [ ] **Step 2:** Jalankan `cd bot && npx vitest run test/config.test.ts`. Hasil yang diharapkan: **FAIL**.
- [ ] **Step 3:** Implementasikan `src/config.ts` dengan skema zod. Tambahkan juga `package.json` (scripts `test`, `build`, `start`, `smoke:extract`), `tsconfig` (ESM, strict), dan `src/domain/types.ts` persis seperti di atas.
- [ ] **Step 4:** Jalankan tes. Hasil yang diharapkan: **PASS**. Jalankan juga `npx tsc --noEmit`. Hasil yang diharapkan: tanpa error.
- [ ] **Step 5:** Commit `feat: kerangka bot, config, tipe domain`.

---

### Task 2: Parser angka Indonesia

**Files:**
- Create: `bot/src/domain/numbers.ts`
- Test: `bot/test/numbers.test.ts`

**Interfaces:**
- Produces:
  - `parseNum(text: string): Num | null`
  - `parseDurasi(text: string): number | null` (dalam detik)

- [ ] **Step 1:** Tes:

```ts
expect(parseNum("Rp578rb")).toEqual({ value: 578000, rounded: true });
expect(parseNum("Rp1,2jt")).toEqual({ value: 1200000, rounded: true });
expect(parseNum("23,7K")).toEqual({ value: 23700, rounded: true });
expect(parseNum("1.317.034")).toEqual({ value: 1317034, rounded: false });
expect(parseNum("Rp1.317.034")).toEqual({ value: 1317034, rounded: false });
expect(parseNum("952")).toEqual({ value: 952, rounded: false });
expect(parseNum("$0.02")).toBeNull();
expect(parseNum("")).toBeNull();
expect(parseDurasi("11:00:32")).toBe(39632);
expect(parseDurasi("00:00:38")).toBe(38);
```

- [ ] **Step 2:** Jalankan tes. Hasil yang diharapkan: **FAIL**.
- [ ] **Step 3:** Implementasikan.
  - Akhiran `rb` = ×1.000, `jt` = ×1.000.000, `K` = ×1.000, `M` = ×1.000.000.
  - Koma adalah desimal, titik adalah pemisah ribuan.
  - `rounded = true` kalau ada akhiran.
  - Mata uang selain Rp/tanpa simbol menghasilkan `null`.
- [ ] **Step 4:** Jalankan tes. Hasil yang diharapkan: **PASS**.
- [ ] **Step 5:** Commit.

---

### Task 3: Caption dan perintah grup

**Files:**
- Create: `bot/src/domain/caption.ts`
- Test: `bot/test/caption.test.ts`

**Interfaces:**
- Produces:
  - `matchCaption(caption: string, hosts: string[]): { host: string; isMati: boolean } | { error: "kosong" | "tidak_dikenal" | "ganda" }`
  - `parseCommand(text: string, today: string): Command | null`, dengan:

```ts
type Command =
  | { kind: "gangguan"; scope: Platform | "semua"; alasan: string }
  | { kind: "normal" }
  | { kind: "izin"; date: string; alasan: string };
```

- [ ] **Step 1:** Tes, dengan `hosts = ["Brando","Vanna","Linda"]`:
  - `matchCaption("Brando")` menghasilkan `{host:"Brando", isMati:false}`.
  - `"brando sesi 2"` menghasilkan Brando.
  - `"mati Brando 🙏"` dan `"Brando mati"` menghasilkan `isMati:true`.
  - `"Brnado"` menghasilkan Brando (jarak edit ≤ 2).
  - `"Vana"` menghasilkan Vanna.
  - `""` menghasilkan `{error:"kosong"}`.
  - `"Rina"` menghasilkan `{error:"tidak_dikenal"}`.
  - `"Brando Vanna"` menghasilkan `{error:"ganda"}`.
  - `parseCommand("#gangguan listrik","2026-11-20")` menghasilkan `{kind:"gangguan",scope:"semua",alasan:"listrik"}`.
  - `"#gangguan shopee"` menghasilkan `scope:"shopee"`.
  - `"#normal"` menghasilkan `{kind:"normal"}`.
  - `"#izin sakit"` menghasilkan `{kind:"izin",date:"2026-11-20",alasan:"sakit"}`.
  - `"#izin 25/11 keperluan keluarga"` menghasilkan `date:"2026-11-25"`.
  - `"halo"` menghasilkan `null`.
- [ ] **Step 2:** Jalankan tes. Hasil yang diharapkan: **FAIL**.
- [ ] **Step 3:** Implementasikan.
  - Kata dicocokkan per token, tanpa membedakan huruf besar-kecil, memakai Levenshtein ≤ 2 dengan panjang nama ≥ 4.
  - Kata `mati` di posisi mana pun menghasilkan `isMati`.
  - Tanggal `dd/mm` di perintah izin memakai tahun dari `today`.
- [ ] **Step 4:** Jalankan tes. Hasil yang diharapkan: **PASS**.
- [ ] **Step 5:** Commit.

---

### Task 4: Ledger (kredit per sesi, reset, jeda tak wajar, atribusi)

**Files:**
- Create: `bot/src/domain/ledger.ts`
- Test: `bot/test/ledger.test.ts`

**Interfaces:**
- Consumes: `Report`, `LedgerEntry`, `CumulativeField` dari Task 1.
- Produces:
  - `buildLedger(reports: Report[], opts: { maxGapMenit: number; liveMulai: string; onShift?: (host: string, date: string) => boolean; attributions?: Map<string, Array<{ host: string; share: number }>> }): LedgerEntry[]`
  - `applyCorrections(reports: Report[], approved: Array<{ messageId: string; platform: Platform; field: CumulativeField; value: number }>): Report[]`

**Aturan yang harus diikuti implementasi:**
- Laporan diproses per platform, diurutkan menurut `effectiveAt ?? receivedAt`.
- **Siaran baru dimulai kalau:**
  - `omzet` turun dibanding laporan sebelumnya, atau
  - laporan sebelumnya adalah layar akhir (`screen === "akhir"` atau `isMati`).
- **Kredit** = nilai sekarang dikurangi nilai sebelumnya, dalam siaran yang sama, untuk setiap `CumulativeField`. Field yang `null` di salah satu sisi tidak diberi kredit.
- **Kredit siaran baru** = nilai penuh dari laporan itu.
- **Penurunan angka tanpa layar akhir sebelumnya** memberi flag `siaran_belum_lengkap` pada entri siaran baru. Kredit siaran baru tetap penuh. Selisih ekor siaran lama yang hilang tidak dikreditkan ke siapa pun.
- **Tanggal entri** = tanggal (Asia/Jakarta) laporan pertama di siaran itu.
- **`intervalStart`**:
  - waktu laporan sebelumnya di siaran yang sama, atau
  - `liveMulai` hari itu, untuk laporan pertama siaran pertama hari itu, atau
  - waktu laporan terakhir siaran sebelumnya, untuk siaran baru setelah reset.
- **Flag `belum_teratribusi`** diberikan kalau:
  - `at − intervalStart > maxGapMenit`, atau
  - `onShift` ada dan mengembalikan `false` untuk host itu.

  Entri ini tidak dihitung ke host mana pun, kecuali `attributions` berisi `messageId` tersebut. Dalam hal itu, kreditnya dipecah ke host-host sesuai `share`.
- **Flag `dibulatkan`** diberikan kalau `omzet.rounded`.

- [ ] **Step 1:** Tes contoh dari rancangan 6.1a (TikTok, 20 Nov):
  - 10:00 Brando Rp300rb
  - 11:10 Brando layar akhir Rp420rb, `isMati`
  - 12:00 Brando Rp150rb
  - 13:20 Vanna Rp500rb

  Kredit omzet yang diharapkan: `[300000, 120000, 150000, 350000]`, dengan host `[Brando, Brando, Brando, Vanna]`. Entri ketiga punya flag `siaran_baru`.
- [ ] **Step 2:** Tes tambahan:
  - **Reset tanpa layar akhir:** 300rb lalu 150rb. Kredit `[300000, 150000]`, entri kedua berflag `siaran_belum_lengkap`.
  - **Bacaan identik dua kali:** kredit kedua = 0, tanpa error.
  - **Platform independen:** laporan Shopee tidak memengaruhi siaran TikTok.
  - **Jeda > 240 menit antara dua laporan:** entri kedua `belum_teratribusi`. Dengan `attributions` `{Brando:0.5, Vanna:0.5}`, kreditnya terpecah dua.
  - **Lewat tengah malam:** siaran mulai 30/11 21:00, laporan 1/12 00:10 dengan omzet naik. Entri ber-`date` `2026-11-30`.
  - **`penontonAktif` dan `rataNontonDetik`** tidak pernah muncul di `credit`.
  - **`applyCorrections`:** mengganti `omzet` bacaan lalu mengubah kredit entri itu dan entri sesudahnya.
- [ ] **Step 3:** Jalankan tes. Hasil yang diharapkan: **FAIL**.
- [ ] **Step 4:** Implementasikan sesuai aturan di atas.
- [ ] **Step 5:** Jalankan tes. Hasil yang diharapkan: **PASS**.
- [ ] **Step 6:** Commit.

---

### Task 5: Target, gugur, dan pace

**Files:**
- Create: `bot/src/domain/targets.ts`
- Test: `bot/test/targets.test.ts`

**Interfaces:**
- Produces:

```ts
interface TargetInputs {
  month: string;                 // "2026-11"
  teamTarget: number;
  hosts: HostConfig[];
  tanpaLive: string[];           // tanggal di Kalender Live
  izin: Array<{ host: string; date: string }>;              // Sakit/Izin/Cuti yang Disetujui (tab Kehadiran)
  gangguan: Array<{ host: string; date: string; menit: number }>; // hanya yang Disetujui
  jadwal: null | Array<{ date: string; host: string; mulai: string; selesai: string }>;
  jamLive: number;               // dari liveMulai–liveSelesai, default 13
}
interface HostTarget {
  bulan: number;                 // target pribadi setelah gugur
  awal: number;                  // sebelum gugur
  gugur: Array<{ date: string; jumlah: number; sebab: "izin" | "gangguan" }>;
  perHariKerja: number;
}
computeTargets(inp: TargetInputs): Record<string, HostTarget>
seharusnya(t: HostTarget, inp: TargetInputs, host: string, upTo: string): number
butuhPerHariKerja(t: HostTarget, realisasi: number, inp: TargetInputs, host: string, today: string): number
```

**Rumus yang dipakai:**
- **`liveDays`** = tanggal di bulan itu yang tidak masuk `tanpaLive`.
- **Hari aktif host** = `liveDays` yang berada di rentang aktif host itu.
- **`awal`** = `teamTarget × aktif_i ÷ Σ aktif_j`.
- **Jam on-air bulanan host** (`J`):
  - Kalau jadwal ada: Σ (`jamLive` ÷ jumlah host yang masuk shift hari itu), untuk hari-hari host itu masuk shift.
  - Kalau jadwal tidak ada: `aktif_i × jamLive ÷ n`, dengan `n` = jumlah host aktif.
- **Gugur izin:**
  - Kalau jadwal ada: `awal × (jam on-air host itu di hari tersebut) ÷ J`.
  - Kalau jadwal tidak ada: `awal × 7 ÷ (6 × aktif_i)`.
- **Gugur gangguan** = `awal × (menit ÷ 60) ÷ J`.
- **`perHariKerja`**:
  - Kalau jadwal tidak ada: `awal ÷ (aktif_i × 6/7)`.
  - Kalau jadwal ada: `awal ÷ jumlah hari shift host itu`.
- **`seharusnya(upTo)`** = `awal × (hari aktif s/d upTo ÷ aktif_i) − Σ gugur dengan date ≤ upTo`. Kalau jadwal ada, faktor hari diganti dengan proporsi jam on-air.

- [ ] **Step 1:** Tes untuk November 2026, target tim Rp60.000.000, 3 host aktif sebulan penuh, tanpa jadwal, `jamLive` 13:
  - `awal` = 20.000.000 untuk tiap host.
  - `perHariKerja` ≈ 777.778.
  - `seharusnya(Brando, "2026-11-20")` = 13.333.333 (dibulatkan ke rupiah).
  - Izin Brando 18/11 disetujui: gugur 777.778, dan `bulan` = 19.222.222.
  - Gangguan Vanna 20/11 selama 120 menit: gugur = 20.000.000 × 2 ÷ 130 = 307.692.
  - `tanpaLive` `["2026-11-25"]`: `liveDays` = 29.
  - Linda aktif mulai 16/11 (15 hari): Brando dan Vanna masing-masing 24.000.000, Linda 12.000.000.
  - Dengan jadwal mini (Sel 17/11: Brando shift Pagi, Vanna Middle, `jamLive` 11): jam on-air Brando hari itu 5,5.
- [ ] **Step 2:** Jalankan tes. Hasil yang diharapkan: **FAIL**.
- [ ] **Step 3:** Implementasikan sesuai rumus di atas. Pembulatan ke rupiah hanya di tampilan, bukan di perhitungan.
- [ ] **Step 4:** Jalankan tes. Hasil yang diharapkan: **PASS**.
- [ ] **Step 5:** Commit.

---

### Task 6: Rekap dashboard dan Analisis Live

**Files:**
- Create: `bot/src/domain/rekap.ts`
- Test: `bot/test/rekap.test.ts`

**Interfaces:**
- Consumes: `LedgerEntry[]` (Task 4), `HostTarget` dan helper dari Task 5.
- Produces:

```ts
interface HostSummary {
  host: string; target: number; realisasi: number; seharusnya: number;
  pctTarget: number; selisih: number; butuhPerHariKerja: number;
  vsBulanLalu: number | null; menitOnAir: number; omzetPerJam: number | null;
  konversi: number | null; disiplin: number | null;
  streakDiBawah: number; status: "ok" | "warn" | "bad";
}
summarizeHosts(entries: LedgerEntry[], lastMonth: LedgerEntry[], targets: Record<string, HostTarget>, inp: TargetInputs, today: string, laporanBermasalah: Record<string, number>): HostSummary[]
dailyByHost(entries: LedgerEntry[], month: string): Record<string, Record<string, number>>
funnel(entries: LedgerEntry[], filter?: { host?: string; from?: string; to?: string }): Funnel
heatmap(entries: LedgerEntry[], month: string): Record<"Sen–Kam" | "Jum–Min", Record<number, number | null>>  // omzet/jam per jam mulai
indeksSlot(entries: LedgerEntry[], host: string, month: string): number | null  // omzet/jam host ÷ rata-rata semua host di jam yang sama; null kalau data < 21 hari live
expectedOmzet(entries: LedgerEntry[], month: string): Map<string, number>  // messageId+host → omzet harapan = rata-rata omzet/jam semua host di jam & kelompok hari itu × menit/60
toKreditRows(entries: LedgerEntry[], attributions, expected: Map<string, number>): KreditRow[]
// KreditRow = { messageId, tanggal, jam, hariKelompok, host /* atau "(belum teratribusi)" */, platform, omzet, pesanan, penontonMasuk, komentar, keranjang, impresi, pengikutBaru, menitOnAir, omzetHarapan, status: "dihitung" | "belum_teratribusi" }
// Atribusi pecahan → satu baris per host dengan nilai × porsi.
```

**Aturan perhitungan:**
- **Realisasi** hanya menjumlahkan entri tanpa flag `belum_teratribusi`, kecuali yang sudah dipecah lewat `attributions`.
- **`menitOnAir`** = Σ (`at − intervalStart`) untuk entri host itu, dihitung sekali per interval walaupun ada dua platform. Kalau dua platform dilaporkan dalam 10 menit, keduanya dianggap satu interval.
- **Konversi** = (pesanan Shopee + produk terjual TikTok) ÷ (dilihat Shopee + tayangan TikTok). Hasilnya `null` kalau penyebutnya 0.
- **`vsBulanLalu`** = realisasi tanggal 1 s/d d ÷ realisasi bulan lalu tanggal 1 s/d min(d, akhir bulan lalu) − 1. Hasilnya `null` kalau bulan lalu tidak ada datanya.
- **Disiplin** = 1 − laporanBermasalah ÷ jumlah laporan host. Hasilnya `null` kalau belum ada laporan.
- **`streakDiBawah`** = jumlah hari live berturut-turut sampai kemarin dengan kredit di bawah `perHariKerja`. Hari izin, hari tanpa live, dan hari tanpa laporan host itu (dengan jadwal tidak aktif) dilewati, tidak memutus hitungan dan tidak menambahnya.
- **Status** mengikuti Global Constraints.

- [ ] **Step 1:** Tes `funnel` dengan angka asli 17 Nov:
  - Shopee: dilihat 952, keranjang 62, pesanan 13, omzet 1.317.034.
  - TikTok: impresi 23.700, tayangan 770, terjual 7, omzet 578.000.

  Hasil yang diharapkan:
  - `atcRate` 0,065
  - `cartToOrder` 0,2097
  - konversi Shopee 0,01366
  - `aov` 101.310
  - `tapIn` 0,0325
  - konversi TikTok 0,00909
  - komentar per dilihat 0,2258 (komentar 215)
- [ ] **Step 2:** Tes `summarizeHosts` dengan data contoh mockup: target 20 jt, realisasi Brando 11,2 jt per 20/11.
  - `pctTarget` 0,56, `seharusnya` 13.333.333, `selisih` −2.133.333, status `bad`.
  - Vanna dengan realisasi 14,1 jt: status `ok`.
  - Linda dengan realisasi 12,6 jt: status `warn`.
  - Streak 3 hari di bawah target menghasilkan `bad` walaupun selisihnya < 10%.
  - Hari izin di tengah tidak memutus streak.
- [ ] **Step 3:** Tes:
  - `indeksSlot` = `null` kalau data baru 10 hari. Dengan 21 hari data, host yang omzet per jamnya 1,12× rata-rata di jam yang sama menghasilkan 1,12.
  - Entri `belum_teratribusi` tidak masuk realisasi.
  - Entri tanggal 30/11 yang dilaporkan 1/12 masuk realisasi November.
  - `vsBulanLalu` = `null` kalau bulan lalu kosong.
- [ ] **Step 4:** Jalankan tes. Hasil yang diharapkan: **FAIL**. Implementasikan, lalu jalankan lagi. Hasil yang diharapkan: **PASS**.
- [ ] **Step 5:** Commit.

---

### Task 6b: Periode filter dan rumus dashboard

**Files:**
- Create: `bot/src/domain/period.ts`, `bot/src/domain/sheetFormulas.ts`
- Test: `bot/test/period.test.ts`, `bot/test/sheetFormulas.test.ts`

**Interfaces:**
- Consumes: `KreditRow` (Task 6) dan baris Target Harian `{ tanggal, host, target, gugur, sebab }` (Task 5).
- Produces:
  - `periodRange(preset: Preset, today: string, custom?: { dari: string; sampai: string }): { dari: string; sampai: string }`
  - `comparisonRange(range, mode: "sebelumnya" | "bulan_lalu" | "tanpa"): { dari: string; sampai: string } | null`
  - `dashboardFormulas(layout: Layout): Record<string /* A1 sel */, string /* rumus */>` untuk tab Dashboard Host, Harian per Host, Analisis Live, Tren Bulanan, dan Kontrol.
    - Sel filter ada di `B2` (preset), `D2` (dari), `F2` (sampai), dan `H2` (pembanding).
    - Sel tersembunyi `J2:K3` berisi rentang efektif dan rentang pembanding yang dihitung dengan rumus. Logikanya harus sama dengan `periodRange` dan `comparisonRange`.

**Aturan:**
- **Minggu dimulai Senin.**
- **`Bulan lalu tanggal sama`:** tanggal 1 sampai min(hari sampai, akhir bulan lalu).
- **`Periode sebelumnya`:** jumlah hari sama, berakhir sehari sebelum `dari`.
- **Custom dengan Dari > Sampai:** sel status menampilkan "Tanggal tidak valid", dan semua angka kosong (bukan 0).

- [ ] **Step 1:** Tes `periodRange` dengan `today = "2026-11-20"` (hari Jumat):
  - `Hari ini` menghasilkan `2026-11-20 … 2026-11-20`.
  - `7 hari terakhir` menghasilkan `11-14 … 11-20`.
  - `Minggu ini` menghasilkan `11-16 … 11-20`.
  - `Minggu lalu` menghasilkan `11-09 … 11-15`.
  - `Bulan lalu` menghasilkan `10-01 … 10-31`.
  - `Custom 2026-11-01..2026-11-15` dikembalikan apa adanya.
  - `comparisonRange(Bulan ini, "bulan_lalu")` menghasilkan `10-01 … 10-20`.
  - `comparisonRange(7 hari terakhir, "sebelumnya")` menghasilkan `11-07 … 11-13`.
- [ ] **Step 2:** Tes rumus. Muat fixture Data Kredit (data contoh mockup: 3 host, 1–20 Nov, ditambah Oktober) dan Target Harian ke HyperFormula, pasang rumus dari `dashboardFormulas`, lalu set filter. Hasil rumus harus sama dengan fungsi TS (Task 5 dan 6) dalam selisih Rp1 dan 0,0001 untuk rasio:
  - **Preset `Bulan ini`:** realisasi Brando 11.200.000, target 20.000.000, seharusnya s/d hari ini 13.333.333, pembanding Oktober 1–20.
  - **`Custom 2026-11-01..2026-11-15`:** realisasi per host sama dengan penjumlahan TS untuk rentang itu.
  - **Funnel Shopee pada filter `Hari ini`** yang hanya berisi data 17 Nov (dengan `today` = 17 Nov): `atcRate` 0,065.
  - **Baris `belum_teratribusi`** tidak masuk realisasi host mana pun, tapi muncul di total "belum teratribusi".
  - **Custom Dari > Sampai** menghasilkan sel kosong dan teks "Tanggal tidak valid".
  - **Tren Bulanan** baris Oktober dan November sama dengan penjumlahan TS per bulan.
- [ ] **Step 3:** Jalankan `npx vitest run test/period.test.ts test/sheetFormulas.test.ts`. Hasil yang diharapkan: **FAIL**.
- [ ] **Step 4:** Implementasikan `period.ts`, lalu `sheetFormulas.ts` dengan rumus `SUMIFS`/`COUNTIFS` di atas kolom tabel Data Kredit dan Target Harian. Pakai daftar fungsi yang diizinkan di Global Constraints. Seluruh tabel memakai rentang kolom penuh, misalnya `'Data Kredit'!$C:$C`.
- [ ] **Step 5:** Jalankan tes. Hasil yang diharapkan: **PASS**.
- [ ] **Step 6:** Commit.

---

### Task 7: Teks pesan bot

**Files:**
- Create: `bot/src/domain/messages.ts`
- Test: `bot/test/messages.test.ts`

**Interfaces:**
- Produces:
  - `rp(n: number): string` menghasilkan `Rp1.317.034`.
  - `rpRingkas(n: number): string` menghasilkan `Rp2,1 jt` atau `Rp578 rb`.
  - `msgPagi(date: string, rows: HostSummary[], gangguanKemarin: string[]): string`
  - `msgTanda(host, perPlatform: Array<{platform, kredit: number, rounded: boolean}>, flags: Flag[]): string`, berisi `✅ Tercatat — Brando · TikTok +Rp410 rb* · Shopee +Rp620.500 · Balas kalau angka salah`.
  - `msgSiapa(): string`
  - `msgKirimUlang(reason): string`
  - `msgDiproses(): string`
  - `msgMintaRiwayat(host, platform): string`
  - `msgRekap(date, rows: HostSummary[], harian: Record<string, number>): string`
  - `msgOwner(date, info: { bolong: string[]; belumLengkap: number; belumTeratribusi: number; koreksiMenunggu: number; eskalasi: string[] }): string`
  - `msgAckPerintah(cmd: Command): string`
  - `mention(host: HostConfig): string`

- [ ] **Step 1:** Tes (cek isi kunci, bukan teks persis):
  - `rp(1317034) === "Rp1.317.034"`
  - `rpRingkas(2133333) === "Rp2,1 jt"`
  - `rpRingkas(578000) === "Rp578 rb"`
  - `msgPagi` memuat nama ketiga host, `56%`, `66,7%`, dan `⚠️` atau `🔴` sesuai status. Kata "teguran" tidak boleh ada.
  - `msgOwner` dengan eskalasi `["Brando"]` memuat `Brando` dan `3 hari`.
  - `msgTanda` untuk angka TikTok yang dibulatkan memuat `*`.
- [ ] **Step 2:** Jalankan tes. Hasil yang diharapkan: **FAIL**. Implementasikan, lalu jalankan lagi. Hasil yang diharapkan: **PASS**.
- [ ] **Step 3:** Commit.

---

### Task 8: Penyimpanan SQLite dan antrean

**Files:**
- Create: `bot/src/infra/db.ts`
- Test: `bot/test/db.test.ts`

**Interfaces:**
- Produces: `openDb(path: string): Db` dengan method berikut.

| Method | Fungsi |
|---|---|
| `markMessage(id, ts): boolean` | `false` kalau pesan sudah pernah diproses |
| `saveReport(r: Report)` | simpan laporan |
| `reports(month: string): Report[]` | termasuk laporan tanggal 1 bulan berikutnya sebelum 06:00, untuk siaran lewat tengah malam |
| `pendingCaption` | `put(msgId, imageRef)`, `take(replyToId)` |
| `pendingExtract` | `put(msgId, imagePath, caption)`, `all()`, `done(msgId)` |
| `outbox.push(op: SheetOp)`, `outbox.next(n)`, `outbox.ack(id)`, `outbox.fail(id)` | antrean tulis ke Sheets |
| `sentCount(waId, date)`, `logSent(waId, date)` | hitungan pesan untuk batas spam |
| `lastProcessedTs()` | waktu pesan terakhir yang diproses |
| `setKv(k,v)`, `getKv(k)` | simpan nilai bebas |

- [ ] **Step 1:** Tes dengan database sementara:
  - `markMessage("a")` pertama `true`, kedua `false`.
  - Laporan tersimpan dan terbaca kembali dengan `Date` utuh.
  - Antrean bersifat FIFO. Operasi yang gagal tetap ada, lalu dicoba lagi.
  - `lastProcessedTs` = waktu terbesar.
- [ ] **Step 2:** Jalankan tes. Hasil yang diharapkan: **FAIL**. Implementasikan dengan better-sqlite3, mode WAL, dan migrasi skema saat dibuka. Jalankan lagi. Hasil yang diharapkan: **PASS**.
- [ ] **Step 3:** Commit.

---

### Task 9: Ekstraktor Claude vision

**Files:**
- Create: `bot/src/infra/extractor.ts`, `bot/scripts/smoke-extract.ts`
- Create: `bot/test/fixtures/screens/live-17nov.jpg` (salinan foto asli dari user)
- Test: `bot/test/extractor.test.ts`

**Interfaces:**
- Produces:
  - `interface Extractor { extract(image: Buffer, mime: string): Promise<ExtractResult> }`
  - `class ClaudeExtractor implements Extractor`, dengan constructor `(client: Anthropic)`

**Ketentuan:**
- **Skema keluaran (zod):** `{ jenis: "layar_live" | "bukan_layar_live" | "tidak_terbaca", platforms: Array<{ platform, screen, ...field PlatformReading dalam bentuk string mentah seperti tertulis di layar } > }`. Angka mentah diubah dengan `parseNum` atau `parseDurasi` (Task 2) di kode, bukan oleh model.
- **Panggilan API:** `client.beta.messages.create` dengan model `claude-opus-5-5`, `max_tokens` 16000, `output_config: { effort: "medium", format: zodOutputFormat(Skema) }`, `betas: ["server-side-fallback-2026-07-01"]`, dan `fallbacks: "default"`. Gambar dikirim sebagai blok `image` base64 sebelum teks.
- **Isi prompt:**
  - Daftar label per platform.
  - Shopee: Penjualan, Pesanan Dibuat, Dilihat, Komentar, Masukkan ke Keranjang, Penonton Aktif, Durasi Rata-rata Menonton, Durasi.
  - TikTok: GMV Teratribusi, Produk terjual teratribusi, Tayangan, Impresi LIVE, Komentar, Pengikut baru.
  - Instruksi untuk menyalin angka persis seperti tertulis, mengisi `null` kalau tidak terlihat, dan tidak pernah menebak.
  - Abaikan bagian "Sistem Pemberian Hadiah".
- **Kapan sebuah platform tidak dihitung:** kalau `omzet` platform itu `null`, platform tersebut dibuang. Kalau tidak ada satu pun platform yang tersisa, hasilnya `tidak_terbaca`.
- **`stop_reason === "refusal"`** menghasilkan `{ok:false, reason:"ditolak"}`.
- **Error API** (`Anthropic.RateLimitError`, `APIConnectionError`, status ≥ 500) dilempar ulang supaya pemanggil memasukkan pesan ke antrean `pendingExtract`. Error 400 tidak dilempar ulang, tapi menghasilkan `tidak_terbaca`.

- [ ] **Step 1:** Tes dengan klien palsu yang mengembalikan JSON terstruktur:
  - Satu gambar berisi dua platform menghasilkan dua `readings`, dengan Shopee omzet `{1317034,false}` dan TikTok omzet `{578000,true}`.
  - Omzet TikTok `null` menghasilkan satu reading saja (Shopee).
  - `jenis:"bukan_layar_live"` menghasilkan `{ok:false, reason:"bukan_layar_live"}`.
  - Refusal menghasilkan `ditolak`.
  - Klien yang melempar `RateLimitError` membuat `extract` ikut melempar.
- [ ] **Step 2:** Jalankan tes. Hasil yang diharapkan: **FAIL**. Implementasikan, lalu jalankan lagi. Hasil yang diharapkan: **PASS**.
- [ ] **Step 3:** Tulis `scripts/smoke-extract.ts` yang membaca `live-17nov.jpg` lalu mencetak hasil dan selisihnya dengan nilai acuan berikut:
  - Shopee: omzet 1317034, pesanan 13, dilihat 952, keranjang 62, komentar 215, penonton aktif 73, rata-rata nonton 38 detik, durasi 39632 detik.
  - TikTok: omzet 578000 (dibulatkan), pesanan 7, tayangan 770, impresi 23700, komentar 213, pengikut 5.

  Script dilewati dengan pesan jelas kalau `ANTHROPIC_API_KEY` tidak ada. Script ini dijalankan di Task 15 dengan key milik user.
  - **Lulus kalau:** semua field cocok.
- [ ] **Step 4:** Commit.

---

### Task 10: Klien WAHA dan gateway Google Sheets/Drive

**Files:**
- Create: `bot/src/infra/waha.ts`, `bot/src/infra/sheets.ts`, `bot/scripts/google-auth.ts`
- Test: `bot/test/waha.test.ts`, `bot/test/sheets-mapping.test.ts`

**Interfaces:**
- Produces, `WahaClient`:
  - `parseIncoming(payload: unknown): Incoming | null`, dengan `Incoming = { id, chatId, from, ts: Date, text: string, hasImage: boolean, mediaUrl?: string, replyToId?: string }`
  - `sendText(chatId, text, replyToId?)`
  - `download(mediaUrl): Promise<{ buf: Buffer; mime: string }>`
  - `messagesSince(chatId, since: Date): Promise<Incoming[]>`
  - `sessionStatus(): Promise<string>`
- Produces, `SheetsGateway`:
  - `readSettings(): Promise<Settings>`
  - `readKoreksiKeputusan()`, `readAtribusi()`, `readKehadiran()`, `readGangguan()`, `readKalenderLive()`
  - `apply(op: SheetOp)`, dengan `SheetOp` berupa: `appendSesi` | `upsertKredit` (berdasarkan messageId+host) | `writeTargetHarian` (ganti semua baris satu bulan) | `appendKoreksi` | `appendGangguan` | `appendKehadiran` | `writeKondisi` (kotak "kondisi saat ini": streak dan status hari ini) | `writeHeartbeat` | `appendLog`
  - `readKontrol(): Promise<Record<string, number>>`, membaca nilai rumus di tab Kontrol untuk pengecekan silang
  - `uploadBukti(buf, name): Promise<string>`
  - `readJadwal(): Promise<Array<{ date, host, mulai, selesai }>>` (membaca tab Data Jadwal)
- Produces, fungsi murni pemetaan baris: `toSesiRows(entries)`, `toKreditSheetRows(rows: KreditRow[])`, `toTargetHarianRows(targets)`, `fromSettingsRows(rows)`. Tabel target bulanan di Pengaturan dibaca sebagai `{ "2026-10": …, "2026-11": … }`.

- [ ] **Step 1:** Tes `parseIncoming` dengan fixture dari Task 0:
  - Foto bercaption menghasilkan `hasImage:true` dan `text:"Brando"`.
  - Teks menghasilkan `hasImage:false`.
  - Balasan berisi `replyToId`.
  - Payload pesan dari chat lain tetap diparsing. Penyaringan grup terjadi di Task 11.
- [ ] **Step 2:** Tes pemetaan baris:
  - `fromSettingsRows` membaca `Jadwal aktif: TIDAK` menjadi `jadwalAktif:false`, dan target `Rp60.000.000` menjadi `{ "2026-11": 60000000 }`.
  - `toSesiRows` menghasilkan kolom yang sesuai dengan `format-live.png` tab Sesi Live, termasuk keterangan `dibulatkan` atau `live mati – layar akhir`.
- [ ] **Step 3:** Jalankan tes. Hasil yang diharapkan: **FAIL**. Implementasikan:
  - Klien WAHA memakai `fetch` dengan header `X-Api-Key`. Path endpoint mengikuti versi WAHA yang terpasang di Task 0 dan dicatat di komentar.
  - Gateway Google memakai `googleapis` dengan `OAuth2Client` dan refresh token.
  - `google-auth.ts` menjalankan alur "installed app" (scope `spreadsheets` dan `drive.file`) lalu mencetak refresh token.

  Jalankan lagi. Hasil yang diharapkan: **PASS**.
- [ ] **Step 4:** Commit.

---

### Task 11: Orkestrasi pesan grup

**Files:**
- Create: `bot/src/app/handleMessage.ts`
- Test: `bot/test/handleMessage.test.ts`

**Interfaces:**
- Consumes: Task 3, 4, 7, 8, 9, dan 10.
- Produces: `handleMessage(m: Incoming, deps: { config: Config, db, waha, extractor, sheets, settings: Settings, now: () => Date }): Promise<void>`

**Perilaku:**
1. Abaikan pesan kalau `m.chatId !== LIVE_GROUP_ID`, atau kalau `db.markMessage` mengembalikan `false`.
2. **Teks berupa perintah** (`parseCommand`):
   - Tambahkan baris di tab Gangguan atau Kehadiran dengan status `Menunggu`, dan host diambil dari nama pengirim. Kalau pengirim tidak dikenal, host dibiarkan kosong untuk diisi owner.
   - Balas dengan `msgAckPerintah`.
   - Untuk `#gangguan`, simpan `gangguanAktif` di kv sampai ada `#normal`.
3. **Balasan teks ke tanda terima bot yang berisi angka:** tambahkan baris di tab Koreksi dengan status `Menunggu`, lalu balas singkat.
4. **Balasan foto ke pesan `msgMintaRiwayat`:** proses sebagai layar akhir dengan `effectiveAt` = 1 detik sebelum laporan pertama siaran baru.
5. **Gambar:**
   - Cocokkan caption.
     - Hasil `kosong`, `tidak_dikenal`, atau `ganda`: simpan di `pendingCaption`, lalu balas `msgSiapa`.
     - Kalau nanti datang balasan berupa nama, lanjutkan proses gambar itu.
   - Unduh gambar, lalu panggil `extract`.
     - Kalau error dilempar: simpan di `pendingExtract`, lalu balas `msgDiproses`.
     - Kalau hasilnya `ok:false`: balas `msgKirimUlang`. Tidak ada data yang disimpan.
     - Kalau berhasil: simpan satu `Report` per platform, unggah bukti ke antrean, bangun ledger hari itu, lalu balas `msgTanda` dengan kredit entri baru.
     - Kalau ada entri `siaran_belum_lengkap`: kirim juga `msgMintaRiwayat`.
6. **Semua penulisan ke Sheets lewat `db.outbox`**, tidak pernah langsung.

- [ ] **Step 1:** Tes dengan fake (db di memori, waha palsu yang merekam pesan terkirim, extractor palsu, sheets palsu). Masing-masing satu tes:
  - (a) Foto dengan caption `Brando` menghasilkan 2 laporan dan 1 tanda terima yang memuat `Brando`.
  - (b) Foto tanpa caption memicu `msgSiapa`. Balasan `Vanna` membuat laporan tersimpan atas nama Vanna.
  - (c) Extractor `bukan_layar_live` memicu `msgKirimUlang`, dan tidak ada laporan tersimpan.
  - (d) Extractor melempar error: pesan masuk ke `pendingExtract` dan bot membalas `msgDiproses`.
  - (e) ID pesan yang sama dua kali hanya diproses sekali.
  - (f) `#izin sakit` dari Brando menghasilkan operasi `appendKehadiran` dengan status `Menunggu`.
  - (g) `#gangguan listrik` lalu `#normal` membuat kv `gangguanAktif` terisi lalu kosong.
  - (h) Balasan `koreksi shopee 1.350.000` menghasilkan `appendKoreksi`.
  - (i) Pesan dari grup lain diabaikan.
  - (j) Dua pesan beruntun (TikTok lalu Shopee dalam 1 menit, host sama) menghasilkan dua tanda terima, dan tiap platform hanya mendapat kredit sekali.
- [ ] **Step 2:** Jalankan tes. Hasil yang diharapkan: **FAIL**. Implementasikan, lalu jalankan lagi. Hasil yang diharapkan: **PASS**.
- [ ] **Step 3:** Commit.

---

### Task 12: Refresh, penjadwal, catch-up, dan detak

**Files:**
- Create: `bot/src/app/refresh.ts`, `bot/src/app/scheduler.ts`, `bot/src/server.ts`, `bot/Dockerfile`
- Test: `bot/test/refresh.test.ts`, `bot/test/scheduler.test.ts`

**Interfaces:**
- Produces:
  - `refresh(deps, today: string): Promise<{ summaries: HostSummary[]; eskalasiBaru: string[] }>`. Fungsi ini membaca input owner, menerapkan koreksi dan atribusi yang disetujui, lalu menghitung target, ledger, dan rekap.
    - Antrekan `upsertKredit` untuk semua entri bulan berjalan. Bulan lalu juga, kalau ada koreksi atau atribusi yang berubah.
    - Antrekan `writeTargetHarian` untuk bulan yang inputnya berubah.
    - Antrekan `writeKondisi` dan `appendSesi` untuk entri yang belum ditulis.
    - Angka dashboard tidak pernah ditulis sebagai nilai. Semuanya rumus (Task 6b).
  - `startScheduler(deps)` dengan tugas berikut:
    - **Pagi** pada `jamPagi`: kirim `msgPagi` ke grup. Kalau jadwal aktif, hanya untuk host yang masuk shift; kalau tidak, untuk semua host. Tidak dikirim selama `gangguanAktif`.
    - **Rekap** pada `jamRekap`, atau 30 menit setelah laporan terakhir kalau lewat dari `jamRekap`: kirim `msgRekap` ke grup dan `msgOwner` pribadi ke owner.
    - **Akhir shift**, hanya kalau jadwal aktif: tag host yang belum lapor.
    - **Refresh** setiap 15 menit.
    - **Flush antrean** setiap 1 menit. Operasi yang gagal dicoba lagi setelah 1, 2, 4, … menit, maksimal 30 menit.
    - **Detak** setiap 5 menit: tulis `writeHeartbeat(now, waStatus)`.
    - **Proses ulang** `pendingExtract` setiap 5 menit.
    - **Pengecekan silang** setiap hari pukul 23:50:
      - Bandingkan `readKontrol()` (rumus "bulan ini" per host) dengan `summarizeHosts`.
      - Kalau selisihnya lebih dari Rp1, catat di Log Bot dan kirim pesan pribadi ke owner: "Angka dashboard tidak cocok untuk <host>, sedang dicek".
  - `catchUp(deps)` saat start: `messagesSince(LIVE_GROUP_ID, lastProcessedTs − 5 menit)`, diurutkan menurut `ts`, lalu setiap pesan masuk ke `handleMessage`.
  - `sendCapped(waId, text)`: kirim pesan inisiatif bot, kecuali kalau `sentCount ≥ maxPesanPerHari`. Dalam hal itu pesan tidak dikirim dan dicatat ke Log Bot.

- [ ] **Step 1:** Tes `refresh`:
  - Eskalasi owner dikirim sekali per awal streak 3 hari, dan tidak dikirim lagi esok harinya untuk streak yang sama.
  - Koreksi yang disetujui mengubah realisasi.
- [ ] **Step 2:** Tes penjadwal dengan jam palsu (`vi.useFakeTimers`, zona Asia/Jakarta):
  - Pagi dikirim tepat 08:00 dan hanya sekali.
  - Selama `gangguanAktif` tidak ada pesan pagi atau tagihan.
  - Rekap dikirim 22:30. Kalau laporan terakhir 23:05, rekap mundur ke 23:35.
  - Kalau jadwal tidak aktif, tidak ada tag akhir shift.
  - `sendCapped` berhenti setelah 6 pesan.
- [ ] **Step 3:** Tes `catchUp`: tiga pesan masuk saat bot mati, dan salah satunya sudah ditandai. Hasil yang diharapkan: dua sisanya diproses berurutan, tidak ada yang dobel.
- [ ] **Step 3b:** Tes pengecekan silang. Gateway palsu mengembalikan nilai Kontrol Brando 11.200.001 dibanding hasil TS 11.200.000, lalu 11.300.000. Hasil yang diharapkan: yang pertama tidak memicu pesan, yang kedua memicu satu pesan ke owner dan satu baris Log Bot.
- [ ] **Step 4:** Jalankan tes. Hasil yang diharapkan: **FAIL**. Implementasikan, termasuk:
  - `server.ts`: express dengan `POST /webhook/waha` yang memverifikasi header rahasia dari `.env`, lalu memanggil `handleMessage`. Pemrosesan diserialkan dengan antrean satu-per-satu.
  - `GET /health` mengembalikan `200 {ok, waStatus}`.
  - `Dockerfile` berbasis node:20-slim.

  Jalankan lagi. Hasil yang diharapkan: **PASS**. Jalankan juga `npm test`. Hasil yang diharapkan: semua tes PASS.
- [ ] **Step 5:** Commit.

---

### Task 13: Spreadsheet CP – Live Tracker dan pemeriksa detak

**Files:**
- Create: `bot/scripts/setup-sheet.ts`, `apps-script/heartbeat.gs`
- Test: `bot/test/setup-sheet.test.ts` (menguji fungsi murni `sheetBlueprint()`)

**Interfaces:**
- Produces: `sheetBlueprint(): Array<{ title: string; headers: string[]; editableRanges: string[]; editors: "owner" | "none"; formulas?: Record<string, string>; validations?: Array<{ range: string; kind: "list" | "date"; values?: string[] }>; hidden?: boolean }>`, untuk tab berikut:
  - Dashboard Host: baris filter `B2/D2/F2/H2` bisa diedit owner, dengan validasi daftar preset dan tanggal. Rumus diambil dari Task 6b. Kotak "Kondisi saat ini" ditulis bot.
  - Harian per Host: memakai filter sendiri. Barisnya tanggal di rentang terpilih (maksimal 92), kolomnya host.
  - Analisis Live: memakai filter sendiri.
  - Tren Bulanan
  - Data Kredit: ditulis bot, terkunci.
  - Target Harian: ditulis bot, terkunci.
  - Kontrol: tersembunyi.
  - Sesi Live
  - Koreksi & Atribusi (kolom yang bisa diedit: Keputusan, Host atribusi, Porsi)
  - Gangguan (kolom yang bisa diedit: Keputusan, Host)
  - Kehadiran, dengan kolom Tanggal, Host, Jenis (Sakit/Izin/Cuti/Telat), Alasan, Sumber, Keputusan. Semua kolom bisa diedit kecuali Sumber. Cuti juga dicatat di tab ini.
  - Kalender Live (bisa diedit)
  - Pengaturan (kolom Nilai bisa diedit)
  - Log Bot
  - Heartbeat
- `setup-sheet.ts` memakai blueprint itu untuk membuat spreadsheet milik owner (OAuth Task 10), mengisi Pengaturan dengan nilai bawaan Global Constraints, memasang protected range (hanya owner dan bot), lalu membuat folder Drive "Bukti Live".
- `heartbeat.gs` dijalankan oleh trigger waktu setiap 10 menit:
  - Baca tab Heartbeat.
  - Kalau `now − lastSeen > 10 menit` atau `waStatus !== "WORKING"`, kirim email ke `ownerEmail`, sekali per kejadian. Penanda kejadian disimpan di `PropertiesService`.
  - Saat kondisi pulih, kirim email "pulih".

- [ ] **Step 1:** Tes `sheetBlueprint`:
  - Ada 15 tab.
  - Setiap tab dashboard dan analisis punya validasi daftar di `B2` dengan 9 preset, validasi tanggal di `D2` dan `F2`, dan hanya `B2:H2` yang bisa diedit owner.
  - Rumus di blueprint identik dengan `dashboardFormulas()`.
  - Pengaturan hanya mengizinkan kolom Nilai diedit.
  - Sesi Live tidak punya rentang yang bisa diedit.
  - Header Dashboard Host sama dengan kolom di `format-live.png`.
- [ ] **Step 2:** Jalankan tes. Hasil yang diharapkan: **FAIL**. Implementasikan, lalu jalankan lagi. Hasil yang diharapkan: **PASS**.
- [ ] **Step 3:** Commit.

---

### Task 14: Deploy, panduan, dan uji skenario (bersama user)

**Files:**
- Modify: `deploy/docker-compose.yml` (tambah service `bot`, volume `./data:/data`, webhook WAHA ke `http://bot:3000/webhook/waha`, event `message`)
- Modify: `deploy/.env.example`
- Create: `docs/panduan-vps.md` bagian 2–4 (Google auth, setup sheet, menjalankan bot)
- Create: `docs/uji-skenario.md`

**Langkah:**
- [ ] **Step 1:** Lengkapi panduan:
  - Menjalankan `google-auth.ts` di komputer user dan memasukkan refresh token ke `.env` di VPS.
  - Menjalankan `setup-sheet.ts`.
  - Memasang `heartbeat.gs` beserta trigger-nya.
  - `docker compose up -d`.
  - Mengisi tab Pengaturan: target, nomor WA owner dan host, email owner.
  - Service WAHA di `deploy/docker-compose.yml`: set `WHATSAPP_FILES_LIFETIME=3600` (detik). Tautan media WAHA kedaluwarsa setelah waktu ini; bot mengunduh gambar segera saat diterima dan mengambil tautan segar menurut id bila unduhan gagal, tetapi umur file yang cukup panjang tetap perlu (catatan final review I1).
- [ ] **Step 2:** User menjalankan panduan. Jalankan `npm run smoke:extract` di VPS. Hasil yang diharapkan: semua field cocok dengan nilai acuan (Task 9).
- [ ] **Step 3:** Jalankan `docs/uji-skenario.md` bersama user di grup uji. Untuk setiap skenario, catat hasil yang diharapkan dan hasil nyata:
  1. **Alur normal:** dua host bergantian, tanda terima benar, Sesi Live terisi, dashboard berubah dalam 15 menit.
  2. **Bot mati 15 menit:** `docker compose stop bot`, kirim 2 screenshot, lalu `start`. Kedua laporan diproses berurutan tanpa dobel. Email detak masuk setelah lebih dari 10 menit.
  3. **WA logout:** dalam 10 menit masuk email "WA terputus".
  4. **API key salah:** bot membalas "sedang diproses". Setelah key diperbaiki, laporan diproses dari antrean.
  5. **Foto buram:** bot meminta kirim ulang, dan tidak ada data yang tercatat.
  6. **`#gangguan listrik` lalu `#normal`:** baris Gangguan berstatus Menunggu. Setelah owner menyetujui, target pribadi host berkurang dan target tim tetap.
  7. **`#izin sakit`:** setelah disetujui, target hari itu gugur.
  8. **Live di-reset di tengah sesi:** dengan screenshot layar akhir, kredit benar. Tanpa layar akhir, muncul "siaran belum lengkap" dan permintaan riwayat.
  9. **Laporan pergantian dilewati** (jeda lebih dari 240 menit): muncul baris "belum teratribusi" di Koreksi & Atribusi. Setelah owner memecah 50/50, realisasi ikut berubah.
  10. **Caption salah** (`Rina`): bot bertanya "Ini laporan siapa?".
  11. **Filter periode:**
      - Ganti Dashboard Host ke `Kemarin`, `Minggu lalu`, `Bulan lalu`, dan `Custom` (rentang yang mencakup data uji). Angka harus berubah seketika dan cocok dengan penjumlahan manual dari Data Kredit.
      - Pembanding `Periode sebelumnya` menampilkan rentang yang benar.
      - Custom terbalik (Dari > Sampai) menampilkan "Tanggal tidak valid".
      - Tab Kontrol cocok dengan angka bot pada pengecekan silang malam itu.
- [ ] **Step 4:** Semua skenario harus lulus. Skenario yang gagal kembali ke task pemiliknya, dimulai dengan tes yang mereproduksi kegagalan itu.
- [ ] **Step 5:** Go-live: pindahkan bot ke grup **CP Live** asli dengan Jadwal aktif = TIDAK. Commit dokumen dan push ke repo.

---

### Task 15: Simpan kode di repo GitHub privat (bersama user)

- [ ] **Step 1:** Minta user membuat repo privat, misalnya `cp-sistem`, lalu hubungkan ke sesi ini dengan akses push.
- [ ] **Step 2:** `git remote add origin …`, lalu `git push -u origin main`.
- [ ] **Step 3:** Di VPS, `git clone` repo itu. Panduan Task 14 memakai `git pull` untuk pembaruan.

Task ini dikerjakan **sebelum Task 14**, dan sebaiknya sesegera mungkin setelah Task 1, supaya pekerjaan tidak hilang kalau kontainer sesi ini berakhir.

---

## Di luar Tahap 1 (sengaja ditunda)

- **Pengingat tepat di jam pergantian berdasarkan tabel Pola Sesi**, termasuk tagih ulang 15 menit dan lapor owner 60 menit (rancangan 6.2). Ditunda sampai owner memutuskan pola sesi. Untuk sementara, tab Pengaturan menyimpan tabel Pola Sesi yang masih kosong.
- **Bobot hari campaign di target harian.**
- **Rapor Host di file Management** (Tahap 4).
- **Jalur konten** (Tahap 2–3).
