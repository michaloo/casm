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
node packages/cli/src/main.ts serve --listen 0.0.0.0:7373     # in another terminal

node packages/cli/src/main.ts project create ~/Explorations
node packages/cli/src/main.ts run --project Explorations --wait "What is in this directory?"
node packages/cli/src/main.ts agents
```

State lives in `$CASM_HOME` (default `~/.casm-ng`): `casm.db` on the server, plus `local.json`, which
`casm serve` writes on every start (the URL and a fresh token for this machine's CLI). With it the CLI
on the server's machine needs no setup.

### Which server the CLI talks to

- **On a machine running a server:** the CLI talks to that server, and `casm -H <name> ...` asks it to
  forward the command to its peer `<name>` (see [Peers](#peers)). Peers are what `-H` names, the same
  hosts the server's agents reach with the casm MCP tools. `casm peers [--probe]` lists them.
- **On a machine without a server:** `-H` picks a host from `$CASM_HOME/hosts.json`, like the apps' host
  list: `casm host add <name> <ws-url> <token> [--default]`, `casm host list`, `casm host rm <name>`.
  The token is one created on that server (`casm token create <name>` there). `casm host add` refuses
  on a machine with a server; add a peer instead.
- `$CASM_HOST` is the default for `-H`. `$CASM_URL` + `$CASM_TOKEN` replace this machine's server
  (`local.json`), and `-H` then names a peer of that server.

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
`{"listen": "100.68.62.102:7373", "name": "ubuntu"}`. `service install` captures the current `PATH`
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

The Mac runs its own casm server and also talks to the one on ubuntu (`ws://100.68.62.102:7373`, over Tailscale).
It needs Node 24+ (`brew install node`) and git.

```sh
git clone <casm-ng repo> ~/Explorations/casm-ng      # or copy the checkout from ubuntu
cd ~/Explorations/casm-ng
scripts/install.sh                                    # ensure ~/.local/bin is on PATH (e.g. in ~/.zshrc)

mkdir -p ~/.casm-ng
echo '{"listen": "<mac-tailscale-ip>:7373", "name": "macbook"}' > ~/.casm-ng/config.json
casm service install                                  # run from a shell whose PATH has claude/codex/pi/opencode
casm service status; casm service logs

casm info                                             # this Mac's CLI uses its own server (local.json)
casm token create ubuntu                              # for ubuntu to use when it peers with the Mac

# ubuntu: the tokens are in ubuntu:~/.casm-ng/client-tokens.txt (the "macbook" line)
casm peer add ubuntu ws://100.68.62.102:7373 <macbook token>   # the Mac's agents and CLI can use ubuntu
casm -H ubuntu info                                   # forwarded by the Mac's server

# on ubuntu, with the "ubuntu" token printed above:
casm peer add macbook ws://<mac-tailscale-ip>:7373 <ubuntu token>
casm -H macbook info
```

To read the token over SSH from the Mac, run `ssh ubuntu "awk '\$1==\"macbook\"{print \$2}' ~/.casm-ng/client-tokens.txt"`.

## Project details: AGENTS.md and memories

```sh
casm project agents-md Explorations          # print <project>/AGENTS.md
casm project agents-md Explorations --edit   # edit it in $EDITOR, then save it on the server
casm project memories Explorations           # each agent's memories for the folder
casm --json project memories Explorations    # with the full text of each entry
```

The protocol's `project.agentsMd` returns a SHA-256 content hash (`null` when missing).
Pass it as `expectedSha256` to `project.setAgentsMd` to reject stale saves with
1003 (Conflict); `null` requires a missing file. Omitting it preserves unconditional
saves. Writes use an atomic rename.

`agent.commands` caches commands per provider and working directory for five minutes,
warms on session open, and accepts `refresh: true`. Concurrent lookups share one request.
Tool items from user `agent.shell` commands carry `origin: "user"`, including history;
the optional origin field distinguishes them from the agent's own shell calls.

Memories are read-only in casm; AGENTS.md is the one thing you edit. Claude Code memories live in
`~/.claude/projects/<folder>/memory/`. Codex memories are one global store (`~/.codex/memories/`)
that Codex regenerates itself; casm lists the parts that apply to the folder. OpenCode and pi have no memory store by default. See docs/design.md.

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

For developing casm through its own agents, use the [stable/development workflow](docs/development.md).
`npm run dev -- init` creates isolated checkout-local state; `npm run dev:server` serves it on
loopback port 7474. Use `npm run dev -- <command>` to target that instance from the CLI.

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

## Cross-host agents

### Peers

A server can call other casm servers ("peers") on behalf of its agents and clients. Peers are
edited on the server machine, straight in its DB (like tokens):

```sh
casm peer add macbook ws://michals-macbook-pro:7373 <token>   # connects and checks server.info first
casm peer list [--probe]
casm peer rm macbook
```

The token is one created on the peer (`casm token create ...` there). Clients see peers through the
read-only `peer.list` RPC (`{probe: true}` adds `reachable`; `casm peers` on the CLI); peer tokens are
never sent over RPC.

Any client can use a peer through its server: a JSON-RPC request with a top-level `"host": "<peer
name or server id>"` is forwarded over the same cached peer connection the MCP tools use (this
server's own name or id means here). That is how `casm -H <peer>` works. The peer's errors keep their
code; an unknown host is 1001 (NotFound), and an unreachable one fails within 3 s with 1005
(Unreachable). `agent.subscribe` through a peer relays the agent's `agent.event` / `agent.status`
notifications, marked with the same `host`, and when the peer connection drops the client gets
`peer.disconnected {host}` once (subscribe again after reconnecting). Any client token can drive the
server's peers, just as the server's agents can.
`casm serve --name <n>` (or `$CASM_NAME`, or `"name"` in config.json) sets the server's display name;
the default is the hostname.

### Agent tools (MCP)

Create an agent with `config.casmTools: true` (`casm run --casm-tools ...`) and its sessions get casm's
own MCP server, served by casm at `POST /mcp` (streamable HTTP, JSON responses, no SSE). Tools:

| Tool | Does |
|---|---|
| `list_hosts` | this server and its peers, with reachability and agents offered |
| `list_projects(host?)`, `list_agents(host?, project?)` | |
| `create_agent(host?, project, provider, prompt?, model?, mode?, name?)` | parent is set to the calling agent |
| `send(host?, agent, text)` | queued if the agent is busy |
| `wait(host?, agent, timeout_s?)` | status, last reply and pending requests; default 50 s (call again on `timedOut`) |
| `get_history(host?, agent, limit?)` | the last transcript entries as text |
| `answer_permission(host?, agent, request_id, decision, message?)`, `answer_question(host?, agent, request_id, answers?)` | unblock a child |

`host` defaults to this server; other hosts are peer names (or server ids). Remote calls go through one
cached connection per peer. An unreachable peer fails within 3 s, and errors come back as MCP tool
errors. Each session gets its own bearer token, minted when the session opens and kept in memory only;
it identifies the calling agent.

| Agent | casm tools |
|---|---|
| Claude Code | yes: `{type: "http", url, headers}` in the SDK's `mcpServers` |
| Codex | yes: `mcp_servers.casm = {url, http_headers}` in the thread config |
| pi | no: pi has no MCP client. Use the `casm` CLI (env vars below) |
| OpenCode | no: MCP servers belong to the shared `opencode serve`, so there is no per-agent token. Use the CLI |

The agent's own permission flow still applies: in Claude's default mode, `mcp__casm__*` calls ask for
approval like any other tool.

### Environment of agent sessions

Every session casm starts (Claude, Codex, pi; not OpenCode, whose server is shared) gets:

| Variable | Value |
|---|---|
| `CASM_SERVER_ID` | this server's `server.info` id |
| `CASM_SERVER_NAME` | this server's name |
| `CASM_AGENT_ID` | the agent's id |

`casm run` reads them, so an agent shelling out to `casm -H macbook run ...` links the child to itself.
`--parent <serverId>/<agentId>` overrides them and `--parent none` turns the link off.

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

## Usage limits

casm tracks each provider's subscription limits and copes with running out:

- **Reporting.** `casm limits` (protocol `provider.limits`, MCP `get_limits`, and in `list_hosts`) shows
  each provider's windows (Claude's 5-hour and weekly windows, Codex's usage limit) with used %,
  reset time and status. Claude reports them as it runs; Codex reports exhaustion when a turn fails.
  `casm usage <agent>` and `casm agents --usage` show each agent's context and cost.
- **Detection.** A turn that fails on a usage or rate limit ends with `turnEnded.limit`
  `{message, resetsAt}`. The reset time is taken from the provider or parsed from its message
  ("try again at 6:31 PM", "in 2 hours", ISO times). The provider is then marked exhausted, so
  its other agents wait too. A successful turn clears the mark.
- **Queueing.** The prompt that hit the limit becomes a pending message (see below) and is resent a
  minute after the reset, or with backoff (15 min, doubling, up to 3 h) when no time is known.
  Messages sent meanwhile wait behind it (`agent.send` returns `deferredUntil`) unless the caller
  passes `whenLimited: "fail"` (`casm send --fail-if-limited`), which fails with error code 1004.
- **For scripts and coordinating agents.** `casm wait` exits 4 when the agent was deferred by a
  limit (3 = still running or waiting for you). The MCP `wait` tool returns `deferred` with a
  hint to pick another provider or host.

## Pending messages

Messages waiting for their agent to become available are stored in the server database and visible:

- **queued**: sent while the agent was busy; goes after the running turn.
- **limit**: hit a usage limit; retried after the reset. Holds back the messages behind it.

`casm pending [agent]` lists them, together with agents waiting for a permission or an answer
(protocol `pending.list` / `agent.pending`, MCP `list_pending`). `casm cancel <agent> <id>` or
`--all` cancels (`agent.cancelPending`); interrupting an agent drops its pending messages. Agents
report `pending: {count, next}` so clients can badge them.

## Schedules

Schedules are host-level jobs: on a cadence they **message an existing agent** or **create a new
agent** from a preset (project, agent type, model/mode, name) with a prompt. They're stored in the
server database and listed with their next run and last result.

```sh
casm schedule add --every 30m --agent reviewer "Any new failing tests?"
casm schedule add --cron "0 9 * * 1-5" --project api --provider codex --mode auto --name standup "Summarise yesterday's commits"
casm schedule add --at 18:30 --agent writer "Continue the draft"      # once
casm send writer --at "in 2h" "…"                                     # shorthand for a once schedule
casm schedules [--agent a]
casm schedule run | enable | disable | rm <schedule>
```

- **Cadence:** a 5-field cron in the server's local time, `every N minutes`, or `once` at a time
  (it disables itself after running).
- **Busy or limited agents:** a schedule's message to an agent that is busy or over a usage limit
  becomes a pending message, or is skipped with `--skip-if-busy` (`whenBusy: "skip"`).
- **Missed runs:** a run missed while the server was down happens once when it's back.
- **Protocol:** `schedule.list/create/update/delete/runNow`, notifications `schedule.changed` /
  `schedule.removed`. Deleting an agent deletes its schedules.
