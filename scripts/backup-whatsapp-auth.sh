#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${RAILWAY_PROJECT_ID:-bdd395a6-c411-4a8f-bb82-0a3303f54f85}"
ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
SERVICE="${RAILWAY_SERVICE:-fete-bot}"
BACKUP_NAME="${1:-}"
MAX_BACKUPS="${WHATSAPP_AUTH_MAX_BACKUPS:-1}"

railway ssh -p "$PROJECT_ID" -e "$ENVIRONMENT" -s "$SERVICE" \
  "BACKUP_NAME='$BACKUP_NAME' MAX_BACKUPS='$MAX_BACKUPS' sh -s" <<'REMOTE'
set -eu

DATA_DIR="${RAILWAY_VOLUME_MOUNT_PATH:-/app/data}"
AUTH_DIR="${AUTH_FOLDER:-$DATA_DIR/auth}"
BACKUP_ROOT="$DATA_DIR/auth-backups"

if [ ! -f "$AUTH_DIR/creds.json" ]; then
  echo "No WhatsApp auth creds found at $AUTH_DIR/creds.json; connect the bot first, then run this backup."
  exit 1
fi

AUTH_ID="$(node -e 'const c=require(process.argv[1]); const id=c.me?.id || c.me?.lid || ""; if (!id) process.exit(2); console.log(id.replace(/[^0-9A-Za-z_.@:-]/g, "_"))' "$AUTH_DIR/creds.json")" || {
  echo "Auth creds exist, but they do not contain a linked WhatsApp identity yet."
  exit 1
}

mkdir -p "$BACKUP_ROOT"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name "*.tmp-*" -exec rm -rf {} + 2>/dev/null || true
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="${BACKUP_NAME:-$STAMP-$AUTH_ID}"
case "$NAME" in
  *[!0-9A-Za-z_.@:-]*|"")
    echo "Backup name must only contain letters, numbers, dot, underscore, at, colon, or hyphen."
    exit 1
    ;;
esac

DEST="$BACKUP_ROOT/$NAME"
if [ -e "$DEST" ]; then
  echo "Backup already exists: $DEST"
  exit 1
fi

TMP="$DEST.tmp"
rm -rf "$TMP"
mkdir -p "$TMP"
cp -a "$AUTH_DIR" "$TMP/auth"
node -e '
const fs = require("node:fs");
const creds = require(process.argv[1]);
const manifest = {
  createdAt: new Date().toISOString(),
  authDir: process.argv[2],
  me: creds.me ?? null,
  registered: creds.registered ?? null,
  platform: creds.platform ?? null,
  format: "auth-directory-v1"
};
fs.writeFileSync(process.argv[3], JSON.stringify(manifest, null, 2) + "\n");
' "$AUTH_DIR/creds.json" "$AUTH_DIR" "$TMP/manifest.json"
mv "$TMP" "$DEST"

echo "WhatsApp auth backup created: $DEST"
cat "$DEST/manifest.json"

case "$MAX_BACKUPS" in
  ''|*[!0-9]*)
    echo "WHATSAPP_AUTH_MAX_BACKUPS must be a positive integer."
    exit 1
    ;;
esac

if [ "$MAX_BACKUPS" -gt 0 ]; then
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name "*.tmp-*" -printf "%T@ %p\n" |
    sort -rn |
    tail -n +"$((MAX_BACKUPS + 1))" |
    cut -d" " -f2- |
    xargs -r rm -rf
fi
REMOTE
