#!/usr/bin/env bash
# Install casm from this checkout for personal use (Linux and macOS). Idempotent.
#
#   scripts/install.sh [--skip-deps] [--service]
#
# - runs `npm ci` in the checkout (skip with --skip-deps)
# - writes a small `casm` launcher to $CASM_BIN_DIR (default ~/.local/bin) that runs
#   packages/cli/src/main.ts from this checkout, so `git pull` updates casm in place
# - with --service, also installs and starts the background service (scripts/service.sh install)
#
# Why a launcher and not `npm i -g`: Node strips TypeScript types only outside node_modules,
# so a globally installed copy of the workspace would not run. Publishing to npm will need a
# bundle step first (see README).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="${CASM_BIN_DIR:-$HOME/.local/bin}"
deps=1
service=0
for a in "$@"; do
  case "$a" in
    --skip-deps) deps=0 ;;
    --service) service=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $a" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "install.sh: node not found on PATH (need Node 24+)" >&2; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 24 ]; then
  echo "install.sh: Node $(node -v) is too old; casm needs Node 24+ (it runs the .ts sources directly)" >&2
  exit 1
fi

if [ "$deps" = 1 ]; then
  echo "==> npm ci in $repo"
  (cd "$repo" && npm ci --no-audit --no-fund)
fi

mkdir -p "$bin_dir"
launcher="$bin_dir/casm"
tmp="$(mktemp "$bin_dir/.casm.XXXXXX")"
cat >"$tmp" <<EOF
#!/bin/sh
# casm launcher, written by $repo/scripts/install.sh
# \`casm service ...\` manages the background server; everything else goes to the CLI.
if [ "\$1" = service ]; then
  shift
  exec "$repo/scripts/service.sh" "\$@"
fi
exec node "$repo/packages/cli/src/main.ts" "\$@"
EOF
chmod 755 "$tmp"
# Replaces whatever was there before (e.g. a symlink from an older npm-installed casm).
mv -f "$tmp" "$launcher"
echo "==> installed $launcher -> $repo/packages/cli/src/main.ts"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "note: $bin_dir is not on your PATH; add it to your shell profile:  export PATH=\"$bin_dir:\$PATH\"" ;;
esac
found="$(command -v casm || true)"
if [ -n "$found" ] && [ "$found" != "$launcher" ]; then
  echo "note: \`casm\` currently resolves to $found, which shadows $launcher; remove it or reorder PATH"
fi

if [ "$service" = 1 ]; then
  "$repo/scripts/service.sh" install
fi
