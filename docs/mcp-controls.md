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

`/mcp` opens status, reconnect and enable/disable controls (Claude; pi for the
servers casm adds). `McpServer.canToggle: false` marks a server that can't be
toggled although the provider supports toggling.
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
- pi 1.1.0 has built-in MCP (stdio and streamable HTTP) but no MCP commands in
  its RPC protocol ([rpc-commands.md](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc-commands.md)).
  casm uses the documented command path instead: it sends pi's built-in `/mcp`
  as an RPC `prompt`, which runs the extension command without a model turn and
  reports through `notify`. `/mcp` prints one status line per server (state,
  tool count when connected, exposure, an indented error); `/mcp reconnect
  <server>` reconnects one server. casm reads those notifications as the
  command's output (until its response), so they don't become transcript
  notices; commands run one at a time. Reconnect all reconnects each enabled
  server in turn. casm only sends `/mcp` when `get_commands` lists the built-in
  one (`builtin:mcp`): with `--no-mcp` or an extension that replaces `/mcp`,
  status explains the limitation and reconnect reloads the session.
  [pi MCP documentation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/mcp.md).
- pi's per-agent MCP servers (casm's own with `casmTools`, and
  `config.mcpServers` in pi's `mcp.json` entry format) are registered by casm's
  extension `packages/server/src/providers/pi-extension.ts`, loaded with `pi -e`,
  through `pi.registerMcpServer`: they apply to that session only and are never
  written to pi's `mcp.json`. The casm server uses `direct` exposure, so its
  tools are declared to the model as `mcp__casm__<tool>`. The JSON reaches the
  extension in `CASM_PI_MCP_SERVERS`, which it removes from pi's environment so
  the agent's shell commands don't inherit the token. A server in `mcp.json`
  with the same name takes precedence, as in pi itself.
- Enable/disable on pi applies to those casm-added servers (`/casm-mcp
  enable|disable <server>`, session only). pi's own `/mcp` toggles save to
  `mcp.json` and exist only in its TUI, so other servers carry `canToggle:
  false` and toggling them is refused with an explanation.

The full MCP connection configuration and credentials are never included in
these status responses. OAuth authentication itself remains provider-managed.
