# casm

A small, self-hosted orchestrator for coding agents (Claude Code, Codex, pi and OpenCode):
a server per machine, peers across machines, a scriptable CLI, and a web client (served at
`/`, installable as a PWA). Design: [docs/design.md](docs/design.md).

Scope: casm runs and coordinates agents (projects, agents, subagents, messages, steering,
queues, schedules, limits). It does not sandbox or containerize agents, import sessions, or
sync them between machines. Full-text search over agent sessions is a separate tool,
[cass](https://github.com/michaloo/cass). This replaces the earlier casm CLI/TUI, which is
kept on the `legacy` branch.

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

casm info                                             # this Mac's CLI uses its own server (local.json)
casm token create studio                              # for studio to use when it peers with the Mac

# studio: the tokens are in studio:~/.casm-ng/client-tokens.txt (the "laptop" line)
casm peer add studio ws://100.64.0.1:7373 <laptop token>   # the Mac's agents and CLI can use studio
casm -H studio info                                   # forwarded by the Mac's server

# on studio, with the "studio" token printed above:
casm peer add laptop ws://<mac-tailscale-ip>:7373 <studio token>
casm -H laptop info
```

To read the token over SSH from the Mac, run `ssh studio "awk '\$1==\"laptop\"{print \$2}' ~/.casm-ng/client-tokens.txt"`.

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

An agent works in its project's folder, or in a folder inside it: `casm run --cwd <dir>`
(`agent.create` `cwd`, MCP `create_agent` `cwd`), relative to the project path or absolute. It must
exist on the host and stay inside the project once `..` and symlinks are resolved. For parallel
agents on one repository, give each task its own git worktree:

```sh
git worktree add .worktrees/<task>          # with .worktrees/ in .gitignore
casm run --project p --cwd .worktrees/<task> "<prompt>"
```

## Cross-host agents

### Peers

A server can call other casm servers ("peers") on behalf of its agents and clients. Peers are
edited on the server machine, straight in its DB (like tokens):

```sh
casm peer add laptop ws://laptop:7373 <token>   # connects and checks server.info first
casm peer list [--probe]
casm peer rm laptop
```

The token is one created on the peer (`casm token create ...` there). Clients see peers through the
read-only `peer.list` RPC (`{probe: true}` adds `reachable`, `latencyMs` and `slow`; `casm peers --probe` on the CLI prints
"reachable 120 ms", "slow: 4.2 s" or "unreachable: ..."); peer tokens are
never sent over RPC.

Any client can use a peer through its server: a JSON-RPC request with a top-level `"host": "<peer
name or server id>"` is forwarded over the same cached peer connection the MCP tools use (this
server's own name or id means here). That is how `casm -H <peer>` works. The peer's errors keep their
code; an unknown host is 1001 (NotFound), and an unreachable one fails with 1005
(Unreachable). A peer gets 10 s to connect and answer (`"peerTimeoutMs"` in config.json), so a
heavily loaded host is slow rather than unreachable; a probe over 2 s reports it as slow. `agent.subscribe` through a peer relays the agent's `agent.event` / `agent.status`
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
cached connection per peer. An unreachable peer fails after the peer timeout, and errors come back as MCP tool
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

`casm run` reads them, so an agent shelling out to `casm -H laptop run ...` links the child to itself.
`--parent <serverId>/<agentId>` overrides them and `--parent none` turns the link off.

### Host agent prompt

When a session starts or resumes, casm puts the host's agent prompt ahead of the agent's own
`config.systemPrompt`, for every provider. It tells the agent where it runs (host, agent id, project,
folder) and which casm commands it has (`casm run`, `send`, `wait`, `schedule add`, `pending`,
`peers`, `limits`, ...), plus the casm MCP tools when the agent has them (`config.casmTools`).
`$CASM_HOME/agent-prompt.md` replaces the built-in default; `{{host}}`, `{{agentId}}`,
`{{agentName}}`, `{{project}}`, `{{cwd}}`, `{{provider}}` and `{{casmTools}}` are filled per agent.
`"agentPrompt": false` in `$CASM_HOME/config.json` turns it off.

```sh
casm agent-prompt [agent]        # the effective prompt, for that agent or an example one
casm agent-prompt --edit         # edit agent-prompt.md in $EDITOR, seeded with the default
casm agent-prompt --reset        # delete it, back to the default
casm agent-prompt --disable      # or --enable
```

Protocol: `server.agentPrompt` / `server.setAgentPrompt`. Changes apply to sessions opened afterwards.

### Subagents

Subagents an agent runs itself (Claude Task/Agent, background ones too, Codex sub-agents, OpenCode
tasks) show in its transcript as `subagent` items. The server tracks them from the live session, so
agents report `subagents: {running}` (a background subagent counts until its completion arrives,
even while the agent is idle) and `casm agents` shows "2 subagents". `casm subagents [agent]`
(`agent.subagents`) lists running and recent ones with type, activity or summary and usage;
`casm history <agent> --subagent <id>` reads one (`agent.subagentHistory`). A subagent still running
when its session ended is shown as stale.

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
  minute after an account reset, or with backoff (15 min, doubling, up to 3 h) when no time is known.
  Transient 429/rate throttles without quota language retry after 30 seconds, doubling to 5 minutes;
  an explicit retry time is respected with a one-second margin.
  Messages sent meanwhile wait behind it (`agent.send` returns `deferredUntil`) unless the caller
  passes `whenLimited: "fail"` (`casm send --fail-if-limited`), which fails with error code 1004.
- **Recovery.** `casm send-now <agent> <message-id>` makes one explicit attempt even while deferred.
  A repeated limit defers the message again; success releases that agent's earlier deferred messages.
  `casm limits --refresh` replaces stale inferred limits with the current account report and resumes
  deferred work when every reported window positively shows capacity. Unavailable, empty or still
  exhausted reports do not release queued work. Agent execution can be idle while `deferred` explains
  why its pending messages are waiting.
- **For scripts and coordinating agents.** `casm wait` exits 4 when the agent was deferred by a
  limit (3 = still running or waiting for you). The MCP `wait` tool returns `deferred` with a
  hint to pick another provider or host.

## Pending messages

Messages waiting for their agent to become available are stored in the server database and visible:

Each agent has one queue, sent strictly in order, one message per turn.

- **queued**: sent while the agent was busy (or behind other waiting messages); goes in its turn.
  While the provider is known to be over its usage limit, the first one waits for the reset as **limit**.
- **limit**: hit a usage limit; retried after the reset. Holds back the messages behind it.
- **failed**: its turn failed before the agent answered it (a session that can't be resumed, the
  provider logged out or unreachable, a server stop right after the send), so the agent's own history
  may not have it. That covers the prompt that started the turn and any steered into it with nothing
  coming back after. Kept at the front with the error in `note` and holds the queue, never resent on
  its own: Retry now (`casm retry <agent> <id>`, `agent.retryPending`) or `casm cancel`. At startup, a
  kept prompt the agent's history shows as answered is dropped.
  `casm wait` exits 5 when the last turn failed (`agent.wait` returns `lastTurn`).

`casm pending [agent]` lists them, together with agents waiting for a permission or an answer
(protocol `pending.list` / `agent.pending`, MCP `list_pending`). `casm cancel <agent> <id>` or
`--all` cancels (`agent.cancelPending`); interrupting an agent stops its turn and keeps the queue, which
goes on after it. `casm send-now <agent> <id>` (`agent.steerPending`)
sends one right away with its images, into the running turn or as a new turn if the agent is idle.
Agents report `pending: {count, next}` so clients can badge them. A recipient can observe this count
and finish its turn to receive queued messages normally. `agent.editPending` changes a waiting message's
text in place. `agent.send` takes an optional client `messageId` (UUID) that becomes the pending id and
the transcript item id; sending the same id again does not deliver it twice.
Agent-authored sends carry explicit sender IDs/name through pending delivery and history; human sends
remain unattributed. See [message provenance](docs/message-provenance.md) for persistence and native-provider limits.

## Schedules

Schedules are host-level jobs: on a cadence they **message an existing agent** or **create a new
agent** from a preset (project, agent type, model/mode, name) with a prompt. They're stored in the
server database and listed with their next run and last result.

```sh
casm schedule add --every 30m --agent reviewer "Any new failing tests?"
casm schedule add --cron "0 9 * * 1-5" --project api --provider codex --mode auto --name standup "Summarise yesterday's commits"
casm schedule add --at 18:30 --agent writer "Continue the draft"      # once
casm schedule add --at "in 2h" --agent writer "…"                     # once, relative
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

## Web client (v1)

```sh
npm ci --include=dev
npm run build
```

The casm server serves `packages/web/dist` at `/` on its existing port, including
SPA fallback. Open `http://<server>:7373` and enter a client token once (create one
with `casm token create web`). The browser stores it in localStorage and passes it
as `?token=` on the WebSocket upgrade. Use a trusted network or HTTPS when serving
outside your machine. `CASM_WEB_ROOT` or the server config's `web` field overrides
the built directory (`web: false` disables serving).

Hosts and peers share one connection; peer requests use the protocol's `host`
field. Click a project to draft a new agent; the first message creates it. Enter
sends, Shift+Enter inserts a newline; running agents offer Queue, Steer and
Interrupt. Thinking and tool rows expand on demand. Older history loads when you
scroll up. Pending messages and permission/question requests sit above the pinned
composer. The app follows the system light/dark setting.
The sidebar remembers collapsed hosts/projects and nests children within the
same host and project. Provider/model labels and an optional host usage popover
keep status visible. A centered Working indicator sits above the composer while
the selected agent runs. Explicit Steer reaches an active turn immediately;
an actual provider limit can still defer the message, with an explanation.

Selections have shareable browser-history URLs: `/h/<host-name>/a/<agent-id>`
for chats and `/h/<host-name>/p/<project-id>/new` for project drafts. Reload and
Back/Forward restore the view; missing or archived agents show a not-found
message. Both the server and Vite serve the React entry point for these paths.
Composer text is saved in localStorage per host and agent (or project for new
agents), debounced while typing and flushed before reload. A successful send
clears the sent draft; failed sends retain it. Pasted images appear as removable
thumbnails and can be sent without text. Persisted image data shares a roughly
1 MB budget across drafts; oversized attachments remain available in the current
session but are silently omitted from storage. Human and agent-authored messages
preserve intentional line breaks; explicit sender metadata identifies agent reports.


For live development, run from `packages/web`:

```sh
VITE_CASM_URL=ws://100.64.0.1:7373 npx vite --host 0.0.0.0 --port 5173
```

Without an override the WebSocket uses the page origin. `?server=ws://host:port`
overrides `VITE_CASM_URL`, which is useful for an isolated dev server. Client HMR
needs no server restart. Keep production service management separate.

```sh
npm run test -w @casm/web
```

Playwright starts a disposable fake-provider server on loopback port 7495 with
`CASM_DEV_HOME=/tmp/casm-web-dev CASM_DEV_PORT=7495`; it makes no model calls and
never uses production agents. Install Chromium once with `npx playwright install
chromium` if needed. Screenshots are written to `/tmp/casm-web-desktop.png` and
`/tmp/casm-web-mobile.png`. The visual fixture covers every transcript row,
long tool output, diffs, highlighted code, and wide tables. Its desktop/mobile
screenshots in both color schemes are `/tmp/casm-web-{visual,tools,diff,code,markdown,permission}-{desktop,mobile}-{light,dark}.png`.

The web theme uses the casm mark's violet and teal accents, system fonts, and
local brand icons. Syntax highlighting loads on demand; tool details render only
when expanded, long output offers Show more, and code blocks include a copy
button that also works over plain HTTP. Tool durations measure live time observed
by the client; historical tools without timing data omit the duration.
Expanded tool results also show inline raster images. Providers bound image
payloads to 1 MiB; Codex view-image results read only the emitted regular-file
path and omit unavailable, oversized, or non-raster files. No filesystem image
endpoint is exposed.
