#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
exec 9>/run/nailflow-update.lock
flock -n 9 || exit 0
REPO=SarahiMalpica/nailflow-inventario
BASE=/opt/nailflow
DATA=/var/lib/nailflow
WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT
curl -fsSL --retry 3 --connect-timeout 10 --max-time 90 \
  "https://github.com/$REPO/releases/latest/download/manifest.json" -o "$WORK/manifest.json"
SHA=$(jq -er '.sha' "$WORK/manifest.json")
TAG=$(jq -er '.tag' "$WORK/manifest.json")
HASH=$(jq -er '.checksum' "$WORK/manifest.json")
[[ "$SHA" =~ ^[a-f0-9]{40}$ && "$TAG" =~ ^ec2-[0-9]+-[0-9]+$ && "$HASH" =~ ^[a-f0-9]{64}$ ]]
DEST="$BASE/releases/$TAG"
if [[ -f "$DATA/deployed-tag" ]] && [[ "$(cat "$DATA/deployed-tag")" == "$TAG" ]]; then
  exit 0
fi
curl -fsSL --retry 3 --connect-timeout 10 --max-time 180 \
  "https://github.com/$REPO/releases/download/$TAG/nailflow.tar.gz" -o "$WORK/nailflow.tar.gz"
echo "$HASH  $WORK/nailflow.tar.gz" | sha256sum --check --status
install -d -o nailflow -g nailflow -m 0750 "$DEST"
chmod 0755 "$WORK"
chmod 0644 "$WORK/nailflow.tar.gz"
runuser -u nailflow -- tar -xzf "$WORK/nailflow.tar.gz" -C "$DEST" --no-same-owner
runuser -u nailflow -- sh -c 'cd "$1" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund' sh "$DEST"
OLD=$(readlink -f "$BASE/current" || true)
rollback() {
  if [[ -n "$OLD" && -d "$OLD" ]]; then
    ln -sfn "$OLD" "$BASE/current"
    systemctl restart nailflow.service
  fi
}
trap 'rollback; rm -rf -- "$WORK"' ERR
systemctl stop nailflow.service
# Copiar con la aplicacion detenida; la base nunca se incluye en los releases.
if [[ -f "$DATA/inventario.sqlite" ]]; then
  install -d -m 0700 "$DATA/backups"
  cp -p "$DATA/inventario.sqlite" "$DATA/backups/before-$TAG.sqlite"
fi
ln -sfn "$DEST" "$BASE/current"
systemctl restart nailflow.service
healthy=false
for attempt in {1..20}; do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/api/health | jq -e '.status == "ok" and .service == "NailFlow"' >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
[[ "$healthy" == true ]]
printf '%s\n' "$TAG" > "$DATA/deployed-tag"
printf '%s\n' "$SHA" > "$DATA/deployed-sha"
echo "Instalada y verificada: $TAG ($SHA)"
