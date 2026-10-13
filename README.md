# casm NG (working name)

A small, self-hosted server for coding agents (Claude Code, Codex, pi and OpenCode), with
native macOS/iOS clients to come. Design: [docs/design.md](docs/design.md).

```
packages/protocol   zod schemas for the wire protocol (source of truth)
packages/server     the server (`casm serve`): WebSocket + JSON-RPC server, SQLite, provider adapters
packages/client     typed Node client
packages/cli        the `casm` command: server subcommands + client, scriptable with --json
spec/protocol.json  the protocol as JSON Schema, for clients in any language
```

Requires Node 24+ (TypeScript runs directly, no build step).

## Quick start

```sh
npm install
node packages/cli/src/main.ts token create laptop         # prints a token
node packages/cli/src/main.ts serve --listen 0.0.0.0:7373

node packages/cli/src/main.ts host add studio ws://studio:7373 <token>
node packages/cli/src/main.ts project create Explorations --path ~/Explorations
node packages/cli/src/main.ts run --project Explorations --wait "What is in this directory?"
node packages/cli/src/main.ts agents
```

State lives in `$CASM_HOME` (default `~/.casm-ng`): `casm.db` on the server, `hosts.json` for the CLI.

## Install from a checkout (Linux and macOS)

```sh
scripts/install.sh            # npm ci + a `casm` launcher in ~/.local/bin (CASM_BIN_DIR overrides); idempotent
casm service install          # background server: systemd user unit (Linux) / launchd agent (macOS)
casm service status | logs [-f] | restart | uninstall
```

The launcher runs `packages/cli/src/main.ts` from the checkout, so `git pull` updates casm in place
(run `scripts/install.sh` again when dependencies change). `casm service ...` is handled by the launcher
(`scripts/service.sh`), and `npm run setup` / `npm run service -- <cmd>` do the same.

The service runs `node .../main.ts serve` and reads `$CASM_HOME/config.json`, for example
`{"listen": "100.64.0.1:7373", "name": "studio"}`. `service install` captures the current `PATH`
into the unit/plist, so the server finds claude/codex/pi/opencode; run it again after installing
agents somewhere new or switching Node versions.
- Linux: `~/.config/systemd/user/casm.service`, `Restart=on-failure`, logs in the user journal. To keep it
  running while logged out, enable linger once: `sudo loginctl enable-linger $USER`.
- macOS: `~/Library/LaunchAgents/dev.casm.server.plist`, `KeepAlive`, logs in `~/Library/Logs/casm/casm.log`.

Publishing to npm is not set up yet. Node refuses to strip types under `node_modules`, so
`npm i -g` of the workspace does not run. A publishable package will need a bundle step first (for
example esbuild of `packages/cli/src/main.ts` into one `dist/casm.js`, keeping
`@anthropic-ai/claude-agent-sdk` external since it ships its own CLI files).

## Install on macOS

The Mac runs its own casm server and also talks to the one on studio (`ws://100.64.0.1:7373`, over Tailscale).
It needs Node 24+ (`brew install node`) and git.

```sh
git clone <casm-ng repo> ~/Explorations/casm-ng      # or copy the checkout from studio
cd ~/Explorations/casm-ng
scripts/install.sh                                    # ensure ~/.local/bin is on PATH (e.g. in ~/.zshrc)

mkdir -p ~/.casm-ng
echo '{"listen": "<mac-tailscale-ip>:7373", "name": "laptop"}' > ~/.casm-ng/config.json
casm service install                                  # run from a shell whose PATH has claude/codex/pi/opencode
casm service status; casm service logs

casm token create cli-laptop                         # this Mac's own CLI -> its own server
casm token create studio                              # for studio to use when it peers with the Mac
casm host add laptop ws://<mac-tailscale-ip>:7373 <cli-laptop token>

# studio: the tokens are in studio:~/.casm-ng/client-tokens.txt (the "laptop" line)
casm host add studio ws://100.64.0.1:7373 <laptop token>
casm peer add studio ws://100.64.0.1:7373 <laptop token>   # lets agents on the Mac call studio's server
casm -H studio info
```

To read the token over SSH from the Mac, run `ssh studio "awk '\$1==\"laptop\"{print \$2}' ~/.casm-ng/client-tokens.txt"`.

## Writing your own client

The protocol is meant to be used by other clients:
- JSON-RPC 2.0 over one WebSocket, with `Authorization: Bearer <token>` on the upgrade request.
- `GET /health` (no auth) returns the server and protocol version.
- `spec/protocol.json` has every method's params and result, plus every notification, as JSON Schema.
  It is regenerated from the zod schemas (`npm run schema`), and a test fails if it is stale.
- Typical flow:
  1. `project.list` / `agent.list`.
  2. `agent.history` to show the transcript (read from the agent's own session files).
  3. `agent.subscribe` for live `agent.event` notifications plus the in-flight turn.
  4. `agent.send`, then `agent.respondPermission` when a `permission` event arrives.

Example: `casm --json agents | jq '.[] | select(.status=="waiting")'`.

## Development

```sh
npm run typecheck
npm test            # fake-provider end-to-end tests; no agent CLI needed
```

## Agents

Each host offers the agents installed on it (`casm info` lists them). Each one uses its native protocol:

| Agent | Transport | Native session id | Permissions |
|---|---|---|---|
| Claude Code | Claude Agent SDK | session UUID | `canUseTool` (modes: default, acceptEdits, plan, auto, …) |
| Codex | `codex app-server` (JSON-RPC stdio) | thread id | approvals; modes `read-only`, `auto`, `untrusted`, `full-access` |
| pi | `pi --mode rpc` | session file path | none built in; extension confirm dialogs are routed as permission requests |
| OpenCode | one shared `opencode serve` per host (HTTP + SSE) | session id | permission asks; mode = OpenCode agent (`build`, `plan`, …) |

Override a binary with `CASM_CLAUDE_PATH`, `CASM_CODEX_PATH`, `CASM_PI_PATH` or `CASM_OPENCODE_PATH`.

## Protocol coverage

[coverage/REPORT.md](coverage/REPORT.md) measures how much of each agent's native protocol, and of
ACP, casm covers. Inventories in `coverage/inventory/` are extracted from each agent's own source of
truth (Claude SDK `sdk.d.ts`, `codex app-server generate-json-schema`, OpenCode's OpenAPI `/doc`,
pi's RPC docs, the ACP npm schema) by `scripts/coverage/<source>.ts`. Every id is classified by hand
in `coverage/<source>.json` as `mapped` (with the casm element it maps to), `ignored` (with a reason)
or `gap` (with a theme and a note).

After upgrading an agent (or the Claude SDK):

```sh
npm run coverage            # re-extract all inventories, rewrite coverage/REPORT.md
npm run coverage -- codex   # just one source; --offline skips the ACP npm download
```

It prints added/removed ids and exits 1 while any are unclassified. Classify new ids in
`coverage/<source>.json` by reading the provider code, delete ids the agent dropped, and run it again.
`npm test` fails on the same drift: it re-extracts Claude, Codex, pi and ACP (from the `/tmp` cache)
when they are installed, and uses the checked-in inventory for OpenCode, which needs a running server.
When a provider starts handling something, flip its entry from `gap` to `mapped`; a test checks that
every `to` names a real protocol element.
