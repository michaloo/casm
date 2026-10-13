# casm NG (working name)

A small, self-hosted server for coding agents (Claude Code now; Codex, pi and OpenCode next), with
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

node packages/cli/src/main.ts host add ubuntu ws://ubuntu:7373 <token>
node packages/cli/src/main.ts project create Explorations --path ~/Explorations
node packages/cli/src/main.ts run --project Explorations --wait "What is in this directory?"
node packages/cli/src/main.ts agents
```

State lives in `$CASM_HOME` (default `~/.casm-ng`): `casm.db` on the server, `hosts.json` for the CLI.

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
