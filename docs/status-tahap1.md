# Status Tahap 1 (Jalur Live)

Diperbarui: 20 November 2026

## Yang sudah selesai

Seluruh kode jalur Live sudah ditulis dan lolos pemeriksaan:
- 430 tes otomatis lolos.
- Setiap bagian diperiksa oleh pemeriksa terpisah.
- Ada pemeriksaan menyeluruh di akhir, plus satu putaran perbaikan.

Bagian-bagian sistemnya:

| Bagian | Fungsi |
|---|---|
| Bot di VPS (`bot/`) | Menerima screenshot di grup WA, membaca angkanya dengan Claude, menghitung kredit per sesi per host, mencatat ke Google Sheets, mengirim update pagi, rekap malam, dan eskalasi pribadi ke owner |
| Kondisi tidak ideal | Live mati/reset, laporan terlewat, `#izin`, `#gangguan`, bot mati lalu menyusul (catch-up), WA error dan kirim ulang, foto buram, caption salah |
| Spreadsheet CP – Live Tracker | Dibuat otomatis lewat `setup-sheet`: dashboard dengan filter periode, analisis live, tren bulanan, tab input owner yang dikunci, validasi isian |
| Pemeriksa detak (`apps-script/heartbeat.gs`) | Mengirim email ke owner kalau bot mati lebih dari 10 menit atau WA terputus |
| Bahan pemasangan | `deploy/docker-compose.yml`, `deploy/.env.example`, `docs/panduan-vps.md`, `docs/uji-skenario.md`, `docs/panduan-host.md` |

## Yang belum, dan perlu dikerjakan bersama owner

1. **Repo GitHub privat.** Kode harus disimpan di sana, karena sesi pengerjaan ini tidak permanen.
2. **Uji WAHA di VPS.** Ikuti `docs/panduan-vps.md` bagian 4 untuk memastikan:
   - bot bisa menerima gambar dari grup,
   - format ID pesan,
   - pengambilan riwayat lebih dari 100 pesan.
3. **Pasang semuanya, lalu jalankan uji 11 skenario** di grup uji (`docs/uji-skenario.md`).
4. **Pindah ke grup CP Live yang asli**, dengan pengaturan "Jadwal aktif" = TIDAK.

## Keputusan yang diambil atas nama owner (silakan dikoreksi)

### Cara kerja sistem

- **Perhitungan dan pengingat berjalan di bot VPS, bukan di Apps Script.** Apps Script hanya dipakai untuk email peringatan saat bot mati.

### Laporan host

- **Nama di caption toleran salah ketik ringan,** misalnya "Brnado" tetap terbaca Brando. Untuk nama pendek, toleransinya hanya 1 huruf.
- **Nama di perintah (`#izin`, `#gangguan`) harus ditulis persis.** Kalau tidak ada nama yang persis, sistem memakai nomor pengirim. Kalau nomor pengirim juga tidak dikenal, kolom host dikosongkan dan owner yang mengisi.
- **Kalau satu foto berisi dua screenshot platform yang sama,** bot meminta kirim ulang.
- **Screenshot layar akhir yang terkirim dua kali diabaikan,** supaya tidak dihitung ganda.
- **Koreksi angka dari host baru berlaku setelah owner menyetujui.** Host juga bisa meminta laporan dipindahkan ke host lain dengan membalas `koreksi host Vanna`, dan ini pun menunggu persetujuan owner.

### Perhitungan kredit

- **Angka TikTok yang dibulatkan dan turun paling banyak 10% dianggap pembulatan,** bukan live yang reset.
- **Laporan sebelum jam 06:00 dihitung ke tanggal hari sebelumnya,** untuk live yang berjalan lewat tengah malam.
- **Jeda lebih dari 4 jam antar laporan ditandai "belum teratribusi".** Owner yang menentukan milik siapa. Batas 4 jam ini bisa diubah di tab Pengaturan.

### Target dan status

- **Kalau "Jadwal aktif" = YA, target dibagi menurut jumlah hari shift tiap host.** Jadwal dibaca dari tab "Data Jadwal" di file jadwal. Kalau datanya kosong atau tidak terbaca, sistem kembali ke mode tanpa jadwal dan owner mendapat satu peringatan per hari.
- **Status 🔴 muncul kalau host 3 hari berturut-turut di bawah target per hari kerja,** walaupun total bulanannya masih sesuai jalur.
- **Hitungan 3 hari berturut-turut belum menyambung antar bulan.** Jadi streak di akhir bulan tidak terbawa ke awal bulan berikutnya. Ini bisa ditambahkan kalau diperlukan.

### Gangguan

- **Menit gangguan hanya dihitung di dalam jam live.**
- **Gangguan yang belum ditutup sampai ganti hari** otomatis ditutup di jam akhir live hari itu, dan owner diberi tahu.

### Dashboard

- **Pembanding "bulan lalu tanggal sama" menggeser seluruh rentang mundur satu bulan.** Contoh: 5–15 Nov dibandingkan dengan 5–15 Okt.

### Pesan bot

- **Pesan bot dibatasi 6 per orang per hari.** Yang tidak kena batas: rekap grup, ringkasan untuk owner, eskalasi, dan alarm data tidak cocok.

### Penyimpanan

- **Bukti screenshot dihapus dari VPS setelah berhasil diunggah ke Google Drive.**
- **Tab data di spreadsheet diperbesar** (Data Kredit 50.000 baris), supaya tidak penuh setelah sebulan.

## Batasan yang perlu diketahui

- **Omzet TikTok per host adalah perkiraan,** karena layar TikTok membulatkan angka.
- **Beberapa detail WAHA belum diuji dengan WhatsApp sungguhan** (nama variabel, format ID, cara pengambilan riwayat). Semuanya ditandai "verifikasi di Task 0" di panduan.
- **Rumus spreadsheet perlu dicek di Google Sheets sungguhan,** karena spreadsheet memakai locale Indonesia. Ini termasuk dalam uji skenario 11.
