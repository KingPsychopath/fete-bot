#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${RAILWAY_PROJECT_ID:-bdd395a6-c411-4a8f-bb82-0a3303f54f85}"
ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
SERVICE="${RAILWAY_SERVICE:-fete-bot}"
BACKUP_NAME="${1:-}"

if [ -z "$BACKUP_NAME" ]; then
  echo "Usage: scripts/restore-whatsapp-auth.sh <backup-name>"
  echo
  echo "Available backups:"
  railway ssh -p "$PROJECT_ID" -e "$ENVIRONMENT" -s "$SERVICE" \
    'find "${RAILWAY_VOLUME_MOUNT_PATH:-/app/data}/auth-backups" -mindepth 1 -maxdepth 1 -type d -printf "%f\n" 2>/dev/null | sort || true'
  exit 2
fi

case "$BACKUP_NAME" in
  *[!0-9A-Za-z_.@:-]*)
    echo "Backup name must only contain letters, numbers, dot, underscore, at, colon, or hyphen."
    exit 1
    ;;
esac

railway ssh -p "$PROJECT_ID" -e "$ENVIRONMENT" -s "$SERVICE" \
  "BACKUP_NAME='$BACKUP_NAME' sh -s" <<'REMOTE'
set -eu

DATA_DIR="${RAILWAY_VOLUME_MOUNT_PATH:-/app/data}"
AUTH_DIR="${AUTH_FOLDER:-$DATA_DIR/auth}"
BACKUP_ROOT="$DATA_DIR/auth-backups"
BACKUP_DIR="$BACKUP_ROOT/$BACKUP_NAME"

if [ ! -d "$BACKUP_DIR/auth" ] && [ ! -f "$BACKUP_DIR/auth.tar" ]; then
  echo "Backup not found: $BACKUP_DIR/auth or $BACKUP_DIR/auth.tar"
  exit 1
fi

if [ -f "$BACKUP_DIR/auth.tar" ]; then
  (cd "$BACKUP_DIR" && sha256sum -c auth.tar.sha256)
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if [ -e "$AUTH_DIR" ]; then
  mv "$AUTH_DIR" "$DATA_DIR/auth-before-restore-$STAMP"
fi
mkdir -p "$AUTH_DIR"
if [ -d "$BACKUP_DIR/auth" ]; then
  cp -a "$BACKUP_DIR/auth/." "$AUTH_DIR/"
else
  tar -C "$AUTH_DIR" -xf "$BACKUP_DIR/auth.tar"
fi

echo "WhatsApp auth restored from: $BACKUP_DIR"
echo "Previous auth moved to: $DATA_DIR/auth-before-restore-$STAMP"
cat "$BACKUP_DIR/manifest.json"
REMOTE

railway redeploy --service "$SERVICE" --environment "$ENVIRONMENT" --yes
