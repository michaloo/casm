// A disposable casm server with deterministic fake providers and realistic
// projects, agents and transcripts, for the screenshots and GIFs in docs/media.
// It never touches real state or makes model calls:
//
//   SHOWCASE_PORT=7497 SHOWCASE_HOME=/tmp/demo node scripts/docs-media/showcase-server.ts
//
// Two servers run in this process: "studio" on SHOWCASE_PORT and its peer
// "buildbox" on SHOWCASE_PORT + 1. The client token is written to
// $SHOWCASE_HOME/web-token.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../../packages/server/src/db.ts";
import { startServer } from "../../packages/server/src/server.ts";
import type { Provider, OpenOptions } from "../../packages/server/src/providers/types.ts";
import type { Catalog, Command, Item, ProviderId, ProviderLimits } from "@casm/protocol";

const home = process.env.SHOWCASE_HOME ?? "/tmp/demo";
const port = Number(process.env.SHOWCASE_PORT ?? 7497);
// casm state and the token live next to the demo folder, not inside it, so
// folder completion shows only the demo projects.
const state = `${home}.state`;
for (const dir of [home, state]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// Global instruction files the host settings show: isolated, never the account's own.
const settings = `${state}/host-settings`;
for (const [key, dir, file] of [
  ["CLAUDE_CONFIG_DIR", "claude", "CLAUDE.md"],
  ["CODEX_HOME", "codex", "AGENTS.md"],
  ["XDG_CONFIG_HOME", "config/opencode", "AGENTS.md"],
  ["PI_CODING_AGENT_DIR", "pi", "AGENTS.md"],
] as const) {
  mkdirSync(`${settings}/${dir}`, { recursive: true });
  writeFileSync(`${settings}/${dir}/${file}`, "# Global instructions\n\n- Prefer small, reviewed commits.\n- Run the tests before you finish.\n");
  process.env[key] = `${settings}/${key === "XDG_CONFIG_HOME" ? "config" : dir}`;
}
process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "1";

// ---------------------------------------------------------------- project folders
const code = home;
function write(path: string, text: string) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
write(`${code}/acme-api/package.json`, JSON.stringify({ name: "acme-api", version: "0.3.0", type: "module", scripts: { test: "node --test", start: "node src/server.js" } }, null, 2) + "\n");
write(`${code}/acme-api/AGENTS.md`, "# acme-api\n\n- Plain Node 24, no dependencies. Run `npm test` before you finish.\n- Keep handlers in `src/server.js` small; data access lives in `src/orders.js`.\n");
write(`${code}/acme-api/README.md`, "# acme-api\n\nA tiny orders API.\n\n```sh\nnpm start   # http://localhost:3000/orders\nnpm test\n```\n");
write(`${code}/acme-api/src/orders.js`, `const orders = [
  { id: 1, customer: "Ada", items: [{ sku: "A-1", qty: 2, price: 12.5 }], status: "shipped" },
  { id: 2, customer: "Linus", items: [{ sku: "B-7", qty: 1, price: 17 }], status: "pending" },
  { id: 3, customer: "Grace", items: [{ sku: "C-3", qty: 3, price: 33.33 }], status: "pending" },
];

// Totals are computed in cents so 3 × 33.33 is 99.99, not 99.99000000000001.
export function orderTotal(order) {
  const cents = order.items.reduce((sum, i) => sum + i.qty * Math.round(i.price * 100), 0);
  return cents / 100;
}

export function listOrders() {
  return orders.map((o) => ({ ...o, total: orderTotal(o) }));
}

export function getOrder(id) {
  const order = orders.find((o) => o.id === id);
  return order && { ...order, total: orderTotal(order) };
}
`);
write(`${code}/acme-api/src/server.js`, `import { createServer } from "node:http";
import { listOrders, getOrder } from "./orders.js";

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/orders") return json(res, 200, listOrders());
  const m = url.pathname.match(/^\\/orders\\/(\\d+)$/);
  const order = m && getOrder(Number(m[1]));
  json(res, order ? 200 : 404, order ?? { error: "not found" });
}).listen(process.env.PORT ?? 3000);

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
`);
write(`${code}/acme-api/test/orders.test.js`, `import { test } from "node:test";
import assert from "node:assert/strict";
import { getOrder, orderTotal } from "../src/orders.js";

test("totals are exact to the cent", () => assert.equal(orderTotal(getOrder(3)), 99.99));
test("unknown orders are undefined", () => assert.equal(getOrder(42), undefined));
`);
write(`${code}/acme-api/docs/rounding.md`, "# Rounding\n\nOrder totals are summed in integer cents and divided once at the end.\n\n| Order | Items | Total |\n| --- | --- | --- |\n| 1 | 2 × 12.50 | 25.00 |\n| 3 | 3 × 33.33 | 99.99 |\n");
write(`${code}/web-shop/package.json`, JSON.stringify({ name: "web-shop", private: true, scripts: { dev: "vite", build: "vite build" } }, null, 2) + "\n");
write(`${code}/web-shop/src/checkout.tsx`, "export function Checkout({ total }: { total: number }) {\n  return <button className=\"pay\">Pay {total.toFixed(2)} €</button>;\n}\n");
write(`${code}/web-shop/AGENTS.md`, "# web-shop\n\nReact + Vite storefront for acme-api.\n");
write(`${code}/docs-site/README.md`, "# docs-site\n\nThe public documentation site.\n");
write(`${code}/infra/README.md`, "# infra\n\nDeploy scripts and dashboards.\n");
write(`${code}/infra/deploy.sh`, "#!/usr/bin/env bash\nset -euo pipefail\nrsync -a dist/ web:/srv/shop/\n");

// ---------------------------------------------------------------- transcripts
const P = (name: string) => `${code}/${name}`;
const fixTotals: Item[] = [
  { kind: "user", id: "ft-1", text: "Order 3 shows a total of 99.99000000000001 in the API. Find the cause and fix it, with a test." },
  { kind: "reasoning", id: "ft-2", text: "Floating-point sums of prices. I'll look at how totals are computed in src/orders.js, then switch to integer cents." },
  { kind: "plan", id: "ft-plan", entries: [
    { text: "Find where order totals are computed", status: "completed" },
    { text: "Sum in integer cents", status: "completed" },
    { text: "Add a regression test", status: "completed" },
    { text: "Run the test suite", status: "completed" },
  ] },
  { kind: "tool", id: "ft-3", name: "Read", input: { file_path: `${P("acme-api")}/src/orders.js` }, status: "done", output: "     1\tconst orders = [\n     2\t  { id: 1, customer: \"Ada\", items: [...] },\n     …\n    12\t  return order.items.reduce((s, i) => s + i.qty * i.price, 0);" },
  { kind: "tool", id: "ft-4", name: "Edit", input: { file_path: `${P("acme-api")}/src/orders.js` }, status: "done", output: "diff --git a/src/orders.js b/src/orders.js\n--- a/src/orders.js\n+++ b/src/orders.js\n@@ -7,6 +7,8 @@\n-export function orderTotal(order) {\n-  return order.items.reduce((s, i) => s + i.qty * i.price, 0);\n-}\n+// Totals are computed in cents so 3 × 33.33 is 99.99, not 99.99000000000001.\n+export function orderTotal(order) {\n+  const cents = order.items.reduce((sum, i) => sum + i.qty * Math.round(i.price * 100), 0);\n+  return cents / 100;\n+}" },
  { kind: "tool", id: "ft-5", name: "Write", input: { file_path: `${P("acme-api")}/test/orders.test.js` }, status: "done", output: "Wrote 7 lines" },
  { kind: "tool", id: "ft-6", name: "Bash", input: { command: "npm test", description: "Run the test suite" }, status: "done", output: "> acme-api@0.3.0 test\n> node --test\n\n✔ totals are exact to the cent (0.6ms)\n✔ unknown orders are undefined (0.1ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ duration_ms 41.2" },
  { kind: "assistant", id: "ft-7", text: `Fixed. The total was a floating-point sum: \`3 × 33.33\` accumulates binary rounding error.

**Change** — \`orderTotal\` now sums integer cents and divides once:

\`\`\`js
export function orderTotal(order) {
  const cents = order.items.reduce((sum, i) => sum + i.qty * Math.round(i.price * 100), 0);
  return cents / 100;
}
\`\`\`

- ${P("acme-api")}/src/orders.js — the fix
- ${P("acme-api")}/test/orders.test.js — a regression test for order 3
- ${P("acme-api")}/docs/rounding.md — a short note on the approach

\`npm test\`: **2 passed**, 0 failed.` },
];

const apiReview: Item[] = [
  { kind: "user", id: "ar-1", text: "Review src/server.js for error handling and HTTP correctness. Findings only, most important first." },
  { kind: "tool", id: "ar-2", name: "shell", input: { command: "rg -n \"json\\(res\" src" }, status: "done", output: "src/server.js:6:  if (url.pathname === \"/orders\") return json(res, 200, listOrders());\nsrc/server.js:9:  json(res, order ? 200 : 404, order ?? { error: \"not found\" });" },
  { kind: "assistant", id: "ar-3", text: "## Findings\n\n1. **No method check** — `POST /orders` returns the list with `200`. Answer `405` with an `Allow: GET` header.\n2. **Unhandled exceptions** crash the process; wrap the handler and return `500`.\n3. **IDs** — `/orders/007` matches; consider rejecting leading zeros.\n\nNothing blocking for the rounding fix." },
];

const leadHistory: Item[] = [
  { kind: "user", id: "ld-1", text: "Ship the checkout total fix end to end: API, storefront and a release note. Split the work across agents and report back." },
  { kind: "tool", id: "ld-2", name: "Bash", input: { command: "casm peers --probe", description: "List the hosts casm can run agents on" }, status: "done", output: "buildbox\tws://buildbox:7373  reachable 14 ms" },
  { kind: "tool", id: "ld-3", name: "Bash", input: { command: "casm run --project acme-api --provider codex --name \"tests: orders\" \"Add property tests for orderTotal\"", description: "Start a Codex agent for the API tests" }, status: "done", output: "5d0c9a3e-7b1f-4c2a-9e8d-2f6b1a4c7e90" },
  { kind: "tool", id: "ld-4", name: "Bash", input: { command: "casm -H buildbox run --project web-shop --name \"storefront build\" \"Build and smoke-test the storefront\"", description: "Start a Claude agent on buildbox for the storefront" }, status: "done", output: "a81f3c62-0e4d-4b7a-8c15-93d2e6f0b4a1" },
  { kind: "subagent", id: "ld-sub", title: "Draft the release note", agentType: "general-purpose", status: "done", summary: "Release note drafted in CHANGELOG.md (3 lines).", usage: { totalTokens: 18400, toolUses: 4, durationMs: 21000 } },
  { kind: "tool", id: "ld-5", name: "Bash", input: { command: "casm wait \"tests: orders\"", description: "Wait for the API tests agent" }, status: "done", output: "Added a property test over 1000 random carts; all 3 tests pass." },
  { kind: "assistant", id: "ld-6", text: "Status:\n\n| Part | Agent | Host | State |\n| --- | --- | --- | --- |\n| API tests | tests: orders | studio | done, 3 passing |\n| Storefront | storefront build | buildbox | done, smoke test green |\n| Release note | subagent | studio | drafted |\n\nReady to tag **0.3.1**." },
];

const checkout: Item[] = [
  { kind: "user", id: "co-1", text: "Show the order total with two decimals on the Pay button, and use the API's total instead of summing in the browser." },
  { kind: "reasoning", id: "co-2", text: "The Checkout component receives `total` from the cart; I'll fetch the order from the API and pass its total through." },
  { kind: "tool", id: "co-3", name: "read", input: { filePath: `${P("web-shop")}/src/checkout.tsx` }, status: "done", output: "export function Checkout({ total }: { total: number }) {\n  return <button className=\"pay\">Pay {total.toFixed(2)} €</button>;\n}" },
  { kind: "assistant", id: "co-4", text: "The button already formats with `toFixed(2)`; the drift came from the cart's own sum. I'll switch it to the API total." },
];

const copyTweaks: Item[] = [
  { kind: "user", id: "ct-1", text: "Tighten the checkout copy: shorter button labels, friendlier error text." },
  { kind: "assistant", id: "ct-2", text: "Done:\n\n- \"Proceed to payment\" → **Pay now**\n- \"An error has occurred\" → **Something went wrong — try again?**" },
];

const nightly: Item[] = [
  { kind: "user", id: "nt-1", text: "Summarize yesterday's commits and open issues in three bullets.", sender: { serverId: "schedule", agentId: "schedule:nightly", name: "nightly triage", host: "studio", schedule: { id: "nightly", name: "nightly triage" } } },
  { kind: "assistant", id: "nt-2", text: "- **4 commits** on main: the rounding fix, its test, a README update and a dependency bump.\n- **2 open issues**: flaky storefront e2e on Safari; slow `/orders` with 10k rows.\n- Nothing is blocking today's deploy." },
];

const testsChild: Item[] = [
  { kind: "user", id: "tc-1", text: "Add property tests for orderTotal", sender: { serverId: "studio", agentId: "lead", name: "release lead", host: "studio" } },
  { kind: "tool", id: "tc-2", name: "shell", input: { command: "npm test" }, status: "done", output: "✔ totals are exact to the cent\n✔ property: total equals sum of cents (1000 runs)\nℹ pass 3" },
  { kind: "assistant", id: "tc-3", text: "Added a property test over 1000 random carts; all 3 tests pass." },
];

const storefront: Item[] = [
  { kind: "user", id: "sf-1", text: "Build and smoke-test the storefront", sender: { serverId: "studio", agentId: "lead", name: "release lead", host: "studio" } },
  { kind: "tool", id: "sf-2", name: "Bash", input: { command: "npm run build && npx playwright test smoke" }, status: "done", output: "vite v8 building for production...\n✓ 212 modules transformed.\n  3 passed (4.1s)" },
  { kind: "assistant", id: "sf-3", text: "Build is clean and the 3 smoke tests pass; the Pay button shows **99.99 €** for order 3." },
];

const deployHistory: Item[] = [
  { kind: "user", id: "dp-1", text: "Dry-run the deploy script and tell me what it would copy." },
  { kind: "tool", id: "dp-2", name: "bash", input: { command: "rsync -an --stats dist/ web:/srv/shop/" }, status: "done", output: "Number of files: 42\nTotal transferred file size: 1.2M" },
  { kind: "assistant", id: "dp-3", text: "It would copy 42 files (1.2 MB) to `web:/srv/shop/`. No deletions." },
];

// ---------------------------------------------------------------- fake providers
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const catalogs: Record<ProviderId, Catalog> = {
  claude: {
    models: [
      { id: "default", name: "Default (recommended)", isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "opus", name: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "sonnet", name: "Sonnet 5.5", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "haiku", name: "Haiku 4.5" },
    ],
    modes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }, { id: "acceptEdits", name: "Accept edits" }, { id: "auto", name: "Auto" }, { id: "bypassPermissions", name: "Bypass permissions" }],
  },
  codex: {
    models: [{ id: "gpt-5.5", name: "GPT-5.5", isDefault: true, efforts: ["low", "medium", "high", "xhigh"] }, { id: "gpt-5.5-codex", name: "GPT-5.5 Codex", efforts: ["low", "medium", "high"] }],
    modes: [{ id: "read-only", name: "Read only" }, { id: "auto", name: "Auto" }, { id: "full-access", name: "Full access" }],
  },
  opencode: {
    models: [{ id: "opencode/big-pickle", name: "Big Pickle", isDefault: true }, { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5" }, { id: "local/qwen3-coder", name: "Qwen3 Coder (local)" }],
    modes: [{ id: "build", name: "Build" }, { id: "plan", name: "Plan" }],
  },
  pi: {
    models: [{ id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", isDefault: true }, { id: "openai/gpt-5.5", name: "GPT-5.5" }],
    modes: [],
  },
};

const resetIn = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const limits: Partial<Record<ProviderId, Omit<ProviderLimits, "provider" | "updatedAt">>> = {
  claude: { plan: "max", windows: [{ id: "five_hour", label: "5-hour", usedPercent: 42, resetsAt: resetIn(2.3), windowMinutes: 300, status: "ok" }, { id: "seven_day", label: "weekly", usedPercent: 18, resetsAt: resetIn(96), windowMinutes: 10080, status: "ok" }] },
  codex: { plan: "pro", windows: [{ id: "primary", label: "5-hour", usedPercent: 12, resetsAt: resetIn(3.1), windowMinutes: 300, status: "ok" }, { id: "secondary", label: "weekly", usedPercent: 63, resetsAt: resetIn(51), windowMinutes: 10080, status: "ok" }] },
};

const commands: Command[] = [
  { name: "review", description: "Review the current changes and list findings", argumentHint: "[path]", kind: "command" },
  { name: "test", description: "Run the project's tests and summarize failures", kind: "command" },
  { name: "release-notes", description: "Draft release notes from recent commits", kind: "skill" },
];

// Replies for prompts the GIF scripts send; anything else gets a generic one.
type Turn = { reasoning?: string; tools?: { name: string; input: unknown; output: string }[]; reply: string; ms?: number };
function turnFor(text: string, provider: ProviderId): Turn {
  const t = text.toLowerCase();
  if (t.includes("validation"))
    return {
      reasoning: "POST /orders needs a body check before it reaches orders.js: customer, at least one item, positive quantities.",
      tools: [
        { name: provider === "claude" ? "Read" : "read", input: { file_path: `${P("acme-api")}/src/server.js` }, output: "    1\timport { createServer } from \"node:http\";\n    …" },
        { name: provider === "claude" ? "Edit" : "edit", input: { file_path: `${P("acme-api")}/src/server.js` }, output: "+  const errors = validateOrder(body);\n+  if (errors.length) return json(res, 422, { errors });" },
        { name: provider === "claude" ? "Bash" : "bash", input: { command: "npm test" }, output: "✔ totals are exact to the cent\n✔ rejects orders without items\nℹ pass 3\nℹ fail 0" },
      ],
      reply: "Added `validateOrder` to `POST /orders`: it requires a customer and at least one item with a positive quantity, and answers **422** with a list of errors.\n\n`npm test`: 3 passed.",
    };
  if (t.includes("changelog") || t.includes("release note"))
    return { tools: [{ name: "Write", input: { file_path: `${P("acme-api")}/CHANGELOG.md` }, output: "Wrote 5 lines" }], reply: "Added a 0.3.1 entry to CHANGELOG.md: exact order totals and input validation." };
  if (t.includes("test")) return { tools: [{ name: "Bash", input: { command: "npm test" }, output: "ℹ tests 3\nℹ pass 3\nℹ fail 0" }], reply: "All 3 tests pass." };
  return { reply: `Done: ${text.replace(/\.$/, "")}.`, ms: 900 };
}

function fakeProvider(id: ProviderId, histories: Map<string, Item[]>, usage: Map<string, number>): Provider {
  let seq = 0;
  return {
    id,
    history: async (sid) => histories.get(sid) ?? [],
    catalog: async () => catalogs[id],
    usage: async (sid) => ({ contextTokens: usage.get(sid) ?? 24_000, contextWindow: id === "claude" ? 200_000 : 272_000, ...(id === "claude" ? { costUsd: 0.42 } : {}) }),
    commands: async () => commands,
    ...(limits[id] ? { limits: async () => limits[id]! } : {}),
    memories: id === "claude" || id === "codex" ? async (cwd) => ({ scope: "project", location: `${cwd}/.memory`, entries: [
      { id: "rounding", title: "Money is integer cents", description: "How this project handles prices", text: "# Money is integer cents\n\nNever sum floats; convert with `Math.round(price * 100)`." },
      { id: "tests", title: "Test command", description: "What to run before finishing", text: "Run `npm test`; it uses node:test, no extra tooling." },
    ] }) : undefined,
    open(o: OpenOptions) {
      const sid = o.resumeId ?? `${id}-live-${++seq}`;
      o.emit({ type: "sessionId", id: sid });
      o.emit({ type: "model", model: o.config.model ?? catalogs[id].models.find((m) => m.isDefault)!.id });
      let busy = false;
      let stopped = false;
      const steers: string[] = [];
      const record = (item: Item) => histories.set(sid, [...(histories.get(sid) ?? []).filter((x) => x.id !== item.id), item]);
      const emit = (item: Item) => (record(item), o.emit({ type: "item", item }));
      async function stream(kind: "assistant" | "reasoning", text: string) {
        for (const word of text.split(/(?<= )/)) {
          if (stopped) return;
          o.emit({ type: "delta", kind, text: word });
          await wait(28);
        }
      }
      async function run(text: string, itemId: string) {
        busy = true;
        stopped = false;
        record({ kind: "user", id: itemId, text });
        const turn = turnFor(text, id);
        if (turn.reasoning) {
          await stream("reasoning", turn.reasoning);
          emit({ kind: "reasoning", id: `r-${itemId}`, text: turn.reasoning });
        }
        for (const [i, tool] of (turn.tools ?? []).entries()) {
          if (stopped) break;
          const item = { kind: "tool" as const, id: `t-${itemId}-${i}`, name: tool.name, input: tool.input, status: "running" as const };
          emit(item);
          await wait(1500);
          emit({ ...item, status: "done", output: tool.output });
        }
        await wait(turn.ms ?? 400);
        let reply = turn.reply;
        if (!stopped) {
          await stream("assistant", reply);
          // Steered in while it worked: fold it into this turn's answer.
          if (steers.length) {
            const extra = `\n\nAlso, as you asked mid-turn: ${steers.splice(0).map((s) => `*${s}*`).join(", ")} — done, with a test.`;
            await stream("assistant", extra);
            reply += extra;
          }
          emit({ kind: "assistant", id: `a-${itemId}`, text: reply });
          usage.set(sid, (usage.get(sid) ?? 24_000) + 3_100);
          o.emit({ type: "usage", usage: { contextTokens: usage.get(sid), contextWindow: id === "claude" ? 200_000 : 272_000 } });
          // Idle before turnEnded: the next queued message is sent from inside it.
          busy = false;
          o.emit({ type: "turnEnded", outcome: "completed" });
        }
        busy = false;
      }
      return {
        send(text, itemId) {
          if (busy) {
            // Steered into the running turn.
            record({ kind: "user", id: itemId, text });
            steers.push(text.replace(/\.$/, "").toLowerCase());
            return;
          }
          void run(text, itemId);
        },
        shell(command, itemId) {
          const item = { kind: "tool" as const, origin: "user" as const, id: itemId, name: "shell", input: { command }, status: "done" as const, output: command.startsWith("git") ? "a40a335 initial orders API" : "" };
          emit(item);
          o.emit({ type: "turnEnded", outcome: "completed" });
        },
        mcpStatus: async () => [
          { name: "casm", status: "connected" as const, tools: 12 },
          { name: "github", status: "connected" as const, tools: 26 },
          { name: "sentry", status: "needs-auth" as const, tools: 0 },
        ],
        mcpReconnect: async () => "MCP servers reconnected.",
        mcpToggle: async () => {},
        async interrupt() {
          stopped = true;
          busy = false;
          o.emit({ type: "turnEnded", outcome: "interrupted" });
        },
        async close() {
          stopped = true;
        },
      };
    },
  };
}

// ---------------------------------------------------------------- the two hosts
type Seed = { name: string; provider: ProviderId; project: string; history: Item[]; model?: string; mode?: string; parent?: string; ctx?: number };

async function host(name: string, hostPort: number, projects: { name: string; group?: string; tags?: string[] }[], seeds: Seed[], ids: ProviderId[]) {
  const dir = `${state}/${name}`;
  mkdirSync(`${dir}/state`, { recursive: true });
  const store = new Store(`${dir}/casm.db`);
  const histories = new Map<string, Item[]>();
  const usage = new Map<string, number>();
  const byName = new Map<string, string>();
  const projectIds = new Map(projects.map((p) => [p.name, store.createProject({ name: p.name, path: P(p.name), group: p.group, tags: p.tags }).id]));
  for (const s of seeds) {
    const parentId = s.parent && byName.get(s.parent);
    const a = store.createAgent({
      projectId: projectIds.get(s.project)!,
      name: s.name,
      provider: s.provider,
      cwd: P(s.project),
      config: { model: s.model ?? catalogs[s.provider].models.find((m) => m.isDefault)!.id, ...(s.mode ? { mode: s.mode } : {}) },
      parent: parentId ? { serverId: store.serverId(), agentId: parentId, host: name } : null,
    });
    byName.set(s.name, a.id);
    store.updateAgent(a.id, { effectiveModel: s.model ?? catalogs[s.provider].models.find((m) => m.isDefault)!.id });
    histories.set(`seed-${a.id}`, s.history);
    usage.set(`seed-${a.id}`, s.ctx ?? 31_000);
    store.updateAgent(a.id, { nativeSessionId: `seed-${a.id}` });
  }
  const server = await startServer({
    store,
    providers: ids.map((id) => fakeProvider(id, histories, usage)),
    host: "127.0.0.1",
    port: hostPort,
    version: "0.0.1",
    name,
    home: `${dir}/state`,
    webRoot: resolve("packages/web/dist"),
  });
  return { store, server, byName, projectIds };
}

const buildbox = await host(
  "buildbox",
  port + 1,
  [{ name: "web-shop" }],
  [
    { name: "storefront build", provider: "claude", project: "web-shop", history: storefront, model: "sonnet" },
    { name: "deploy dry-run", provider: "opencode", project: "web-shop", history: deployHistory, model: "local/qwen3-coder" },
  ],
  ["claude", "codex", "opencode"],
);

const studio = await host(
  "studio",
  port,
  [
    { name: "acme-api", group: "work", tags: ["node"] },
    { name: "web-shop", group: "work" },
    { name: "infra", group: "ops" },
  ],
  [
    { name: "fix order totals", provider: "claude", project: "acme-api", history: fixTotals, model: "opus", ctx: 58_000 },
    { name: "api review", provider: "codex", project: "acme-api", history: apiReview, model: "gpt-5.5" },
    { name: "release lead", provider: "claude", project: "acme-api", history: leadHistory, model: "opus", ctx: 92_000 },
    { name: "tests: orders", provider: "codex", project: "acme-api", history: testsChild, parent: "release lead" },
    { name: "checkout total", provider: "opencode", project: "web-shop", history: checkout, model: "opencode/big-pickle" },
    { name: "copy tweaks", provider: "pi", project: "web-shop", history: copyTweaks },
    { name: "nightly triage", provider: "claude", project: "infra", history: nightly, model: "haiku" },
  ],
  ["claude", "codex", "pi", "opencode"],
);

// Peer studio → buildbox, so the sidebar shows both hosts and a remote child.
const peerToken = buildbox.store.createToken("studio");
studio.store.setPeer({ name: "buildbox", url: `ws://127.0.0.1:${port + 1}`, token: peerToken, serverId: buildbox.store.serverId() });

// Schedules (through the scheduler, so next runs are computed).
const sched = studio.server.scheduler;
await sched.create({ name: "nightly triage", cadence: { type: "cron", expr: "0 7 * * 1-5" }, target: { type: "newAgent", projectId: studio.projectIds.get("acme-api")!, provider: "claude", config: { model: "haiku" }, name: "nightly triage" }, prompt: "Summarize yesterday's commits and open issues in three bullets." });
await sched.create({ name: "review pass", cadence: { type: "every", minutes: 30 }, target: { type: "agent", agentId: studio.byName.get("api review")!, whenBusy: "skip" }, prompt: "Re-run the review on anything that changed since your last pass." });
await sched.create({ name: "release reminder", cadence: { type: "once", at: new Date(Date.now() + 2 * 3_600_000).toISOString() }, target: { type: "agent", agentId: studio.byName.get("release lead")! }, prompt: "Check whether the storefront build finished and post the release note." });

const token = studio.store.createToken("showcase");
writeFileSync(`${state}/web-token`, token);
writeFileSync(`${state}/agents.json`, JSON.stringify(Object.fromEntries(studio.byName), null, 2));
console.log(`showcase: ${studio.server.url} (peer buildbox on ${port + 1}); token in ${state}/web-token`);
// Open client sockets can keep close() waiting; don't outlive the capture script.
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    setTimeout(() => process.exit(), 1000).unref();
    void Promise.all([studio.server.close(), buildbox.server.close()]).then(() => process.exit());
  });
