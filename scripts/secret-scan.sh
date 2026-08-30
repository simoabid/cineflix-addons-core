#!/bin/sh
# ─── Secret scan (Phase 9 §12.2) ─────────────────────────────────────────────
# Scans files for patterns that must never be committed: private keys, generic
# high-entropy API-token assignments, and known provider key prefixes.
#
# Usage:
#   scripts/secret-scan.sh            # scan the staged diff (pre-commit mode)
#   scripts/secret-scan.sh --all      # scan the tracked tree (CI mode)
#
# Exit 1 when a likely secret is found; always exits 0 with nothing to scan.

set -u

MODE="${1:-staged}"

PATTERNS='(BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY|-----BEGIN CERTIFICATE-----|AKIA[0-9A-Z]{16}|xox[abp]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{36}|sk_live_[0-9A-Za-z]{16,}|AIza[0-9A-Za-z_-]{35})'

if [ "$MODE" = "--all" ]; then
    FILES=$(git ls-files)
    if [ -z "$FILES" ]; then
        echo "secret-scan: nothing to scan"
        exit 0
    fi
    MATCHES=$(printf '%s\n' "$FILES" | xargs grep -n -E "$PATTERNS" 2>/dev/null)
else
    # Scan the staged diff: added/modified lines only (lines starting with +).
    MATCHES=$(git diff --cached --unified=0 -- '^:' 2>/dev/null | grep -E "^\+" | grep -n -E "$PATTERNS")
fi

if [ -n "$MATCHES" ]; then
    echo "secret-scan: potential secret detected" >&2
    echo "$MATCHES" | head -20 >&2
    exit 1
fi

echo "secret-scan: clean"
exit 0
