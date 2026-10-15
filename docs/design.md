# casm design

casm is a self-hosted coding-agent orchestrator: one server per machine,
projects and agents on that server, peers across machines, a scriptable CLI,
and a primary web client. The current product scope and commands are in the
[README](../README.md).

## Scope

casm runs and coordinates Claude Code, Codex, pi and OpenCode through their
native protocols. It manages messages, steering, queues, subagents, permission
and question requests, schedules, and provider limits.

The providers fill different roles. Claude Code and Codex are the frontier
subscriptions, with account limits casm tracks. OpenCode is a full coding agent
with decent built-in behaviors (permissions, questions, child sessions) and
broad model-provider integrations, including local models. pi is a bare,
minimal coding agent for advanced users: great for steering, extensible, and
without a built-in permission system; casm adds none, so pi's tools run without
asking.

It does not sandbox or containerize agents, import sessions (including Paseo
sessions), or synchronize sessions/files between machines. Provider permission
modes remain provider settings, not a casm isolation boundary. Full-text session
search belongs to [cass](https://github.com/michaloo/cass). The old CLI/TUI lives
on `legacy`; reproducing its features is not a casm roadmap.

The React web client in `packages/web` is primary, served at `/` by the server
and installable as a PWA. Native macOS/iOS apps and their Swift package live on
the separate `apple` branch. Native distribution, speech engines, and Slack
integration are outside this design's current scope.

## Architecture

```text
Web client / casm CLI / other RPC clients
                  │ authenticated WebSocket, JSON-RPC
              casm serve ── peer casm servers
                  │
       Claude SDK / Codex app-server / pi RPC / OpenCode HTTP + SSE
```

The server and CLI run TypeScript directly on Node 24+. Linux uses a systemd
user service; macOS uses launchd. Clients connect to an independently installed
server. Networking and TLS/tunnelling are deployment concerns, not services
managed by casm.

Client bearer tokens authenticate RPC connections. The local CLI discovers its
server through `$CASM_HOME/local.json`. Servers hold peer credentials; a client
request's `host` selects one peer for one-hop forwarding. CLI `-H`, web host
navigation, and agent orchestration use those same peers. Client-only machines
can instead configure direct connections through `hosts.json`.

## Domain and persistence

- **Project:** a named existing directory on one host, with optional group,
  tags and ordering. Projects organize work; casm does not create Git worktrees
  or manage branches. An agent may use a directory/worktree within its project.
- **Agent:** saved provider/configuration, working directory and native session
  ID. Reload opens a new provider process for the same session; restart starts
  a new native session on the next turn. Parent links identify orchestrated
  children, including children on peers. Provider-internal subagents have
  separate history from their parent's transcript.
- **Message:** send normally queues behind an active turn; explicit steering
  enters that turn. Pending messages survive server restarts. Client message
  IDs support retry reconciliation. Sender metadata records agent provenance;
  trusted-client declarations are not a separate authorization boundary.
- **Schedule:** a persisted cron, interval or one-time job targeting an existing
  agent or creating one from a preset. Existing-agent jobs queue or skip when
  busy. The schedule keeps its next run and last result; the conversation stays
  in the agent's native store.

SQLite stores projects, agent configuration/session references, pending
messages, message identity/sender metadata, schedules, tokens and peers.
Provider stores remain the source of conversation history. casm normalizes
history on demand and buffers live events for subscribers; it does not maintain
an independent durable transcript archive.

Execution state and outstanding permission/question callbacks belong to live
provider processes. A server restart does not preserve an active turn. Failed
unanswered prompts are retained for explicit recovery; queued work resumes
through the pending-message machinery. Provider limits defer work with backoff;
a healthy account refresh or explicit Send now can attempt recovery.

Files inside project folders are readable, never writable, through casm:
`fs.read` (text previews up to 1 MiB) and `fs.downloadLink`. Paths
must stay inside a registered project folder after symlinks and `..` are
resolved. Downloads use `GET /dl/<token>`: an HMAC-signed link for one file that
expires after about five minutes, signed with `$CASM_HOME/download-secret`, so
no client token appears in a URL. Links to a peer's file wrap the peer's own
link; the file streams through the server the client is connected to. The
server's own state directory is never served, even inside a project folder.

Project AGENTS.md is editable with a content-hash conflict check. Provider
memories are read-only views of their existing stores. casm does not generate
or own those memories.

## Protocol and provider boundaries

[`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts) is the
source of truth for methods, events and normalized transcript items.
[`spec/protocol.json`](../spec/protocol.json) exports JSON Schema for clients
in any language; tests detect schema drift. `/health` exposes server/protocol
versions. The CLI offers JSON output and meaningful wait/failure exit codes.

Each provider adapter owns native session lifecycle, history normalization,
streaming, permission/question translation and catalog/usage queries. Features
vary by provider; unavailable information must remain explicit. The server's
runtime `NODE_ENV` is removed from inherited provider environments so it cannot
change agent builds or dependency installation.

Agent-to-agent orchestration goes through the CLI, run from the agent's shell:
every session gets `CASM_*` env naming its server and agent, so children link
to it as parent and its messages carry it as sender. casm offers agents no MCP
server of its own; per-agent `config.mcpServers` reach each provider in its own
format (pi through a casm extension, for that session only). A peer child
executes and stores its state on its own host; forwarding is coordination, not
migration or synchronization. Peer disconnects invalidate subscriptions and require
clients to reconnect and reload.

## Web client and validation

The web client is chat-first: host/project/agent navigation, virtualized
transcripts, model/mode controls, pending requests, Queue/Steer/Interrupt, and
provider usage. Shareable routes restore selection. Draft text and bounded
image attachments persist locally; history and live state reload from the
server. Small screens must retain readable transcript content, accessible
navigation and a usable composer without page-level horizontal overflow.

Validation combines protocol/type checks, fake-provider server tests and
Playwright browser tests with realistic transcript fixtures. See
[development.md](development.md) for isolated state/ports and deployment.
Development tests must not restart the stable orchestrator or operate on its
agents. Native app builds and their platform-specific decisions remain on
`apple`.
