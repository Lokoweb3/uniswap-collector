#!/usr/bin/env bash
# Starts the remote MCP server for claude.ai / Claude mobile. Reads
# LP_MCP_PUBLIC_URL (and optional LP_MCP_PORT, LP_TZ) from .env.mcp next to
# this script so the public address is set once. Binds to loopback only; a
# tunnel (Tailscale Funnel, Cloudflare Tunnel) provides the public HTTPS side.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HERE/.env.mcp" ]; then set -a; . "$HERE/.env.mcp"; set +a; fi
: "${LP_MCP_PUBLIC_URL:?Set LP_MCP_PUBLIC_URL in .env.mcp to the https address of your tunnel}"
exec node "$HERE/lp-mcp-remote.mjs"
