# MCP controls and composer commands

`casm mcp <agent>` lists live MCP status. `casm mcp <agent> --reconnect`
reconnects all servers; append a server name to target one where supported.
`--json` returns the protocol result, including the reconnect mode and message.
Peer routing uses the usual `-H` argument.

The web composer offers `/mcp`, `/reload`, `/restart`, and `/interrupt` as casm
actions before the provider's commands and skills. Type `/` at the start of the
message to filter; arrows select, Enter runs a casm action or inserts a provider
command, Tab completes, and Escape closes the palette. Touch selection works
likewise. Provider commands are inserted as text and use the ordinary send path,
including commands whose names also exist as casm actions. Descriptions and
argument hints come from `agent.commands`.

`/mcp` opens status, reconnect and (Claude only) enable/disable controls.
`agent.mcpStatus` returns servers, supported reconnect scope and toggle capability.
`agent.mcpReconnect` returns `mode: native | reload` and an explanation.
`agent.mcpToggle` takes a server name and enabled flag. Status opens a provider
session if needed, without sending a model prompt. Archived agents are rejected.
A fallback reconnect uses `agent.reload` and reopens the same native session;
like explicit reload, it interrupts a running turn. Ordinary native connection
errors are returned, not silently converted into session reloads.

Provider behavior, verified against installed APIs:

- Claude uses SDK `Query.mcpServerStatus`, `reconnectMcpServer`, and
  `toggleMcpServer`. Reconnect all skips disabled servers. Tool counts come from
  the live SDK inventory. See `@anthropic-ai/claude-agent-sdk/sdk.d.ts`.
- Codex uses paginated, thread-scoped `mcpServerStatus/list` and
  `config/mcpServer/reload`. Reload applies to all servers, with refreshed
  configuration applied on the next active turn. There is no per-server reload;
  the result explains this even when a CLI caller names one server. Method-not-found
  from older versions falls back to session reload. Runtime connection states,
  discovery errors and authentication requirements are preserved.
  [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).
- Pi's installed RPC protocol has no MCP controls. Status explains the limitation;
  reconnect reloads the session so extensions can re-read configuration.

The full MCP connection configuration and credentials are never included in
these status responses. OAuth authentication itself remains provider-managed.
