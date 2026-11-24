#!/usr/bin/env bash
# Uji fungsi bantu install.sh (tanpa Docker/jaringan):  bash deploy/test-install-helpers.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=install.sh
source ./install.sh
set +e

GAGAL=0
cek() { # cek "nama" "diharapkan" "hasil"
  if [[ "$2" == "$3" ]]; then printf 'LULUS  %s\n' "$1"; else printf 'GAGAL  %s\n  harap: [%s]\n  dapat: [%s]\n' "$1" "$2" "$3"; GAGAL=$((GAGAL + 1)); fi
}

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
F="$T/.env"

# --- is_placeholder ---
for v in "" "GANTI_dengan_sandi_acak" "sk-ant-GANTI_dengan_key_Anda" "GANTI.apps.googleusercontent.com"; do
  is_placeholder "$v"; cek "placeholder: [$v]" 0 $?
done
for v in "abc123" "sk-ant-api03-realkey" "1234.apps.googleusercontent.com"; do
  is_placeholder "$v"; cek "bukan placeholder: [$v]" 1 $?
done

# --- set_env ---
printf 'A=1\n# OWNER_EMAIL=x\nB=lama\nA2=tetap\n' > "$F"
chmod 644 "$F"
set_env B 'baru' "$F"
cek "ganti nilai yang ada" "baru" "$(get_env B "$F")"
cek "kunci mirip tidak ikut berubah" "tetap" "$(get_env A2 "$F")"
cek "baris lain utuh" "1" "$(get_env A "$F")"
set_env C 'x' "$F"
cek "tambah kunci baru" "x" "$(get_env C "$F")"
cek "mode 600 setelah set_env" "600" "$(stat -c %a "$F")"
set_env OWNER_EMAIL 'o@x.id' "$F"
cek "baris komentar tidak diganti, kunci ditambah" "o@x.id" "$(get_env OWNER_EMAIL "$F")"
cek "jumlah baris OWNER_EMAIL=" "1" "$(grep -c '^OWNER_EMAIL=' "$F")"

for v in 'a/b&c|d' "it's \"q\" \$HOME \\n \\1 &" 'sk-ant-api03-AbC_-/+=' '  spasi di tepi  ' '#bukan-komentar'; do
  set_env KHUSUS "$v" "$F"
  cek "nilai khusus: [$v]" "$v" "$(get_env KHUSUS "$F")"
done
cek "KHUSUS hanya satu baris" "1" "$(grep -c '^KHUSUS=' "$F")"
set_env BAD $'a\nb' "$F" >/dev/null 2>&1; cek "tolak baris baru" 1 $?
cek "BAD tidak tertulis" "" "$(get_env BAD "$F")"
set_env BARU_FILE 1 "$T/tidak-ada.env"
cek "buat berkas baru mode 600" "600" "$(stat -c %a "$T/tidak-ada.env")"

# --- mask_number ---
cek "mask nomor lengkap" "*********7890" "$(mask_number '6281234567890@c.us')"
cek "mask nomor pendek" "1234" "$(mask_number '1234')"

# --- mask_json ---
J='{"from":"6281234567890@c.us","pushName":"Budi","_data":{"notifyName":"Budi S","id":"true_120363012345678901@g.us_ABC"},"timestamp":1732000000,"body":"hubungi 08123456789 ya","arr":["628111222333444"]}'
M=$(mask_json <<< "$J")
cek "mask: nomor di from" "*********7890@c.us" "$(jq -r .from <<< "$M")"
cek "mask: pushName" "***" "$(jq -r .pushName <<< "$M")"
cek "mask: notifyName bersarang" "***" "$(jq -r ._data.notifyName <<< "$M")"
cek "mask: id grup 18 digit tetap" "true_120363012345678901@g.us_ABC" "$(jq -r ._data.id <<< "$M")"
cek "mask: timestamp angka tetap" "1732000000" "$(jq -r .timestamp <<< "$M")"
cek "mask: nomor di teks" "hubungi *******6789 ya" "$(jq -r .body <<< "$M")"
cek "mask: dalam array" "***********3444" "$(jq -r '.arr[0]' <<< "$M")"

# --- daftar_grup (jq defensif untuk beberapa bentuk jawaban WAHA) ---
waha_get() { printf '%s' "$FAKE"; }
FAKE='[{"id":{"_serialized":"1203@g.us"},"subject":"CP Live"},{"id":"9@c.us","name":"orang"}]'
cek "grup: NOWEB/WEBJS" $'1203@g.us	CP Live' "$(daftar_grup)"
FAKE='[{"JID":"55@g.us","Name":"Grup Go"}]'
cek "grup: GOWS" $'55@g.us	Grup Go' "$(daftar_grup)"
FAKE='{"77@g.us":{"subject":"Peta"}}'
cek "grup: objek berkunci id" $'77@g.us	Peta' "$(daftar_grup)"
FAKE='bukan json'
cek "grup: gagal parse -> kosong" "" "$(daftar_grup)"
waha_get() { case "$1" in */groups) printf '[]' ;; */chats*) printf '%s' '[{"id":"88@g.us","name":"Dari Chat"},{"id":"1@c.us","name":"x"}]' ;; esac; }
cek "grup: cadangan lewat daftar chat" $'88@g.us	Dari Chat' "$(daftar_grup)"

# --- get_env: CR dan tanda kutip pembungkus dibuang ---
printf 'Q1="nilai kutip"\nQ2='"'"'satu'"'"'\nQ3=ada-cr\r\nQ4="setengah\n' > "$F"
cek "get_env: kutip ganda" "nilai kutip" "$(get_env Q1 "$F")"
cek "get_env: kutip tunggal" "satu" "$(get_env Q2 "$F")"
cek "get_env: CR dibuang" "ada-cr" "$(get_env Q3 "$F")"
cek "get_env: kutip tak berpasangan dibiarkan" '"setengah' "$(get_env Q4 "$F")"

# --- cara_ulang: sebelum klon menunjuk install.sh di folder kerja ---
INSTALL_DIR="$T/belum-ada"
cek "cara_ulang: sebelum klon" "sudo INSTALL_DIR=$T/belum-ada bash install.sh" "$(cara_ulang)"
mkdir -p "$T/sudah/deploy" && : > "$T/sudah/deploy/install.sh"
INSTALL_DIR="$T/sudah"
cek "cara_ulang: sesudah klon + opsi" "sudo INSTALL_DIR=$T/sudah bash $T/sudah/deploy/install.sh --qr" "$(cara_ulang --qr)"
if [[ ! -e /opt/cp-sistem ]]; then
  INSTALL_DIR=/opt/cp-sistem
  cek "cara_ulang: folder bawaan tanpa awalan" "sudo bash install.sh" "$(cara_ulang)"
fi

# --- port_dipakai / pilih_port_waha (berkas /proc palsu) ---
PROC_NET_TCP="$T/tcp"; PROC_NET_TCP6="$T/tcp6"
hdr='  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
printf '%s\n   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1\n   1: 00000000:0C1C 00000000:0000 0A 0 0 0 0 0 0 0 0\n   2: 0100007F:0C1D 0100007F:9C40 01 0 0 0 0 0 0 0 0\n' "$hdr" > "$PROC_NET_TCP"
printf '%s\n   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 0 0 0 0 0 0 0 0\n' "$hdr" > "$PROC_NET_TCP6"
port_dipakai 3000; cek "port: 3000 dipakai (127.0.0.1)" 0 $?
port_dipakai 3100; cek "port: 3100 dipakai (0.0.0.0)" 0 $?
port_dipakai 3101; cek "port: 3101 hanya koneksi keluar -> bebas" 1 $?
port_dipakai 8080; cek "port: 8080 dipakai (IPv6)" 0 $?
port_dipakai 3102; cek "port: 3102 bebas" 1 $?
PROC_NET_TCP6="$T/tidak-ada"
port_dipakai 3000; cek "port: tanpa tcp6 (IPv6 mati) tetap terdeteksi" 0 $?
PROC_NET_TCP6="$T/tcp6"
ENV_FILE="$T/port.env"; : > "$ENV_FILE"
pilih_port_waha >/dev/null
cek "pilih port: lewati yang dipakai" "3101" "$(get_env WAHA_PORT)"
cek "pilih port: WAHA_BASE ikut" "http://127.0.0.1:3101" "$WAHA_BASE"
set_env WAHA_PORT 3000 "$ENV_FILE"
pilih_port_waha >/dev/null
cek "pilih port: nilai tersimpan dipakai lagi (tidak dipilih ulang)" "http://127.0.0.1:3000" "$WAHA_BASE"
printf '%s\n' "$hdr" > "$PROC_NET_TCP"; : > "$PROC_NET_TCP6"; : > "$ENV_FILE"
pilih_port_waha >/dev/null
cek "pilih port: 3000 bila bebas" "3000" "$(get_env WAHA_PORT)"

# --- galat_waha_terakhir: tidak boleh menghentikan skrip (set -e + pipefail) bila log tanpa ERROR ---
dc() { printf '%s\n' '[05:30:01.000] INFO (7): [Manager] Session started' '[05:30:02.000] WARN (WhatsappSession/7): Failed QR item event'; }
hasil=$( (set -Eeuo pipefail; trap 'echo TERHENTI' ERR; g="$(galat_waha_terakhir)"; echo "lanjut:[$g]") 2>&1 )
cek "galat_waha_terakhir: log tanpa ERROR -> kosong, skrip lanjut" "lanjut:[]" "$hasil"
dc() { printf '%s\n' $'\x1b[31mERROR\x1b[39m (WhatsappSession/48): session:default - Waiting failed {"session":"default"}'; }
hasil=$( (set -Eeuo pipefail; g="$(galat_waha_terakhir)"; echo "[$g]") 2>&1 )
cek "galat_waha_terakhir: ambil baris ERROR (tanpa warna)" "[ERROR (WhatsappSession/48): session:default - Waiting failed]" "$hasil"

# --- daftar_grup: WAHA menjawab galat (curl -f gagal) tidak boleh menghentikan skrip ---
waha_get() { return 22; }
hasil=$( (set -Eeuo pipefail; trap 'echo TERHENTI' ERR; d="$(daftar_grup)"; echo "lanjut:[$d]") 2>&1 )
cek "daftar_grup: WAHA galat -> kosong, skrip lanjut" "lanjut:[]" "$hasil"

# --- on_error: satu laporan saja walau galat terjadi di dalam $(...) bertingkat ---
# shellcheck disable=SC2016
hasil=$(bash -c 'source ./install.sh; set -Eeuo pipefail; trap "on_error \$LINENO" ERR; f() { local x; x="$(false | grep a)"; echo "$x"; }; g() { f; }; g' 2>&1 | grep -c "Pemasangan berhenti")
cek "on_error: dilaporkan sekali" "1" "$hasil"

if (( GAGAL > 0 )); then printf '\n%d uji GAGAL\n' "$GAGAL"; exit 1; fi
printf '\nSemua uji lulus\n'
