#!/usr/bin/env bash
# Nightly backup of the JSON ledgers: a dated tar.gz kept locally under backups/
# (last 14 kept, plus any not yet uploaded) and uploaded to the VPS at
# /home/openclaw/ledger-backups/; a run that gets through also uploads missed nights.
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
NAMES=(fee-events.json v4-collects.json memecoin-discovered.json fee-snapshots.json fee-daily.json fee-prices.json backfill.json
       liquidity-ledger.json v4-liquidity-ledger.json v4-owner-collects.json token-sales.json token-sales.jsonl memecoin-guardian-log.jsonl token-disposals.json strategy-proposals.json portfolio.json range-log.json snet-staking.json alerts-state.json
       claims.json position-registry.json position-values.json state.json watch-accrual.json watch-pnl-basis.json earn-log.json
       v4-positions*.json settings.json brain/notes.md agent-memory/*.json)

# One instance per data directory. This used to archive the current directory only,
# which meant the Arc instance -- its settings, its claim history, its position
# registry -- was never backed up at all. Each directory is stored under its own
# name inside the archive, so two settings.json files cannot overwrite each other on
# restore. LP_BACKUP_DATA_DIRS overrides the list; missing directories are skipped
# with a line in the log rather than silently.
DATA_DIRS="${LP_BACKUP_DATA_DIRS:-$PWD ${LP_ARC_DATA_DIR:-$HOME/arc-data}}"
ARGS=()
COUNT=0
set -f; read -r -a DIRS <<< "$DATA_DIRS"; set +f   # no globbing of paths
for d in "${DIRS[@]}"; do
  if [ ! -d "$d" ]; then log "skipping $d (not a directory)"; continue; fi
  parent=$(dirname "$d"); base=$(basename "$d")
  found=0
  for pattern in "${NAMES[@]}"; do
    for f in "$d"/$pattern; do
      [ -f "$f" ] || continue
      ARGS+=(-C "$parent" "$base/${f#"$d"/}")
      found=$((found + 1))
    done
  done
  COUNT=$((COUNT + found))
  log "$d: $found file(s)"
done
FILES=("${ARGS[@]}")   # unused by the script; test/hygiene-paths.test.js cuts the loop above out at this line
[ "$COUNT" -gt 0 ] || { log "nothing to back up"; exit 1; }

tar -czf "$OUT" "${ARGS[@]}"
# A truncated archive is worse than none: read it back before calling it a backup.
tar -tzf "$OUT" >/dev/null || { log "ARCHIVE UNREADABLE: $OUT"; exit 1; }
SIZE=$(du -h "$OUT" | cut -f1)
log "archived $COUNT file(s) from ${DATA_DIRS} to $OUT ($SIZE)"

# backups/.uploaded lists the archives the VPS already has. Local pruning keeps the newest 14
# and, beyond those, any archive not uploaded yet (up to 60), so an outage longer than two
# weeks no longer deletes nights that never left this machine.
SENT="backups/.uploaded"
touch "$SENT"
prune_local() {
  local n=0 f
  for f in $(ls -1 backups/ledgers-*.tar.gz 2>/dev/null | sort -r); do
    n=$((n + 1))
    [ "$n" -le 14 ] && continue
    if [ "$n" -gt 60 ] || grep -qxF "$(basename "$f")" "$SENT"; then rm -f "$f"; fi
  done
}

if [ "${1:-}" = "--local" ]; then prune_local; exit 0; fi

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY" -o IdentitiesOnly=yes)
ERR=$(mktemp); trap 'rm -f "$ERR"' EXIT

# Catch-up: every local archive the VPS does not have goes up, oldest first, so the first run
# that gets through also delivers the nights missed while the VPS was unreachable.
PENDING=()
DONE=0
for f in $(ls -1 backups/ledgers-*.tar.gz | sort); do
  grep -qxF "$(basename "$f")" "$SENT" || PENDING+=("$f")
done
fail() {  # the real ssh/scp error goes into the log line (and so into the alert)
  cat "$ERR" >>"$LOG"
  local why; why=$(tail -n1 "$ERR" | tr -d '\r')
  prune_local
  log "UPLOAD FAILED to $HOST (local archive kept; $(( ${#PENDING[@]} - DONE )) waiting): ${why:-no error text}"
  exit 2
}
ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p '$DIR'" 2>"$ERR" || fail
for f in "${PENDING[@]}"; do
  scp -q "${SSH_OPTS[@]}" "$f" "$HOST:$DIR/" 2>"$ERR" || fail
  basename "$f" >>"$SENT"
  DONE=$((DONE + 1))
done
# Keep the newest 30 on the VPS, by name (the name carries the date; a caught-up archive has a fresh mtime).
ssh "${SSH_OPTS[@]}" "$HOST" "ls -1 '$DIR'/ledgers-*.tar.gz 2>/dev/null | sort -r | tail -n +31 | xargs -r rm -f" 2>>"$LOG" || true
prune_local
# Forget names that no longer exist locally.
for n in $(cat "$SENT"); do [ -f "backups/$n" ] && echo "$n"; done >"$SENT.tmp" && mv "$SENT.tmp" "$SENT"
log "uploaded $DONE archive(s) to $HOST:$DIR/"
