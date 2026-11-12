#!/usr/bin/env bash
# Put Walk Keeper live on the Contabo server (walk.statix.engineering).
# Run from this folder:  bash deploy.sh
# First run also makes the service, the Caddy site and the .env (password comes from WK_NEW_PASS_HASH).
set -euo pipefail
cd "$(dirname "$0")"
HOST=root@184.174.35.25
KEY=~/.ssh/technopol_vps
SSH="ssh -i $KEY -o BatchMode=yes $HOST"

node test-server.mjs
$SSH 'mkdir -p /srv/walkkeeper/data/backups'
scp -i $KEY -q server.js index.html $HOST:/srv/walkkeeper/

$SSH "WK_NEW_PASS_HASH='${WK_NEW_PASS_HASH:-}' bash -s" <<'REMOTE'
set -euo pipefail
cd /srv/walkkeeper
if [ ! -f .env ]; then
  [ -n "$WK_NEW_PASS_HASH" ] || { echo "First deploy needs WK_NEW_PASS_HASH"; exit 1; }
  printf 'PORT=8830\nHOST=127.0.0.1\nWK_PASS_HASH=%s\nWK_SECRET=%s\n' "$WK_NEW_PASS_HASH" "$(openssl rand -hex 32)" > .env
  chmod 600 .env
fi
if [ ! -f /etc/systemd/system/walkkeeper.service ]; then
  cat > /etc/systemd/system/walkkeeper.service <<'UNIT'
[Unit]
Description=Walk Keeper family treadmill app
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/srv/walkkeeper
EnvironmentFile=/srv/walkkeeper/.env
Environment=NODE_ENV=production
ExecStart=/opt/node24/bin/node /srv/walkkeeper/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/srv/walkkeeper/data

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable walkkeeper
fi
systemctl restart walkkeeper
if ! grep -q 'walk.statix.engineering' /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)
  cat >> /etc/caddy/Caddyfile <<'CADDY'

walk.statix.engineering, walk.184-174-35-25.sslip.io {
	encode zstd gzip
	header {
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}
	reverse_proxy 127.0.0.1:8830
}
CADDY
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl reload caddy
fi
sleep 1
curl -fsS http://127.0.0.1:8830/api/health && echo
REMOTE
echo "Live: https://walk.statix.engineering  (until DNS works: https://walk.184-174-35-25.sslip.io)"
