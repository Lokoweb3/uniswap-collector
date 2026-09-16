#!/usr/bin/env bash
# Put a saved theme back in place:  ./themes/apply.sh 2026-09-15-original
# Restores dashboard.css (Dashboard + Analytics) and the <style> block inside
# wallet.html (the Wallet page). Nothing else in wallet.html is touched.
# Restart is not needed for CSS: reload the page (shift-reload to bypass cache).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
NAME="${1:-}"
if [ -z "$NAME" ] || [ ! -d "$HERE/$NAME" ]; then
  echo "Saved themes:"; ls -1 "$HERE" | grep -v '\.sh$\|README'; exit 1
fi
cp "$HERE/$NAME/dashboard.css" "$ROOT/dashboard.css"
node -e '
const fs=require("fs"), root=process.argv[1], style=process.argv[2];
const p=root+"/wallet.html", s=fs.readFileSync(p,"utf8");
const a=s.indexOf("<style"), b=s.indexOf("</style>",a)+8;
if (a<0||b<8) { console.error("wallet.html: no <style> block found"); process.exit(1); }
fs.writeFileSync(p, s.slice(0,a)+fs.readFileSync(style,"utf8")+s.slice(b));
' "$ROOT" "$HERE/$NAME/wallet-style.html"
echo "Applied theme '$NAME'. Reload the dashboard (shift-reload) to see it."
