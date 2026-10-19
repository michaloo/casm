# Provider feature matrix

What casm supports per agent provider, checked against casm's adapter code and
the provider's own source or protocol at the installed versions:

| Provider | Installed | Source read at | casm adapter |
|---|---|---|---|
| Claude Code | CLI 2.1.292, Agent SDK 0.3.296 | `@anthropic-ai/claude-agent-sdk` 0.3.296 `sdk.d.ts` (the CLI is closed source) | `packages/server/src/providers/claude.ts`, `claude-tasks.ts` |
| Codex | codex-cli 0.160.1 | Installed `app-server generate-ts`; local [openai/codex] source `9d3ae38` for implementation details | `providers/codex.ts`, `codex-reviews.ts` |
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
| Questions | ✓ | ✓ (blocking and nonblocking) | ✓ | ✓ (extension dialogs) |
| Subagents (live + transcript) | ✓ | ✓ | ✓ | ✗ |
| User shell commands | ✓ | ✓ | ✓ | ✓ |
| Slash commands and skills | ✓ | ✓ | ✓ | ✓ |
| MCP status / reconnect / toggle | ✓ / ✓ / ✓ | ✓ / all only / **gap** | ✓ / ✓ / ✓ | ✓ / ✓ / **partial** |
| Per-agent MCP servers | ✓ | ✓ | **partial** | ✓ |
| Model catalog | ✓ | ✓ | ✓ | ✓ |
| Effective model | ✓ | ✓ | ✓ | ✓ |
| Account limits | ✓ | ✓ | ✗ | ✗ |
| Context usage | ✓ | ✓ | ✓ | ✓ |
| Cost per day (estimated) | ✗ | ✗ | ✓ | ✓ |
| Local models | **partial** | **gap** | ✓ | ✓ |
| Images in / out | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ |
| Plan mode | **partial** | ✓ (including plan text deltas) | ✓ (plan agent) | ✗ |
| Background jobs wake the agent | ✓ | **partial** | ✓ | ✓ (extensions) |

The [2026-10-19 Codex/Claude audit](adapter-audit-20261019.md) distinguishes
implemented paths, missing notifications, and test coverage. A supported feature
here does not imply every upstream event or field is consumed.

OpenCode was also verified end to end on an isolated dev server with
OpenCode's free `opencode/big-pickle` model (no API key) and the local
`llama.cpp/qwen3.6-35b` through the llama.cpp router: streaming and thinking,
bash, steering, interrupt, a permission approval, a question, the plan agent,
the effective model and a subagent's env. See [OpenCode
authentication](#opencode-authentication) for the model options.

## Per feature

### Start, resume, history

- Claude: `Options.sessionId` / `Options.resume` (`sdk.d.ts`); history parsed from
  Claude's JSONL across branches and compaction (`claude.ts` `chain`,
  `historyItems`).
- Codex: `thread/start`, `thread/resume`, history from `thread/items/list` (or
  `thread/read` with turns when pagination returns MethodNotFound) and
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
  turn just ended with the explicit no-active-turn error (`v2/turn.rs`
  `TurnSteerParams`). Other rejections retain the message for Retry now without
  interrupting healthy work or submitting a second turn.
- OpenCode: a second `prompt_async` while busy stores the user message, and the
  running loop picks it up at its next step (`session/prompt.ts` `prompt` and
  `runLoop`: the loop only exits when the last assistant message answers the
  latest user message; `effect/runner.ts` `ensureRunning` joins the running
  loop). Verified live.
- pi: RPC `steer` with images; `/…` text goes as `prompt` with
  `streamingBehavior: "steer"`.

### Permissions and modes

See [permission modes, presets and defaults](permission-modes.md) for the
four-provider comparison, required resume semantics and deferred Codex reset gap.

- Claude: `canUseTool` with "always" from the SDK's suggestions; modes plan,
  default, acceptEdits, auto, bypassPermissions as `permissionMode`. A mode
  change reopens the session after the turn rather than `setPermissionMode`;
  a mode Claude switches to itself (`system/status` `permissionMode`) becomes
  the agent's mode (`ProviderEvent` `mode`).
- Codex: command, file-change and permissions approvals; modes plan, auto,
  auto-review, full-access map to approval policy, sandbox, reviewer and
  collaboration mode (`codex.ts` `MODES`).
  Automatic reviews now upsert a separate review row by review ID, including
  the canonical action, target item ID, outcome and rationale. Multiple reviews
  can target one tool; network reviews have no target. Approval never completes
  the execution tool. CASM retains these otherwise transient events as small
  history supplements; old reviews cannot be reconstructed. Uncorrelated
  `guardianWarning` messages remain warnings, without guessed command links.
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
  decline). Nonblocking `agentMessage.questions` have separate editors while
  the agent keeps working, with options and free text. Answers use native
  `turn/steer` with the originating turn ID and wait for acceptance; rejection
  keeps the editor. Editors expire at turn end. Question text and answer outcomes
  remain in history, including question-only assistant messages.
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

### Per-agent MCP servers

`config.mcpServers` reaches each session in the provider's own format. casm
adds no MCP server of its own: agents run the `casm` CLI, and `agents.ts`
`sessionConfig` puts `CASM_*` into every session's env so it links and
attributes to the agent.

- Claude ✓ `Options.mcpServers`; Codex ✓ `config.mcp_servers` on thread start
  and resume; pi ✓ `registerMcpServer` in casm's extension, for the session only.
- OpenCode **partial**: MCP servers belong to the whole `opencode serve`, which
  casm shares between agents. casm loads a plugin into it
  (`opencode-plugin.ts`, through `OPENCODE_CONFIG_CONTENT`) and writes each
  session's state to a private directory: its `shell.env` hook gives bash and
  user shell commands the agent's env (`config.env` and `CASM_*`, so `casm run`
  from inside links the parent; subagents use their parent's).
  `config.mcpServers` is not applied; use OpenCode's own config.

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

### Cost per day

`provider.costs` (the Usage tab's cost cards, `casm costs`) sums what the agent
itself recorded for each model call, per local day of the host, over the host's
casm agents. Only the agents' own data is read: no provider APIs, no keys. The
amount is the agent's estimate, its catalog price × tokens, not a bill: it can
differ from the invoice (routing, BYOK fees, price changes), subscription
logins report list prices nobody pays, and free, local or unpriced models count
as 0.

- OpenCode ✓: each assistant message's `cost`, timed by `time.completed`, in the
  agent's session and its subagents' child sessions (`/session/:id/children`).
  Read through `opencode serve`; a session is read again only when its tree's
  `time.updated` changes, and those are checked only after OpenCode's database
  (`opencode.db`, `-wal`) changed, so a repeat call starts no server.
- pi ✓: `usage.cost.total` of every assistant and tool-result message and of
  usage, compaction and branch-summary entries in the session file (what
  `get_session_stats` totals), timed by the message's timestamp. Re-read when the
  file's size or mtime changes.
- Claude ✗: its transcript records tokens but no per-call cost (only a
  cumulative `cost-state` line, with no per-call times).
- Codex ✗: reports no cost.

Computed on demand, not recorded as turns run: the agents' stores already hold
every call with its time and cost, so this covers turns from before casm
watched and turns run outside it, needs no second copy or backfill, and can't
count a resumed session twice. Agents deleted from casm drop out.

### Local models

- OpenCode ✓ and pi ✓: models from their own config (OpenCode providers such as
  `llama.cpp`, pi `models.json`) are in the catalog.
- Claude **partial**: `config.env` with `ANTHROPIC_BASE_URL` (and a token/model)
  points a session at an Anthropic-compatible endpoint, e.g. the llama.cpp
  router: `casm run --env ANTHROPIC_BASE_URL=http://127.0.0.1:8080 --model <id>`
  (also `casm run --env` from inside an agent). The catalog and limits still use
  the host env; context-window lookups are scoped
  by provider context. The web client has no env field.
- Codex **gap**: `thread/start` takes `modelProvider` and
  `config["model_providers.<id>"]` (`v2/thread.rs`); casm sends neither, so
  local models only work through `~/.codex/config.toml` (for every agent) or a
  per-agent `CODEX_HOME` in `config.env`, and the catalog never lists them.
  History, usage, resume, commands and child readers now receive per-agent
  store context; Claude supports `CLAUDE_CONFIG_DIR` through the same contract.
  New `/restart` records retain only the effective provider home. Legacy records
  and home changes made before restart cannot reconstruct the original store.
  Catalogs and account limits remain host-scoped.

### Images

- In: Claude image blocks, Codex `image` inputs, OpenCode `file` parts with data
  URLs, pi `images` on `prompt`/`steer`; also in history (up to ~1 MB each).
- Out: tool-result images for all four (`tool-images.ts`), including Codex
  `imageView` and `imageGeneration` items and OpenCode tool attachments.

### Plan mode

- Claude **partial**: the `plan` permission mode and its plan/todo tools work,
  and casm follows the mode Claude reports in `system/init` and `system/status`
  (approving ExitPlanMode switches Claude to `default`, which becomes the
  agent's mode without a reopen). The approval itself is a generic permission
  card showing the plan input: there is no choice of the next mode (the SDK's
  `setMode` permission update) and no feedback text when rejecting.
- Codex ✓: `collaborationMode: plan` per turn, completed plan items,
  `turn/plan/updated` and `item/plan/delta` work. Late deltas cannot replace a
  finalized plan.
- OpenCode ✓: the `plan` agent as the agent's mode; todo lists become plan items.
- pi ✗: only an example extension.

### Background jobs

An agent can start work, end its turn and expect to be woken when the work
finishes. When a provider starts such a turn itself, its adapter emits a
`turnStarted` provider event and the manager runs it as a turn of its own
(`agents.ts` `startOwnTurn`): status `running`, a `wake:` notice saying why,
the reply, then `turnEnded`. Messages sent meanwhile queue behind it. The
adapters tell these turns from casm's own by whether casm dispatched one
(`send`/`shell`) that hasn't ended. Live events were checked against Claude
Code 2.1.292, codex-cli 0.160.1, OpenCode 1.19.0 and pi 1.1.0.

- Claude ✓: background Bash (`run_in_background`), Monitor and background
  subagents (`Agent` with `run_in_background`) report back as harness-made user
  messages (`origin.kind: "task-notification"` in the transcript), and Claude
  Code runs a turn for each. The SDK stream doesn't carry that message. casm
  sets `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, so a turn opens with
  `system/session_state_changed` `running`; after a background subagent the
  session stays running and the next turn opens with `system/init` alone. The
  `task_notification` just before names the task in the notice ("Woken by a
  background task: Background command "…" completed"); a Monitor event has
  none live, so it shows "Woken by a background task" (history shows the
  event's summary from the transcript). A message steered in too late for a
  turn runs as the next native turn and shows without a notice.
- Codex **partial**: a command left running in a background terminal (unified
  exec) never wakes Codex: when it exits, Codex completes its `commandExecution`
  item under the finished turn and starts nothing (`core/src/unified_exec/
  async_watcher.rs`). casm shows the card as running until then, not "Did not
  finish". Subagent completion doesn't trigger a turn either
  (`agent/control/completion.rs`, `trigger_turn: false`); the model has to
  poll or wait. Turns Codex does start itself (an active goal continuing,
  queued input, another agent's message with `trigger_turn`) arrive as
  `turn/started` without a `turn/start` and run as "Codex started a turn on
  its own". casm doesn't inject a message when a background terminal exits:
  Codex's own clients don't either, and the model can't tell that from a user
  prompt.
- OpenCode ✓: background subagents (`task` with `background: true`, behind
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` in the server's
  environment) report back with a synthetic user message
  (`<task … state="completed|error">`) and OpenCode runs the session again
  (`tool/task.ts` `inject`, `session/prompt.ts`). casm sees `session.status`
  busy without a prompt of its own and adopts the turn, named after the task.
  The bash tool has no background option.
- pi ✓ (extensions): pi has no background jobs of its own. An extension can
  start a run while idle (`pi.sendMessage(…, { triggerTurn: true })`,
  `pi.sendUserMessage`, e.g. `examples/extensions/file-trigger.ts`); RPC mode
  emits `agent_start` with no prompt pending, and casm adopts the run as "A pi
  extension started a turn". A displayed custom message shows as a notice and
  an extension's user message as a user item.

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


## Adapter diagnostics and coordination

Codex plan deltas, goals, authentication recovery and hook results are visible;
Claude authentication and hook progress/results are visible too. Diagnostic rows
use stable IDs and history supplements when native transcripts omit them. Hidden
hook context stays hidden. Unfinished hooks show an unknown outcome on provider
closure; Codex synchronous turn-owned hooks also finalize at turn end.

Codex effective effort and recognized explicit mode presets synchronize with
agent state; custom permission profiles remain unmapped. Claude command-change
events invalidate cached commands. Child Codex model/effort metadata is retained.
Requests explicitly scoped to a different Codex thread cannot open the parent's
permission or question dialog.

Conversational agent and scheduled messages carry a sender envelope into the
model's context. CASM displays the original text using stored sender metadata;
human text is unchanged. Native slash commands retain exact syntax and UI sender
metadata. See [the adapter audit](adapter-audit-20261019.md) for remaining scope
and validation limits.
