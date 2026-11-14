#!/usr/bin/env bash
# Тексер: ИЗОЛИРОВАННАЯ установка. Всё — только в /opt/tekser и служба tekser.
# Не меняет системный Node, nginx/Caddy, порты 80/443 и другие проекты.
#   bash setup.sh            (порт по умолчанию 8087)
#   PORT=8090 bash setup.sh  (если 8087 занят)
set -euo pipefail
REPO="${REPO:-https://github.com/rightways94-prog/tekser.git}"
DIR=/opt/tekser
PORT="${PORT:-8087}"
NODEV=v22.12.0
if [ -f /etc/systemd/system/tekser.service ] && ! grep -q "$DIR" /etc/systemd/system/tekser.service; then
  echo "Служба tekser уже есть и она чужая — остановка, ничего не изменено."; exit 1; fi
if ss -ltnH "( sport = :$PORT )" | grep -q . && ! systemctl is-active --quiet tekser; then
  echo "Порт $PORT занят другим процессом — ничего не изменено. Запустите: PORT=8090 bash setup.sh"; exit 1; fi
command -v git >/dev/null || { apt-get update -y && apt-get install -y git; }
mkdir -p "$DIR"
if [ ! -x "$DIR/node/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODEV/node-$NODEV-linux-x64.tar.gz" | tar -xz -C "$DIR"
  mv "$DIR/node-$NODEV-linux-x64" "$DIR/node"
fi
export PATH="$DIR/node/bin:$PATH"
id tekser >/dev/null 2>&1 || useradd -r -d "$DIR" -s /usr/sbin/nologin tekser
git config --global --get-all safe.directory | grep -qx "$DIR/app" || git config --global --add safe.directory "$DIR/app"
if [ -d "$DIR/app/.git" ]; then git -C "$DIR/app" pull --ff-only; else git clone "$REPO" "$DIR/app"; fi
cd "$DIR/app" && npm install --omit=dev --no-audit --no-fund
if [ ! -f "$DIR/app/.env" ]; then
  read -rsp "Вставьте ключ OpenAI API (sk-...) и нажмите Enter: " KEY; echo
  printf 'OPENAI_API_KEY=%s\nOPENAI_MODEL=gpt-6.1-sol\nLIMIT_PER_HOUR=5\nPORT=%s\n' "$KEY" "$PORT" > "$DIR/app/.env"
fi
chown -R tekser:tekser "$DIR"; chmod 600 "$DIR/app/.env"
cat > /etc/systemd/system/tekser.service <<UNIT
[Unit]
Description=Tekser ($DIR)
After=network.target
[Service]
User=tekser
WorkingDirectory=$DIR/app
ExecStart=$DIR/node/bin/node --env-file=$DIR/app/.env server.js
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now tekser && systemctl restart tekser
# Автообновление: раз в 5 минут подтягивает новый код из GitHub (только Тексер)
cat > "$DIR/update.sh" <<'UPD'
#!/usr/bin/env bash
cd /opt/tekser/app || exit 0
old=$(git rev-parse HEAD); git pull -q --ff-only || exit 0; new=$(git rev-parse HEAD)
[ "$old" = "$new" ] && exit 0
PATH=/opt/tekser/node/bin:$PATH npm install --omit=dev --no-audit --no-fund -q
chown -R tekser:tekser /opt/tekser && systemctl restart tekser
UPD
chmod +x "$DIR/update.sh"
printf '[Unit]\nDescription=Tekser auto-update\n[Service]\nType=oneshot\nExecStart=%s/update.sh\n' "$DIR" > /etc/systemd/system/tekser-update.service
printf '[Unit]\nDescription=Tekser auto-update every 5 min\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=5min\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/tekser-update.timer
systemctl daemon-reload && systemctl enable --now tekser-update.timer
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "$PORT/tcp"; fi
sleep 2; systemctl --no-pager --lines=3 status tekser | head -6
echo; echo "ГОТОВО: http://$(curl -fsS4 https://api.ipify.org):$PORT"
