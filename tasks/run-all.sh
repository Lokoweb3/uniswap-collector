#!/bin/bash
# Master task runner — LP analysis, code review and dashboard review every 6 h, spawned by server.js (cron is not running here)
set -e
cd "$(dirname "$0")/.."
echo ""
echo "════════════════════════════════════"
echo " Task Runner — $(date)"
echo "════════════════════════════════════"
mkdir -p tasks/output

echo "── LP Analysis ─────────────────────"
node tasks/improvement-loop.js && echo "  ✅ improvement-loop" || echo "  ❌ improvement-loop failed"

echo "── Code Analysis ───────────────────"
node tasks/code-scan.js   && echo "  ✅ code-scan"   || echo "  ⚠️  code-scan failed (non-fatal)"
node tasks/code-review.js && echo "  ✅ code-review" || echo "  ⚠️  code-review failed (non-fatal)"

echo "── Dashboard Review ────────────────"
node tasks/dashboard-review.js && echo "  ✅ dashboard-review" || echo "  ⚠️  dashboard-review failed (non-fatal)"

echo "── Done: $(date) ───────────────────"
echo ""
if [ -f brain/proposals.md ]; then tail -15 brain/proposals.md; fi
