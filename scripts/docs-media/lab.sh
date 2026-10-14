#!/usr/bin/env bash
# A disposable two-host casm lab for recording the CLI casts in docs/media:
# servers "studio" (port 7481) and "worker" (7482) peered with each other,
# a demo project "acme-api" on both, and a `casm` wrapper bound to studio.
# Agents in it are real (they make model calls); use cheap models.
#
#   scripts/docs-media/lab.sh up      start (fresh state under $LAB, default /var/tmp/casm-lab)
#   scripts/docs-media/lab.sh down    stop both servers
#   export PATH="$LAB/bin:$PATH"      then `casm ...` talks to studio
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
lab="${LAB:-/var/tmp/casm-lab}"
code=/tmp/code

clean_env() { for v in $(env | grep -o '^CASM_[A-Z_]*' || true); do unset "$v"; done; }

down() {
  for h in studio worker; do
    [ -f "$lab/$h.pid" ] && kill "$(cat "$lab/$h.pid")" 2>/dev/null || true
    rm -f "$lab/$h.pid"
  done
}

project() {
  local d="$code/acme-api"
  rm -rf "$d"; mkdir -p "$d/src" "$d/test"
  cat > "$d/package.json" <<'EOF'
{
  "name": "acme-api",
  "version": "0.3.0",
  "type": "module",
  "scripts": { "test": "node --test", "start": "node src/server.js" }
}
EOF
  cat > "$d/src/orders.js" <<'EOF'
const orders = [
  { id: 1, customer: "Ada", total: 42.5, status: "shipped" },
  { id: 2, customer: "Linus", total: 17, status: "pending" },
  { id: 3, customer: "Grace", total: 99.99, status: "pending" },
];

export function listOrders() {
  return orders;
}

export function getOrder(id) {
  return orders.find((o) => o.id === id);
}
EOF
  cat > "$d/test/orders.test.js" <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { getOrder, listOrders } from "../src/orders.js";

test("lists orders", () => assert.equal(listOrders().length, 3));
test("finds an order", () => assert.equal(getOrder(2).customer, "Linus"));
EOF
  printf '# acme-api\n\nA tiny orders API used as a casm demo project.\n' > "$d/README.md"
  printf '# acme-api\n\n- Plain Node 24, no dependencies. Run `npm test` before you finish.\n' > "$d/AGENTS.md"
  (cd "$d" && git init -q && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm "initial orders API")
}

up() {
  down
  rm -rf "$lab"; mkdir -p "$lab/bin"
  project
  cat > "$lab/bin/casm" <<EOF
#!/usr/bin/env bash
for v in \$(env | grep -o '^CASM_[A-Z_]*'); do unset "\$v"; done
export CASM_HOME="$lab/\${LAB_HOST:-studio}"
exec node "$repo/packages/cli/src/main.ts" "\$@"
EOF
  chmod +x "$lab/bin/casm"
  local port=7481
  for h in studio worker; do
    mkdir -p "$lab/$h"
    ( clean_env; export CASM_HOME="$lab/$h"
      nohup node "$repo/packages/cli/src/main.ts" serve --listen "127.0.0.1:$port" --name "$h" > "$lab/$h.log" 2>&1 &
      echo $! > "$lab/$h.pid" )
    port=$((port + 1))
  done
  for _ in $(seq 50); do [ -f "$lab/studio/local.json" ] && [ -f "$lab/worker/local.json" ] && break; sleep 0.2; done
  export PATH="$lab/bin:$PATH"
  LAB_HOST=worker casm project create "$code/acme-api" --name acme-api >/dev/null
  casm peer add worker ws://127.0.0.1:7482 "$(LAB_HOST=worker casm token create studio)" >/dev/null
  echo "lab up: export PATH=\"$lab/bin:\$PATH\""
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
