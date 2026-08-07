#!/usr/bin/env bash
set -euo pipefail

readonly APP_DIR=/opt/roleplay-agent
readonly DB_ROLE=roleplay
readonly DB_NAME=roleplay

if sudo -u postgres psql -Atqc "SELECT 1 FROM pg_roles WHERE rolname='roleplay'" | grep -q 1; then
  echo "Refusing to replace existing PostgreSQL role: roleplay" >&2
  exit 1
fi
if sudo -u postgres psql -Atqc "SELECT 1 FROM pg_database WHERE datname='roleplay'" | grep -q 1; then
  echo "Refusing to replace existing PostgreSQL database: roleplay" >&2
  exit 1
fi
if [[ -e "${APP_DIR}/.env" ]]; then
  echo "Refusing to replace existing environment file: ${APP_DIR}/.env" >&2
  exit 1
fi

db_password="$(openssl rand -hex 32)"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE ${DB_ROLE} LOGIN PASSWORD '${db_password}';"
sudo -u postgres createdb -O "${DB_ROLE}" "${DB_NAME}"
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

sudo install -o root -g ubuntu -m 0640 /tmp/roleplay-agent.env.template "${APP_DIR}/.env"
sudo sed -i "s/__SET_DATABASE_PASSWORD__/${db_password}/" "${APP_DIR}/.env"
unset db_password

sudo chown -R ubuntu:ubuntu "${APP_DIR}/data"
cd "${APP_DIR}"
PATH=/opt/node22/bin:/usr/bin:/bin /opt/node22/bin/node scripts/init-db.mjs
PATH=/opt/node22/bin:/usr/bin:/bin /opt/node22/bin/node scripts/seed-worldbook.mjs

sudo install -o root -g root -m 0644 /tmp/roleplay-agent.service /etc/systemd/system/roleplay-agent.service
sudo install -o root -g root -m 0644 /tmp/rpg.zizi1025.xyz.nginx /etc/nginx/sites-available/rpg.zizi1025.xyz
sudo ln -s /etc/nginx/sites-available/rpg.zizi1025.xyz /etc/nginx/sites-enabled/rpg.zizi1025.xyz

sudo systemctl daemon-reload
sudo systemctl enable roleplay-agent.service
sudo nginx -t
sudo systemctl reload nginx

echo "bootstrap-complete"
