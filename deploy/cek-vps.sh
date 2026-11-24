#!/usr/bin/env bash
# Cek kondisi VPS sebelum memasang CP Live. HANYA MEMBACA: tidak memasang, mengubah, atau menghentikan apa pun.
# Tidak menampilkan isi .env, variabel lingkungan container, atau rahasia lain.
# Pakai:  curl -fsSL https://raw.githubusercontent.com/pandeyoga/cpdm/main/deploy/cek-vps.sh | sudo bash
set -uo pipefail

PERHATIAN=0
judul() { printf '\n== %s ==\n' "$1"; }
baris() { printf '  %s\n' "$*"; }
awas() { printf '  [PERHATIAN] %s\n' "$*"; PERHATIAN=$((PERHATIAN + 1)); }
aman() { printf '  [OK] %s\n' "$*"; }
ada() { command -v "$1" >/dev/null 2>&1; }

judul "Sistem"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  baris "OS      : $(. /etc/os-release; echo "${PRETTY_NAME:-?}")"
fi
baris "Kernel  : $(uname -r)  |  Arsitektur: $(uname -m)"
baris "CPU     : $(nproc 2>/dev/null || echo ?) inti  |  Nyala sejak: $(uptime -p 2>/dev/null || echo ?)"
[[ "$(id -u)" -eq 0 ]] || awas "Tidak dijalankan sebagai root; sebagian data tidak terbaca. Jalankan dengan sudo."
[[ "$(uname -m)" == "x86_64" || "$(uname -m)" == "aarch64" ]] || awas "Arsitektur $(uname -m) mungkin tidak didukung image WAHA."

judul "Memori dan disk"
mem_total=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
swap_total=$(awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo)
baris "RAM total ${mem_total} MB, tersedia ${mem_avail} MB, swap ${swap_total} MB"
if (( mem_avail < 1200 )); then
  awas "RAM tersedia di bawah 1,2 GB. WAHA (WhatsApp) + bot butuh sekitar 1 GB; proyek lain bisa melambat."
else
  aman "RAM tersedia cukup untuk WAHA + bot (sekitar 1 GB)"
fi
(( swap_total > 0 )) || baris "Tidak ada swap (bukan masalah bila RAM tersedia cukup)."
for d in / /opt /var/lib/docker; do
  [[ -d "$d" ]] || continue
  baris "Disk kosong di $d : $(df -Ph "$d" | awk 'NR==2 {print $4 " dari " $2 " (terpakai " $5 ")"}')"
done
free_root_gb=$(df -Pk /var/lib 2>/dev/null | awk 'NR==2 {print int($4/1024/1024)}')
if (( ${free_root_gb:-0} < 5 )); then awas "Disk kosong di bawah 5 GB; image WAHA + bot butuh sekitar 3 GB."; else aman "Disk kosong cukup (${free_root_gb} GB)"; fi

judul "Docker"
if ada docker; then
  dv=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  if [[ -n "$dv" ]]; then baris "Docker  : $dv (berjalan)"; else awas "Docker terpasang tetapi daemon tidak menjawab (systemctl status docker)."; fi
  if docker compose version >/dev/null 2>&1; then
    aman "docker compose v2: $(docker compose version --short 2>/dev/null)"
  else
    awas "Docker ada tetapi 'docker compose' (v2) tidak ada. Pemasang TIDAK akan memasang ulang Docker; perlu paket docker-compose-plugin."
  fi
  ada docker-compose && baris "docker-compose lama (v1) juga ada: $(docker-compose version --short 2>/dev/null || echo ?)"
  if ada snap && snap list docker >/dev/null 2>&1; then awas "Docker terpasang lewat snap; jalankan pemasang dengan hati-hati (folder di luar /home bisa dibatasi snap)."; fi
  if ada dpkg; then
    pk=$(dpkg -l 2>/dev/null | awk '/^ii/ && $2 ~ /^(docker|containerd|moby)/ {print $2}' | tr '\n' ' ')
    baris "Paket   : ${pk:-(bukan dari apt)}"
  fi
  dr=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  [[ -z "$dr" ]] || baris "Data Docker: $dr"
else
  baris "Docker belum terpasang (pemasang akan memasangnya; tidak ada container lain yang terpengaruh)."
fi

if ada docker && docker info >/dev/null 2>&1; then
  judul "Container yang berjalan (nama | image | port)"
  docker ps --format '{{.Names}} | {{.Image}} | {{.Ports}}' 2>/dev/null | sed -e 's/0\.0\.0\.0/semua-IP/g' -e 's/^/  /'
  baris "Jumlah: $(docker ps -q 2>/dev/null | wc -l) berjalan, $(docker ps -aq 2>/dev/null | wc -l) total"
  judul "Proyek docker compose"
  docker compose ls --all --format table 2>/dev/null | sed 's/^/  /' || baris "(tidak bisa dibaca)"
  if docker compose ls --all -q 2>/dev/null | grep -qx 'cp-sistem'; then
    baris "Proyek 'cp-sistem' sudah ada (pemasangan sebelumnya); pemasang akan melanjutkannya."
  fi
  if docker ps -a --format '{{.Image}}' 2>/dev/null | grep -q 'devlikeapro/waha'; then
    awas "Sudah ada container WAHA lain di VPS ini (lihat daftar di atas). Boleh berdampingan, asal nomor WhatsApp-nya berbeda."
  fi
  judul "Pemakaian disk Docker"
  docker system df 2>/dev/null | sed 's/^/  /'
fi

judul "Port yang sedang dipakai (TCP, mendengarkan)"
if ada ss; then
  ss -Htlnp 2>/dev/null | awk '{
      addr=$4; n=split(addr, a, ":"); port=a[n]; host=substr(addr, 1, length(addr)-length(port)-1);
      proc=$0; sub(/.*users:\(\("/, "", proc); sub(/".*/, "", proc); if (proc == $0) proc="?";
      printf "  %-6s %-22s %s\n", port, host, proc }' | sort -n -u
  port_bebas=""
  for p in 3000 $(seq 3100 3199); do
    if ! ss -Htln "sport = :$p" 2>/dev/null | grep -q .; then port_bebas="$p"; break; fi
  done
  if ss -Htln 'sport = :3000' 2>/dev/null | grep -q .; then
    awas "Port 3000 sudah dipakai. Pemasang akan memakai port lain secara otomatis (${port_bebas:-?}) khusus di 127.0.0.1."
  else
    aman "Port 3000 bebas"
  fi
else
  baris "(perintah ss tidak ada; lewati)"
fi

judul "Layanan lain (hanya informasi; pemasang tidak menyentuhnya)"
for s in nginx apache2 caddy traefik ufw fail2ban unattended-upgrades; do
  if ada systemctl && systemctl list-unit-files "$s.service" >/dev/null 2>&1 && systemctl list-unit-files "$s.service" | grep -q "^$s"; then
    baris "$(printf '%-20s' "$s") $(systemctl is-active "$s" 2>/dev/null)"
  fi
done
if ada ufw; then baris "Firewall ufw: $(ufw status 2>/dev/null | head -1)"; fi
if pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1; then
  awas "apt/dpkg sedang berjalan (pembaruan otomatis?). Tunggu selesai sebelum memasang."
fi

judul "Folder tujuan"
if [[ -d /opt/cp-sistem/.git ]]; then
  baris "/opt/cp-sistem sudah ada (hasil pemasangan sebelumnya)."
elif [[ -e /opt/cp-sistem ]]; then
  awas "/opt/cp-sistem sudah ada tetapi bukan dari pemasang ini. Pakai folder lain: INSTALL_DIR=/opt/cp-live"
else
  aman "/opt/cp-sistem belum ada (akan dibuat)"
fi

judul "Kesimpulan"
if (( PERHATIAN == 0 )); then
  baris "Tidak ada yang perlu diperhatikan. Aman menjalankan pemasang."
else
  baris "$PERHATIAN hal perlu diperhatikan (lihat [PERHATIAN] di atas)."
fi
baris "Pemasang CP Live hanya membuat proyek Docker bernama 'cp-sistem' di /opt/cp-sistem,"
baris "port WAHA hanya di 127.0.0.1 (tidak terbuka ke internet), dan tidak menghentikan,"
baris "memperbarui, atau menghapus container/proyek lain."
baris "Salin seluruh tulisan di atas dan kirim ke chat (tidak berisi sandi atau kunci)."
