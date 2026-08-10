#!/usr/bin/env bash
# Restores the demo HOME to a known state and re-dates its sessions relative to
# now.
#
# Both halves matter. Recording a demo *runs* the agents, and an agent that
# resumes a session rewrites its transcript and bumps its mtime - which reorders
# the picker, so a scenario that types "3" selects a different session on the
# second take than it did on the first. And absolute timestamps would age: a
# demo recorded today would say "2.3d ago" next week.
#
#   seed.sh <demo-home> <pristine-snapshot>
set -euo pipefail
HOME_DIR="$1"
PRISTINE="$2"

[ -d "$PRISTINE" ] || { echo "no pristine snapshot at $PRISTINE" >&2; exit 1; }
rsync -a --delete "$PRISTINE/" "$HOME_DIR/"

# Newest first. These offsets are what the picker shows as the age column, so
# they are chosen to look like a real week of work rather than six sessions from
# the same ten minutes. The third row is the one the scenarios select.
seconds_ago() { python3 -c "import sys,time;print(int(time.time()-float(sys.argv[1])))" "$1"; }
touch_ago() { # <file> <seconds-ago>
  python3 -c "import os,sys,time;t=time.time()-float(sys.argv[2]);os.utime(sys.argv[1],(t,t))" "$1" "$2"
}

CC="$HOME_DIR/.claude/projects"
touch_ago "$CC/-Users-michal-casm-demo-home-Projects-acme-web/2690cd0d-87e9-47eb-b8ae-11eb1ba5ddca.jsonl" $((22 * 60))
touch_ago "$CC/-Users-michal-casm-demo-home-Projects-acme-web/8b9440f7-8ac2-4a25-b3bc-3ddbd10a0a22.jsonl" $((70 * 60))
touch_ago "$CC/-Users-michal-casm-demo-home-Projects-acme-api/da9c8c9e-c339-4d18-85bc-db03c647e21c.jsonl" $((185 * 60))
touch_ago "$CC/-Users-michal-casm-demo-home-Projects-acme-api/e78fdd25-2421-4f1a-a47b-affcaa36ffe5.jsonl" $((56 * 3600))

# pi dates a session by its file mtime, like claude
PI="$HOME_DIR/.pi/agent/sessions"
find "$PI" -name '*.jsonl' -print0 2>/dev/null |
  while IFS= read -r -d '' f; do touch_ago "$f" $((19 * 3600)); done

# The demos launch a real agent, and an agent with no credential renders a red
# "Not logged in - run /login" across the frame. Seed one the same way casm
# seeds a container: the access token only, never the refresh token, so this
# throwaway HOME cannot rotate the token out from under your real login. It
# expires in hours, which is exactly long enough to record with and no longer.
node --input-type=module -e '
import { claudeCredential } from "'"$CASM_REPO"'/lib/docker.mjs";
import fs from "node:fs";
import path from "node:path";
const c = claudeCredential();
if (!c) { console.error("  no claude credential to seed - the demo will show a login prompt"); process.exit(0); }
const dir = path.join(process.argv[1], ".claude");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, ".credentials.json"), c.json, { mode: 0o600 });
const left = c.expiresAt ? Math.round((c.expiresAt - Date.now()) / 60000) : null;
console.error(`  seeded claude auth from ${c.source}${left !== null ? ` (${left} min left)` : ""}`);
' "$HOME_DIR"

# opencode keeps its own clock in sqlite, in epoch milliseconds
DB="$HOME_DIR/.local/share/opencode/opencode.db"
if [ -f "$DB" ]; then
  ms=$(python3 -c "import time;print(int((time.time() - 5.7*3600) * 1000))")
  sqlite3 "$DB" "update session set time_updated = $ms;"
fi
