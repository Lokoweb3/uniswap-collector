#!/usr/bin/env bash
# Nightly backup of the JSON ledgers: a dated tar.gz kept locally under backups/
# (last 14 kept) and uploaded to the VPS at /home/openclaw/ledger-backups/.
#
# Ledgers are the only copy of the collector's history (fee snapshots, daily
# accrual, collects, liquidity ledger, backfill, portfolio series, range log,
# staking log) plus settings.json and the alert / v4 discovery state. Secrets
# (.env*, keystores, mcp-auth.json, gate-state.json) are never included.
#
#   ./backup-ledgers.sh            # archive + upload
#   ./backup-ledgers.sh --local    # archive only
#
# Env (optional): LP_BACKUP_HOST (default openclaw@<your-vps-ip>),
# LP_BACKUP_DIR (default /home/openclaw/ledger-backups), LP_BACKUP_KEY (ssh key).
set -euo pipefail
cd "$(dirname "$0")"

HOST="${LP_BACKUP_HOST:-openclaw@<your-vps-ip>}"
DIR="${LP_BACKUP_DIR:-/home/openclaw/ledger-backups}"
KEY="${LP_BACKUP_KEY:-}"
LOG="backup.log"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="backups/ledgers-${STAMP}.tar.gz"
mkdir -p backups

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }

# Everything that is runtime history, present or not.
FILES=()
for f in fee-events.json v4-collects.json memecoin-discovered.json fee-snapshots.json fee-daily.json fee-prices.json backfill.json \
         liquidity-ledger.json v4-liquidity-ledger.json v4-owner-collects.json token-sales.json token-disposals.json strategy-proposals.json portfolio.json range-log.json snet-staking.json alerts-state.json \
         v4-positions*.json settings.json; do
  [ -f "$f" ] && FILES+=("$f")
done
[ "${#FILES[@]}" -gt 0 ] || { log "nothing to back up"; exit 1; }

tar -czf "$OUT" "${FILES[@]}"
SIZE=$(du -h "$OUT" | cut -f1)
log "archived ${#FILES[@]} files to $OUT ($SIZE)"

# Keep the newest 14 local archives.
ls -1t backups/ledgers-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f

[ "${1:-}" = "--local" ] && exit 0

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY" -o IdentitiesOnly=yes)
if ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p '$DIR'" 2>>"$LOG" \
   && scp -q "${SSH_OPTS[@]}" "$OUT" "$HOST:$DIR/" 2>>"$LOG"; then
  # Keep the newest 30 on the VPS.
  ssh "${SSH_OPTS[@]}" "$HOST" "ls -1t '$DIR'/ledgers-*.tar.gz 2>/dev/null | tail -n +31 | xargs -r rm -f" 2>>"$LOG" || true
  log "uploaded to $HOST:$DIR/"
else
  log "UPLOAD FAILED to $HOST (local archive kept); check ssh key authorization"
  exit 2
fi
