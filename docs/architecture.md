# Architecture

casm runs one server per machine. Each server owns that machine's projects and
agents and drives Claude Code, Codex, OpenCode and pi through their native
protocols. Servers connect to each other as peers. The web client and the CLI
are clients of a server. Commands are in the [README](../README.md) and the
[CLI reference](cli.md); the vocabulary is in [Concepts](concepts.md).

```text
Web client / casm CLI / other RPC clients
                  │ authenticated WebSocket, JSON-RPC
              casm serve ── peer casm servers
                  │
       Claude SDK / Codex app-server / pi RPC / OpenCode HTTP + SSE
```

## What casm does not do

- It does not sandbox or containerize agents. Permission modes are the
  providers' own settings, not a casm isolation boundary
  ([permission modes](permission-modes.md)).
- It does not import sessions from other tools, or synchronize sessions or
  files between machines.
- It does not create Git worktrees or manage branches.
- It does not manage networking or TLS. How servers, peers and phones reach
  each other is a deployment choice ([network](network.md)).

## Servers, clients and peers

The server runs on Node 24+: from a source checkout it runs the TypeScript
directly, and the npm package ships compiled JavaScript. Linux uses a systemd
user service; macOS uses launchd.

Client bearer tokens authenticate RPC connections. The local CLI finds its
server through `$CASM_HOME/local.json`. Servers hold peer credentials; a
request's `host` selects one peer for one-hop forwarding. CLI `-H`, host
navigation in the web client, and agents orchestrating agents all use the same
peers. A machine that only runs clients can instead list direct connections in
`hosts.json`.

## Domain and persistence

- **Project:** a named existing directory on one host, with optional group,
  tags and ordering. An agent may use a directory or worktree within its
  project.
- **Agent:** a saved provider configuration, working directory and native
  session ID. Reload opens a new provider process for the same session; restart
  starts a new native session on the next turn. Parent links identify
  orchestrated children, including children on peers. Provider-internal
  subagents keep their history separate from their parent's transcript.
- **Message:** a send queues behind an active turn; an explicit steer enters
  that turn. Pending messages survive server restarts. Client message IDs make
  retries safe. Sender metadata records which agent sent a message
  ([message provenance](message-provenance.md)); it is a declaration by a
  trusted client, not an authorization boundary.
- **Schedule:** a project's persisted cron, interval or one-time job that
  messages one of its agents or creates one from a preset. Jobs for an existing
  agent queue or skip when it is busy. The schedule keeps its next run and last
  result; the conversation stays in the agent's native store.

SQLite in `$CASM_HOME` stores projects, agent configuration and session
references, pending messages, message sender metadata, schedules, tokens and
peers. Conversation history stays in each provider's own store (Claude's JSONL
files, Codex's rollouts, OpenCode's database, pi's session files). casm reads
and normalizes it on demand and buffers live events for subscribers; it keeps
no transcript archive of its own. That is also why a session started through
casm can be resumed in the provider's own tool.

Running turns and outstanding permission or question requests live in the
provider processes, so a server restart does not preserve an active turn.
Failed prompts that got no answer are kept for explicit recovery; queued work
resumes through the pending queue. When a provider limit is hit, work is
deferred with backoff; a healthy usage refresh or an explicit Send now retries
it.

### Files

Files inside project folders are readable, never writable, through casm:
`fs.read` (text previews up to 1 MiB) and `fs.downloadLink`. Paths must stay
inside a registered project folder after symlinks and `..` are resolved.
Downloads use `GET /dl/<token>`: an HMAC-signed link for one file, valid for
about five minutes and signed with `$CASM_HOME/download-secret`, so no client
token appears in a URL. A link to a peer's file wraps the peer's own link, and
the file streams through the server the client is connected to. The server's
state directory is never served, even when it sits inside a project folder.

A project's AGENTS.md is editable, with a content-hash conflict check.
Provider memories are read-only views of the providers' own stores.

## Protocol and providers

[`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts) is the
source of truth for methods, events and normalized transcript items.
[`spec/protocol.json`](../spec/protocol.json) exports it as JSON Schema for
clients in any language ([protocol](protocol.md)). `/health` reports the
server and protocol versions. The CLI offers JSON output and meaningful
exit codes for waits and failures.

Each provider adapter owns the native session lifecycle, history
normalization, streaming, permission and question translation, and model and
usage queries. Features differ by provider, and anything a provider does not
report is shown as unavailable rather than guessed
([provider feature matrix](providers.md)). The server's own `NODE_ENV` is
removed from the environment agents inherit, so it cannot change their builds
or dependency installs.

## Agents running agents

Agents orchestrate other agents with the same CLI you use, from their own
shell. Every session gets `CASM_*` environment variables naming its server and
agent, so the agents it starts link to it as their parent and its messages
carry it as the sender. casm gives agents no MCP server of its own; per-agent
`config.mcpServers` reach each provider in its own format (pi through a casm
extension, for that session only). An agent started on a peer runs and keeps
its state on that peer: forwarding coordinates work, it does not move it. When
a peer disconnects, its subscriptions end and clients reconnect and reload.

## Web client

The web client is served at `/` by every server and can be installed as a PWA
([web client](web-client.md), [PWA](pwa.md)). Navigation follows hosts, then
projects, then agents, and routes are shareable. Transcripts are virtualized;
model, mode and effort controls, pending requests, Queue, Steer and Interrupt
sit in the composer. Drafts and small image attachments are kept in the
browser; history and live state always come from the server.
