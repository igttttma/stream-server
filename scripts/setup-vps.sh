#!/usr/bin/env bash
# Sets up this stream-server copy on a Debian/Ubuntu VPS: Node.js, a Let's
# Encrypt certificate for the server's public IP (trusted everywhere: no browser
# warning, no app change), renewal every 6 hours, and systemd services.
# Run as root from the server folder (e.g. /opt/stream-server), with .env in
# place and TCP 80 + 8443 open:
#   bash scripts/setup-vps.sh 203.0.113.7
# Safe to run again (an existing certificate is kept until it is due).
set -euo pipefail

IP="${1:?usage: bash scripts/setup-vps.sh <public IP>}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
[ -f .env ] || { echo ".env missing: copy .env.example and set SCREEN_PASSWORD"; exit 1; }
[ -d node_modules/ws ] || { echo "node_modules missing: copy it along or run npm ci"; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nodejs python3-venv openssl >/dev/null

# Debian's certbot is too old for IP certificates: use the current one from PyPI
if [ ! -x /opt/certbot/bin/certbot ]; then
  python3 -m venv /opt/certbot
  /opt/certbot/bin/pip install -q --upgrade pip certbot
fi

# IP certificates only come with the ~6-day "shortlived" profile; port 80 must be free
/opt/certbot/bin/certbot certonly --standalone --non-interactive --agree-tos \
  --register-unsafely-without-email --keep-until-expiring \
  --ip-address "$IP" --preferred-profile shortlived --cert-name stream-server

grep -q '^CERT_FILE=' .env || cat >> .env <<EOF
CERT_FILE=/etc/letsencrypt/live/stream-server/fullchain.pem
KEY_FILE=/etc/letsencrypt/live/stream-server/privkey.pem
EOF
chmod 600 .env

cat > /etc/systemd/system/stream-server.service <<EOF
[Unit]
Description=BlimpMate stream server (video calls, remote screen control)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
ExecStart=$(command -v node) server.mjs
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/certbot-renew.service <<'EOF'
[Unit]
Description=Renew Let's Encrypt certificates (the stream-server IP certificate lasts ~6 days)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/certbot/bin/certbot renew --non-interactive --deploy-hook "systemctl restart stream-server"
EOF

cat > /etc/systemd/system/certbot-renew.timer <<'EOF'
[Unit]
Description=Renew Let's Encrypt certificates every 6 hours

[Timer]
OnCalendar=*-*-* 00,06,12,18:00:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now certbot-renew.timer
systemctl enable stream-server
systemctl restart stream-server
sleep 2
systemctl is-active stream-server
echo "Done: https://$IP:8443/screen"
