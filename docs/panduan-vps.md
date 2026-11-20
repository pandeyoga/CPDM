# Panduan memasang bot CP Live di VPS

Panduan ini untuk pemilik agensi (bukan developer). Ikuti berurutan, satu perintah per kotak, salin lalu tempel ke terminal.
Kalau ada langkah yang gagal, jangan lanjut: lihat bagian **Pemecahan masalah** di akhir, atau minta bantuan.

> **Aturan keselamatan.** Semua rahasia (API key, sandi, client secret, refresh token) hanya ditulis di berkas `.env` di VPS atau diketik di terminal Anda sendiri. **Jangan pernah menempelkannya ke chat, email, atau dokumen bersama**, termasuk saat meminta bantuan. Kalau perlu menunjukkan hasil perintah, pastikan tidak ada rahasia di dalamnya.

Gambaran sistem:

- **WAHA** = program yang menghubungkan satu nomor WhatsApp (nomor bot) ke komputer.
- **Bot** = program yang membaca screenshot di grup WhatsApp, mencatatnya ke Google Sheets, dan membalas.
- Keduanya berjalan di VPS memakai Docker. Dashboard WAHA **tidak** dibuka ke internet; Anda membukanya lewat SSH tunnel dari komputer Anda.

Dalam panduan ini, tanda `~` berarti folder rumah Anda di VPS, dan `deploy` adalah folder `~/cp-sistem/deploy`.

---

## 0. Yang harus disiapkan dulu

- [ ] **VPS Linux** (Ubuntu 22.04/24.04 atau Debian 12), RAM 1–2 GB, akses SSH.
- [ ] **Nomor WhatsApp khusus bot** (nomor baru, jangan nomor pribadi) dan **HP** yang memegang nomor itu untuk scan QR.
- [ ] **Akun Google owner** (akun yang nantinya memiliki spreadsheet "CP – Live Tracker").
- [ ] **API key Claude** dari <https://console.anthropic.com> (menu API Keys; pastikan ada saldo/kredit). Bentuknya `sk-ant-...`.
- [ ] **Repo GitHub privat** berisi kode `cp-sistem` ini.
- [ ] Sebuah **komputer** (laptop) dengan browser, untuk langkah 4 (tunnel) dan 5 (login Google).

---

## 1. Pasang Docker di VPS

Masuk ke VPS lewat SSH, lalu cek sistem operasi:

```bash
cat /etc/os-release
```

Pastikan tertulis Ubuntu atau Debian. Pasang Docker memakai skrip resmi:

```bash
curl -fsSL https://get.docker.com | sudo sh
```

Izinkan akun Anda memakai Docker tanpa `sudo`:

```bash
sudo usermod -aG docker $USER
```

**Keluar dari SSH lalu masuk lagi** (supaya izin berlaku). Cek:

```bash
docker --version && docker compose version
```

Kedua perintah harus menampilkan nomor versi. (Opsional tapi disarankan) aktifkan firewall yang hanya membuka SSH:

```bash
sudo ufw allow OpenSSH && sudo ufw --force enable
```

---

## 2. Ambil kode dari GitHub (repo privat)

Repo privat butuh "kunci" supaya VPS boleh membacanya. Buat kunci khusus baca:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -t ed25519 -f ~/.ssh/cp_deploy -N "" -C "vps-cp-live"
```

Tampilkan **kunci publik** (aman untuk disalin; ini bukan rahasia):

```bash
cat ~/.ssh/cp_deploy.pub
```

Di GitHub: buka repo > **Settings** > **Deploy keys** > **Add deploy key**. Beri judul `vps-cp-live`, tempel isi kunci publik tadi, **biarkan "Allow write access" tidak dicentang**, lalu simpan.

Beritahu SSH memakai kunci itu untuk GitHub:

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/cp_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config && chmod 600 ~/.ssh/config
```

Ambil kode (ganti `NAMA_GITHUB/cp-sistem` dengan nama repo Anda yang sebenarnya):

```bash
git clone git@github.com:NAMA_GITHUB/cp-sistem.git ~/cp-sistem
```

Kalau ditanya "Are you sure you want to continue connecting", ketik `yes`. Lalu masuk ke folder deploy:

```bash
cd ~/cp-sistem/deploy
```

---

## 3. Buat berkas `.env` dari contoh

```bash
cp .env.example .env && chmod 600 .env
```

Anda perlu dua kunci acak dan satu sandi dashboard. Untuk dua kunci (`WAHA_API_KEY` dan `WAHA_HMAC_KEY`), jalankan perintah ini **dua kali** (tiap hasilnya 64 karakter) dan catat tiap hasilnya di tempat aman (mis. pengelola sandi) untuk dimasukkan ke `.env`:

```bash
openssl rand -hex 32
```

Untuk sandi dashboard, buat satu lagi yang lebih pendek:

```bash
openssl rand -hex 16
```

Buka `.env` untuk diisi:

```bash
nano .env
```

Isi sekarang (sisanya nanti pada langkah berikutnya):

| Variabel | Isi |
|---|---|
| `WAHA_API_KEY` | hasil `openssl rand -hex 32` pertama |
| `WAHA_HMAC_KEY` | hasil `openssl rand -hex 32` kedua (**beda** dari yang pertama) |
| `WAHA_DASHBOARD_PASSWORD` | hasil `openssl rand -hex 16`, atau sandi kuat lain |
| `ANTHROPIC_API_KEY` | API key Claude Anda (`sk-ant-...`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | diisi di langkah 5 |
| `GOOGLE_REFRESH_TOKEN` | diisi di langkah 5 |
| `LIVE_SPREADSHEET_ID`, `BUKTI_FOLDER_ID` | diisi di langkah 6 (kosongkan dulu) |
| `LIVE_GROUP_ID` | diisi di langkah 4 |

Simpan di `nano`: tekan `Ctrl+O`, `Enter`, lalu `Ctrl+X`.

---

## 4. Jalankan WAHA saja dan uji dengan WhatsApp sungguhan (Task 0)

Langkah ini juga menghasilkan contoh pesan asli yang dipakai untuk memastikan bot membaca format WhatsApp dengan benar. **Jalankan hanya WAHA dulu, bot belum**:

```bash
cd ~/cp-sistem/deploy && docker compose up -d waha
```

Cek sudah berjalan (status `Up`):

```bash
docker compose ps
```

### 4a. Buka dashboard lewat SSH tunnel

Dashboard hanya mendengarkan di `127.0.0.1` VPS, jadi dibuka lewat "terowongan" dari **komputer Anda** (bukan dari VPS). Di terminal komputer Anda (Mac/Linux/Windows PowerShell), ganti `USER` dan `IP_VPS`:

```bash
ssh -L 3000:127.0.0.1:3000 USER@IP_VPS
```

Biarkan jendela itu terbuka. Di browser komputer Anda buka:

```
http://localhost:3000/dashboard
```

Masuk dengan username `admin` dan sandi `WAHA_DASHBOARD_PASSWORD` dari `.env`. (Kalau port 3000 di komputer Anda sudah terpakai, ganti `3000:127.0.0.1:3000` menjadi `3001:127.0.0.1:3000` lalu buka `localhost:3001`.)

### 4b. Scan QR dengan HP nomor bot

1. Di dashboard, pilih sesi **default** lalu **Start** (kalau belum jalan).
2. Muncul kode QR. Di HP nomor bot: WhatsApp > **Perangkat tertaut** > **Tautkan perangkat** > scan QR.
3. Status sesi harus berubah menjadi **WORKING**.

### 4c. Buat grup uji dan kirim contoh

1. Dengan HP lain (HP Anda), buat grup WhatsApp bernama **CP Live** (untuk uji, nanti bot dipindah ke grup CP Live yang asli di langkah akhir) dan masukkan **nomor bot**.
2. Di grup itu kirim tiga hal:
   1. **Foto contoh** `live-17nov.jpg` (screenshot data live) dengan caption `Brando`. Berkasnya ada di repo GitHub di `bot/test/fixtures/screens/live-17nov.jpg`: buka di GitHub, klik **Download raw file**, kirim ke HP Anda (atau minta pengembang mengirimkannya), lalu kirim ke grup sebagai foto.
   2. Teks `#izin sakit`.
   3. **Balas (reply)** pesan foto tadi dengan teks apa saja, mis. `koreksi shopee 1.350.000`.
3. Supaya uji lengkap, tambahkan juga:
   - Minta **orang lain** (HP lain) menulis satu pesan di grup. Ini untuk melihat apakah pengirimnya muncul sebagai nomor (`...@c.us`) atau sebagai kode `...@lid`.
   - Kirim **foto "lihat sekali"** (view once) atau video pendek, untuk melihat bentuk pesan media yang gagal diunduh.

### 4d. Ambil data dengan curl (di VPS)

Siapkan variabel kunci (tidak menampilkannya di layar):

```bash
cd ~/cp-sistem/deploy && export WAHA_API_KEY=$(grep '^WAHA_API_KEY=' .env | cut -d= -f2-)
```

**Status sesi** (harus berisi `"status": "WORKING"`):

```bash
curl -s -H "X-Api-Key: $WAHA_API_KEY" http://127.0.0.1:3000/api/sessions/default | python3 -m json.tool > session-status.json; cat session-status.json
```

> Kalau ada alamat API yang menghasilkan `404`, daftar alamat yang benar untuk versi WAHA Anda ada di Swagger: `http://localhost:3000/` (lewat tunnel yang sama dengan dashboard).

**Cari ID grup** (nama grup "CP Live", ID berakhiran `@g.us`):

```bash
curl -s -H "X-Api-Key: $WAHA_API_KEY" http://127.0.0.1:3000/api/default/groups | python3 -m json.tool | grep -n -B2 -A2 "g.us"
```

Salin ID grup (bentuknya `120363xxxxxxxxxx@g.us`) ke `.env` sebagai `LIVE_GROUP_ID` (`nano .env`). Lalu simpan ke variabel untuk perintah berikutnya (ganti ID-nya):

```bash
export GRUP="120363xxxxxxxxxx@g.us"
```

**Pesan grup** (20 pesan terakhir, dengan media):

```bash
curl -s -H "X-Api-Key: $WAHA_API_KEY" "http://127.0.0.1:3000/api/default/chats/$GRUP/messages?limit=20&downloadMedia=true" | python3 -m json.tool > pesan-grup.json; wc -l pesan-grup.json
```

### 4e. Pemeriksaan Task 0 (centang satu per satu)

**(1) Gambar dari grup diterima dan bisa diunduh.** Lihat pesan foto: harus ada `"body": "Brando"` (caption), `"hasMedia": true`, dan `media.url`.

```bash
grep -n -E '"body"|"hasMedia"|"url"|"mimetype"' pesan-grup.json | head -40
```

Ambil alamat `url` foto dari hasil di atas, lalu unduh dengan kunci (ganti `ALAMAT_URL`):

```bash
curl -s -H "X-Api-Key: $WAHA_API_KEY" -o foto-uji.jpg "ALAMAT_URL" && file foto-uji.jpg
```

Hasilnya harus `JPEG image data`. **Kalau gambar dari grup tidak diterima atau tidak bisa diunduh: BERHENTI** dan laporkan, jangan lanjut ke langkah berikutnya.

**(2) Bentuk ID pesan.** Lihat beberapa ID, catat bentuknya (mis. `false_120363...@g.us_3EB0..._628...@c.us`):

```bash
grep -n '"id"' pesan-grup.json | head -10
```

**(3) Pesan lebih dari 100 (bila memungkinkan).** Bot mengambil pesan lama dengan `limit=100`. Kalau grup sudah punya lebih dari 100 pesan, cek apakah halaman berikutnya bisa diambil:

```bash
curl -s -H "X-Api-Key: $WAHA_API_KEY" "http://127.0.0.1:3000/api/default/chats/$GRUP/messages?limit=100&offset=100" | python3 -m json.tool | grep -c '"id"'
```

Catat angkanya (0 berarti tidak ada halaman kedua atau parameter `offset` tidak berlaku; ini informasi, bukan kegagalan). Kalau grup uji masih sedikit pesan, lewati dan tulis "belum diuji".

**(4) Payload media yang gagal.** Dari foto "lihat sekali"/video tadi, cari pesan yang `"hasMedia": true` tetapi `media` kosong atau berisi `error`:

```bash
grep -n -B3 -A8 '"error"' pesan-grup.json | head -60
```

Cara kedua: tunggu lebih dari 1 jam (umur berkas `WHATSAPP_FILES_LIFETIME=3600`), lalu unduh ulang `url` foto lama; harus gagal (404). Catat bentuk jawabannya.

**(5) Pengirim berupa `@lid`.** Dari pesan orang lain tadi, lihat kolom pengirim (`participant`, `author`, atau `from`):

```bash
grep -n -E '"participant"|"author"|"from"' pesan-grup.json | head -20
```

Catat apakah berakhiran `@c.us` (nomor telepon) atau `@lid` (kode acak). Kalau `@lid`, pencocokan "No WA host" di tab Pengaturan perlu diperhatikan: laporkan, jangan diabaikan.

### 4f. Simpan hasil dengan nomor disamarkan

Samarkan nomor telepon (62xxxxxxxxxx menjadi `628xxxxxxxxx`) pada berkas hasil sebelum dibagikan:

```bash
sed -i -E 's/62[0-9]{8,12}@(c\.us|s\.whatsapp\.net)/628xxxxxxxxx@\1/g; s/"62[0-9]{8,12}"/"628xxxxxxxxx"/g' pesan-grup.json session-status.json
```

**Periksa sendiri isi kedua berkas dengan mata** (`less pesan-grup.json`) sebelum dibagikan: nama kontak (`pushName`/`notifyName`) dan nomor dalam bentuk lain bisa masih muncul; samarkan manual bila ada. Pastikan juga **tidak ada kunci rahasia** di dalamnya (hasilnya harus `0`):

```bash
grep -c "$WAHA_API_KEY" pesan-grup.json session-status.json
```

Berkas yang disamarkan inilah yang dipakai sebagai contoh data uji di kode (`bot/test/fixtures/waha/`): `group-image-caption.json`, `group-text.json`, `group-reply.json`, `session-status.json`. Bagikan berkas-berkas itu (bukan `.env`) kepada pengembang.

---

## 5. Google: izin akses Sheets dan Drive

Bot menulis ke Google Sheets dan Drive atas nama akun Google owner. Anda membuat "kunci aplikasi" sekali, lalu menjalankan satu program di **komputer Anda** (karena butuh browser).

### 5a. Buat proyek dan aktifkan API

1. Buka <https://console.cloud.google.com> dengan akun Google owner.
2. Buat proyek baru, nama bebas (mis. `CP Live`).
3. Menu **APIs & Services** > **Library**. Cari dan **Enable** dua API: **Google Sheets API** dan **Google Drive API**.

### 5b. Layar persetujuan (consent screen) — status HARUS "In production"

1. **APIs & Services** > **OAuth consent screen** (di tampilan baru: **Google Auth Platform**).
2. Tipe pengguna **External**. Isi nama aplikasi (mis. `CP Live`), email dukungan, dan email kontak developer (email Anda).
3. Cari **Publishing status** (atau menu **Audience**). Jika tertulis **Testing**, klik **Publish app** sampai berstatus **In production**.

> **Penting:** kalau dibiarkan "Testing", refresh token Google **kedaluwarsa tiap 7 hari** dan bot tiba-tiba berhenti menulis ke spreadsheet. "In production" tanpa verifikasi Google tidak apa-apa untuk dipakai sendiri; Anda hanya akan melihat peringatan "Google hasn't verified this app" saat login (klik **Advanced** > **Go to ... (unsafe)**; ini aplikasi Anda sendiri).

### 5c. Buat OAuth client tipe Desktop

1. **APIs & Services** > **Credentials** > **Create credentials** > **OAuth client ID**.
2. **Application type: Desktop app**, nama bebas, **Create**.
3. Akan tampil **Client ID** dan **Client secret**. Salin keduanya ke `.env` di VPS (`nano .env`): `GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET`. Jangan kirim ke chat.

### 5d. Dapatkan refresh token (di KOMPUTER Anda, bukan VPS)

Di komputer perlu **Node.js 22** (unduh dari <https://nodejs.org>) dan salinan kode. Di terminal komputer:

```bash
git clone git@github.com:NAMA_GITHUB/cp-sistem.git && cd cp-sistem/bot
```

(Kalau komputer Anda belum punya akses GitHub, unduh repo sebagai ZIP dari GitHub, ekstrak, lalu masuk ke folder `bot`.)

```bash
npm ci --ignore-scripts && npm run build
```

Jalankan program login. Rahasia diketik lewat isian tersembunyi (tidak tersimpan di riwayat perintah). **Mac/Linux** (tiga perintah, satu per satu):

```bash
printf 'Client ID: '; read -rs GOOGLE_CLIENT_ID; echo; export GOOGLE_CLIENT_ID
```

```bash
printf 'Client secret: '; read -rs GOOGLE_CLIENT_SECRET; echo; export GOOGLE_CLIENT_SECRET
```

```bash
node dist/scripts/google-auth.js
```

**Windows (PowerShell)**, tiga perintah satu per satu:

```powershell
$env:GOOGLE_CLIENT_ID = Read-Host "Client ID"
```

```powershell
$env:GOOGLE_CLIENT_SECRET = [System.Net.NetworkCredential]::new("", (Read-Host "Client secret" -AsSecureString)).Password
```

```powershell
node dist/scripts/google-auth.js
```

Program mencetak sebuah tautan ("Buka tautan ini di browser..."). Buka tautan itu di browser, pilih akun Google owner, lalu setujui akses ke Sheets dan Drive. Setelah "Selesai" muncul di browser, kembali ke terminal: **satu baris panjang yang tercetak adalah refresh token**.

Salin baris itu ke `.env` di VPS sebagai `GOOGLE_REFRESH_TOKEN=` (`nano .env`). Jangan menempelkannya ke chat. Kalau muncul pesan "Google tidak mengembalikan refresh token", buka <https://myaccount.google.com/permissions>, cabut akses aplikasi `CP Live`, lalu jalankan ulang.

Setelah selesai, tutup jendela terminal itu supaya variabel rahasia hilang.

---

## 6. Buat spreadsheet dengan setup-sheet (di VPS)

Bangun gambar bot dulu (beberapa menit):

```bash
cd ~/cp-sistem/deploy && docker compose build bot
```

Jalankan setup-sheet. Ini membuat spreadsheet **"CP – Live Tracker"** (15 tab, rumus, proteksi) dan folder Drive **"Bukti Live"**:

```bash
docker compose run --rm --no-deps bot node dist/scripts/setup-sheet.js
```

Hasilnya dua baris:

```
LIVE_SPREADSHEET_ID=...
BUKTI_FOLDER_ID=...
```

Salin kedua nilai itu ke `.env` (`nano .env`). Aman dijalankan ulang kapan saja: isian owner tidak ditimpa, dan tab fakta diperbesar otomatis bila masih kecil.

> Spreadsheet dan folder **harus dibuat oleh program ini** (bukan buatan tangan), karena akses bot hanya mencakup berkas yang dibuatnya sendiri.

Buka spreadsheet di Google Drive (akun owner), mis. cari "CP – Live Tracker". Bagikan ke orang lain lewat tombol **Share** bila perlu.

---

## 7. Pasang detak jantung (heartbeat.gs)

Skrip ini mengirim email ke owner kalau bot mati lebih dari 10 menit atau WhatsApp terputus.

1. Buka spreadsheet "CP – Live Tracker" > **Ekstensi** > **Apps Script**.
2. Hapus kode bawaan (`function myFunction...`).
3. Salin isi berkas: paling mudah dari GitHub, buka `apps-script/heartbeat.gs` di repo, klik **Raw**, pilih semua (Ctrl+A), salin, lalu tempel ke editor Apps Script. Alternatif, tampilkan di VPS:

```bash
cat ~/cp-sistem/apps-script/heartbeat.gs
```

4. Klik ikon simpan. Di menu pilihan fungsi (di atas editor) pilih **`pasangPemicu`**, lalu klik **Jalankan**.
5. Muncul "Perlu otorisasi": **Tinjau izin** > pilih akun owner > **Lanjutan** > **Buka ... (tidak aman)** > **Izinkan**. (Skrip ini milik Anda sendiri.)
6. Cek: ikon jam (**Pemicu**) di sisi kiri harus menampilkan satu pemicu `cekDetak`, berbasis waktu, tiap 10 menit.

Email dikirim ke alamat di Pengaturan > **Email owner** (langkah 8).

---

## 8. Isi tab Pengaturan

Buka tab **Pengaturan** di spreadsheet. Hanya sel berwarna yang boleh diisi.

**Kolom A–B (pengaturan umum):**

| Sel | Pengaturan | Isi |
|---|---|---|
| B2 | Jadwal aktif | **TIDAK** (biarkan; ubah ke YA hanya bila tab Data Jadwal sudah terisi) |
| B3 / B4 | Jam live mulai / selesai | `09:00` / `22:00` (sesuaikan) |
| B5 | Jam update pagi | `08:00` |
| B6 | Jam rekap | `22:30` |
| B7 | Batas jeda (menit) | `240` |
| B8 | Batas pesan per orang per hari | `6` |
| B9 | **No WA owner** | nomor WhatsApp pribadi Anda, mis. `0812xxxxxxxx` atau `62812xxxxxxxx` |
| B10 | **Email owner** | email untuk peringatan detak (sudah terisi otomatis dengan email login Google; ubah bila perlu) |

**Kolom D–E (target):** isi **Bulan** (mis. `2026-11`) dan **Target** (total omzet tim sebulan, mis. `60000000`), satu baris per bulan.

**Kolom G–J (host, maksimal 10 baris, G2:G11):**

| G: Nama | H: No WA | I: Aktif mulai | J: Aktif selesai |
|---|---|---|---|
| Brando | 0812xxxxxxxx | (opsional) | (opsional) |

Nama host = nama yang akan ditulis di caption foto. Tulis tanpa spasi di awal/akhir. **No WA** diisi supaya bot bisa menandai (@) host.

**Jadwal aktif tetap TIDAK** selama masa uji.

---

## 9. Jalankan bot

Sampai langkah ini hanya WAHA yang berjalan; bot baru dinyalakan di sini, setelah `LIVE_GROUP_ID` (langkah 4d) dan semua variabel lain di `.env` terisi (tidak ada yang bernilai `GANTI...`), lalu buat folder data milik pengguna Docker bot (uid 1000):

```bash
cd ~/cp-sistem/deploy && mkdir -p data && sudo chown -R 1000:1000 data
```

Nyalakan semuanya:

```bash
docker compose up -d --build
```

Cek:

```bash
docker compose ps
```

Kolom status `waha` dan `bot` harus `Up` (bot akan berubah menjadi `healthy` dalam ±30 detik). Lihat log bot:

```bash
docker compose logs --tail 50 bot
```

Harus ada baris `bot: mendengarkan di port 3000` dan **tidak ada** kata `Variabel lingkungan hilang`. Cek kesehatan bot dan WhatsApp:

```bash
docker compose exec bot node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"
```

Hasilnya harus `{"ok":true,"waStatus":"WORKING"}`. Sampai 1–5 menit setelah bot baru menyala, `waStatus` bisa masih `UNKNOWN`; ulangi perintahnya sesudah beberapa menit. Dalam 5–10 menit, tab **Heartbeat** di spreadsheet terisi waktu dan `WORKING`.

---

## 10. Uji pembacaan screenshot (smoke:extract)

Mengirim foto acuan ke Claude dengan key asli dan membandingkannya dengan angka yang benar (biaya sangat kecil):

```bash
docker compose exec bot npm run smoke:extract
```

Hasil yang diharapkan: baris terakhir `LULUS: semua field cocok`, dan setiap baris berawalan `OK` dengan nilai:

| Platform | Field | Nilai acuan |
|---|---|---|
| Shopee | omzet | 1317034 |
| Shopee | pesanan | 13 |
| Shopee | penontonMasuk | 952 |
| Shopee | keranjang | 62 |
| Shopee | komentar | 215 |
| Shopee | penontonAktif | 73 |
| Shopee | rataNontonDetik | 38 |
| Shopee | durasiDetik | 39632 |
| TikTok | omzet | 578000 |
| TikTok | pesanan | 7 |
| TikTok | penontonMasuk | 770 |
| TikTok | impresi | 23700 |
| TikTok | komentar | 213 |
| TikTok | pengikutBaru | 5 |

Kalau ada baris `BEDA`, jangan lanjut ke uji skenario; kirim baris-baris `BEDA` (bukan seluruh log yang mungkin berisi hal lain) kepada pengembang.

Setelah lulus, lanjutkan ke **`docs/uji-skenario.md`**.

---

## 11. Cadangan harian database (opsional tapi sangat disarankan)

Data penting bot ada di satu berkas SQLite (`deploy/data/bot.db`). Spreadsheet sudah tersimpan di Google, tetapi antrean dan catatan internal bot hanya ada di VPS. Buat skrip cadangan:

```bash
nano ~/cp-backup.sh
```

Isi dengan:

```bash
#!/bin/bash
set -euo pipefail
cd ~/cp-sistem/deploy
TGL=$(date +%F)
# Salinan konsisten dari database yang sedang dipakai (aman walau bot hidup).
docker compose exec -T bot node -e "const D=require('better-sqlite3');new D('/data/bot.db').backup('/data/cadangan-$TGL.db').then(()=>console.log('ok'))"
# Kirim ke luar VPS: AKTIFKAN SATU baris di bawah (hapus tanda # di depannya) setelah mengganti
# USER@SERVER_LAIN dan /folder/cadangan/ dengan tujuan Anda. Dibiarkan mati supaya skrip tidak berhenti sebelum pembersihan.
# scp -q data/cadangan-$TGL.db USER@SERVER_LAIN:/folder/cadangan/
# rclone copy data/cadangan-$TGL.db remote:cp-live-cadangan/
# Hapus cadangan lokal yang lebih tua dari 7 hari.
find data -name 'cadangan-*.db' -mtime +7 -delete
```

Jadikan bisa dijalankan, coba sekali, lalu jadwalkan tiap hari pukul 03:15:

```bash
chmod +x ~/cp-backup.sh && ~/cp-backup.sh
```

```bash
(crontab -l 2>/dev/null; echo '15 3 * * * $HOME/cp-backup.sh >> $HOME/cp-backup.log 2>&1') | crontab -
```

Untuk `scp` tanpa sandi, siapkan kunci SSH ke server tujuan lebih dulu. Catatan: berkas `cadangan-*.db` berada di `deploy/data/` dan tidak ikut ke GitHub.

---

## 12. Pembaruan bot

Kalau ada versi kode baru di GitHub:

```bash
cd ~/cp-sistem && git pull
```

```bash
cd ~/cp-sistem/deploy && docker compose up -d --build
```

Cek hasilnya dengan `docker compose ps` dan `docker compose logs --tail 50 bot`. Data (database, sesi WhatsApp) tidak hilang karena tersimpan di folder `data` dan volume WAHA. Setelah pembaruan yang mengubah spreadsheet, jalankan ulang setup-sheet (langkah 6), aman diulang.

Untuk memperbarui WAHA, ubah `WAHA_TAG` di `.env` ke tag yang sudah diuji, lalu `docker compose pull waha && docker compose up -d`.

---

## Pemecahan masalah

**QR perlu di-scan ulang / status sesi bukan WORKING.** Buka dashboard lewat tunnel (langkah 4a), buka sesi **default**: jika `SCAN_QR_CODE`, scan QR lagi dengan HP nomor bot. Jika `FAILED`/`STOPPED`, klik **Stop** lalu **Start**. Cek juga di HP bot: WhatsApp > Perangkat tertaut, perangkat tidak boleh dikeluarkan. Cek status dari VPS:

```bash
docker compose exec bot node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"
```

**Email "[CP Live] Bot bermasalah" masuk.** Isi emailnya menyebut sebabnya: "Detak terakhir N menit lalu" berarti bot mati atau tidak bisa menulis ke Google; "Status WhatsApp: ..." berarti WhatsApp terputus (lihat QR di atas). Cek bot:

```bash
cd ~/cp-sistem/deploy && docker compose ps && docker compose logs --tail 100 bot
```

Kalau bot berhenti, nyalakan lagi:

```bash
docker compose up -d
```

Email "[CP Live] Bot pulih" masuk sendiri bila sudah normal. Email hanya dikirim sekali per kejadian.

**Bot diam (tidak membalas di grup).** Periksa berurutan:

1. `docker compose ps`: `bot` dan `waha` harus `Up`.
2. `docker compose logs --tail 100 bot`: cari galat. `webhook ... 401` atau penolakan tanda tangan berarti `WAHA_HMAC_KEY` di `.env` salah/berubah; setelah memperbaikinya jalankan `docker compose up -d --force-recreate`.
3. Status WhatsApp `WORKING`? (perintah health di atas).
4. `LIVE_GROUP_ID` di `.env` sama dengan ID grup sungguhan dari langkah 4d (bukan tulisan `GANTI...`), dan nomor bot masih anggota grup.
5. Caption foto memuat nama host yang ada di tab Pengaturan.
6. Saldo/kredit API key Claude masih ada (lihat console.anthropic.com). Kalau habis, bot membalas "Laporan diterima, sedang diproses." dan memprosesnya nanti dari antrean setelah diperbaiki.

**Tab spreadsheet berhenti terisi setelah ±7 hari.** Hampir pasti consent screen masih "Testing" (langkah 5b). Ubah ke "In production", ulangi langkah 5d untuk refresh token baru, perbarui `.env`, lalu `docker compose up -d --force-recreate bot`.

**Mengubah isi `.env`.** Setelah mengubah `.env`, terapkan dengan:

```bash
cd ~/cp-sistem/deploy && docker compose up -d --force-recreate
```
