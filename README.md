# casm

casm is a small, self-hosted agent orchestrator for **Claude Code, Codex, pi and
OpenCode**. Run a server on each machine and connect them as peers. A scriptable
CLI and opt-in MCP tools let agents spawn, message and steer other agents, locally
or across machines. Schedules, persistent message queues and provider limits
support unattended work. The server serves the primary web client, installable
as a PWA.

casm does not provide sandboxing or containers, import sessions, or synchronize
sessions and files between machines. Agents work with their host's tools and
provider permissions. Full-text session search is the separate tool
[cass](https://github.com/michaloo/cass). Native macOS/iOS clients live on the
[`apple` branch](https://github.com/michaloo/casm/tree/apple); the former CLI/TUI
is preserved on `legacy`.

## How it compares

These tools overlap: all three support remote agent work and agent-to-agent
coordination. Their server arrangements and client workflows differ. This
comparison was reviewed on **2026-10-14** against this checkout, local Paseo
sources and HAPI's upstream documentation. Provider capabilities vary; a feature
listed for one provider is not a promise for every provider.

| Area | casm | [Paseo][paseo] | [HAPI (`tiann/hapi`)][hapi] |
| --- | --- | --- | --- |
| Architecture | Independent server per machine; authenticated WebSocket RPC; provider-native history. | Local daemon manages agents; desktop can start it. Optional Hub dispatches automation to daemons. [Core][paseo], [Hub][paseo-hub] | CLI wrappers connect to a central Hub; optional Runners launch sessions remotely. [Architecture][hapi-install] |
| Clients | CLI, MCP tools, web/PWA. | Desktop, iOS, Android, web, CLI and TypeScript SDK. [Clients][paseo] | Terminal CLI, native iOS/Android, web/PWA and Telegram Mini App. [Clients][hapi] |
| Multi-machine | Servers forward requests to named peers; CLI `-H`, web host selection and MCP share those peers. | Clients connect to multiple daemons; remote CLI and Hub support multiple machines. [Core][paseo], [Hub][paseo-hub] | Multiple working machines connect to one Hub; Runners enable remote session creation. [Installation][hapi-install] |
| Relay / cloud dependency | Direct connections; no casm relay or cloud account. Supply your own network access. | Direct TCP/VPN or optional encrypted relay; relay can be self-hosted. [Connections][paseo], [relay][paseo-relay] | Hub can be self-hosted with relay disabled; network relay and mobile push services are optional. [Deployment options][hapi-install] |
| Providers | Claude Code, Codex, pi, OpenCode. | Those four plus Copilot, Antigravity and Muse Code; extensible through plugins. [Providers][paseo] | Those four plus Cursor Agent, Grok Build, Kimi, Copilot, Antigravity and DeepSeek Harness. [Supported agents][hapi-agents] |
| Agent-to-agent orchestration | CLI and opt-in MCP spawn/manage agents, preserve parent links and support Queue/Steer across peers. | CLI and opt-in MCP manage agents/workspaces across providers; remote CLI reaches other hosts. [Orchestration][paseo-orchestration] | CLI/MCP peer discovery, inspection and messaging, including resuming peers when needed. [Peer tools][hapi-cli] |
| Schedules | Cron, interval and one-time jobs; target an existing agent or create one. | Cron schedules create agents; heartbeats prompt existing agents. Hub adds event-triggered automation. [Schedules][paseo-schedules], [Hub][paseo-hub] | No built-in scheduler documented in the reviewed [CLI][hapi-cli] and [Hub][hapi-hub] guides. |
| Limits / usage | Provider-dependent subscription windows, context usage and cost; limit-aware deferral and retry. | Usage-source plugins expose account/session windows, balances and availability. [Usage API][paseo-usage] | Provider-dependent context usage; cross-provider quota gauges are discussed in [upstream #846][hapi-usage]. Comprehensive quota/retry support was not verified. |
| Licensing / self-hosting | Self-hosted; no license declared in this checkout. | Self-hosted core and optional Hub, Apache-2.0. [Core license][paseo-license], [Hub license][paseo-hub-license] | Self-hosted, AGPL-3.0. [License][hapi-license] |
| Mobile | Responsive web/PWA is the primary mobile client; native work is on `apple`. | Native iOS/Android and web, with voice and remote agent control. [Mobile][paseo] | Native iOS/Android, PWA and Telegram; mobile approvals, dictation and push options. [Mobile][hapi] |

**When to use which:**

- **casm:** you want a small orchestrator with independent peer servers, explicit
  queues and steering, and CLI/MCP workflows for agents coordinating other agents.
- **Paseo:** you want a broader desktop/mobile workspace with editors, terminals,
  diffs, worktrees and voice alongside orchestration and optional Hub automation.
  See its [workspace overview][paseo] and [Hub][paseo-hub].
- **HAPI:** you want to keep using native agent terminals and control those
  sessions remotely through a central Hub and native mobile apps. See its
  [session workflow][hapi-workflow].

## Quick start

Requires **Node.js 24+**, npm, and an installed/authenticated provider you intend
to use. Install from a checkout on Linux or macOS; the launcher runs that checkout's
TypeScript sources. Build the web assets before starting the server:

```sh
git clone https://github.com/michaloo/casm.git
cd casm
npm ci
npm run build
scripts/install.sh --skip-deps
export PATH="$HOME/.local/bin:$PATH"
casm serve
```

The default address is `127.0.0.1:7373`. In another terminal, create a browser token:

```sh
casm token create web
```

Open **http://localhost:7373** and enter that token in the connection form. The
local CLI discovers the running server automatically. State lives in
`$CASM_HOME` (default `~/.casm-ng`). Treat tokens as credentials.

For a background server, stop the foreground process and run:

```sh
casm service install
casm service status
```

This installs a systemd user service on Linux or a launchd agent on macOS.
`$CASM_HOME/config.json` can set `listen` and `name`; see
[development and deployment](docs/development.md). To reach the web client from
another device, use a reachable listen address and your own trusted VPN or HTTPS
proxy. The default loopback address is only reachable on the server machine.

### Connect another machine

Install and run casm on the other machine with a reachable address. On that
machine, create a token with `casm token create peer`. On this machine, register
its URL and the returned token:

```sh
casm peer add worker ws://worker:7373 '<token-from-worker>'
casm peers --probe
casm -H worker projects
```

`worker` in the URL must resolve to the other machine. Use `wss://` when connecting
through TLS. Peering forwards commands; it does not copy files or sessions.
A CLI-only machine without a local server can instead use
`casm host add worker <ws-url> <token> --default`.

## CLI essentials

Register an existing directory, then start an agent (choose a provider installed
on that host). `--casm-tools` gives that agent casm's MCP orchestration tools:

```sh
casm project create "$PWD" --name demo
casm run --project demo --provider codex --casm-tools "Review this project"
casm agents
```

Use the returned agent ID, an ID prefix or its exact name in place of `<agent>`:

```sh
casm send <agent> "Run the relevant tests"       # queue while busy
casm send <agent> "Focus on the parser" --steer  # steer the active turn
casm pending <agent>
casm history <agent>
casm watch <agent>
casm wait <agent>
casm interrupt <agent>
casm limits
casm usage <agent>
casm schedule add --at "in 2h" --agent <agent> "Check the results"
casm schedules
```

`casm retry <agent> <message-id>` retries a failed or limit-deferred pending
message. `casm cancel <agent> <message-id>` removes one. Permission and question
requests are available through `permissions`, `approve`, `deny`, `questions` and
`answer`, or in the web client. Use `--json` for scripting and `-H worker` to
address a peer. `casm --help` lists all commands and wait exit codes.

See [design](docs/design.md) for architecture and scope, and
[development](docs/development.md) for isolated dev servers, tests and deployment.

[paseo]: https://github.com/getpaseo/paseo/blob/a1da1b8f2/README.md
[paseo-hub]: https://github.com/getpaseo/hub/blob/28f6c78/README.md
[paseo-relay]: https://github.com/getpaseo/paseo-relay/blob/3fc41c9/README.md
[paseo-orchestration]: https://github.com/getpaseo/paseo/blob/a1da1b8f2/public-docs/orchestration.md
[paseo-schedules]: https://github.com/getpaseo/paseo/blob/a1da1b8f2/public-docs/schedules.md
[paseo-usage]: https://github.com/getpaseo/paseo/blob/a1da1b8f2/public-docs/plugins/reference.md#usage-sources
[paseo-license]: https://github.com/getpaseo/paseo/blob/a1da1b8f2/LICENSE
[paseo-hub-license]: https://github.com/getpaseo/hub/blob/28f6c78/LICENSE
[hapi]: https://github.com/tiann/hapi
[hapi-install]: https://hapi.run/docs/guide/installation
[hapi-agents]: https://hapi.run/docs/guide/agents
[hapi-cli]: https://github.com/tiann/hapi/blob/main/cli/README.md
[hapi-hub]: https://github.com/tiann/hapi/blob/main/hub/README.md
[hapi-usage]: https://github.com/tiann/hapi/issues/846
[hapi-license]: https://github.com/tiann/hapi/blob/main/LICENSE
[hapi-workflow]: https://hapi.run/docs/guide/how-it-works
