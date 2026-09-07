#!/usr/bin/env bash
# Starts the read-only dashboard. No key is loaded and no transaction can be
# sent from it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8787}"
echo "Open http://localhost:${PORT} in your Windows browser."
echo "WSL forwards localhost automatically. If it does not connect, start with"
echo "  ./run-dashboard.sh ${PORT} --lan"
[ "${2:-}" = "--lan" ] && export LP_BIND=0.0.0.0
exec node "$HERE/server.js" "--port=$PORT"
