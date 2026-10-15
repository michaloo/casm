# casm

casm is a small, self-hosted agent orchestrator for **Claude Code, Codex, pi and
OpenCode**. Run a server on each machine and connect them as peers. Drive your
agents from the web client (installable as a PWA), a scriptable CLI, or let
agents spawn, message and steer other agents through opt-in MCP tools, locally
or across machines. Persistent queues, schedules and provider-limit handling
keep unattended work going.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/web-agent-dark.png">
  <img alt="The casm web client: hosts, projects and agents in the sidebar, an agent's transcript and the composer" src="docs/media/web-agent-light.png">
</picture>

Which agent for what:

- **Claude Code** and **Codex** run on your frontier-model subscriptions; casm
  shows their account limits and defers work when one runs out.
- **OpenCode** is a full coding agent with decent built-in behaviors
  (permissions, questions, subagents) and broad model-provider integrations,
  including local models.
- **pi** is a bare, minimal coding agent, great for steering, for advanced users
  who know what they're doing: it has no built-in permission system, so its
  tools run without asking.

[Providers](docs/providers.md) has the verified feature matrix per provider.

casm does not provide sandboxing or containers, import sessions, or synchronize
sessions and files between machines. Agents work with their host's tools and
provider permissions. Full-text session search is the separate tool
[cass](https://github.com/michaloo/cass). Native macOS/iOS clients live on the
[`apple` branch](https://github.com/michaloo/casm/tree/apple); the former CLI/TUI
is preserved on `legacy`.

**Documentation:** [getting started](docs/getting-started.md) ·
[concepts](docs/concepts.md) · [CLI reference](docs/cli.md) ·
[web client](docs/web-client.md) · [MCP tools](docs/mcp-tools.md) ·
[protocol](docs/protocol.md) · [troubleshooting](docs/troubleshooting.md) ·
[all docs](docs/README.md)

## Quick start

Requires **Node.js 24+**, npm, and an installed, logged-in provider. Install
from a checkout on Linux or macOS; the launcher runs that checkout's TypeScript
sources:

```sh
git clone https://github.com/michaloo/casm.git
cd casm
npm ci                     # with NODE_ENV unset (or NODE_ENV=development)
npm run build
scripts/install.sh --skip-deps
export PATH="$HOME/.local/bin:$PATH"
casm serve
```

The server listens on `127.0.0.1:7373` and keeps its state in `$CASM_HOME`
(default `~/.casm-ng`). In another terminal, register a folder and start an
agent; the CLI finds the local server by itself:

```sh
casm project create ~/code/acme-api --name acme-api
casm run --project acme-api --provider claude --name reviewer "Summarize src/orders.js"
casm wait reviewer
```

![casm project create, run, agents, wait and history](docs/media/cli-quickstart.svg)

For the web client, create a token with `casm token create web`, open
**http://localhost:7373** and paste it. Treat tokens as passwords.

## Run it as a service

Stop the foreground server, then:

```sh
casm service install    # systemd user unit on Linux, launchd agent on macOS
casm service status
```

`$CASM_HOME/config.json` sets `listen` and `name`. To use casm from another
device, bind a reachable address on your own trusted network (a VPN such as
Tailscale) or put it behind an HTTPS proxy; the default loopback address only
accepts the server machine. See [getting started](docs/getting-started.md#run-it-as-a-service).

## Connect another machine

Install and run casm on the other machine with a reachable address, and create a
token there with `casm token create studio`. Back here, register it as a peer:

```sh
casm peer add worker ws://worker:7373 '<token-from-worker>'
casm peers --probe
casm -H worker projects
```

Now `-H worker` runs any command there, the web client shows it as a second
host, and agents with casm tools can start agents on it. Peering forwards
commands; it never copies files or sessions. A CLI-only machine can instead use
`casm host add worker <ws-url> <token> --default`.

![peers, -H and a permission request](docs/media/cli-peers.svg)

## Install as an app

Open your casm server's web address and install it using your browser:

- **iPhone:** in Safari, tap **Share → Add to Home Screen**. Keep **Open as Web App** enabled if shown, then tap **Add**.
- **macOS:** in Safari (macOS Sonoma or later), choose **File → Add to Dock**.
- **Chrome / Edge:** on **HTTPS**, use the install button in the address bar (or the browser's install-app menu).

Safari's Home Screen and Dock apps also work with a plain HTTP server address.
Chrome/Edge's manifest-based install prompt needs HTTPS; localhost is the local-development exception.
Use the server address you normally connect to, including its port. The installed
app uses the casm Apple icon and opens without browser navigation controls.

On HTTPS or localhost, casm caches its public app shell for offline startup.
Recently opened chats and the sidebar are kept in IndexedDB on every address,
plain HTTP included, and stay readable offline (see
[Offline and connection](docs/web-client.md#offline-and-connection)); sending
still needs the server. The service worker never caches API
responses, WebSockets, signed downloads, or URLs with query parameters. A new
shell is checked on launch after deployment and activates after all old casm
tabs/app windows close; it does not reload an active chat. Plain remote HTTP works without a
service worker. Vite development also leaves service workers unregistered.

Apple's [iPhone installation instructions](https://support.apple.com/guide/iphone/iphea86e5236/ios)
and [Mac web app instructions](https://support.apple.com/104996) describe the OS controls.
See [PWA implementation decisions](docs/pwa.md) for cache boundaries and checks.

See the [web client guide](docs/web-client.md) for the sidebar, chat, queue,
schedules, settings and file previews.

## CLI essentials

Use an agent's ID, an ID prefix or its exact name in place of `<agent>`:

```sh
casm send <agent> "Run the relevant tests"       # queued while it's busy
casm send <agent> "Focus on the parser" --steer  # into the running turn
casm pending                                     # queued, deferred and failed messages
casm history <agent>    casm watch <agent>    casm wait <agent>    casm interrupt <agent>
casm limits             casm usage <agent>
casm schedule add --at "in 2h" --agent <agent> "Check the results"
casm run --project acme-api --casm-tools "…"     # an agent that can run agents
```

Use `--json` for scripting and `-H <peer>` for another host; `casm --help`
lists everything. The [CLI reference](docs/cli.md) has real examples of every
command.

![queue, steer and cancel](docs/media/cli-queue-steer.svg)

### Message delivery

Queued messages run in strict FIFO order, one per turn. Interrupt stops the
current turn, keeps the queue, and continues with the next message. A failed
message holds the queue until **Retry now** or **Cancel**; a usage-limit message
waits for its reset time, and the limit also holds that provider's other agents,
across restarts. **Steer** and **Send now** are the explicit ways to go ahead of
the queue. Clients can pass a message ID so a resend after a lost response is
reconciled, not delivered twice. Details: [concepts](docs/concepts.md#messages-and-the-queue).

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
| Providers | Claude Code and Codex (frontier subscriptions), OpenCode (full agent, broad provider integrations), pi (minimal, steerable). | Those four plus Copilot, Antigravity and Muse Code; extensible through plugins. [Providers][paseo] | Those four plus Cursor Agent, Grok Build, Kimi, Copilot, Antigravity and DeepSeek Harness. [Supported agents][hapi-agents] |
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
