#!/bin/sh
# ─── Encrypted backup (Phase 10 §13.4) ───────────────────────────────────────
# Backs up the runtime state directory (data/) into a versioned tarball,
# optionally encrypted with age(1) or gpg(1) when a recipient/key is given.
#
# Usage:
#   scripts/backup.sh [--out DIR] [--age-recipient RECIPIENT] [--gpg-key KEYID]
#
# Restore procedure & RPO/RTO targets: docs/backup-restore.md and
# docs/runbooks/data-restore.md. Run restore drills quarterly (§13.4).
set -eu

OUT_DIR="./backups"
AGE_RECIPIENT=""
GPG_KEY=""

while [ $# -gt 0 ]; do
    case "$1" in
        --out) OUT_DIR="$2"; shift 2 ;;
        --age-recipient) AGE_RECIPIENT="$2"; shift 2 ;;
        --gpg-key) GPG_KEY="$2"; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

[ -d data ] || { echo "no data/ directory to back up" >&2; exit 1; }
mkdir -p "$OUT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="addons-core-state-${STAMP}"

# Sanitized config export is produced alongside the state snapshot when an
# authenticated server is reachable; the state tarball alone is the minimum
# viable restore artifact (addons.json contains addon transport URLs — treat
# the backup as secret-bearing and encrypt at rest).
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -czf "$TMP/$BASE.tar.gz" data

if [ -n "$AGE_RECIPIENT" ]; then
    age -r "$AGE_RECIPIENT" -o "$OUT_DIR/$BASE.tar.gz.age" "$TMP/$BASE.tar.gz"
    echo "backup: $OUT_DIR/$BASE.tar.gz.age"
elif [ -n "$GPG_KEY" ]; then
    gpg --yes --encrypt --recipient "$GPG_KEY" \
        -o "$OUT_DIR/$BASE.tar.gz.gpg" "$TMP/$BASE.tar.gz"
    echo "backup: $OUT_DIR/$BASE.tar.gz.gpg"
else
    cat "$TMP/$BASE.tar.gz" > "$OUT_DIR/$BASE.tar.gz"
    echo "backup (UNENCRYPTED — treat as secret-bearing): $OUT_DIR/$BASE.tar.gz"
fi
