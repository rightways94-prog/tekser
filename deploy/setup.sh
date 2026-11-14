#!/usr/bin/env bash
# Тексер: установка на Ubuntu-сервер (Hetzner). Запуск от root:
#   bash setup.sh https://github.com/<user>/tekser.git
set -euo pipefail
REPO="${1:?Укажите адрес репозитория}"
DIR=/opt/tekser
apt-get update -y && apt-get install -y git curl ca-certificates
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
id tekser >/dev/null 2>&1 || useradd -r -m -d "$DIR" -s /usr/sbin/nologin tekser
if [ -d "$DIR/app/.git" ]; then git -C "$DIR/app" pull --ff-only; else git clone "$REPO" "$DIR/app"; fi
cd "$DIR/app" && npm install --omit=dev --no-audit --no-fund
if [ ! -f "$DIR/app/.env" ]; then
  read -rsp "Вставьте ключ OpenAI API (sk-...) и нажмите Enter: " KEY; echo
  printf 'OPENAI_API_KEY=%s\nOPENAI_MODEL=gpt-6.1-sol\nLIMIT_PER_HOUR=5\nPORT=3000\n' "$KEY" > "$DIR/app/.env"
  chmod 600 "$DIR/app/.env"
fi
chown -R tekser:tekser "$DIR"
cat > /etc/systemd/system/tekser.service <<UNIT
[Unit]
Description=Tekser
After=network.target
[Service]
User=tekser
WorkingDirectory=$DIR/app
ExecStart=/usr/bin/node --env-file=$DIR/app/.env server.js
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now tekser && systemctl restart tekser
IP=$(curl -fsS4 https://api.ipify.org)
HOST="tekser.${IP//./-}.sslip.io"
if ss -ltn '( sport = :80 or sport = :443 )' | grep -q LISTEN && ! command -v caddy >/dev/null; then
  echo "Порты 80/443 заняты другим сервисом. Тексер доступен по http://$IP:3000"
  command -v ufw >/dev/null && ufw allow 3000/tcp || true
  exit 0
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
grep -q "$HOST" /etc/caddy/Caddyfile 2>/dev/null || printf '\n%s {\n  reverse_proxy localhost:3000\n}\n' "$HOST" >> /etc/caddy/Caddyfile
command -v ufw >/dev/null && ufw allow 80/tcp && ufw allow 443/tcp || true
systemctl reload caddy || systemctl restart caddy
sleep 3; systemctl --no-pager status tekser | head -5
echo; echo "ГОТОВО: https://$HOST"
