#!/usr/bin/env bash
# Installs the timer as a systemd user unit, if systemd is actually running.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! systemctl --user show-environment >/dev/null 2>&1; then
  cat >&2 <<'MSG'
systemd is not running for your user.

In WSL, enable it by adding to /etc/wsl.conf:

  [boot]
  systemd=true

then run `wsl --shutdown` from Windows and reopen the distro.

If you would rather not, use the Windows Task Scheduler bridge in the README --
it is more reliable anyway, because it can start WSL rather than needing it to
already be running.
MSG
  exit 1
fi

mkdir -p "$HOME/.config/systemd/user"
# Units may sit flat beside this script or in a systemd/ subdirectory.
UNITS="$HERE"
[ -f "$UNITS/lp-collector.service" ] || UNITS="$HERE/systemd"
[ -f "$UNITS/lp-collector.service" ] || { echo "Cannot find lp-collector.service" >&2; exit 1; }
cp "$UNITS/lp-collector.service" "$UNITS/lp-collector.timer" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now lp-collector.timer
# Keeps the timer alive after you close every WSL terminal.
loginctl enable-linger "$USER" 2>/dev/null || \
  echo "Note: could not enable linger. The timer only runs while WSL is open."
systemctl --user list-timers lp-collector.timer --no-pager
