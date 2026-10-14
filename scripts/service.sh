#!/usr/bin/env bash
# Run `casm serve` as a background service: a systemd user unit on Linux, a launchd agent on macOS.
#
#   scripts/service.sh install     write the unit/plist (capturing the current PATH) and (re)start it
#   scripts/service.sh uninstall   stop it and remove the unit/plist
#   scripts/service.sh status
#   scripts/service.sh logs [-f]   recent server log (-f to follow)
#   scripts/service.sh restart
#
# The installed `casm` launcher forwards `casm service ...` here.
# The server reads $CASM_HOME/config.json (default ~/.casm-ng) for "listen" and "name".
# PATH is captured at install time so the server finds claude/codex/pi/opencode; re-run
# `install` after moving those or switching Node versions.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
main="$repo/packages/cli/src/main.ts"
casm_home="${CASM_HOME:-$HOME/.casm-ng}"
cmd="${1:-}"
[ $# -gt 0 ] && shift

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

node_bin() {
  local n
  n="$(command -v node)" || { echo "service.sh: node not found on PATH" >&2; exit 1; }
  # Resolve to an absolute path so the service does not depend on PATH order.
  (cd "$(dirname "$n")" && echo "$(pwd -P)/$(basename "$n")")
}

# ---------------------------------------------------------------- Linux (systemd --user)
unit_name=casm.service
unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit_name"

# systemd treats % specially and needs quotes/backslashes escaped inside "..."
sd_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g'; }

linux_install() {
  local node; node="$(node_bin)"
  mkdir -p "$(dirname "$unit_file")" "$casm_home"
  cat >"$unit_file" <<EOF
# Written by $repo/scripts/service.sh install
[Unit]
Description=casm NG server (casm serve)
Documentation=file://$repo/README.md
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart="$(sd_escape "$node")" "$(sd_escape "$main")" serve
WorkingDirectory=%h
Environment="PATH=$(sd_escape "$PATH")"
Environment="CASM_HOME=$(sd_escape "$casm_home")"
Restart=on-failure
# The listen address may not exist yet at boot (e.g. Tailscale still coming up): keep retrying.
RestartSec=5
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$unit_name" >/dev/null 2>&1
  systemctl --user restart "$unit_name"
  echo "==> installed $unit_file and (re)started $unit_name"
  if command -v loginctl >/dev/null && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != yes ]; then
    echo "note: linger is off, so casm stops when you log out. Enable it with:  sudo loginctl enable-linger $USER"
  fi
  sleep 2
  systemctl --user --no-pager status "$unit_name" || true
}

linux_uninstall() {
  systemctl --user disable --now "$unit_name" 2>/dev/null || true
  rm -f "$unit_file"
  systemctl --user daemon-reload
  echo "==> removed $unit_name"
}

linux() {
  case "$cmd" in
    install) linux_install ;;
    uninstall) linux_uninstall ;;
    status) systemctl --user --no-pager status "$unit_name" ;;
    restart) systemctl --user restart "$unit_name" && systemctl --user --no-pager status "$unit_name" ;;
    logs)
      if [ "${1:-}" = -f ]; then exec journalctl --user -u "$unit_name" -f -n 50
      else exec journalctl --user -u "$unit_name" --no-pager -n "${1:-200}"; fi ;;
    *) usage; exit 2 ;;
  esac
}

# ---------------------------------------------------------------- macOS (launchd)
label=dev.casm.server
plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$HOME/Library/Logs/casm"
domain="gui/$(id -u)"

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

mac_install() {
  local node; node="$(node_bin)"
  mkdir -p "$(dirname "$plist")" "$log_dir" "$casm_home"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by $(xml_escape "$repo")/scripts/service.sh install -->
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node")</string>
    <string>$(xml_escape "$main")</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$PATH")</string>
    <key>CASM_HOME</key><string>$(xml_escape "$casm_home")</string>
  </dict>
  <key>WorkingDirectory</key><string>$(xml_escape "$HOME")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <!-- Not Background: that clamps the server and every agent, build and tool it
       starts to the lowest CPU priority and throttled I/O (seconds per exec). -->
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml_escape "$log_dir")/casm.log</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$log_dir")/casm.log</string>
</dict>
</plist>
EOF
  plutil -lint "$plist" >/dev/null
  launchctl bootout "$domain/$label" 2>/dev/null || true
  # bootout returns before the old job is gone; bootstrapping too early fails with
  # "Bootstrap failed: 5: Input/output error".
  local i
  for i in $(seq 1 50); do launchctl print "$domain/$label" >/dev/null 2>&1 || break; sleep 0.2; done
  launchctl bootstrap "$domain" "$plist" || { sleep 2; launchctl bootstrap "$domain" "$plist"; }
  launchctl enable "$domain/$label"
  launchctl kickstart -k "$domain/$label"
  echo "==> installed $plist and (re)started $label; logs in $log_dir/casm.log"
  sleep 2
  mac_status
}

mac_status() {
  launchctl print "$domain/$label" | grep -E '^\s*(state|pid|last exit code|program) =' || {
    echo "$label is not loaded"; return 3; }
}

mac() {
  case "$cmd" in
    install) mac_install ;;
    uninstall)
      launchctl bootout "$domain/$label" 2>/dev/null || true
      rm -f "$plist"
      echo "==> removed $label (logs left in $log_dir)" ;;
    status) mac_status ;;
    restart) launchctl kickstart -k "$domain/$label" && sleep 1 && mac_status ;;
    logs)
      if [ "${1:-}" = -f ]; then exec tail -n 50 -F "$log_dir/casm.log"
      else exec tail -n "${1:-200}" "$log_dir/casm.log"; fi ;;
    *) usage; exit 2 ;;
  esac
}

case "$cmd" in
  ""|-h|--help|help) usage; exit 0 ;;
esac
case "$(uname -s)" in
  Linux) linux "$@" ;;
  Darwin) mac "$@" ;;
  *) echo "service.sh: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
