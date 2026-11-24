#!/usr/bin/env bash
# ============================================================================
# CP Live — pemasang satu perintah untuk VPS (Ubuntu/Debian).
#
#   curl -fsSL https://raw.githubusercontent.com/pandeyoga/cpdm/main/deploy/install.sh -o install.sh && sudo bash install.sh
#
# Aman dijalankan ulang: langkah yang sudah selesai dilewati.
# Opsi:  --dari-awal   ulangi semua langkah (rahasia di .env yang sudah ada tetap dipakai)
#        --qr          sambungkan ulang WhatsApp (scan QR lagi), tanpa langkah lain
#        --sheet       hanya login Google + buat spreadsheet & folder bukti (tanpa WhatsApp), mis. untuk ditunjukkan dulu
#        --repo URL    alamat repo (mis. git@github.com:pandeyoga/cpdm.git untuk repo privat)
# Variabel: INSTALL_DIR (bawaan /opt/cp-sistem), REPO_URL (bawaan https://github.com/pandeyoga/cpdm)
# Rahasia tidak pernah dicetak ke layar maupun di-commit.
# ============================================================================
set -Eeuo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/cp-sistem}"
REPO_URL="${REPO_URL:-https://github.com/pandeyoga/cpdm}"
WAHA_BASE="http://127.0.0.1:3000"
SESI="default"
DARI_AWAL=0
HANYA_QR=0
HANYA_SHEET=0

DEPLOY=""
ENV_FILE=""
STATE_DIR=""
ASK_ANSWER=""

# ---------- tampilan ----------
if [[ -t 1 ]]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_B=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_B=""; C_OFF=""
fi
ok()    { printf '%s✅ %s%s\n' "$C_OK" "$*" "$C_OFF"; }
warn()  { printf '%s⚠️  %s%s\n' "$C_WARN" "$*" "$C_OFF"; }
err()   { printf '%s❌ %s%s\n' "$C_ERR" "$*" "$C_OFF" >&2; }
info()  { printf '   %s\n' "$*"; }
judul() { printf '\n%s== %s ==%s\n' "$C_B" "$*" "$C_OFF"; }
die()   { err "$*"; exit 1; }

# ---------- fungsi bantu murni (diuji di test-install-helpers.sh) ----------

# Nilai kosong atau masih pengisi dari .env.example?
is_placeholder() {
  local v="${1-}"
  [[ -z "$v" || "$v" == *GANTI* ]]
}

# Baca nilai KEY dari berkas env (kosong bila tidak ada).
get_env() {
  local key="$1" file="${2:-$ENV_FILE}" line=""
  [[ -f "$file" ]] && line=$(grep -m1 "^${key}=" "$file" || true)
  line="${line#*=}"
  line="${line%$'\r'}"
  if [[ ${#line} -ge 2 && ( ( "${line:0:1}" == '"' && "${line: -1}" == '"' ) || ( "${line:0:1}" == "'" && "${line: -1}" == "'" ) ) ]]; then
    line="${line:1:${#line}-2}"
  fi
  printf '%s' "$line"
}

# Tulis KEY=VALUE: ganti baris yang ada, atau tambahkan. Aman untuk karakter / & | \ ' " $ dan spasi
# (nilai diteruskan lewat environment awk, tidak lewat sed). Berkas selalu mode 600.
set_env() {
  local key="$1" value="$2" file="${3:-$ENV_FILE}" tmp
  [[ "$value" != *$'\n'* ]] || { err "Nilai $key tidak boleh berisi baris baru."; return 1; }
  [[ -f "$file" ]] || { : > "$file"; chmod 600 "$file"; }
  tmp=$(mktemp "${file}.XXXXXX")
  chmod 600 "$tmp"
  if ! KEY="$key" VAL="$value" awk '
      BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
      index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 }; next }
      { print }
      END { if (!done) print k "=" v }
    ' "$file" > "$tmp"; then
    rm -f "$tmp"; return 1
  fi
  mv "$tmp" "$file"
  chmod 600 "$file"
}

# "6281234567890@c.us" -> "*********7890" (hanya 4 digit terakhir yang terlihat).
mask_number() {
  local d="${1%%@*}"
  d="${d//[^0-9]/}"
  local n=${#d}
  if (( n <= 4 )); then printf '%s' "$d"; return 0; fi
  local stars
  stars=$(printf '%*s' $((n - 4)) '' | tr ' ' '*')
  printf '%s%s' "$stars" "${d: -4}"
}

# JSON (stdin) -> JSON dengan deret digit 8-15 disamarkan kecuali 4 terakhir, pushName/notifyName -> "***".
mask_json() {
  jq '
    walk(
      if type == "string" then
        gsub("(?<![0-9])(?<d>[0-9]{8,15})(?![0-9])"; "\(.d[:-4] | gsub("[0-9]"; "*"))\(.d[-4:])")
      elif type == "object" then
        with_entries(if (.key == "pushName" or .key == "notifyName") then .value = "***" else . end)
      else . end
    )'
}

# ---------- interaksi (selalu dari /dev/tty, jadi aman saat dipanggil lewat pipe) ----------
need_tty() {
  if ! { : </dev/tty; } 2>/dev/null; then
    die "Skrip ini perlu terminal interaktif. Jalankan lewat SSH biasa (bukan lewat otomatisasi)."
  fi
}

ask() { # ask "pertanyaan" [bawaan]  -> $ASK_ANSWER
  local prompt="$1" def="${2-}" ans=""
  if [[ -n "$def" ]]; then printf '%s [%s]: ' "$prompt" "$def" >&2; else printf '%s: ' "$prompt" >&2; fi
  IFS= read -r ans </dev/tty || true
  ASK_ANSWER="${ans:-$def}"
}

ask_secret() { # tidak menampilkan ketikan
  local prompt="$1" ans=""
  printf '%s (ketikan tidak terlihat; tempel lalu Enter): ' "$prompt" >&2
  IFS= read -rs ans </dev/tty || true
  printf '\n' >&2
  ASK_ANSWER="$ans"
}

confirm() { # confirm "pertanyaan" -> 0 bila y
  local ans
  ask "$1 (y/n)" ""
  ans="$ASK_ANSWER"
  [[ "$ans" =~ ^[YyJj] ]]
}

# ---------- penanda langkah ----------
step_done() { [[ "$DARI_AWAL" -eq 0 && -f "$STATE_DIR/$1" ]]; }
mark_done() { mkdir -p "$STATE_DIR"; date -u +%FT%TZ > "$STATE_DIR/$1"; }

# Perintah untuk melanjutkan; sebelum langkah 2 skrip baru ada di folder tempat pemilik menjalankannya.
cara_ulang() {
  local awal=""
  [[ "$INSTALL_DIR" == "/opt/cp-sistem" ]] || awal="INSTALL_DIR=$INSTALL_DIR "
  if [[ -f "$INSTALL_DIR/deploy/install.sh" ]]; then
    printf 'sudo %sbash %s/deploy/install.sh%s' "$awal" "$INSTALL_DIR" "${1:+ $1}"
  else
    printf 'sudo %sbash install.sh%s' "$awal" "${1:+ $1}"
  fi
}

on_error() {
  local line="$1"
  # Dengan set -E trap juga jalan di subshell $(...) dan di tiap tingkat fungsi; cukup lapor sekali, di shell utama.
  (( BASH_SUBSHELL == 0 )) || return 0
  err "Pemasangan berhenti (baris $line). Baca pesan di atas."
  info "Langkah yang sudah selesai tidak diulang. Setelah masalah diperbaiki, jalankan lagi:"
  info "  $(cara_ulang)"
  exit 1
}

# apt-get yang sabar: VPS baru sering menjalankan pembaruan otomatis yang mengunci apt beberapa menit.
apt_coba() {
  local n
  for n in 1 2 3 4 5 6; do
    apt-get -o DPkg::Lock::Timeout=120 "$@" && return 0
    if (( n < 6 )); then
      warn "apt sedang dipakai proses lain (biasa pada VPS baru). Menunggu 30 detik lalu mencoba lagi ($n/5)..."
      sleep 30
    fi
  done
  return 1
}

# ---------- 0. pemeriksaan awal ----------
preflight() {
  judul "0/11 Pemeriksaan awal"
  if [[ "$(id -u)" -ne 0 ]]; then
    err "Skrip harus dijalankan sebagai root."
    info "Jalankan:  sudo bash install.sh"
    exit 1
  fi
  need_tty
  local id_like=""
  # shellcheck disable=SC1091
  if [[ -r /etc/os-release ]]; then id_like="$(. /etc/os-release; echo "${ID:-} ${ID_LIKE:-}")"; fi
  if ! command -v apt-get >/dev/null 2>&1 || [[ "$id_like" != *debian* && "$id_like" != *ubuntu* ]]; then
    die "Pemasang ini hanya mendukung Ubuntu atau Debian. Sistem Anda: ${id_like:-tidak dikenal}."
  fi
  ok "Sistem: ${id_like%% *} (didukung)"
  local mem_kb disk_kb
  local avail_kb
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  avail_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  if (( mem_kb < 1400000 )); then
    warn "RAM sekitar $((mem_kb / 1024)) MB, kurang dari 1,5 GB. Bisa berjalan, tetapi proses build bisa gagal. Disarankan VPS 2 GB."
  elif (( ${avail_kb:-0} < 1200000 )); then
    warn "RAM tersedia hanya $((avail_kb / 1024)) MB (sisanya dipakai program lain). WAHA + bot butuh sekitar 1 GB; proyek lain bisa melambat."
  else
    ok "RAM cukup ($((avail_kb / 1024)) MB tersedia dari $((mem_kb / 1024)) MB)"
  fi
  if command -v docker >/dev/null 2>&1; then
    local lain
    lain=$(docker ps -q 2>/dev/null | wc -l || true)
    (( lain == 0 )) || info "Ada $lain container lain yang berjalan. Pemasang ini tidak menghentikan, memperbarui, atau menghapusnya."
  fi
  local cek_dir="$INSTALL_DIR"
  while [[ ! -d "$cek_dir" ]]; do cek_dir="$(dirname "$cek_dir")"; done
  disk_kb=$(df -Pk "$cek_dir" | awk 'NR==2 {print $4}')
  if (( disk_kb < 5 * 1024 * 1024 )); then
    warn "Ruang disk kosong sekitar $((disk_kb / 1024 / 1024)) GB, kurang dari 5 GB. Docker butuh ruang; bebaskan disk bila gagal."
  else
    ok "Ruang disk cukup ($((disk_kb / 1024 / 1024)) GB kosong)"
  fi
}

# ---------- 1. paket ----------
install_packages() {
  judul "1/11 Memasang paket yang dibutuhkan"
  local perlu=() p
  for p in git curl openssl jq qrencode ca-certificates; do
    if [[ "$p" == "ca-certificates" ]]; then
      dpkg -s ca-certificates >/dev/null 2>&1 || perlu+=("$p")
    else
      command -v "$p" >/dev/null 2>&1 || perlu+=("$p")
    fi
  done
  if (( ${#perlu[@]} > 0 )); then
    info "Memasang: ${perlu[*]} (beberapa menit)"
    export DEBIAN_FRONTEND=noninteractive
    apt_coba update -qq || die "apt-get update gagal. Periksa koneksi internet VPS lalu jalankan ulang."
    apt_coba install -y -qq "${perlu[@]}" || die "Gagal memasang paket: ${perlu[*]}. Jalankan ulang; bila tetap gagal kirim pesan galat di atas ke pembuat bot."
  fi
  ok "Paket dasar siap"
  if docker compose version >/dev/null 2>&1; then
    ok "Docker sudah terpasang"
  elif command -v docker >/dev/null 2>&1; then
    # Docker sudah dipakai proyek lain: JANGAN pasang ulang (bisa me-restart semua container). Cukup tambah plugin compose.
    info "Docker sudah ada tetapi 'docker compose' belum; memasang plugin compose saja (Docker tidak dipasang ulang)."
    apt_coba install -y -qq docker-compose-plugin >/dev/null 2>&1 || apt_coba install -y -qq docker-compose-v2 >/dev/null 2>&1 || true
    docker compose version >/dev/null 2>&1 || die "Tidak bisa memasang 'docker compose' v2 otomatis. Docker di VPS ini dipasang dengan cara lain; minta pengelola VPS memasang docker-compose-plugin, lalu jalankan ulang. Docker yang ada tidak diubah."
    ok "Plugin docker compose terpasang"
  else
    info "Memasang Docker (skrip resmi get.docker.com, beberapa menit)"
    local n ok_docker=0
    for n in 1 2 3; do
      if curl -fsSL https://get.docker.com | sh; then ok_docker=1; break; fi
      if (( n < 3 )); then
        warn "Pemasangan Docker gagal (bisa karena pembaruan otomatis VPS sedang jalan). Mencoba lagi dalam 60 detik ($n/2)..."
        sleep 60
      fi
    done
    (( ok_docker == 1 )) || die "Pemasangan Docker gagal. Jalankan ulang skrip ini; bila tetap gagal kirim pesan galat di atas."
    systemctl enable --now docker >/dev/null 2>&1 || true
    docker compose version >/dev/null 2>&1 || die "Docker terpasang tetapi 'docker compose' tidak ada. Pasang paket docker-compose-plugin lalu jalankan ulang."
    ok "Docker terpasang"
  fi
}

# ---------- 2. kode ----------
petunjuk_deploy_key() {
  err "Tidak bisa mengambil kode dari $REPO_URL."
  info "Kalau repo sudah dijadikan PRIVAT, pakai kunci deploy (hanya-baca):"
  info "  1) Buat kunci di VPS ini:"
  info "       ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519 -C cp-sistem-vps"
  info "       cat /root/.ssh/id_ed25519.pub"
  info "  2) Salin satu baris hasilnya. Di GitHub buka repo > Settings > Deploy keys > Add deploy key,"
  info "     tempel, beri judul 'vps', JANGAN centang Allow write access, lalu simpan."
  info "  3) Jalankan ulang dengan alamat SSH:"
  info "       sudo bash install.sh --repo git@github.com:pandeyoga/cpdm.git"
}

ambil_kode() {
  judul "2/11 Mengambil kode bot"
  export GIT_TERMINAL_PROMPT=0
  if [[ "$REPO_URL" == git@* || "$REPO_URL" == ssh://* ]]; then
    export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
  fi
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    if git -C "$INSTALL_DIR" pull --ff-only >/dev/null 2>&1; then
      ok "Kode diperbarui ($INSTALL_DIR)"
    else
      warn "Tidak bisa memperbarui kode (repo privat atau ada perubahan lokal). Memakai kode yang sudah ada."
    fi
  else
    if [[ -e "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
      die "Folder $INSTALL_DIR sudah ada tetapi bukan hasil clone. Pindahkan/hapus folder itu lalu jalankan ulang."
    fi
    mkdir -p "$(dirname "$INSTALL_DIR")"
    if ! git clone --quiet "$REPO_URL" "$INSTALL_DIR"; then
      petunjuk_deploy_key
      exit 1
    fi
    ok "Kode diambil ke $INSTALL_DIR"
  fi
  DEPLOY="$INSTALL_DIR/deploy"
  ENV_FILE="$DEPLOY/.env"
  STATE_DIR="$DEPLOY/.installer-state"
  [[ -f "$DEPLOY/docker-compose.yml" ]] || die "docker-compose.yml tidak ditemukan di $DEPLOY. Kode tidak lengkap; hapus $INSTALL_DIR lalu jalankan ulang."
}

dc() { (cd "$DEPLOY" && docker compose "$@"); }

# Apakah ada program yang mendengarkan di port TCP ini (alamat mana pun)? Tanpa ketergantungan pada ss/netstat.
port_dipakai() {
  local hex f berkas=()
  hex=$(printf '%04X' "$1")
  # tcp6 tidak ada bila IPv6 dimatikan; hanya baca berkas yang ada.
  for f in "${PROC_NET_TCP:-/proc/net/tcp}" "${PROC_NET_TCP6:-/proc/net/tcp6}"; do [[ -r "$f" ]] && berkas+=("$f"); done
  (( ${#berkas[@]} > 0 )) || return 1
  awk -v h="$hex" '$4 == "0A" { n = split($2, a, ":"); if (a[n] == h) f = 1 } END { exit !f }' "${berkas[@]}"
}

# Port WAHA di 127.0.0.1: 3000, atau port bebas pertama di 3100-3199 bila 3000 dipakai proyek lain. Dipilih sekali, disimpan di .env.
pilih_port_waha() {
  local port p
  port="$(get_env WAHA_PORT)"
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    port=""
    for p in 3000 $(seq 3100 3199); do
      if ! port_dipakai "$p"; then port="$p"; break; fi
    done
    [[ -n "$port" ]] || die "Tidak ada port bebas di 3000 atau 3100-3199 untuk WAHA. Bebaskan salah satu lalu jalankan ulang."
    set_env WAHA_PORT "$port"
    if [[ "$port" == "3000" ]]; then ok "Port WAHA: 3000 (hanya 127.0.0.1)"; else ok "Port 3000 dipakai program lain; WAHA memakai port $port (hanya 127.0.0.1)"; fi
  fi
  WAHA_BASE="http://127.0.0.1:$port"
}

# ---------- 3. .env ----------
siapkan_env() {
  judul "3/11 Menyiapkan konfigurasi (.env)"
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$DEPLOY/.env.example" "$ENV_FILE"
    ok "Berkas .env dibuat"
  fi
  chmod 600 "$ENV_FILE"

  local k
  for k in WAHA_API_KEY WAHA_HMAC_KEY; do
    if is_placeholder "$(get_env "$k")"; then set_env "$k" "$(openssl rand -hex 32)"; ok "$k dibuat otomatis"; fi
  done
  if is_placeholder "$(get_env WAHA_DASHBOARD_PASSWORD)"; then
    set_env WAHA_DASHBOARD_PASSWORD "$(openssl rand -hex 16)"; ok "WAHA_DASHBOARD_PASSWORD dibuat otomatis"
  fi

  pilih_port_waha

  if is_placeholder "$(get_env ANTHROPIC_API_KEY)"; then
    warn "Perlu API key Claude. Buat key BARU di console.anthropic.com > API Keys (berawalan sk-ant-api...)."
    info "Pastikan akun punya saldo/kredit. JANGAN kirim key ini lewat chat atau email; ketik langsung di sini."
    local coba=0 key=""
    while (( coba < 3 )); do
      ask_secret "API key Claude"
      key="$ASK_ANSWER"
      if [[ "$key" == sk-ant-* && ${#key} -ge 30 ]]; then break; fi
      warn "Bentuknya tidak seperti API key Claude (harus berawalan sk-ant- dan panjang). Coba lagi."
      key=""; coba=$((coba + 1))
    done
    [[ -n "$key" ]] || die "API key Claude belum valid. Jalankan ulang skrip dan tempel key dengan benar."
    set_env ANTHROPIC_API_KEY "$key"
    ok "API key Claude tersimpan di .env (tidak ditampilkan)"
  else
    ok "API key Claude sudah ada"
  fi
}

# ---------- WAHA ----------
# waha_get PATH [berkas_keluaran]: kunci API diteruskan lewat konfigurasi curl sementara (tidak tampak di `ps`).
waha_curl() {
  local key
  key="$(get_env WAHA_API_KEY)"
  curl -sS --max-time 20 -K <(printf 'header = "X-Api-Key: %s"\n' "$key") "$@"
}
waha_get() { waha_curl -f "$WAHA_BASE$1"; }
waha_post() { waha_curl -f -X POST "$WAHA_BASE$1" >/dev/null; }

waha_status() {
  waha_get "/api/sessions/$SESI" 2>/dev/null | jq -r '.status // empty' 2>/dev/null || true
}

tunggu_api_waha() {
  local i code dibuat_ulang=0
  info "Menunggu WAHA siap (maksimal 2 menit)..."
  for ((i = 0; i < 40; i++)); do
    code=$(waha_curl -o /dev/null -w '%{http_code}' "$WAHA_BASE/api/sessions/$SESI" 2>/dev/null || true)
    case "$code" in
      200) return 0 ;;
      404) waha_post "/api/sessions/$SESI/start" 2>/dev/null || true ;;
      401|403)
        if (( dibuat_ulang == 0 )); then
          warn "WAHA memakai kunci API lama; memuat ulang WAHA dengan kunci dari .env (sambungan WhatsApp tetap)..."
          dc up -d --force-recreate waha >/dev/null || true
          dibuat_ulang=1
        else
          die "WAHA tetap menolak kunci API di $ENV_FILE. Kirim pesan ini ke pembuat bot."
        fi
        ;;
    esac
    sleep 3
  done
  err "WAHA tidak menjawab dalam 2 menit."
  info "Lihat penyebabnya:  docker compose -f $DEPLOY/docker-compose.yml logs --tail 50 waha"
  return 1
}

tampilkan_qr() {
  local qr
  qr=$(waha_get "/api/$SESI/auth/qr?format=raw" 2>/dev/null | jq -r '.value // empty' 2>/dev/null || true)
  printf '\033[2J\033[H'
  printf '%s== Hubungkan WhatsApp ==%s\n' "$C_B" "$C_OFF"
  info "Di HP yang memegang NOMOR BOT: WhatsApp > Perangkat tertaut > Tautkan perangkat > scan kode di bawah."
  info "Kode berganti tiap sekitar 20 detik; bila gagal, tunggu kode baru muncul. (Ctrl+C untuk batal)"
  echo
  if [[ -n "$qr" ]]; then
    qrencode -t ANSIUTF8 -m 2 "$qr"
  else
    warn "QR belum tersedia, menunggu WAHA..."
  fi
}

# Satu baris galat terakhir dari log WAHA (tanpa log webhook), untuk ditunjukkan ke pemilik.
galat_waha_terakhir() {
  dc logs --no-color --no-log-prefix --tail 400 waha 2>/dev/null | sed -E 's/\x1b\[[0-9;]*m//g' \
    | grep -E '(ERROR|FATAL) \(' | grep -v 'WebhookSender' | tail -1 \
    | sed -E 's/^\[[0-9:.]+\] //; s/ \{"session".*$//' | cut -c1-200 || true  # grep tanpa hasil + pipefail
}

DIAGNOSA_CMD="curl -fsSL https://raw.githubusercontent.com/pandeyoga/cpdm/main/deploy/diagnosa-waha.sh | sudo bash"

sambungkan_whatsapp() {
  local paksa="${1:-0}" status="" i t0 detik pernah_qr=0 gagal_terlapor=0 kedaluwarsa_terlapor=0 galat
  info "Menjalankan WAHA (pertama kali mengunduh image sekitar 1 GB, bisa beberapa menit)..."
  if ! dc up -d waha >/dev/null; then
    err "Gagal menjalankan WAHA. Penyebabnya tertulis di atas."
    info "Yang sering terjadi: port $(get_env WAHA_PORT) sudah dipakai program lain (hapus baris WAHA_PORT di $ENV_FILE agar dipilih ulang),"
    info "disk VPS penuh (cek: df -h), atau batas unduh Docker Hub (tunggu 1 jam)."
    info "Setelah diperbaiki, jalankan lagi:  $(cara_ulang)"
    return 1
  fi
  tunggu_api_waha
  status=$(waha_status)
  if [[ "$status" == "WORKING" && "$paksa" == "1" ]]; then
    if confirm "WhatsApp sudah tersambung. Putuskan dulu dan scan ulang?"; then
      waha_post "/api/sessions/$SESI/logout" || warn "Gagal memutus sesi lama; lanjut mencoba."
      sleep 3
      waha_post "/api/sessions/$SESI/start" 2>/dev/null || true
    fi
  fi
  t0=$(date +%s)
  while true; do
    status=$(waha_status)
    case "$status" in
      WORKING) break ;;
      STOPPED|"") waha_post "/api/sessions/$SESI/start" 2>/dev/null || true; sleep 3 ;;
      FAILED)
        # WAHA sendiri memulai ulang sesi sekitar 2 detik setelah gagal; me-restart container justru mengganggu.
        if (( pernah_qr == 1 )); then
          # GOWS: QR yang tidak di-scan sekitar 3 menit kedaluwarsa (status FAILED sebentar), lalu QR baru dibuat.
          if (( kedaluwarsa_terlapor == 0 )); then
            warn "QR kedaluwarsa karena belum di-scan. QR baru sedang dibuat, tunggu sebentar..."
            kedaluwarsa_terlapor=1
          fi
        elif (( gagal_terlapor == 0 )); then
          galat="$(galat_waha_terakhir)"
          warn "Sesi WhatsApp gagal dimulai; WAHA mencoba lagi sendiri.${galat:+ Penyebab: $galat}"
          gagal_terlapor=1
        fi
        sleep 5
        ;;
      SCAN_QR_CODE)
        pernah_qr=1
        kedaluwarsa_terlapor=0
        tampilkan_qr
        for ((i = 0; i < 7; i++)); do
          sleep 3
          [[ "$(waha_status)" == "WORKING" ]] && break
        done
        ;;
      *) sleep 3 ;;
    esac
    detik=$(( $(date +%s) - t0 ))
    if (( pernah_qr == 0 && detik > 120 )) && [[ "$status" == "FAILED" || "$status" == "STARTING" ]]; then
      err "Sesi WhatsApp terus gagal dimulai selama 2 menit (QR belum pernah muncul)."
      galat="$(galat_waha_terakhir)"
      [[ -z "$galat" ]] || info "Galat terakhir WAHA: $galat"
      info "Jalankan diagnosa (hanya membaca) lalu kirim hasilnya ke pembuat bot:"
      info "  $DIAGNOSA_CMD"
      return 1
    fi
    if (( detik > 600 )); then
      err "10 menit berlalu tetapi WhatsApp belum tersambung."
      info "Ulangi hanya langkah ini:  $(cara_ulang --qr)"
      info "Bila tetap gagal, jalankan diagnosa:  $DIAGNOSA_CMD"
      return 1
    fi
  done
  printf '\033[2J\033[H'
  local me
  me=$(waha_get "/api/sessions/$SESI/me" 2>/dev/null | jq -r '.id // empty' 2>/dev/null || true)
  if [[ -n "$me" ]]; then
    ok "WhatsApp tersambung, nomor bot: $(mask_number "$me")"
  else
    ok "WhatsApp tersambung"
  fi
}

langkah_whatsapp() {
  judul "4/11 Menyambungkan WhatsApp (nomor bot)"
  if step_done wa && [[ "$(waha_status)" == "WORKING" ]]; then ok "WhatsApp sudah tersambung (lewati)"; return 0; fi
  sambungkan_whatsapp 0
  mark_done wa
}

# ---------- 5. grup ----------
daftar_grup() { # stdout: "id<TAB>nama" per baris; cadangan lewat daftar chat bila /groups kosong
  local hasil
  hasil=$(waha_get "/api/$SESI/groups" 2>/dev/null | saring_grup || true)
  [[ -n "$hasil" ]] || hasil=$(waha_get "/api/$SESI/chats?limit=100" 2>/dev/null | saring_grup || true)
  printf '%s' "$hasil"
}

saring_grup() { # JSON (stdin) -> "id<TAB>nama" untuk id berakhiran @g.us
  jq -r '
    (if type == "array" then .
     elif type == "object" then (to_entries | map(select(.value | type == "object") | .value + {jid: .key}))
     else [] end)
    | .[]
    | { id: ((.id | if type == "object" then (._serialized // ((.user // "") + "@" + (.server // ""))) else . end) // .JID // .jid),
        name: (.subject // .name // .Name // "(tanpa nama)") }
    | select(.id != null and ((.id | tostring) | endswith("@g.us")))
    | "\(.id)\t\(.name)"' 2>/dev/null || true
}

langkah_grup() {
  judul "5/11 Memilih grup WhatsApp \"CP Live\""
  local sekarang
  sekarang="$(get_env LIVE_GROUP_ID)"
  if step_done grup && [[ "$sekarang" == *@g.us ]]; then ok "Grup sudah dipilih (lewati)"; return 0; fi
  info "Buat (atau pakai) grup WhatsApp bernama \"CP Live\" yang berisi NOMOR BOT, lalu tekan Enter."
  ask "Tekan Enter bila grup sudah siap" ""
  local daftar ids names line pilih i gid=""
  while [[ -z "$gid" ]]; do
    daftar=$(daftar_grup)
    ids=(); names=()
    while IFS=$'\t' read -r id nm; do
      [[ -n "$id" ]] || continue
      ids+=("$id"); names+=("$nm")
    done <<< "$daftar"
    if (( ${#ids[@]} == 0 )); then
      warn "Tidak ada grup terbaca. Pastikan nomor bot sudah masuk grup."
      ask "r = muat ulang, m = ketik ID grup sendiri" "r"
      pilih="$ASK_ANSWER"
    else
      echo
      for ((i = 0; i < ${#ids[@]}; i++)); do printf '  %2d) %s\n' $((i + 1)) "${names[$i]}"; done
      echo
      ask "Nomor grup yang dipakai (r = muat ulang, m = ketik ID sendiri)" ""
      pilih="$ASK_ANSWER"
    fi
    line="$pilih"
    if [[ "$line" =~ ^[0-9]+$ ]] && (( line >= 1 && line <= ${#ids[@]} )); then
      gid="${ids[$((line - 1))]}"
    elif [[ "$line" =~ ^[Mm]$ ]]; then
      info "ID grup berbentuk angka panjang diakhiri @g.us (contoh 120363012345678901@g.us)."
      info "Bila grup tidak muncul di daftar: kirim satu pesan di grup itu, tunggu 30 detik, lalu pilih r (muat ulang)."
      ask "ID grup (berakhiran @g.us)" ""
      if [[ "$ASK_ANSWER" == *@g.us ]]; then gid="$ASK_ANSWER"; else warn "ID harus berakhiran @g.us."; fi
    elif [[ ! "$line" =~ ^[Rr]$ && -n "$line" ]]; then
      warn "Pilihan tidak dikenal."
    fi
  done
  set_env LIVE_GROUP_ID "$gid"
  ok "Grup dipilih dan disimpan"
  mark_done grup
}

# ---------- 6. uji Task 0 ----------
langkah_task0() {
  judul "6/11 Uji terima gambar dari grup"
  if step_done task0; then ok "Uji gambar sudah lulus (lewati)"; return 0; fi
  local gid mulai batas pesan="" i url mime path ukuran out
  gid="$(get_env LIVE_GROUP_ID)"
  mulai=$(( $(date +%s) - 30 ))
  local kode_http
  kode_http=$(waha_curl -o /dev/null -w '%{http_code}' "$WAHA_BASE/api/$SESI/chats/$gid/messages?limit=1" 2>/dev/null || true)
  if [[ "$kode_http" != "200" ]]; then
    err "WAHA tidak bisa membaca pesan grup yang dipilih (kode HTTP ${kode_http:-tidak ada jawaban})."
    case "$kode_http" in
      400|404|422)
        info "ID grup tampaknya salah. Grup akan ditanyakan lagi saat skrip dijalankan ulang."
        rm -f "$STATE_DIR/grup"
        set_env LIVE_GROUP_ID "GANTI_dengan_id_grup"
        ;;
      *) info "WhatsApp mungkin terputus atau WAHA belum siap. Tunggu 1 menit." ;;
    esac
    info "Jalankan lagi:  $(cara_ulang)"
    return 1
  fi
  info "Sekarang kirim SATU foto apa saja ke grup tadi dengan keterangan (caption):  tes"
  info "Menunggu foto masuk (maksimal 3 menit)..."
  batas=$(( $(date +%s) + 180 ))
  while (( $(date +%s) < batas )); do
    pesan=$(waha_get "/api/$SESI/chats/$gid/messages?limit=5&downloadMedia=true" 2>/dev/null | jq -c --argjson t "$mulai" '
      (if type == "array" then . else [] end)
      | map(select((.hasMedia == true) and ((.timestamp // 0) >= $t)))
      | sort_by(.timestamp) | last // empty' 2>/dev/null || true)
    [[ -n "$pesan" ]] && break
    sleep 5
  done
  if [[ -z "$pesan" ]]; then
    err "Tidak ada foto baru dari grup dalam 3 menit."
    info "Cek: (1) nomor bot ada di grup dan grup yang dipilih benar, (2) foto dikirim SETELAH tulisan di atas muncul."
    info "Lalu ulangi:  $(cara_ulang)"
    return 1
  fi
  ok "Pesan bergambar terdeteksi"
  url=$(jq -r '.media.url // empty' <<< "$pesan")
  mime=$(jq -r '.media.mimetype // empty' <<< "$pesan")
  mkdir -p "$DEPLOY/task0"
  # Simpan salinan tersamar (tanpa nomor lengkap/nama) untuk dikirim ke pembuat bot.
  jq . <<< "$pesan" | mask_json > "$DEPLOY/task0/pesan-gambar.json"
  waha_get "/api/sessions/$SESI" 2>/dev/null | mask_json > "$DEPLOY/task0/sesi.json" || true
  if [[ -z "$url" ]]; then
    err "Pesan terdeteksi tetapi gambarnya tidak terunduh oleh WAHA (media.url kosong)."
    info "Biasanya karena WHATSAPP_DOWNLOAD_MEDIA belum aktif atau WAHA baru mulai. Tunggu 1 menit lalu ulangi."
    info "Kirim berkas ini ke pembuat bot (tidak berisi rahasia): $DEPLOY/task0/pesan-gambar.json"
    return 1
  fi
  if [[ "$url" == *://* ]]; then path="/${url#*://*/}"; else path="/${url#/}"; fi
  out=$(mktemp)
  if ! waha_curl -f -o "$out" "$WAHA_BASE$path"; then
    rm -f "$out"
    err "Gambar terlihat tetapi gagal diunduh dari WAHA (alamat: $path)."
    info "Kirim berkas ini ke pembuat bot (tidak berisi rahasia): $DEPLOY/task0/pesan-gambar.json"
    return 1
  fi
  ukuran=$(( $(wc -c < "$out") / 1024 ))
  rm -f "$out"
  if [[ -n "$mime" && "$mime" != image/* ]]; then
    warn "Berkas yang diterima bertipe $mime (bukan gambar). Kirim foto biasa, bukan dokumen/video."
  fi
  ok "Gambar dari grup berhasil diterima (${ukuran} KB)"
  info "Dua berkas ini boleh dikirim ke pembuat bot (nomor & nama sudah disamarkan, tanpa rahasia):"
  info "  $DEPLOY/task0/pesan-gambar.json"
  info "  $DEPLOY/task0/sesi.json"
  mark_done task0
}

# ---------- 7. uji baca screenshot ----------
langkah_smoke() {
  judul "7/11 Uji baca screenshot contoh dengan Claude (opsional)"
  if step_done smoke; then ok "Uji baca sudah dilakukan (lewati)"; return 0; fi
  if ! confirm "Uji baca screenshot contoh dengan Claude? (memakai sedikit saldo, sekitar beberapa sen)"; then
    info "Dilewati."
    mark_done smoke
    return 0
  fi
  info "Membangun image bot (pertama kali sekitar 3-6 menit)..."
  dc build bot || { err "Build bot gagal. Lihat pesan di atas; jalankan ulang skrip setelah diperbaiki."; return 1; }
  if dc run --rm --no-deps -T bot node dist/scripts/smoke-extract.js </dev/null; then
    ok "Uji baca selesai (hasil di atas; LULUS berarti pembacaan cocok dengan acuan)"
  else
    warn "Uji baca melaporkan masalah (lihat di atas). Bot tetap bisa dipasang; kirim hasil di atas ke pembuat bot."
  fi
  mark_done smoke
}

# ---------- 8. Google ----------
langkah_google() {
  judul "8/11 Menghubungkan akun Google"
  if is_placeholder "$(get_env GOOGLE_CLIENT_ID)" || is_placeholder "$(get_env GOOGLE_CLIENT_SECRET)"; then
    info "Siapkan dulu 'kunci aplikasi' Google (sekali, sekitar 10 menit) di komputer Anda:"
    info "  1) Buka console.cloud.google.com > buat project baru (nama bebas)."
    info "  2) APIs & Services > Library: aktifkan 'Google Sheets API' dan 'Google Drive API'."
    info "  3) OAuth consent screen: User type = External, isi nama aplikasi & email Anda,"
    info "     tambahkan email Google Anda sendiri sebagai Test user, lalu klik PUBLISH APP (In production)."
    info "  4) Credentials > Create credentials > OAuth client ID > Application type = Desktop app."
    info "  5) Salin Client ID dan Client secret yang muncul."
    local id="" secret=""
    ask "Client ID (berakhiran .apps.googleusercontent.com)" ""
    id="$ASK_ANSWER"
    [[ -n "$id" ]] || die "Client ID kosong. Jalankan ulang skrip setelah menyiapkannya."
    [[ "$id" == *.apps.googleusercontent.com ]] || warn "Client ID biasanya berakhiran .apps.googleusercontent.com; pastikan salinannya benar."
    ask_secret "Client secret"
    secret="$ASK_ANSWER"
    [[ -n "$secret" ]] || die "Client secret kosong. Jalankan ulang skrip setelah menyiapkannya."
    set_env GOOGLE_CLIENT_ID "$id"
    set_env GOOGLE_CLIENT_SECRET "$secret"
    ok "Kunci aplikasi Google tersimpan di .env"
  else
    ok "Kunci aplikasi Google sudah ada"
  fi

  if ! is_placeholder "$(get_env GOOGLE_REFRESH_TOKEN)"; then
    ok "Izin akun Google sudah ada (lewati)"
    return 0
  fi
  dc build --quiet bot >/dev/null || { err "Build bot gagal. Lihat pesan di atas."; return 1; }
  info "Sekarang Anda akan diberi sebuah tautan. Buka di browser, setujui akses, lalu tempel kembali alamat akhirnya."
  local out token berhasil=0
  out=$(mktemp)
  chmod 600 "$out"
  while true; do
    if dc run --rm --no-deps -T bot node dist/scripts/google-auth.js --manual </dev/tty >"$out"; then berhasil=1; break; fi
    err "Login Google gagal. Pastikan Anda menempel ALAMAT LENGKAP dari browser, dan akun Anda terdaftar sebagai Test user."
    confirm "Coba lagi sekarang? (akan muncul tautan BARU)" || break
  done
  if (( berhasil == 0 )); then
    rm -f "$out"
    info "Ulangi nanti:  $(cara_ulang)"
    return 1
  fi
  token=$(tr -d '\r' < "$out" | grep -m1 '^GOOGLE_REFRESH_TOKEN=' | cut -d= -f2- || true)
  rm -f "$out"
  [[ -n "$token" ]] || die "Token Google tidak diterima. Ulangi skrip; bila perlu cabut akses aplikasi di myaccount.google.com/permissions lalu coba lagi."
  set_env GOOGLE_REFRESH_TOKEN "$token"
  ok "Izin akun Google tersimpan (token tidak ditampilkan)"
}

# ---------- 9. spreadsheet ----------
langkah_sheet() {
  judul "9/11 Membuat spreadsheet dan folder bukti"
  if step_done sheet && [[ -n "$(get_env LIVE_SPREADSHEET_ID)" ]]; then
    ok "Spreadsheet sudah dibuat (lewati)"
    info "Tautan: https://docs.google.com/spreadsheets/d/$(get_env LIVE_SPREADSHEET_ID)"
    return 0
  fi
  local owner out sid fid
  ask "Email owner yang ikut jadi editor (Enter = akun Google yang tadi login)" ""
  owner="$ASK_ANSWER"
  if [[ -n "$owner" && "$owner" != *@*.* ]]; then die "Email tidak valid: $owner"; fi
  [[ -n "$owner" ]] && set_env OWNER_EMAIL "$owner"
  out=$(mktemp)
  chmod 600 "$out"
  info "Membuat spreadsheet 'CP – Live Tracker' dan folder 'Bukti Live' (sekitar 1 menit)..."
  if ! dc run --rm --no-deps -T bot node dist/scripts/setup-sheet.js </dev/null >"$out"; then
    rm -f "$out"
    err "Pembuatan spreadsheet gagal (lihat pesan di atas)."
    info "Penyebab umum: Google Sheets API / Drive API belum diaktifkan, atau token kedaluwarsa."
    info "Perbaiki lalu jalankan ulang skrip; untuk login Google ulang, hapus baris GOOGLE_REFRESH_TOKEN di $ENV_FILE."
    return 1
  fi
  sid=$(tr -d '\r' < "$out" | grep -m1 '^LIVE_SPREADSHEET_ID=' | cut -d= -f2- || true)
  fid=$(tr -d '\r' < "$out" | grep -m1 '^BUKTI_FOLDER_ID=' | cut -d= -f2- || true)
  rm -f "$out"
  [[ -n "$sid" && -n "$fid" ]] || die "ID spreadsheet/folder tidak terbaca dari hasil setup. Jalankan ulang skrip."
  set_env LIVE_SPREADSHEET_ID "$sid"
  set_env BUKTI_FOLDER_ID "$fid"
  ok "Spreadsheet dibuat: https://docs.google.com/spreadsheets/d/$sid"
  mark_done sheet
}

# ---------- 10. jalankan bot ----------
langkah_bot() {
  judul "10/11 Menjalankan bot"
  mkdir -p "$DEPLOY/data"
  chown -R 1000:1000 "$DEPLOY/data"
  info "Membangun dan menyalakan WAHA + bot (beberapa menit pertama kali)..."
  dc up -d --build || { err "Gagal menyalakan layanan (lihat pesan di atas)."; return 1; }
  local cid status="" i
  cid=$(dc ps -q bot)
  [[ -n "$cid" ]] || die "Kontainer bot tidak ditemukan. Lihat: docker compose -f $DEPLOY/docker-compose.yml ps"
  info "Menunggu bot sehat (maksimal 3 menit)..."
  for ((i = 0; i < 36; i++)); do
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}tanpa-healthcheck{{end}}' "$cid" 2>/dev/null || echo unknown)
    [[ "$status" == "healthy" ]] && break
    sleep 5
  done
  if [[ "$status" != "healthy" ]]; then
    err "Bot belum sehat (status: $status)."
    dc logs --tail 30 bot || true
    info "Perbaiki sesuai pesan di atas lalu jalankan ulang skrip. Log lengkap:  docker compose -f $DEPLOY/docker-compose.yml logs -f bot"
    return 1
  fi
  ok "Bot berjalan dan sehat"
  dc ps
  mark_done bot
}

# ---------- 11. ringkasan ----------
ringkasan() {
  judul "11/11 Selesai"
  ok "WAHA (WhatsApp) dan bot berjalan di VPS ini."
  echo
  printf '%sSisa langkah manual (sekali saja):%s\n' "$C_B" "$C_OFF"
  info "1) Buka spreadsheet: https://docs.google.com/spreadsheets/d/$(get_env LIVE_SPREADSHEET_ID)"
  info "2) Pasang pemeriksa detak: Ekstensi > Apps Script > tempel isi berkas $INSTALL_DIR/apps-script/heartbeat.gs,"
  info "   lalu jalankan fungsi pasangPemicu() sekali dan setujui izinnya."
  info "3) Isi tab Pengaturan: target bulan, host + nomor WA mereka, dan nomor WA owner."
  info "4) Tambahkan para host ke grup WhatsApp \"CP Live\"."
  echo
  printf '%sPerintah berguna:%s\n' "$C_B" "$C_OFF"
  info "Lanjutkan/ulangi pemasangan : $(cara_ulang)"
  info "Sambung ulang WhatsApp      : $(cara_ulang --qr)"
  info "Lihat log bot               : docker compose -f $INSTALL_DIR/deploy/docker-compose.yml logs -f bot"
  info "Status layanan              : docker compose -f $INSTALL_DIR/deploy/docker-compose.yml ps"
  echo
  info "Rahasia ada di $ENV_FILE (jangan dikirim ke siapa pun)."
  info "Dashboard WAHA (opsional) tidak terbuka ke internet. Dari laptop:  ssh -L 3000:127.0.0.1:$(get_env WAHA_PORT) <user>@<ip-vps>"
  info "  lalu buka http://localhost:3000/dashboard (user admin, sandi = WAHA_DASHBOARD_PASSWORD di berkas yang sama)."
}

main() {
  while (( $# > 0 )); do
    case "$1" in
      --dari-awal) DARI_AWAL=1 ;;
      --qr) HANYA_QR=1 ;;
      --sheet) HANYA_SHEET=1 ;;
      --repo) shift; REPO_URL="${1:?--repo butuh alamat repo}" ;;
      --repo=*) REPO_URL="${1#--repo=}" ;;
      -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
      *) die "Opsi tidak dikenal: $1 (yang ada: --dari-awal, --qr, --sheet, --repo URL)" ;;
    esac
    shift
  done
  trap 'on_error $LINENO' ERR
  preflight
  install_packages
  ambil_kode
  if (( DARI_AWAL == 1 )); then rm -rf "$STATE_DIR"; warn "Mengulang semua langkah (rahasia yang sudah ada tetap dipakai)."; fi
  siapkan_env
  if (( HANYA_SHEET == 1 )); then
    langkah_google
    langkah_sheet
    judul "Spreadsheet siap"
    info "Buka: https://docs.google.com/spreadsheets/d/$(get_env LIVE_SPREADSHEET_ID)"
    info "Bot belum berjalan (WhatsApp belum disambungkan), jadi tab masih kosong; strukturnya sudah final."
    info "Lanjutkan pemasangan (scan WhatsApp, dst.) kapan saja:  $(cara_ulang)"
    exit 0
  fi
  if (( HANYA_QR == 1 )); then
    judul "Sambung ulang WhatsApp"
    sambungkan_whatsapp 1
    mark_done wa
    exit 0
  fi
  langkah_whatsapp
  langkah_grup
  langkah_task0
  langkah_smoke
  langkah_google
  langkah_sheet
  langkah_bot
  ringkasan
}

if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
