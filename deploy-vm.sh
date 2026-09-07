#!/usr/bin/env bash
# Moves the read-only stack (dashboard, MCP servers, Tailscale tunnel, data
# files) to a fresh Ubuntu VM. The collector and its keystore stay on this
# machine; the keystore is never copied. Idempotent: re-run to update code.
#
#   ./deploy-vm.sh root@203.0.113.5
#
# What it does on the VM: installs Node 22, Tailscale, a firewall that admits
# only SSH (Tailscale needs no inbound ports), an unprivileged `lp` user, the
# code and data files, and two systemd services. Then it logs the VM into your
# tailnet as `lp-dashboard` (you click one link), publishes the MCP server on
# Funnel and the dashboard on the tailnet-only port, and sets this machine up
# to push collector results to the VM after every run.
#
# Before running: free the node name on this machine (the script does it for
# you after asking), because the connector URL follows the name.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:?usage: $0 root@vm-ip}"
HOST="${TARGET#*@}"
REMOTE_DIR=/home/lp/uniswap-collector
KEY="$HOME/.ssh/lp-vm"
TS="$HOME/.local/tailscale/tailscale"; TSOCK="$HOME/.local/state/tailscale/tailscaled.sock"

[ -f "$KEY" ] || ssh-keygen -t ed25519 -N "" -f "$KEY" -C "lp-vm sync" >/dev/null
PUB="$(cat "$KEY.pub")"

echo "== 1/6 base system on $HOST"
ssh -o StrictHostKeyChecking=accept-new "$TARGET" bash -s <<REMOTE
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ufw rsync ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "\$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
id lp >/dev/null 2>&1 || useradd -m -s /bin/bash lp
install -d -m 700 -o lp -g lp /home/lp/.ssh
grep -qF "$PUB" /home/lp/.ssh/authorized_keys 2>/dev/null || echo "$PUB" >> /home/lp/.ssh/authorized_keys
chown lp:lp /home/lp/.ssh/authorized_keys; chmod 600 /home/lp/.ssh/authorized_keys
ufw --force default deny incoming >/dev/null; ufw --force default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null; ufw --force enable >/dev/null
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
echo "node \$(node -v), tailscale \$(tailscale version | head -1), firewall: \$(ufw status | head -1)"
REMOTE

echo "== 2/6 code and data"
rsync -az --delete -e "ssh" \
  --exclude node_modules --exclude 'operator-keystore*' --exclude '*.keystore.json' --exclude '*.dpapi' \
  --exclude .mcp-passphrase.txt --exclude .env.sync --exclude dashboard.log --exclude mcp-remote.log \
  --exclude '.git' \
  "$HERE/" "$TARGET:$REMOTE_DIR/"
ssh "$TARGET" bash -s <<REMOTE
set -euo pipefail
cd $REMOTE_DIR
chown -R lp:lp $REMOTE_DIR
chmod 600 .env.mcp mcp-auth.json 2>/dev/null || true
sudo -u lp npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || sudo -u lp npm install --omit=dev --no-audit --no-fund >/dev/null
cp vm/lp-dashboard.service vm/lp-mcp-remote.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now lp-dashboard lp-mcp-remote >/dev/null
sleep 3
systemctl is-active lp-dashboard lp-mcp-remote | paste -sd' '
curl -sf http://127.0.0.1:8787/api/positions >/dev/null && echo "dashboard answering" || echo "dashboard not answering yet (first chain read can take a minute)"
REMOTE

echo "== 3/6 free the node name here"
if "$TS" --socket="$TSOCK" status >/dev/null 2>&1; then
  read -r -p "Rename this machine's Tailscale node to lp-pc and stop its tunnel, so the VM can take lp-dashboard? [y/N] " yn
  if [ "$yn" = "y" ]; then
    "$TS" --socket="$TSOCK" serve reset >/dev/null 2>&1 || true
    "$TS" --socket="$TSOCK" up --hostname=lp-pc --accept-dns=false >/dev/null
    for pid in $(pgrep -f "^node $HERE/lp-mcp-remote.mjs"); do kill "$pid"; done 2>/dev/null || true
    echo "this machine is now lp-pc; remote MCP server stopped here"
  fi
fi

echo "== 4/6 join the tailnet as lp-dashboard (click the link it prints)"
ssh -t "$TARGET" "tailscale up --hostname=lp-dashboard --accept-dns=false"
ssh "$TARGET" bash -s <<'REMOTE'
set -euo pipefail
tailscale funnel --bg 8788 >/dev/null
tailscale serve --bg --https=8443 http://127.0.0.1:8787 >/dev/null
tailscale funnel status
REMOTE

echo "== 5/6 push collector results from here after every run"
printf 'LP_SYNC_TARGET=lp@%s:%s\nLP_SYNC_KEY=%s\n' "$HOST" "$REMOTE_DIR" "$KEY" > "$HERE/.env.sync"
chmod 600 "$HERE/.env.sync"
"$HERE/sync-to-vm.sh" && echo "first sync done"

echo "== 6/6 check"
NAME="$(ssh "$TARGET" "tailscale status --json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log(JSON.parse(d).Self.DNSName.replace(/\.$/,""))})')"
echo "connector:  https://$NAME/mcp   (unchanged if the name is lp-dashboard)"
echo "dashboard:  https://$NAME:8443  (tailnet devices only)"
echo "The public address answers once the VM's certificate is issued (about a minute) and public DNS updates (up to ten)."
