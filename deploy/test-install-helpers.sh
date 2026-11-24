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

if (( GAGAL > 0 )); then printf '\n%d uji GAGAL\n' "$GAGAL"; exit 1; fi
printf '\nSemua uji lulus\n'
