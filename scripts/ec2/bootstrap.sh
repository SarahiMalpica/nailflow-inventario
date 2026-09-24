#!/usr/bin/env bash
set -Eeuo pipefail
dnf install -y nodejs24 nodejs24-npm nginx jq
if ! command -v node >/dev/null; then ln -s /usr/bin/node-24 /usr/local/bin/node; fi
if ! command -v npm >/dev/null; then ln -s /usr/bin/npm-24 /usr/local/bin/npm; fi
node -e 'if (+process.versions.node.split(".")[0] < 24) process.exit(1)'
id nailflow >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/nailflow --shell /sbin/nologin nailflow
install -d -o nailflow -g nailflow -m 0750 /var/lib/nailflow
install -d -m 0755 /opt/nailflow/releases
if [[ ! -f /etc/nailflow.env ]]; then
  umask 077
  {
    echo NODE_ENV=production
    echo HOST=127.0.0.1
    echo PORT=3000
    echo DB_PATH=/var/lib/nailflow/inventario.sqlite
    printf 'JWT_SECRET='
    openssl rand -hex 48
  } > /etc/nailflow.env
fi
cat > /etc/systemd/system/nailflow.service <<'UNIT'
[Unit]
Description=NailFlow
After=network.target
ConditionPathExists=/opt/nailflow/current/server.js
[Service]
User=nailflow
Group=nailflow
WorkingDirectory=/opt/nailflow/current
EnvironmentFile=/etc/nailflow.env
ExecStart=/usr/bin/env node server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/nailflow
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/nailflow-update.service <<'UNIT'
[Unit]
Description=Instalar la ultima version aprobada de NailFlow
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/nailflow-update
TimeoutStartSec=600
UNIT
cat > /etc/systemd/system/nailflow-update.timer <<'UNIT'
[Unit]
Description=Comprobar actualizaciones de NailFlow cada dos minutos
[Timer]
OnBootSec=45s
OnUnitActiveSec=2min
RandomizedDelaySec=10s
[Install]
WantedBy=timers.target
UNIT
cat > /etc/nginx/conf.d/nailflow.conf <<'NGINX'
server {
    listen 80;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX
cat > /etc/nginx/nginx.conf <<'NGINX'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log;
pid /run/nginx.pid;
include /usr/share/nginx/modules/*.conf;
events { worker_connections 1024; }
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile on;
    include /etc/nginx/conf.d/*.conf;
}
NGINX
nginx -t
systemctl daemon-reload
systemctl enable nailflow.service
systemctl enable --now nginx
# Habilitar el timer despues de restaurar la base y publicar el primer release.
