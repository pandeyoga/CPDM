# Rancangan Sistem Monitoring & Analisis Performa — Collector Parfum

Tanggal: 20 November 2026 · Status: **draf untuk disetujui**

---

## 1. Latar belakang dan tujuan

Agensi menangani dua hal untuk client **Collector Parfum** (toko parfum, Bandung):

- **Sosial media**: TikTok dan Instagram.
- **Live selling**: TikTok Shop dan Shopee Live.

**Masalah utama:** staff kurang concern, kurang punya rasa urgensi, dan kurang inisiatif. Tanpa dipantau, mereka cenderung tidak produktif.

**Peran sistem ini:** menjadi *asisten supervisor otomatis*. Tugasnya:

- Terus mengingatkan setiap orang soal target dan output mereka.
- Menunjukkan posisi mereka dibanding target dan dibanding bulan lalu.
- Menagih laporan.
- Menyediakan data rinci per orang, supaya evaluasi bisa objektif.

**Sistem dianggap berhasil kalau:**

1. Staff menerima update target dan tagihan secara otomatis, tanpa owner harus menagih manual.
2. Setiap sesi live dan setiap konten tercatat lengkap dengan datanya.
3. Analisis mingguan dan evaluasi bulanan berbasis data tersedia tepat waktu.
4. Owner dan management bisa melihat hasilnya di satu tempat.

## 2. Ruang lingkup

Sistem punya **dua jalur yang terpisah tegas**. Keduanya hanya bertemu di analisis.

| | Jalur Live | Jalur Konten |
|---|---|---|
| Orang | 3 host: Brando, Vanna, Linda | Content planner + editor (orang terpisah dari host) |
| Pekerjaan | Live di TikTok Shop dan Shopee **bersamaan**, bergantian (rolling) di dalam shift | 2 video + 2 feed per hari (±60 + 60 per bulan, 14 + 14 per minggu) |
| Cara input | Screenshot di grup WA | Spreadsheet, Docs, unggah export, Form |
| Data disimpan di | 📊 CP – Live Tracker | 📊 CP – Content Tracker |

### Tujuan (goals)

- **G1.** Pengingat dan tagihan otomatis lewat **grup WA**.
- **G2.** Pencatatan per sesi live dari screenshot yang dibaca AI.
- **G3.** Target bulanan diisi sebagai **satu angka**, lalu dirinci otomatis per host per hari.
- **G4.** Framework mingguan content planner dan papan konten terpantau dengan deadline.
- **G5.** Impor data performa sosmed dari export yang ditarik manual oleh staff.
- **G6.** Analisis mingguan (Senin) dan evaluasi bulanan (tanggal 5) disusun oleh Claude.
- **G7.** Spreadsheet khusus management untuk melihat hasil.
- **G8.** Rapor per staff.

### Bukan tujuan (non-goals)

- Menarik data live lewat API TikTok Shop atau Shopee. Data live tetap dari screenshot.
- Menarik data sosmed lewat API atau konektor berbayar. Data sosmed tetap dari export manual. Ini bisa jadi tahap lanjut.
- Membuat aplikasi atau dashboard web terpisah. Google Sheets dan Docs adalah antarmukanya.
- **Mengubah jadwal atau shift.** Sistem membaca jadwal yang ada apa adanya. Perubahan shift (Varian A/B) akan diputuskan belakangan.
- Mengelola penggajian atau bonus.

### Hal yang membuat sistem gagal walaupun teknisnya jalan (anti-goals)

- **Input yang ribet.** Kalau host harus mengetik banyak, mereka berhenti melapor. Untuk host, input harus sesederhana "kirim screenshot".
- **Angka salah baca masuk ke data tanpa dikonfirmasi.** Kalau AI salah membaca angka dan tidak ada konfirmasi, evaluasi jadi tidak objektif.
- **Teguran yang mempermalukan staff di grup.**
- **Bot yang terlalu sering mengirim pesan**, sampai pesannya diabaikan.
- **Data kosong dibaca sebagai 0.** Kosong artinya "belum ada data", bukan "tidak ada yang menonton".

## 3. Kondisi yang sudah ada

### File jadwal

- **"Penjadwalan Host Live CP"** (Google Sheets, ID `1HoEliPldP8w02mA1F2YP1Qz7XbEhBT4gOkpzO_2vH4A`).
- Tab **Data Jadwal** berisi kolom: Tanggal, ID Staf, Nama, Shift, Mulai, Selesai, Durasi Jam, Status, dan lainnya.
- Shift saat ini:
  - Pagi 09–17
  - Middle 12–20
  - Siang 14–22
- Di hari 2 orang, pasangannya Pagi + Middle.
- Live berlangsung 09:00–22:00 di hari 3 orang, dan 09:00–20:00 di hari 2 orang.
- Status jadwal masih DRAF. Sistem hanya **membaca** file ini.

### Screenshot layar akhir live

- **Shopee:** Penjualan, Pesanan dibuat, Penonton aktif, Dilihat, Komentar, Masukkan ke keranjang, Durasi, Rata-rata menonton.
- **TikTok:** GMV teratribusi, Produk terjual, Pengikut baru, Komentar, Impresi, Tayangan.
- Angka TikTok di layar itu **dibulatkan**, misalnya Rp578rb atau 23,7K.

### Live tidak berhenti saat ganti host

Contohnya, live Shopee berjalan 11 jam di hari 2 orang. Artinya angka di layar adalah **angka kumulatif** sejak live dimulai.

### Contoh export sosmed

| Platform | Format | Kolom |
|---|---|---|
| TikTok Studio | xlsx | Video title, Video link, Post time, Video views, Likes, Comments, Shares, Add to Favorites |
| Meta Business Suite (IG) | csv | Post ID, Description, Duration, Publish time, Permalink, Post type (IG reel / IG image), Date (= Lifetime), Views, Reach, Likes, Shares, Follows, Comments, Saves |

Jam posting di kedua file **kemungkinan dalam UTC** (WIB = +7). Ini perlu diverifikasi.

## 4. Pendekatan yang dipertimbangkan

| Keputusan | Pilihan yang dipertimbangkan | Dipilih | Alasan |
|---|---|---|---|
| Wadah data | Google Sheets + Docs · aplikasi atau dashboard web | **Google Sheets + Docs** | Sudah familiar, murah, dan spreadsheet bisa langsung jadi antarmuka |
| Mesin otomasi | Apps Script · Make atau n8n | **Apps Script** | Gratis dan menempel di spreadsheet. Make atau n8n berlangganan dan jumlah operasinya dibatasi |
| WhatsApp | Gateway berbayar (Fonnte, Wablas) · API resmi Meta · open source self-host | **Open source: WAHA di VPS milik user** | Permintaan user. Evolution API sempat dipertimbangkan, tapi status lisensinya di rilis terbaru tidak jelas |
| Bentuk komunikasi WA | Grup · pesan pribadi | **Grup**, kecuali teguran yang dikirim pribadi ke owner | Transparan dan mendorong urgensi |
| Input host | Screenshot dibaca AI · ketik template · Google Form | **Screenshot dibaca AI, lalu dikonfirmasi** | Paling ringan untuk host, dan screenshot sekaligus jadi bukti |
| Data sosmed | Export manual · konektor berbayar (Windsor, Supermetrics, Coupler) · API resmi | **Export manual, diunggah apa adanya** | Permintaan user. Tanpa biaya langganan |
| Ritme input metrik konten | Isi baris H+3/H+7 setiap hari · tarikan mingguan | **Tarikan mingguan 14 hari terakhir, plus tarikan sebulan penuh setiap tanggal 4** | Jauh lebih ringan, dan umur konten tetap bisa dibandingkan |
| Susunan file | Satu file banyak tab · file terpisah | **Tiga file terpisah: Live, Konten, Management** | Hak akses lebih bersih, dan pengaturan masing-masing jalur tidak tercampur |

## 5. Arsitektur

```
🖥️ VPS milik user (Docker, menyala 24 jam)
 ├─ WAHA (WhatsApp HTTP API, Core): menghubungkan 1 nomor bot ke WhatsApp
 └─ Bot service (dibuat builder):
      • menerima pesan grup dari webhook WAHA
      • meminta Claude API (vision) membaca screenshot
      • menulis hasilnya ke Sheets
      • membalas konfirmasi di grup

📁 Google Drive: "CP – Sistem Performa"
 ├─ 📊 CP – Live Tracker       (+ Apps Script)
 ├─ 📊 CP – Content Tracker    (+ Apps Script)
 ├─ 📊 CP – Management         (hanya-lihat, diperbarui otomatis)
 ├─ 📁 Script      → 📄 Script Minggu NN (1 dokumen per minggu, dari template)
 ├─ 📁 Laporan     → 📄 Analisis Mingguan · 📄 Evaluasi Bulanan
 ├─ 📁 Tarikan     → export TikTok/IG per minggu dan per bulan
 ├─ 📁 Bukti Live  → screenshot host (arsip bukti)
 └─ 📁 Footage
 🔗 Penjadwalan Host Live CP (milik user, hanya dibaca)

⚙️ Perhitungan, rincian target, dan pengingat terjadwal
   • Tahap 1: dijalankan bot service di VPS (keputusan builder: satu tempat,
     bisa dites otomatis, server sudah menyala 24 jam)
   • Apps Script hanya dipakai untuk pemeriksa detak bot (email ke owner)
   • impor export sosmed dan Outbox ditentukan di Tahap 2–3

🧠 Claude (tugas terjadwal di akun Claude user, memakai konektor Google)
   • review script, analisis mingguan, evaluasi bulanan
   • menulis hasilnya ke Docs
   • menaruh pesan di tab Outbox. Claude tidak memegang akses WA
```

### Grup WA

- **👥 CP Live:** 3 host + owner + bot.
- **👥 CP Konten:** planner + editor + owner + bot.
- **Pesan pribadi dari bot ke owner:** teguran atau eskalasi, dan rekap untuk owner.

## 6. Jalur Live

### 6.1 Sesi

- **Satu sesi** adalah satu host yang on-air di kedua platform sekaligus.
- **Laporan dihitung per platform.** Setiap platform punya urutan laporannya sendiri.
- **Nilai sebuah laporan** = selisih angka kumulatif di screenshot itu dengan screenshot sebelumnya, untuk platform yang sama, dalam siaran yang sama.
- **Hanya angka kumulatif yang dikurangkan.**
  - Shopee: penjualan, pesanan, dilihat, komentar, masuk keranjang, durasi.
  - TikTok: GMV teratribusi, produk terjual, tayangan, impresi, komentar, pengikut baru.
  - "Penonton aktif" dan "durasi rata-rata menonton" bukan angka kumulatif. Keduanya disimpan apa adanya.

### 6.1a Live mati atau reset di tengah sesi

Kalau live mati (koneksi putus, aplikasi crash, atau live diakhiri) lalu dimulai lagi, angkanya kembali ke 0. Sistem menangani ini dengan membagi data ke dalam **siaran**:

**1. Aturan untuk host.** Kalau live mati, **wajib screenshot layar akhir siaran itu** sebelum memulai live baru. Contohnya "Live Streaming Berakhir" di Shopee atau "LIVE luar biasa!" di TikTok. Caption-nya `nama + mati`.

**2. Deteksi otomatis.** Laporan baru yang angkanya **lebih kecil** dari laporan sebelumnya di platform yang sama, atau yang datang setelah layar akhir, dianggap **siaran baru**.

**3. Cara menghitung.**
- Bagian akhir siaran yang mati = (angka di layar akhir − laporan terakhir sebelum mati). Bagian ini dikreditkan ke host yang sedang on-air saat live mati.
- Siaran baru dihitung dari 0.

```
TikTok GMV (kumulatif)                         Kredit
10:00  Brando  Rp300rb                         Brando +300rb
11:10  ⚠ live mati → layar akhir Rp420rb       Brando +120rb
       live baru mulai dari 0
12:00  Brando  Rp150rb  (siaran baru)          Brando +150rb
13:20  Vanna   Rp500rb                         Vanna  +350rb
```

**4. Kalau screenshot layar akhir terlewat.** Bot mendeteksi angka yang turun, lalu menag host itu di grup dan meminta screenshot dari **riwayat live di aplikasi**. Selama screenshot itu belum ada, selisihnya ditandai **"siaran belum lengkap"** dan tidak dikreditkan ke siapa pun.

### 6.1b Laporan pergantian yang terlewat

Kalau satu laporan pergantian tidak dikirim, laporan berikutnya ikut memuat penjualan host sebelumnya. Penanganannya:

- Bot mengenali situasi ini dari pengirim yang berbeda dengan host on-air menurut jadwal (kalau jadwal sudah aktif), atau dari jeda waktu yang tidak wajar.
- Selisih itu ditandai **"belum teratribusi"**. Bot memberi usulan pembagian berdasarkan jadwal, lalu owner yang menetapkan di tab Atribusi.
- Host yang lupa lapor tidak diuntungkan.

### 6.2 Pola sesi (jadwal tidak diubah)

Pola sesi diatur di tabel **Pola Sesi** di tab Pengaturan. **Untuk sekarang tabelnya kosong**, dan sistem berjalan dalam **mode bebas**:

- Host lapor setiap selesai gilirannya. Jam pengiriman screenshot dicatat sebagai batas sesi.
- Di akhir shift, host yang hari itu masuk shift tapi belum lapor sama sekali akan ditag di grup. Aturan ini hanya berlaku kalau saklar "Jadwal aktif" = YA (lihat 6.4).

Kalau tabel Pola Sesi nanti diisi, misalnya dengan Varian A (9 × 90 menit):

- Bot mengingatkan tepat di jam pergantian.
- Kalau 15 menit kemudian belum ada laporan, bot menagih ulang.
- Kalau 60 menit kemudian masih belum ada, owner dikabari secara pribadi.

### 6.3 Laporan di grup

1. Host mengirim screenshot TikTok dan Shopee di grup **CP Live**.
   - Layar yang difoto sama dengan contoh dari user: panel data live Shopee dan TikTok.
   - Pengirimnya bisa dari HP bersama.
2. **Caption wajib berisi nama host**, misalnya `Brando` atau `Brando mati`.
   - Bot mencocokkan nama itu dengan daftar host. Salah ketik kecil tetap dikenali.
   - Kalau caption kosong atau nama tidak dikenali, bot membalas: "Ini laporan siapa?". Laporan baru diproses setelah dijawab.
3. AI mengenali apakah gambar itu screenshot dashboard live, dan dari platform mana. Gambar lain diabaikan.
4. Bot membalas pesan itu dengan ringkasan, misalnya: "✅ Tercatat — Brando · TikTok +Rp… · Shopee +Rp… · Balas kalau angka salah".
5. **Diam berarti setuju.** Angka langsung dihitung, dengan screenshot sebagai bukti.
6. **Koreksi dari host** yang berbeda dengan bacaan AI tidak langsung dipakai. Koreksi itu masuk ke tab **Koreksi** untuk disetujui owner.
7. Screenshot diarsipkan di folder 📁 Bukti Live.

**Kolom yang disimpan per platform:**

- **Shopee:** penjualan, pesanan, penonton aktif, dilihat, komentar, masuk keranjang, durasi.
- **TikTok:** GMV teratribusi, produk terjual, tayangan, impresi, komentar, pengikut baru.

Angka TikTok yang dibulatkan disimpan sebagai angka biasa (misalnya Rp578rb → 578000) dan diberi tanda "dibulatkan". Karena itu **omzet TikTok per host adalah angka perkiraan**. Di laporan, angka ini ditampilkan dengan keterangan tersebut.

### 6.4 Target

- Owner mengisi **satu angka**, yaitu target omzet bulanan, di tab Pengaturan. Angka ini bisa diisi kapan saja.
- **Definisi target:** omzet live kotor = GMV teratribusi TikTok + Penjualan Shopee, sesuai angka yang tampil di screenshot. Target ini bukan total penjualan toko, dan bukan omzet bersih setelah pembatalan.
- **Rincian otomatis:**
  - **Per host** = target ÷ 3.
  - Host yang **cuti** (tercatat CUTI di tab Ketersediaan di file jadwal) mendapat target yang dikurangi sebanding dengan jam yang hilang.
  - **Per hari per host** = target host × (jam on-air host hari itu ÷ total jam on-air host bulan itu).
    - Jam on-air harian dihitung dari tabel Pola Sesi kalau sudah diisi.
    - Kalau belum, dihitung dari jam live hari itu ÷ jumlah host yang masuk shift, berdasarkan jadwal.
    - Hari libur tidak punya target.

**Saklar "Jadwal aktif" di tab Pengaturan**

File jadwal sekarang masih berisi simulasi. Karena itu ada saklar "Jadwal aktif" (YA/TIDAK), yang sementara diset **TIDAK**.

Selama TIDAK:
- Bot tidak menag atau menegur siapa pun berdasarkan jadwal.
- Target harian per host dihitung dengan asumsi 6 hari kerja per minggu, dengan jatah yang sama setiap hari.

Begitu jadwal asli sudah dimasukkan dan saklarnya diubah ke YA, semua aturan yang memakai jadwal langsung aktif. Owner bertanggung jawab memastikan tukar shift dan izin sakit tercatat di file jadwal.
- **Pace:** target kumulatif sampai hari ini dibanding realisasi, serta kebutuhan per hari untuk sisa bulan.
- **Pembanding bulan lalu** memakai rentang tanggal yang sama. Contoh: tanggal 1–20 bulan ini dibanding tanggal 1–20 bulan lalu.

### 6.5 Pesan otomatis

- **08:00 di grup:** update untuk tiap host yang masuk shift hari itu. Selama "Jadwal aktif" = TIDAK, update dikirim untuk ketiga host. Isinya realisasi bulan berjalan, persentase dibanding seharusnya, selisih kurang atau lebih, perbandingan dengan bulan lalu, kebutuhan per hari, dan jam shift.
- **Selama live:** balasan konfirmasi untuk setiap laporan.
- **22:30, atau 30 menit setelah live terakhir hari itu berakhir kalau live lewat dari 22:00:**
  - Rekap harian di grup: per host untuk hari ini dan bulan berjalan.
  - Pesan pribadi ke owner: siapa saja yang tidak lapor, data yang "belum teratribusi" atau "siaran belum lengkap", dan koreksi yang menunggu persetujuan.
- **Live di hari campaign yang lewat tengah malam** dicatat di tanggal live itu dimulai.
- **Eskalasi:**
  - Host yang tertinggal dari pace mendapat nada lebih tegas di update pagi.
  - Host yang tertinggal 3 hari berturut-turut dilaporkan **secara pribadi ke owner**, bukan di grup.
- **Batas pesan per orang per hari** diterapkan supaya bot tidak spam.

### 6.6 Metrik evaluasi host

- Omzet
- Omzet per jam
- Konversi (pesanan ÷ penonton)
- Jumlah masuk keranjang
- Persentase target tercapai
- **Disiplin lapor**, dihitung sebagai persentase shift yang laporannya lengkap: tidak ada data "belum teratribusi" maupun "siaran belum lengkap" karena kelalaian host itu, dan caption benar. Kalau Pola Sesi sudah diisi, ketepatan waktu juga dihitung, dengan batas 15 menit setelah jam pergantian.
- **Indeks slot:** omzet per jam seorang host dibanding rata-rata semua host di jam yang sama. Indeks ini baru aktif setelah data terkumpul minimal 3–4 minggu.

### 6.7 Kondisi tidak ideal

Ada empat kelompok kondisi: live tidak bisa berjalan, staff tidak masuk, sistem sendiri bermasalah, dan gangguan di jalur konten. Untuk A dan B, owner yang memutuskan apakah sebuah laporan diterima. Aturan di bawah sudah disetujui owner pada 20 Nov 2026.

**A. Live tidak bisa berjalan**

Penyebabnya bisa listrik mati, internet putus, HP atau aplikasi rusak, atau akun kena pembatasan platform.

- **Cara lapor:** host atau owner menulis di grup.
  - `#gangguan listrik` untuk menandai mulai gangguan, dan `#normal` saat sudah pulih.
  - Bisa juga per platform, misalnya `#gangguan shopee`.
  - Bot mencatat jam mulai dan selesai di tab **Gangguan**. Owner menetapkannya di kolom Keputusan.
- **Efek:**
  - Jam yang hilang karena gangguan yang disetujui **tidak dihitung di target pribadi** host yang sedang on-air saat itu. Jatah target untuk jam itu gugur.
  - **Target tim dan tampilan management tetap.** Jam yang hilang ditampilkan terpisah.
- **Selama gangguan:** bot tidak menagih laporan. Update pagi berikutnya menyebutkan gangguan itu.
- **Setelah pulih:**
  - Live yang dimulai lagi dihitung sebagai siaran baru (6.1a).
  - Kalau layar akhir tidak sempat difoto (misalnya HP mati), bot meminta screenshot dari riwayat live.
- **Gangguan yang tidak dilaporkan** tidak otomatis dimaafkan. Jamnya tetap dihitung sebagai jam kerja biasa.

**B. Staff sakit, izin, cuti, tukar shift, atau telat**

- **Cara lapor:**
  - Host menulis di grup, misalnya `#izin sakit` untuk hari ini, atau `#izin 25/11 keperluan keluarga` untuk tanggal tertentu.
  - Owner menetapkannya di tab **Kehadiran** dengan pilihan Disetujui / Ditolak / Tanpa keterangan. Owner juga bisa langsung mengisi tab ini.
- **Efek:**
  - **Sakit atau izin yang disetujui, dan cuti:** target host itu untuk hari tersebut = 0. Hari itu tidak masuk hitungan "tertinggal", dan di rapor tercatat sebagai izin, bukan kinerja buruk.
  - **Tanpa keterangan atau ditolak:** target tetap berlaku, dan tercatat di disiplin.
  - **Host pengganti** yang mengisi jam kosong tetap mendapat kredit atas penjualannya, tanpa targetnya dinaikkan. Jam tambahan itu dicatat sebagai "jam pengganti", nilai plus di rapor.
  - **Telat** tidak mengurangi target, kecuali owner menyetujuinya sebagai izin.
- **Host baru masuk atau keluar di tengah bulan:** daftar host di tab Pengaturan punya kolom tanggal aktif mulai dan selesai. Target dibagi ke host yang aktif, sebanding dengan jumlah hari aktif masing-masing.
- **Hari tanpa live** (libur nasional, toko tutup): owner mengisinya di tab **Kalender Live**. Hari itu tidak punya target, dan target bulan dibagi hanya ke hari-hari live.

**C. Sistem sendiri bermasalah**

| Masalah | Penanganan |
|---|---|
| Bot atau VPS mati, atau WA bot terputus dan perlu scan QR ulang | Saat bot hidup lagi, pesan yang masuk selama bot mati diambil ulang dari riwayat chat grup dan diproses berurutan, jadi tidak ada laporan yang hilang. **Pemeriksa terpisah di sisi Google** (Apps Script kecil) mengecek detak bot setiap 10 menit dan mengirim **email** ke owner kalau bot tidak aktif lebih dari 10 menit atau WA terputus. |
| Claude API gagal atau kena limit | Screenshot disimpan dan diproses ulang otomatis. Bot membalas "diterima, sedang diproses". |
| Google Sheets gagal | Data disimpan dulu di antrean di server, lalu dikirim ulang. Tidak ada yang hilang. |
| Foto buram, tidak terbaca, atau bukan layar live | Bot meminta foto dikirim ulang. Tidak ada data yang dicatat. |
| Nama di caption salah atau tidak dikenal | Bot bertanya "Ini laporan siapa?". |

**D. Jalur konten (berlaku di Tahap 2)**

- **Planner atau editor izin:** deadline orang itu di hari tersebut ditangguhkan, dan target mingguannya disesuaikan.
- **Shooting batal** (listrik mati, talent sakit): dicatat di tab Gangguan konten.
- Stok konten satu minggu dari pipa 2 minggu menjaga posting harian tetap berjalan.

**Verifikasi:** setiap skenario di atas punya tes otomatis. Sebelum sistem dipakai, ada juga **uji skenario di VPS**:

1. Bot dimatikan 15 menit, lalu screenshot dikirim ke grup.
2. Nomor WA bot di-logout.
3. API key dibuat salah.
4. Foto buram dikirim.
5. `#gangguan` lalu `#normal`.
6. `#izin`.
7. Live di-reset di tengah sesi.
8. Laporan pergantian sengaja tidak dikirim.
9. Caption ditulis salah.

## 7. Jalur Konten

### 7.1 Framework mingguan content planner

Angka dan jam di bawah bisa diubah di tab Pengaturan.

| Hari | Hasil kerja | Batas |
|---|---|---|
| Senin | Unggah export TikTok dan IG (konten 14 hari terakhir), lalu isi Form Laporan Analisis | 12:00 |
| Selasa | Bank Ide: minimal 20 ide video + 20 ide feed, dengan link referensi | 17:00 |
| Rabu | Minimal 7 script video + 7 brief feed | 17:00 |
| Kamis | Total 14 + 14. Owner diberi notifikasi untuk menyetujui | 17:00 |
| Jumat | Minimal 7 video tersuting, footage diunggah | 18:00 |
| Sabtu | 14 video tersuting, kalender diperbarui, footage diserahkan ke editor | 18:00 |

Ditambah satu tugas bulanan: **tanggal 4**, unggah export sebulan penuh untuk evaluasi bulanan.

### 7.2 Pipa 2 minggu

- Produksi di minggu N.
- Editing di minggu N+1.
- Tayang di minggu N+2.

Dengan pola ini selalu ada stok konten untuk satu minggu ke depan.

### 7.3 Papan Konten (satu baris per konten)

- **Kode konten:** `CP-V-WWNN` untuk video, `CP-F-WWNN` untuk feed (WW = nomor minggu, NN = nomor urut).
- **Kolom lain:** jenis, platform target, pilar, format, jenis hook, produk, ajakan (CTA), kode ide asal, link script, PIC, deadline, rencana tanggal tayang, tanggal tayang aktual, **link postingan TikTok dan IG**.
- **Alur status video:** Ide → Script → Disetujui → Tersuting → Diedit → QC → Terjadwal → Tayang.
- **Alur status feed:** Ide → Brief → Disetujui → Desain → QC → Terjadwal → Tayang.
- **Video yang tayang di TikTok dan IG sekaligus dihitung sebagai 1 output.** Satu baris punya dua kolom link.

### 7.4 Tab lain di Content Tracker

- **Bank Ide:** satu baris per ide. Kolomnya kode ide, tanggal, link referensi, pilar, format, produk, catatan, status (baru / dipilih / ditolak), dan kode konten kalau ide itu dipilih.
- **Kalender:** tampilan per tanggal yang dibuat otomatis dari Papan Konten.

### 7.5 Dokumen script

- Satu dokumen per minggu, dibuat dari template.
- Setiap script diberi judul berupa kode kontennya.
- Struktur script: hook, isi, CTA, talent, lokasi, properti, catatan shot.
- Owner menyetujui lewat komentar di Docs, lalu status di Papan diubah menjadi Disetujui.

### 7.6 Data sosmed

1. Planner mengunggah file export **apa adanya** ke folder `Tarikan/Minggu NN`.
2. Robot memindahkan isinya ke tab Raw TikTok dan Raw IG, lalu memberi cap tanggal tarikan.
3. Kolomnya diseragamkan. Contohnya, "Add to Favorites" di TikTok disamakan dengan "Saves" di IG.
4. Setiap baris dicocokkan ke Papan Konten **lewat link postingan**.
5. Jam posting dikonversi ke WIB. Selisih zona waktu disimpan sebagai pengaturan, dan nilainya diverifikasi builder dari satu postingan yang jam tayangnya diketahui.
6. Sel yang datanya belum ada dibiarkan kosong, tidak diisi 0.

### 7.7 Form Laporan Analisis Mingguan (diisi planner)

- **A. Evaluasi final:** konten 2 minggu lalu (umur 8–14 hari). Isinya top 3 dengan alasannya, bottom 3 dengan dugaan penyebabnya, 3 temuan, dan 3 keputusan untuk produksi.
- **B. Sinyal awal:** konten minggu lalu. Isinya 1–3 konten yang mulai naik dan aksi cepat yang akan diambil.
- **C. Kendala.**

### 7.8 Pengingat di grup CP Konten

- Deadline harian sesuai tabel di 7.1.
- **21:00:** cek apakah konten yang dijadwalkan tayang hari itu sudah tayang (link postingannya sudah terisi).
- Editor diingatkan untuk konten yang sudah melewati batas edit.

## 8. Analisis oleh Claude

| Kapan | Hasil |
|---|---|
| Kamis malam | Review script minggu itu: hook, kesesuaian pilar, dibandingkan dengan pola konten terbaik. Hasilnya berupa komentar di dokumen script dan ringkasan ke owner |
| Senin sore | Dokumen **Analisis Mingguan**: evaluasi final 2 minggu lalu, sinyal awal minggu lalu, pengecekan temuan planner terhadap data, ringkasan live per host, dan kaitan konten dengan live |
| Tanggal 5, 09:00 | Dokumen **Evaluasi Bulanan** untuk bulan sebelumnya (rincian di bawah) |
| Kapan saja | Lewat chat |

**Isi Evaluasi Bulanan:**

- Sales: target vs realisasi total dan per host, perbandingan dengan bulan lalu, TikTok vs Shopee, peta jam ramai.
- Konten: output vs target 60 + 60, top dan bottom 5 konten, pilar/format/hook yang paling berhasil, pertumbuhan followers.
- Sintesis konten dan sales.
- Rapor per staff.
- Usulan target dan keputusan untuk bulan depan.
- Konten dari 5 hari terakhir bulan ditandai "belum final".

**Laporan dikirim ke owner:** link dokumen ditulis ke tab Outbox, lalu Apps Script mengirimnya lewat WA.

**Batasan:** screenshot live tidak memuat penjualan per produk. Karena itu kaitan konten dengan live dianalisis di tingkat harian, misalnya omzet dan jumlah penonton. Analisis per produk baru bisa dilakukan kalau nanti ada data penjualan per produk.

## 8a. Tab analisis (data mentah diolah jadi metrik)

Kedua tab ini **hanya bisa dilihat** dan dihitung otomatis. Masing-masing memuat **Kamus Metrik**, supaya semua staff memakai definisi yang sama. Format contohnya ada di `format-ankonten.png` dan `format-anlive.png`.

### Analisis Konten (di Content Tracker)

**A. Ringkasan per platform dan format.** Isinya jumlah konten, rata-rata dan median views, ER, save rate, share rate, follow rate, dan rasio views ÷ reach.

**B. Per label** (pilar, format, hook, produk). Isinya rata-rata views, indeks, ER, dan save rate. Label yang sampelnya kurang dari 5 konten ditandai "sampel kecil".

**C. Per jam posting (WIB)** dan per hari.

**D. Per konten.** Isinya umur data, status (final atau awal), ER, save rate, indeks, dan momentum. Hanya konten berstatus final yang diberi peringkat.

**Definisi metrik konten:**
- **ER IG** = (like + komen + share + save) ÷ reach.
- **ER TikTok** = (like + komen + share + favorit) ÷ views. TikTok tidak menyediakan data reach, jadi ER TikTok **tidak dibandingkan langsung** dengan ER IG.
- **Save rate** = save ÷ views.
- **Share rate** = share ÷ views.
- **Follow rate** (IG) = follow ÷ reach.
- **Indeks** = views ÷ median views konten berformat sama di periode itu.
- **Momentum** = pertumbuhan views antara tarikan pertama dan kedua.
- **Final** = umur data minimal 7 hari.

### Analisis Live (di Live Tracker)

**A. Corong penjualan per platform**, bisa difilter per hari, per host, atau per periode.
- **Shopee:** dilihat → keranjang → pesanan. Metriknya add-to-cart rate, cart-to-order, konversi, AOV, omzet per jam, dan komentar ÷ dilihat.
- **TikTok:** impresi → tayangan → produk terjual. Metriknya tap-in rate, konversi, nilai per produk, komentar ÷ tayangan, dan pengikut baru.

**B. Per host.** Isinya omzet per jam, AOV, konversi, add-to-cart, komentar per jam, dan indeks slot.

**C. Peta jam ramai.** Omzet per jam disusun menurut jam dalam sehari dan kelompok hari. Peta ini jadi dasar keputusan Varian A atau B nanti.

## 8b. Hak akses

| File | Owner | Host | Planner / Editor | Management | Bot |
|---|---|---|---|---|---|
| Live Tracker | Edit Pengaturan dan kolom Keputusan di Koreksi & Atribusi. Tab lain hanya bisa dilihat | Tanpa akses (semua lewat grup WA) | – | – | Menulis data |
| Content Tracker | Edit Pengaturan | – | Edit kolom input di Papan Konten dan Bank Ide. Tab lain hanya bisa dilihat | – | Menulis data |
| Management | Lihat saja | – | – | Lihat saja. Opsional: tidak bisa diunduh atau disalin | Menulis data |

- **Semua kolom otomatis dikunci (protected range).**
- **Rapor Host dan Rapor Konten ditempatkan di file Management, bukan di tracker.** Alasannya, siapa pun yang punya akses ke sebuah file bisa melihat semua tab di file itu. Kalau rapor ditaruh di tracker, staff bisa membaca evaluasi diri sendiri dan rekannya.
- **Tab Output Mingguan dan tab Analisis tetap terbuka untuk tim.**

## 9. Spreadsheet Management

File **hanya-lihat** yang diperbarui otomatis. Isinya:

- Ringkasan bulan berjalan: target vs realisasi, posisi terhadap pace, perbandingan dengan bulan lalu.
- Kartu performa per host.
- Output dan performa konten.
- Kedisiplinan lapor.
- Link ke Analisis Mingguan dan Evaluasi Bulanan.

## 10. Rapor per staff

- **Host:** omzet, omzet per jam, konversi, indeks slot, persentase target, disiplin lapor, tren 3 bulan.
- **Planner:** ketepatan deadline di tiap tahap, output vs target, kualitas analisis (apakah temuannya sesuai data), performa konten.
- **Editor:** ketepatan batas edit dan jumlah konten yang selesai.

## 11. Urutan pembangunan

1. **Live**
   - WAHA dan bot service di VPS.
   - CP – Live Tracker.
   - Rincian target.
   - Pengingat dan rekap.

   Uji pertama: memastikan WAHA bisa menerima gambar dari grup.
2. **Konten**
   - CP – Content Tracker: Papan Konten, Bank Ide, Kalender.
   - Template dokumen script.
   - Pengingat deadline.
3. **Analisis**
   - Impor export sosmed.
   - Form laporan planner.
   - Review script hari Kamis dan Analisis Mingguan hari Senin.
   - Outbox.
4. **Evaluasi dan management**
   - Evaluasi Bulanan setiap tanggal 5.
   - Rapor staff.
   - CP – Management.
   - Indeks slot.

## 12. Yang disiapkan user

- **VPS.** Sudah ada. Spesifikasi dan sistem operasinya dicek di Tahap 1.
- **Akses ke VPS lewat cara yang aman.** Password dan kunci SSH tidak pernah dikirim lewat chat. Pilihannya:
  - User menjalankan perintah dari panduan.
  - User menghubungkan komputernya ke sesi Claude (Remote Control).
- **Nomor WA khusus untuk bot**, plus HP untuk scan QR.
- **API key Claude** dari Anthropic Console.
- **Daftar staff:** nama, peran, dan nomor WA.
- **Dua grup WA** (CP Live dan CP Konten), dengan nomor bot sudah dimasukkan.
- **Target omzet bulanan**, yang bisa diisi kapan saja.

## 13. Diserahkan ke builder

- Bahasa pemrograman bot service.
- Struktur kolom rinci di setiap tab.
- Tampilan visual spreadsheet.
- Redaksi pesan, selama nadanya sesuai bagian 6.5.
- Cara bot service menulis ke Sheets.
- Penanganan error dan log.

## 14. Pertanyaan terbuka

Tidak ada yang menghalangi Tahap 1.

- **Management: hanya internal, atau client juga?** *Asumsi sementara: hanya internal.* Kalau client ikut melihat, rapor dan data kedisiplinan staff tidak ditampilkan di file yang bisa dilihat client. Perlu dijawab sebelum Tahap 4.
- **Apakah pencapaian target terkait bonus?** Kalau iya, perlu jejak audit yang lebih ketat dan penguncian data per bulan.
- **Berapa jumlah planner dan editor, dan siapa yang mendesain dan memposting feed?** Perlu dijawab sebelum Tahap 2, karena pengingat harus tahu siapa yang ditag.

## 15. Keputusan yang diambil builder (dicek owner saat membaca)

- **Diam berarti setuju** untuk angka hasil bacaan AI. Koreksi dari host baru dipakai setelah disetujui owner.
- **Laporan pergantian yang terlewat** ditandai "belum teratribusi". Owner yang menetapkannya, dengan usulan pembagian dari bot.
- **Saklar "Jadwal aktif"** sementara diset TIDAK, sampai jadwal asli dimasukkan.
- **Host yang cuti mendapat target yang dikurangi sebanding.** Di luar itu, target dibagi rata 3.
- **Definisi target** adalah omzet live kotor, yaitu TikTok GMV teratribusi + Shopee Penjualan.
- **Video yang tayang di TikTok dan IG** dihitung 1 output.
- **Feed punya alur status sendiri.**
- **Live yang lewat tengah malam** dicatat di tanggal live itu dimulai.
- **Zona waktu file export** disimpan sebagai pengaturan dan diverifikasi.
