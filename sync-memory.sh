#!/usr/bin/env bash
# Pushes the agent's shared memory to the VPS so the agent there (Loko_AI)
# remembers the same things: brain/notes.md, agent-memory/*.json and
# agent-work.log. Uses the nightly backup's SSH access (LP_BACKUP_HOST /
# LP_BACKUP_KEY from ./.env, the same as backup-ledgers.sh) and lands in
# $LP_MEMORY_DIR (default /home/openclaw/lp-memory). Silent no-op when
# unconfigured. Nothing from .env is printed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HERE/.env" ]; then set -a; . "$HERE/.env"; set +a; fi
HOST="${LP_BACKUP_HOST:-}"
case "$HOST" in ""|*"<your-vps-ip>"*) exit 0 ;; esac
DIR="${LP_MEMORY_DIR:-/home/openclaw/lp-memory}"
KEY="${LP_BACKUP_KEY:-}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY" -o IdentitiesOnly=yes)
FILES=()
[ -f "$HERE/brain/notes.md" ] && FILES+=("$HERE/brain/notes.md")
[ -f "$HERE/agent-work.log" ] && FILES+=("$HERE/agent-work.log")
[ "${#FILES[@]}" -gt 0 ] || exit 0
ssh -q "${SSH_OPTS[@]}" "$HOST" "mkdir -p '$DIR/agent-memory'" || { echo "$(date -u +%FT%TZ) memory sync: ssh failed" >&2; exit 2; }
scp -q "${SSH_OPTS[@]}" "${FILES[@]}" "$HOST:$DIR/" || { echo "$(date -u +%FT%TZ) memory sync: scp failed" >&2; exit 2; }
if ls "$HERE"/agent-memory/*.json >/dev/null 2>&1; then
  scp -q "${SSH_OPTS[@]}" "$HERE"/agent-memory/*.json "$HOST:$DIR/agent-memory/" || exit 2
fi
echo "$(date -u +%FT%TZ) memory synced to $DIR"
