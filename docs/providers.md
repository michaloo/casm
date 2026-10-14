# Provider feature matrix

What casm supports per agent provider, checked against casm's adapter code and
the provider's own source or protocol at the installed versions:

| Provider | Installed | Source read at | casm adapter |
|---|---|---|---|
| Claude Code | CLI 2.1.292, Agent SDK 0.3.296 | `@anthropic-ai/claude-agent-sdk` 0.3.296 `sdk.d.ts` (the CLI is closed source) | `packages/server/src/providers/claude.ts`, `claude-tasks.ts` |
| Codex | codex-cli 0.160.1 | [openai/codex] `rust-v0.160.1`, `codex-rs/app-server-protocol` | `providers/codex.ts` |
| OpenCode | 1.19.0 | [anomalyco/opencode] `v1.19.0`, `packages/opencode/src` | `providers/opencode.ts`, `opencode-plugin.ts` |
| pi | 1.1.0 | [earendil-works/pi] `v1.1.0`, `packages/coding-agent` | `providers/pi.ts`, `pi-extension.ts` |

✓ casm supports it · **partial** something is missing (explained) · ✗ the provider
lacks it · **gap** the provider supports it, casm doesn't yet. Provider paths
below are relative to the source roots in the table; casm paths to
`packages/server/src/`.

| Feature | Claude | Codex | OpenCode | pi |
|---|---|---|---|---|
| Start, resume, history | ✓ | ✓ | ✓ | ✓ |
| Streaming text | ✓ | ✓ | ✓ | ✓ |
| Thinking | ✓ | ✓ | ✓ | ✓ |
| Interrupt | ✓ | ✓ | ✓ | ✓ |
| Steer into a running turn | ✓ | ✓ | ✓ | ✓ |
| Permissions + modes | ✓ | ✓ | ✓ | ✗ |
| Questions | ✓ | ✓ | ✓ | ✓ (extension dialogs) |
| Subagents (live + transcript) | ✓ | ✓ | ✓ | ✗ |
| User shell commands | ✓ | ✓ | ✓ | ✓ |
| Slash commands and skills | ✓ | ✓ | ✓ | ✓ |
| MCP status / reconnect / toggle | ✓ / ✓ / ✓ | ✓ / all only / **gap** | ✓ / ✓ / ✓ | ✓ / ✓ / **partial** |
| Per-agent MCP + casm tools | ✓ | ✓ | **partial** | ✓ |
| Model catalog | ✓ | ✓ | ✓ | ✓ |
| Effective model | ✓ | ✓ | ✓ | ✓ |
| Account limits | ✓ | ✓ | ✗ | ✗ |
| Context usage | ✓ | ✓ | ✓ | ✓ |
| Local models | **partial** | **gap** | ✓ | ✓ |
| Images in / out | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ |
| Plan mode | **partial** | ✓ | ✓ (plan agent) | ✗ |

OpenCode was also verified end to end on an isolated dev server with
OpenCode's free `opencode/big-pickle` model (no API key) and the local
`llama.cpp/qwen3.6-35b` through the llama.cpp router: streaming and thinking,
bash, steering, interrupt, a permission approval, a question, the plan agent,
the effective model, casm tools and a subagent's env. See [OpenCode
authentication](#opencode-authentication) for the model options.

## Per feature

### Start, resume, history

- Claude: `Options.sessionId` / `Options.resume` (`sdk.d.ts`); history parsed from
  Claude's JSONL across branches and compaction (`claude.ts` `chain`,
  `historyItems`).
- Codex: `thread/start`, `thread/resume`, history from `thread/items/list` and
  failed turns from `thread/turns/list` (`common.rs`; `codex.ts` `readHistory`).
- OpenCode: `POST /session`, prompts to an existing session id, history from
  `GET /session/:id/message` (`server/routes/instance/httpapi/groups/session.ts`;
  `opencode.ts` `normalizeMessages`).
- pi: `pi --mode rpc --session <file>`, id from `get_state.sessionFile`, history
  from the session JSONL's active branch (`docs/rpc-commands.md`; `pi.ts`
  `parseSession`). Forks and the session tree are not exposed.

### Streaming text and thinking

- Claude: `includePartialMessages`, `text_delta`/`thinking_delta`, adaptive
  thinking with summarized display.
- Codex: `item/agentMessage/delta`, `item/reasoning/summaryTextDelta` and
  `textDelta`; casm asks for `model_reasoning_summary: "detailed"`.
- OpenCode: `message.part.delta` for text and reasoning parts on `/global/event`.
- pi: `message_update` `text_delta`/`thinking_delta` (`docs/json.md`); effort is
  `--thinking`.

### Interrupt

- Claude `Query.interrupt()`; Codex `turn/interrupt`; OpenCode
  `POST /session/:id/abort` (an aborted bash call shows as an error: the bash
  tool appends a `<shell_metadata>` note, `tool/shell.ts`); pi `clear_queue` +
  `abort`, or `abort_bash` for a shell command.

### Steer into a running turn

The manager calls the session's `send` while a turn runs (`agents.ts` `send`,
`whenBusy: "steer"`).

- Claude: pushed into the streaming input queue. Steers with images are stored
  by Claude Code as content blocks in a `queued_command` attachment; history
  reads both forms.
- Codex: `turn/steer` with `expectedTurnId`, falling back to `turn/start` if the
  turn just ended (`v2/turn.rs` `TurnSteerParams`).
- OpenCode: a second `prompt_async` while busy stores the user message, and the
  running loop picks it up at its next step (`session/prompt.ts` `prompt` and
  `runLoop`: the loop only exits when the last assistant message answers the
  latest user message; `effect/runner.ts` `ensureRunning` joins the running
  loop). Verified live.
- pi: RPC `steer` with images; `/…` text goes as `prompt` with
  `streamingBehavior: "steer"`.

### Permissions and modes

- Claude: `canUseTool` with "always" from the SDK's suggestions; modes plan,
  default, acceptEdits, auto, bypassPermissions as `permissionMode`. A mode
  change reopens the session after the turn rather than `setPermissionMode`.
- Codex: command, file-change and permissions approvals; modes plan, auto,
  auto-review, full-access map to approval policy, sandbox, reviewer and
  collaboration mode (`codex.ts` `MODES`).
- OpenCode: `permission.asked` → `POST /permission/:id/reply` with
  `once`/`always`/`reject`. Modes are OpenCode's primary agents (`GET /agent`:
  build, plan and your own), sent as `agent` per prompt.
- pi ✗: no permission system (`docs/security.md`). Extension `confirm` dialogs
  are shown as permission cards without "always".

### Questions

- Claude: AskUserQuestion through `canUseTool`, MCP elicitation through
  `onElicitation` (form and URL).
- Codex: `item/tool/requestUserInput` and `mcpServer/elicitation/request` in
  form mode, and in URL mode as a card showing the message and URL (accept or
  decline). In Default mode Codex only offers `request_user_input` behind an
  off-by-default feature, so questions mostly come from Plan mode.
- OpenCode: `question.asked` → `/question/:id/reply` or `/reject`. The question
  tool is enabled for `opencode serve` (client `cli`).
- pi: extension `select`/`input`/`editor` dialogs
  (`docs/rpc-extension-ui.md`); pi itself has no question tool.

### Subagents

- Claude: Agent/Task tool calls and `task_*` system messages feed one card;
  transcript via `getSubagentMessages`.
- Codex: child threads (`thread/started` with `parentThreadId`),
  `collabAgentToolCall`/`subAgentActivity` items; transcript via
  `thread/items/list` of the child thread.
- OpenCode: the `task` tool; child sessions' tool activity updates the card, and
  the transcript is the child session's messages. Background tasks
  (`background: true`, `tool/task.ts`) complete their tool call at once; the
  card stays running until OpenCode injects the `<task … state="completed|error">`
  result into the parent session. Cards carry the subagent's model and duration.
- pi ✗: none in core (only an example extension that spawns separate
  processes).

### User shell commands

Claude runs them itself and records them with `shouldQuery: false` (Claude
Code's bash mode); Codex `thread/shellCommand`; OpenCode
`POST /session/:id/shell`; pi RPC `bash`.

### Slash commands and skills

Claude `supportedCommands` + `reloadSkills`; Codex `/compact`, `/review` and
`skills/list`; OpenCode `GET /command` (commands and skills), run through
`POST /session/:id/command`; pi `get_commands` (extension commands, prompt
templates, skills). pi in RPC mode skips an untrusted project's `.pi/` prompts,
skills and extensions.

### MCP status, reconnect, toggle

See [mcp-controls.md](mcp-controls.md).

- Claude ✓: `mcpServerStatus`, `reconnectMcpServer`, `toggleMcpServer`.
- Codex: status via `mcpServerStatus/list`; reconnect is `config/mcpServer/reload`,
  which only reloads every server (no per-server reload in the protocol).
  **gap** toggle: there is no toggle RPC, but `mcp_servers.<name>.enabled = false`
  as a thread config override on resume would do it.
- OpenCode ✓: `GET /mcp`, `POST /mcp/:name/connect|disconnect` for reconnect and
  toggle (runtime only, shared by sessions in the directory; `mcp/index.ts`).
  The status has no tool counts.
- pi **partial**: pi has built-in MCP but no MCP RPC commands; casm runs its
  `/mcp` command and parses the output. Only servers casm added can be toggled
  (`/casm-mcp`), not those in pi's `mcp.json`.

No provider's MCP sign-in is wired up yet (Codex `mcpServer/oauth/login`, pi
`/mcp login`, OpenCode `/mcp/:name/auth`); casm's protocol has no MCP login
action.

### Per-agent MCP servers and casm tools

`agents.ts` `sessionConfig` adds casm's own MCP server (with an agent token)
to `config.mcpServers` when `casmTools` is set (`mcp.ts` `casmMcpEntry`).

- Claude ✓ `Options.mcpServers`; Codex ✓ `config.mcp_servers` on thread start
  and resume; pi ✓ `registerMcpServer` in casm's extension, for the session only.
- OpenCode **partial**: MCP servers belong to the whole `opencode serve`, which
  casm shares between agents. casm loads a plugin into it
  (`opencode-plugin.ts`, through `OPENCODE_CONFIG_CONTENT`) and writes each
  session's state to a private directory: its `shell.env` hook gives bash and
  user shell commands the agent's env (`config.env` and `CASM_*`, so `casm run`
  from inside links the parent; subagents use their parent's), and casm's MCP
  tools become `casm_*` plugin tools calling casm with the agent's token. A
  session permission rule (`casm_*` allow or deny) shows them only to agents
  with `casmTools`. Other `config.mcpServers` entries are not applied; use
  OpenCode's own config.

### Model catalog and effective model

- Catalogs: Claude `supportedModels`; Codex `model/list`; OpenCode
  `GET /config/providers` (variants are efforts) and `GET /agent` for modes; pi
  `get_available_models`.
- Effective model (`ProviderEvent` `model`): Claude from `system/init`; Codex
  from the thread response, `model/rerouted` and `thread/settings/updated`;
  OpenCode from each assistant message's `providerID/modelID`; pi from
  `get_state` and each assistant message.

### Account limits

- Claude ✓: `rate_limit_event` and the experimental usage query.
- Codex ✓: `account/rateLimits/read` and `account/rateLimits/updated`.
- OpenCode ✗ and pi ✗: no quota API (OpenCode's HTTP API has no usage or limits
  route; pi's RPC none). casm still recognizes limit errors in turn failures
  (`limits.ts`).

### Context usage

Claude from per-call usage and `modelUsage.contextWindow`; Codex
`thread/tokenUsage/updated`; OpenCode from assistant message tokens and the
model's `limit.context`; pi `get_session_stats`.

### Local models

- OpenCode ✓ and pi ✓: models from their own config (OpenCode providers such as
  `llama.cpp`, pi `models.json`) are in the catalog.
- Claude **partial**: `config.env` with `ANTHROPIC_BASE_URL` (and a token/model)
  points a session at an Anthropic-compatible endpoint, e.g. the llama.cpp
  router, but the catalog, limits and context-window lookups use the host env,
  and the CLI and web client can't set `config.env` yet (only the
  `agent.create`/`agent.update` RPCs).
- Codex **gap**: `thread/start` takes `modelProvider` and
  `config["model_providers.<id>"]` (`v2/thread.rs`); casm sends neither, so
  local models only work through `~/.codex/config.toml` (for every agent) or a
  per-agent `CODEX_HOME` in `config.env`, and the catalog never lists them.

### Images

- In: Claude image blocks, Codex `image` inputs, OpenCode `file` parts with data
  URLs, pi `images` on `prompt`/`steer`; also in history (up to ~1 MB each).
- Out: tool-result images for all four (`tool-images.ts`), including Codex
  `imageView` and `imageGeneration` items and OpenCode tool attachments.

### Plan mode

- Claude **partial**: `plan` permission mode and its plan/todo tools work, but
  ExitPlanMode reaches casm as a generic permission card (no choice of the next
  mode), and casm doesn't follow `permissionMode` from `system/init`/`status`,
  so after a plan is approved the agent's mode still says plan.
- Codex ✓: `collaborationMode: plan` per turn, plan items and `turn/plan/updated`.
- OpenCode ✓: the `plan` agent as the agent's mode; todo lists become plan items.
- pi ✗: only an example extension.

## OpenCode authentication

casm uses the host's OpenCode install and credentials (`~/.local/share/opencode`).

- **Free models, no key**: OpenCode Zen's free models (`opencode/big-pickle`
  and others marked `-free` in `opencode models`) work without signing in. Zen
  only accepts requests whose message ids look like OpenCode's own, so casm
  creates user message ids in OpenCode's format (`opencode.ts` `messageId`;
  `id/id.ts`).
- **Local models**: any provider in `~/.config/opencode/opencode.jsonc`, e.g. the
  llama.cpp router at `http://127.0.0.1:8080` (wakes buildbox on demand).
- **ChatGPT Plus/Pro (Codex subscription)**: OpenCode's OpenAI plugin supports it
  (`plugin/openai/codex.ts`), but needs an interactive login; it does not reuse
  `~/.codex/auth.json`. To sign in on a headless box:

  ```sh
  opencode auth login -p openai -m "ChatGPT Pro/Plus (headless)"
  ```

  It prints a URL and a code to enter in a browser. The `openai/*` models then
  appear in casm's OpenCode catalog once it is refreshed (the web model
  picker's refresh, or `provider.catalog` with `refresh: true`).

## Newer upstream

- Claude Agent SDK 0.3.300: no new `Query` methods; 0.3.299 fixes merged queued
  messages with content blocks (image steers) running together.
- Codex HEAD: `subAgentActivity` items carry `model` and `reasoningEffort`;
  `turn/start` gains `parentTurnId`/`rootTurnId`; MCP OAuth login gains a
  `loginId`. If `omit_app_server_notification_media` is ever on by default, tool
  and generated images leave `item/*` notifications and casm would read them
  with `thread/items/read`.
- pi 1.2: `--model` prefers the provider with credentials for bare ids; RPC
  unchanged.

[openai/codex]: https://github.com/openai/codex
[anomalyco/opencode]: https://github.com/anomalyco/opencode
[earendil-works/pi]: https://github.com/earendil-works/pi
