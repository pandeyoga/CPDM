#!/usr/bin/env bash
# Diagnosa WAHA (WhatsApp) bila sesi tidak mau tersambung. HANYA MEMBACA; tidak mengubah apa pun.
# Tidak menampilkan kunci/sandi; deret angka panjang (nomor HP) disamarkan.
# Pakai:  curl -fsSL https://raw.githubusercontent.com/pandeyoga/cpdm/main/deploy/diagnosa-waha.sh | sudo bash
set -uo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/cp-sistem}"
DEPLOY="$INSTALL_DIR/deploy"
judul() { printf '\n== %s ==\n' "$1"; }
samar() { sed -E -e 's/\x1b\[[0-9;]*m//g' -e 's/([0-9]{4,11})([0-9]{4})/****\2/g'; }
# </dev/null: saat skrip dijalankan lewat "curl | bash", stdin adalah sisa skrip; docker exec akan menelannya.
dc() { (cd "$DEPLOY" && docker compose "$@" </dev/null); }

[[ -f "$DEPLOY/docker-compose.yml" ]] || { echo "Tidak menemukan $DEPLOY/docker-compose.yml (atur INSTALL_DIR bila folder lain)."; exit 1; }

judul "Container WAHA"
dc ps waha --format '{{.Name}} | {{.State}} | {{.Status}} | {{.Image}}' 2>&1 | samar
img=$(dc images waha --format json 2>/dev/null | jq -r '(if type=="array" then .[0] else . end) | "\(.Repository // .repository):\(.Tag // .tag) \(.ID // .id)"' 2>/dev/null || true)
[[ -z "$img" ]] || echo "Image: $img"

judul "Status sesi (API WAHA)"
key=$(grep -m1 '^WAHA_API_KEY=' "$DEPLOY/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r"'"'")
port=$(grep -m1 '^WAHA_PORT=' "$DEPLOY/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r"'"'")
if [[ -n "$key" ]]; then
  curl -s -m 10 -K <(printf 'header = "X-Api-Key: %s"\n' "$key") "http://127.0.0.1:${port:-3000}/api/sessions/default" \
    | jq -c '{status, engine: (.engine.engine // .config.engine // null)}' 2>/dev/null || echo "API WAHA tidak menjawab di port ${port:-3000}"
else
  echo "WAHA_API_KEY tidak ditemukan di .env"
fi

judul "Galat WAHA (ringkas, tanpa log webhook; angka = berapa kali muncul)"
log=$(dc logs --no-color --no-log-prefix --tail 1500 waha 2>&1 | samar)
grep -E '(ERROR|FATAL) \(' <<< "$log" | grep -v -E 'WebhookSender' \
  | sed -E 's/^\[[0-9:.]+\] //; s/ \{"session".*$//' | sort | uniq -c | sort -rn | head -12
judul "Rincian galat terakhir"
grep -v -E 'WebhookSender|ENOTFOUND bot|Retrying [0-9]+/15' <<< "$log" \
  | grep -E -A10 '(ERROR|FATAL) \(' | grep -v -E '^\s+at ' | tail -14

judul "Jaringan dari dalam container WAHA"
dc exec -T waha getent hosts web.whatsapp.com >/dev/null 2>&1 \
  && echo "DNS web.whatsapp.com : OK" || echo "DNS web.whatsapp.com : GAGAL"
dc exec -T waha node -e "fetch('https://web.whatsapp.com',{signal:AbortSignal.timeout(15000)}).then(r=>console.log('HTTPS web.whatsapp.com: OK ('+r.status+')')).catch(e=>console.log('HTTPS web.whatsapp.com: GAGAL ('+(e.cause&&e.cause.code||e.message)+')'))" 2>&1 | samar
echo "resolv.conf container : $(dc exec -T waha sh -c 'grep -m3 ^nameserver /etc/resolv.conf | tr "\n" " "' 2>/dev/null)"

judul "Jaringan dari VPS"
getent hosts web.whatsapp.com >/dev/null 2>&1 && echo "DNS web.whatsapp.com (VPS): OK" || echo "DNS web.whatsapp.com (VPS): GAGAL"
kode=$(curl -s -o /dev/null -m 15 -w '%{http_code}' https://web.whatsapp.com 2>/dev/null || true)
if [[ "$kode" =~ ^[23] ]]; then echo "HTTPS web.whatsapp.com (VPS): OK ($kode)"; else echo "HTTPS web.whatsapp.com (VPS): GAGAL (${kode:-tanpa jawaban})"; fi
if [[ -f /etc/docker/daemon.json ]]; then echo "daemon.json dns: $(jq -c '.dns // "tidak diatur"' /etc/docker/daemon.json 2>/dev/null)"; fi

judul "Memori dan proses yang dimatikan"
free -m | sed -n '1,2p'
dmesg 2>/dev/null | grep -i -E 'out of memory|oom-kill|killed process' | tail -5 | samar || true
if systemctl is-active monarx-agent >/dev/null 2>&1; then
  echo "monarx-agent aktif; catatan tentang chrome/chromium (1 jam terakhir):"
  journalctl -u monarx-agent --since '1 hour ago' --no-pager 2>/dev/null | grep -i -E 'chrom|kill|block' | tail -5 | samar
fi

judul "Selesai"
echo "Salin seluruh tulisan di atas dan kirim ke chat (tidak berisi kunci/sandi; nomor disamarkan)."
