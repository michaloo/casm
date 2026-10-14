# Agent providers: pi, OpenCode, alternatives and ACP

Reviewed **2026-10-14**. Research only; no provider implementation changes.

## Recommendation

**Keep pi for now; keep OpenCode as the strategic open/local provider; add a small, capability-gated ACP provider pilot.** Do not add another collection of bespoke adapters.

- OpenCode has the strongest combination of an existing casm integration, a discoverable server API, durable sessions, permissions, questions and native child sessions. Its local-model tool calling worked in this review, after a title-generation compatibility problem on the first attempt.
- Pi remains a useful, comparatively compact local harness with explicit steering, detailed JSONL events and extension dialogs. It also passed the same local-model task. Removing its 888-line adapter is a real simplification, but neither OpenCode nor today's pi ACP wrapper is a lossless replacement. Keep it until there is a deliberate decision that its extension/RPC workflow is no longer needed. There is no evidence here of pi becoming inactive or losing local-model support.
- Pilot ACP with **Goose and Qwen Code**, then **Gemini CLI** for Google-account access and **Cline CLI** if users want its workflow. Ship only agents that pass restart/history, cancellation and interaction tests. Keep native Claude/Codex/OpenCode integrations: ACP does not automatically reproduce their richer controls or quota visibility.
- **Crush** is technically credible but would need another bespoke integration today. Defer it. **Amp** is worth an opt-in ACP experiment for existing subscribers, not a local-provider replacement. **Aider** is a poor fit for this orchestration interface. **Mistral Vibe** is a worthwhile later ACP candidate.

This recommendation optimizes for casm's stated role: coordinate agents on their host, preserve native history, manage queues and interactions. It does not propose sandboxing, session imports, file synchronization, another editor, or remote cloud execution.

## Evidence and version boundary

Repository assessment: `709dfd1` on `main`, including `b92bad1` (MCP status/reconnect) and the new web MCP panel. Read [README](../../README.md), [design](../design.md), [provider implementations](../../packages/server/src/providers), [MCP integration](../../packages/server/src/mcp.ts), [agent manager](../../packages/server/src/agents.ts), and [coverage report](../../coverage/REPORT.md). Adapter counts below were measured after rebasing this research branch onto that commit.

Upstream evidence was fetched from official repositories, release APIs and documentation during this review, not inferred from prior comparisons. Release links pin the baseline; links to `main`/`dev` and hosted docs describe the current documented surface and can move. This is a documentation/source review plus two local smoke tests, not certification of every feature in every release. **Unverified** means the reviewed sources do not establish the required integration contract; it does not mean impossible.

| Agent | Release observed | Release date | License | Installation footprint / activity |
|---|---|---|---|---|
| OpenCode | [1.19.0](https://github.com/anomalyco/opencode/releases/tag/v1.19.0) | Oct 11 | MIT | Platform binary (Bun-based application); local server, database and optional MCP/LSP/plugin processes. Repo pushed Oct 14. Installed here: 1.19.0. |
| pi | [1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0) | Oct 12 | MIT | Node >=22.19, npm package or pinned installer; subprocess per session. Repo pushed Oct 14. Installed/tested here: 1.1.0. |
| Goose | [1.54.0](https://github.com/aaif-goose/goose/releases/tag/v1.54.0) | Oct 8 | Apache-2.0 | Rust CLI binary; desktop optional; MCP extensions may add runtimes. Active Oct 14. `block/goose` redirects to `aaif-goose/goose`. |
| Crush | [0.98.1](https://github.com/charmbracelet/crush/releases/tag/v0.98.1) | Oct 9 | [FSL-1.1-MIT](https://github.com/charmbracelet/crush/blob/v0.98.1/LICENSE.md) | Go binary; server/local database plus optional LSP/MCP. Active Oct 14. Source-available now with MIT future license; do not label current versions MIT. |
| Gemini CLI | [0.64.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.64.0) | Oct 13 | Apache-2.0 | Node/npm CLI; no desktop required. Active Oct 14. |
| Qwen Code | [0.25.1](https://github.com/QwenLM/qwen-code/releases/tag/v0.25.1) | Oct 11 | Apache-2.0 | Node/npm CLI; optional HTTP daemon/web surface. Active Oct 14. Latest-releases API also returns SDK releases: do not mistake SDK 0.1.19 for CLI version. |
| Cline CLI | [3.0.71](https://github.com/cline/cline/releases/tag/cli-v3.0.71) | Oct 13 | Apache-2.0 | `npm install -g cline`; standalone CLI, editor extension unnecessary. Active Oct 14. Distinct from extension 4.1.24 and desktop 0.0.46. |
| Aider | [0.86.0](https://github.com/Aider-AI/aider/releases/tag/v0.86.0) | Aug 9, 2025 | Apache-2.0 | Python environment, Git, LiteLLM and parsing dependencies. Last repository push observed May 22, 2026; substantially slower release activity than others. |
| Amp | [npm snapshot](https://registry.npmjs.org/@sourcegraph/amp/latest): `0.0.1791979242-g144271`; [ACP wrapper 0.10.0](https://github.com/tao12345666333/amp-acp/releases/tag/v0.10.0) | Observed Oct 14 | Proprietary service/CLI; wrapper Apache-2.0 | Auto-updating CLI; wrapper adds a binary and Amp dependency. No comparable public core release history; [CLI docs](https://ampcode.com/docs/cli) document automatic updates. |
| Mistral Vibe | [2.26.1](https://github.com/mistralai/mistral-vibe/releases/tag/v2.26.1) | Oct 9 | Apache-2.0 | Python/uv or packaged install, optional MCP processes. Active Oct 9. |
| ACP SDK | [1.8.0](https://registry.npmjs.org/@agentclientprotocol/sdk/1.8.0) | Observed Oct 14 | Apache-2.0 | TypeScript client dependency **plus each selected agent and any adapter**. Not an agent or inference engine. |

Activity is a point-in-time repository/release observation, not a support guarantee. Installation footprint is architectural, not a measured RSS or download-size benchmark. No alternative agents were installed for this research.

## Comparison: control plane and interactions

“Resume” below means continuing persisted conversation after a new process starts, not preserving a running turn through a casm restart. “Native children” means the agent's own delegation; casm can independently spawn other agents through its CLI.

| Tool | Headless/server protocol | Persistence / resume | Stream detail | Permissions and interactive questions | Native children |
|---|---|---|---|---|---|
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) | Custom bidirectional JSONL RPC over stdio; JSON print mode; TS SDK | JSONL tree; file path/UUID selection; RPC session switching; active branch matters | Text/thought deltas, tool start/update/end, retry/compaction and settled events | No general built-in tool approval policy in casm's integration; extension gates and confirm/select/input/editor dialogs are bridged | Core deliberately omits subagents; extensions can implement them |
| [OpenCode](https://opencode.ai/docs/server/) | HTTP/OpenAPI + SSE; native `opencode acp`; JSON CLI | Durable session IDs; message/history/children APIs; continue by ID | Message/part updates and deltas, tool state/output, reasoning, status, usage | Native permission and question request/reply endpoints; casm translates v1 events | Yes, task tools and child sessions |
| [Goose](https://github.com/aaif-goose/goose/blob/main/documentation/docs/gdk/acp/index.md) | Native ACP stdio; `goose serve` ACP over HTTP/WebSocket; headless CLI | Native session store; ACP advertises load/list | ACP text/tool updates; session usage where provided; detailed behavior requires conformance test | Permission modes and ACP approval requests; [MCP elicitation](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/mcp-elicitation.md). Plain headless mode cannot stop for interactive input | Yes, independent subagents |
| [Crush](https://github.com/charmbracelet/crush/blob/v0.98.1/internal/server/endpoints.go) | `crush server`, HTTP JSON + SSE; `crush run`; no native ACP verified | Native persisted sessions, list/history APIs; `run --session ID` | Message/tool/permission events; correlated `RunComplete` | Server permission grant and question answer/cancel routes; prompts scoped to client's selected session | Yes, [agent tool](https://github.com/charmbracelet/crush/blob/v0.98.1/internal/agent/agent_tool.go) creates child task sessions |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md) | Native `gemini --acp`; headless JSON/stream-json | [Saved sessions, resume](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md); ACP load advertised | ACP message/thought/tool stream; headless messages/tools/results | ACP approvals and agent policy; exact structured question behavior over ACP needs verification, not just TUI testing | Yes, [specialist subagents](https://geminicli.com/docs/core/subagents/) |
| [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/) | Native `qwen --acp`; bidirectional stream-json; `qwen serve` HTTP/SSE around ACP | Persisted sessions; ACP load/list/resume advertised | Assistant/tool updates, statuses, headless usage; daemon adds its own runtime events | Approval modes and ACP requests; question transport and cancellation require a live test | Yes; managed child sessions/delegation in current source |
| [Cline CLI](https://github.com/cline/cline/blob/main/docs/usage/acp.mdx) | Native `cline --acp`; structured JSONL CLI; SDK | Persisted sessions; ACP load advertised | JSONL content start/update/end, iteration, usage, done/error; ACP tool updates | ACP approval UI and Plan/Act configuration. Question parity with CLI not verified. ACP defaults approval off; ordinary CLI auto-approval default differs | Yes; [CLI/Desktop children](https://github.com/cline/cline/blob/main/docs/features/subagents.mdx), not editor-extension children |
| [Aider](https://aider.chat/docs/scripting.html) | One-shot command/Python scripting; no supported persistent bidirectional server protocol verified | Chat-history restoration from files; not a native opaque session-ID server contract | Human-oriented streamed output; no comparable stable tool lifecycle event protocol verified | Terminal prompts / automatic answers; external correlated callbacks unverified | Architect/editor model pairing is not a native child-agent session API |
| [Amp](https://ampcode.com/docs/cli/streaming-json) | Execute mode, stream-json input/output; SDK; third-party ACP wrapper | Thread IDs; continue; wrapper persists ACP-to-thread mapping | Messages/tool use/results and usage; incremental events need stream option; wrapper translates to ACP | Permission settings/hooks; wrapper modes supported. Do not assume execute-mode output alone provides a remote approval/question responder | Yes, specialist agents/Task |
| [Vibe](https://github.com/mistralai/mistral-vibe/blob/main/README.md) | Headless text/JSON/streaming; native ACP integration | Session journal, resume by ID | Text/tool events and export usage/cost; ACP mapping needs testing | Native approvals and `ask_user_question`; ACP parity untested here | Yes, task delegation and explore agent |
| [Generic ACP](https://agentclientprotocol.com/protocol/v1/schema) | Negotiated JSON-RPC, normally local stdio | `session/load` replays history; optional `session/resume` omits replay | Standard chunks/tool updates, plans/config/usage; newer optional surfaces | `session/request_permission`; **current stable elicitation supports structured questions** | SDK includes proposed subagent updates; do not assume implementation by every agent |

## Comparison: models, MCP and operational visibility

For every “compatible endpoint” entry, tool quality still depends on model training, chat template, API fields, context size and harness prompts. None is a promise that every llama.cpp model will use tools reliably.

| Tool | Local/OpenAI-compatible models | Model catalog surface | MCP and runtime change | Usage / account limits |
|---|---|---|---|---|
| pi | [Custom `models.json`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md), OpenAI/Anthropic-compatible APIs; tested here | RPC `get_available_models`, current model/state; configured/discovered models | **Built-in MCP exists in tested 1.1.0**, including HTTP/stdio; `/mcp` reconnect/control, `/reload` after config edits. casm does not inject per-agent MCP or expose native pi status | RPC session token/context/cost stats; no uniform cross-provider subscription quota endpoint verified |
| OpenCode | Custom provider using `@ai-sdk/openai-compatible` and `baseURL`; tested here | `/provider`, `/config/providers`, `/agent`; metadata/context limits | Dynamic add/status/connect/disconnect; casm now exposes status/reconnect. Server connections are shared by directory, so per-agent bearer-token injection remains absent | Message tokens/cost/context; no account quota endpoint in reviewed serve API |
| Goose | [Custom providers/Ollama/local endpoints](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/providers.md); tool-capable model needed | Provider/configuration-dependent; ACP session choices, not a guaranteed universal discovery API | MCP is central to tools/extensions; dynamic extension management. Generic ACP hot-reload parity unverified | Token/context/cost reporting; universal subscription limits unverified |
| Crush | [Custom OpenAI/Anthropic providers and local models](https://github.com/charmbracelet/crush/blob/main/README.md#local-models) | Catwalk registry, CLI `models`, HTTP workspace provider catalog | stdio/HTTP/SSE, OAuth, list-change notifications; HTTP `mcp/refresh-tools`. Refreshing tool lists is not proof that every config edit reconnects | Session usage/cost; provider-specific credit handling exists; no uniform account-window API verified |
| Gemini CLI | Google Gemini/Vertex authentication and models; **not a verified generic OpenAI endpoint client** | Model selection/configuration exposed through agent/ACP; Google-specific catalog | MCP client; [`/mcp reload`](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md) rediscovers servers. ACP invocation parity needs testing | Headless stats and [Google quotas](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md); ACP account-window API unverified |
| Qwen Code | [Configured OpenAI-compatible routes](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/model-providers.md), custom base URLs | `modelProviders`, model picker/config; interactive model config hot-reload documented | MCP stdio/HTTP/SSE. [User guide](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/mcp.md) still tells users to restart after adding servers; newer runtime work is not proof of universal ACP hot reload | Headless usage/budgets; uniform subscription-window API unverified |
| Cline CLI | [Local providers](https://github.com/cline/cline/blob/main/docs/running-models-locally/overview.mdx), Ollama/LM Studio and configurable APIs | ACP provider/model selectors and catalog from active provider | Native MCP management; restart controls exist. Generic ACP runtime reconfiguration unverified | JSONL usage/run result; children count toward total; provider-wide quota contract unverified |
| Aider | [OpenAI-compatible base URL](https://aider.chat/docs/llms/openai-compat.html), Ollama and LiteLLM routes | CLI model listing and model metadata, not a server catalog | No core MCP client/hot-reload contract verified; third-party bridges are separate dependencies | Session token/cost display; no structured account limits contract verified |
| Amp | [Custom URL routing now exists](https://ampcode.com/docs/customize/model-routing), including Chat Completions/Responses/Anthropic formats. **Ubuntu loopback/local llama.cpp routing not verified**; docs require endpoint reachability from Amp | Managed model/mode selection and routing catalog; not a drop-in local discovery contract | Native MCP and execute-time config; wrapper forwards stdio/HTTP/SSE. [Catalog refresh semantics](https://ampcode.com/docs/customize/mcp) vary between threads/runners | Stream usage plus service credits/plans; no casm-ready quota callback verified |
| Vibe | Configurable provider/model endpoints; local compatibility not tested | Configured models and ACP selectors; universal discovery API unverified | Native MCP configuration; hot reload over ACP unverified | Tokens, cost, context and run exports; universal account quota API unverified |
| Generic ACP | Does not supply inference or make an incompatible agent local-compatible | Stable session config/model choices when supplied; proposed `providers/list/set/disable` are **not a universal deployed catalog API** | Session new/load accepts MCP definitions; HTTP/SSE are negotiated. MCP-over-ACP is a newer proposal, not automatic runtime reload | Stable `usage_update` supports context/window/cumulative cost; not subscription quota/reset windows |

## What casm pays today

Physical source lines, including comments/blanks, measured with `wc -l`; not a complexity score. Test lines exclude shared integration fixtures and manager/protocol tests.

| Provider | Adapter source | Direct tests | Ongoing integration cost and fallback |
|---|---:|---:|---|
| Claude | 1,375 core + 272 task/memory helpers | 934 | Agent SDK query lifecycle, partial streams plus JSONL history normalization, task/subagent identity recovery, permission suggestions and question/elicitation translation. User shell execution is a host subprocess with transcript append/acknowledgement and recycle fallback. Catalog via SDK; account limits use explicitly experimental SDK API. Native MCP status/reconnect/toggle now implemented. |
| Codex | 1,255 core + 80 memory helper | 784 | app-server JSON-RPC lifecycle, thread start/resume/items, turn IDs, approvals and elicitation, child-thread filtering/history, terminal interactions. Native shell command and structured model/rate-limit APIs. MCP status pagination and whole-config reload; loaded threads apply it on a subsequent active turn. |
| OpenCode | 979 | 463 | Shared HTTP server lifecycle and refcounting, global SSE demultiplexing, directory scope, message/part identity, child permission routing, history and usage reconciliation. Native shell endpoint lacks a dependable user-shell exit-code contract in casm's normalization. No account quota API; per-agent `config.env`/MCP injection is not applied by this shared-server adapter. Native status/reconnect added; reconnect affects sessions in that directory. |
| pi | 888 | 348 | Per-session process, bespoke JSONL framing/correlation, branch-aware native history and timestamp/entry ID aliases, tool-output differencing, extension dialog mapping, settled-vs-end semantics and slash-command steering. Native RPC bash/abort with persistent context. No native child-history hook, permission modes or account-limit query. MCP UI currently falls back to whole-session reload. |

Shared provider files add 95 lines for interfaces, 24 MCP mapping, 60 tool-image handling and 7 environment normalization. The provider directory totals **5,035 lines**. Removing pi saves roughly **18% of provider-directory lines**, not 18% of all casm maintenance: provider enums, configuration, tests, UI, docs and existing agent records must also be handled.

Important distinctions:

1. **MCP support is not casm MCP injection.** `casmMcpEntry()` only supports Claude/Codex. Its “pi has no MCP client” comment is obsolete against pi 1.1.0. OpenCode's directory-shared configuration cannot safely be treated as an isolated per-agent token store. Both can still orchestrate through the casm CLI and host environment/prompt paths.
2. **A new MCP control panel does not create a universal reload operation.** Claude reconnect/toggle, Codex whole-config refresh, OpenCode directory-shared reconnect and pi process reload have different effects. The manager falls back to session reload for missing native APIs.
3. **Coverage is an inventory, not a quality score.** The checked-in report says Claude 62%, Codex 57%, OpenCode 43%, pi 70%, ACP 75%. ACP's percentage means equivalent casm concepts, not an installed adapter. Some classifications lag implementation: it still describes absent MCP controls and says ACP subagents have no casm model, while current source already has `Item.subagent` and native child history. `account/usage/read` being a gap does not mean Codex lacks the implemented `account/rateLimits/read` path.
4. **Native session resume is not active-turn survival.** Live requests, approvals and tool processes are not made durable by retaining a session ID. The observed stable-server restart during this research is an example of that boundary.

## Per-tool assessment

### pi: retain, with an explicit retirement gate

Pi's core remains intentionally small: no built-in subagents/plan mode, but extensible tools and UI dialogs. Its current [README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) and [RPC commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md) describe an actively maintained integration substrate, not merely a terminal UI. Its [MCP documentation at 1.1.0](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/mcp.md) disproves the old “no MCP” premise.

Its weakness for casm is that extensions define much of the richer behavior. A confirmation dialog is not automatically a comprehensive approval policy; extension-created children do not automatically acquire casm's native child-history semantics. But casm already owns orchestration, so absent native subagents alone is not a reason to remove it.

Retirement gate: confirm no required pi extensions or RPC steering workflow, validate OpenCode across the actual local-model set and unattended restarts, and preserve the ability to read existing pi-backed agents. A product change removing pi should define existing-agent behavior explicitly; it must not silently route their session-file IDs to a different provider. No such change is made here.

### OpenCode: keep the native server adapter

Its HTTP/OpenAPI design is a good match for an orchestrator. The server already provides the state casm needs rather than requiring terminal scraping. [ACP support](https://opencode.ai/docs/acp/) is useful for broad clients, but replacing the working HTTP adapter would add migration risk for little immediate benefit.

The expensive parts are shared-server scoping, event ordering and evolving part/permission schemas. Per-agent environment/MCP isolation and v2 interaction events need attention before treating OpenCode as fully equivalent to per-session Claude/Codex processes. Current [provider configuration](https://opencode.ai/docs/providers/) permits local endpoints; runtime success remains model/template-dependent, as the test below demonstrated.

### Goose: first ACP candidate

Goose combines native ACP with local-model flexibility and MCP-first tools. Its [session management](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/sessions/session-management.md) and [subagent documentation](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/context-engineering/subagents.mdx) make it more than a one-shot runner. Keep casm's own queues/schedules authoritative instead of adopting Goose recipes as another orchestration layer.

Use ACP rather than copying its desktop backend. Its registry initialization succeeds, but the registry's unauthenticated session-new probe returned an internal error on this date. That is a test/setup observation, not proof that authenticated Goose cannot create sessions; require a real configured-provider smoke test.

### Crush: good server, weaker portfolio fit

The tagged [server endpoints](https://github.com/charmbracelet/crush/blob/v0.98.1/internal/server/endpoints.go) include sessions, history, permissions, questions, provider catalogs, MCP tool refresh and user shell. Its [run command](https://github.com/charmbracelet/crush/blob/v0.98.1/internal/cmd/run.go) supports continuing a session, and correlated run IDs address queued-turn completion. This is materially stronger than the old “pretty TUI only” characterization.

No native ACP implementation was found in the reviewed source or official registry. A dedicated adapter would duplicate much of OpenCode's HTTP/SSE work, including workspace lifetime and selected-session prompt routing. FSL rather than a permissive present-day license is another portfolio distinction. Worth revisiting if someone specifically prefers Crush; not the next integration to build.

### Gemini CLI: useful Google route, not the local-model answer

Native ACP and Google-maintained tooling make this a reasonable low-incremental-cost addition through a generic provider. Headless output alone is insufficient for interactive approvals; use ACP. Treat its Google quota information separately from a standardized remaining-budget API. The current [authentication guide](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx) covers Google accounts, API keys and Vertex, not a general llama.cpp Chat Completions backend.

### Qwen Code: strong second ACP candidate

Qwen has native ACP, compatible model endpoints and increasingly extensive daemon/session machinery. That breadth is useful, but casm should consume the agent interface rather than depend on its entire web/workspace stack. Its [headless guide](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/headless.md) explicitly distinguishes budget behavior in one-shot/stream-json versus daemon/ACP paths: do not assume a CLI budget flag governs the ACP runtime. Check question cancellation, resume/replay, child history and per-session MCP identity before enabling unattended use.

### Cline CLI: now a real standalone candidate

The [CLI reference](https://github.com/cline/cline/blob/main/docs/cli/cli-reference.mdx) documents a current JSONL event protocol, while native ACP supplies session resume, model/provider selection and approvals. Evaluate this product/version rather than extrapolating from the editor extension.

A material behavior difference: documented CLI subagents do not receive MCP tools, and approving `spawn_agent` authorizes their subsequent tool execution without individual approval prompts. Casm must present that native behavior accurately. It cannot promise that a parent permission UI intercepts each child operation.

### Aider: keep available as a tool, not a provider

Aider is mature at code editing and supports local endpoints. Its [scripting guide](https://aider.chat/docs/scripting.html) explicitly declines compatibility guarantees for the Python API. File-based chat restoration and terminal prompts would force casm to manufacture a protocol and session abstraction. MCP, structured questions and nested histories would add more glue. It can be called from an existing agent's shell when useful; a first-class provider has poor return on maintenance effort.

### Amp: account-driven optional integration

Amp has [execute mode](https://ampcode.com/docs/cli/execute-mode), [JSON streaming](https://ampcode.com/docs/cli/streaming-json), native specialists and configurable model routing. It is no longer accurate to say it cannot route to custom API endpoints. However, that documentation does not establish that the hosted routing service can reach this host's `127.0.0.1:8080`; this review did not test it.

The [third-party ACP adapter](https://github.com/tao12345666333/amp-acp) persists thread mappings and forwards MCP, but introduces another translation/version layer. Its remote Orb mode has different permission/MCP semantics and is outside this recommendation. Add only for actual Amp demand, pinned to a tested wrapper version.

### Other notable candidates

**Mistral Vibe 2.26.1** merits a later ACP pilot: open source, native delegation/questions, session journals and compatible providers. Its [ACP setup](https://github.com/mistralai/mistral-vibe/blob/v2.26.1/docs/acp-setup.md) and [current README](https://github.com/mistralai/mistral-vibe/blob/main/README.md) establish the integration direction. Test emitted usage, question responses and resumed child history; do not infer them merely from TUI features.

**Kimi is a migration trap in a registry-only review.** The registry still lists Python Kimi CLI 1.52.0, but its [repository](https://github.com/MoonshotAI/kimi-cli) now announces archival and replacement by [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code). Do not add the retired Python implementation just because its ACP handshake works. The successor [2.1.1 release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.1.1) was published September 24; its current README declares MIT, a single-binary distribution, compatible providers, MCP, subagents and native `kimi acp`. Evaluate that implementation separately: the old registry probe does not verify its persistence, question, reload, catalog or quota behavior.

The [official ACP agent list](https://agentclientprotocol.com/get-started/agents) also includes Copilot, Cursor, Kiro, Augment, Factory and OpenHands. These broaden potential coverage, but registry membership alone does not establish session durability or local-model freedom. No bespoke adapter is recommended without user demand.

## Generic ACP: add a bounded pilot, not a lowest-common-denominator rewrite

Use the **Agent Client Protocol**, not similarly named Agent Communication or Control protocols. The current [SDK 1.8.0](https://registry.npmjs.org/@agentclientprotocol/sdk/1.8.0) matches casm's inventory. The specification has evolved: [elicitation](https://agentclientprotocol.com/protocol/v1/elicitation) and [usage updates](https://agentclientprotocol.com/announcements/session-usage-stabilized) are stable; [subagent sessions](https://agentclientprotocol.com/rfds/subagents), [configurable LLM providers](https://agentclientprotocol.com/rfds/custom-llm-endpoint) and [MCP-over-ACP](https://agentclientprotocol.com/rfds/mcp-over-acp) need proposal/capability scrutiny. Presence in an SDK schema does not prove universal deployment.

### Actual coverage available today

The [registry snapshot for October 14](https://github.com/agentclientprotocol/registry/blob/main/.protocol-matrix/snapshots/2026-10-14.json) distinguishes advertised capabilities from method probes. The following is its advertisement evidence, not a successful end-to-end restart test:

| Agent / adapter | Entry point | Load with replay | Resume without replay | Maturity qualification |
|---|---|---|---|---|
| OpenCode 1.19.0 | Native `opencode acp` | Yes | Yes | Registry session creation succeeded |
| Goose 1.54.0 | Native `goose acp` | Yes | No advertised | Initialize succeeded; session-new probe internal error |
| Gemini 0.64.0 | Native `gemini --acp` | Yes | No advertised | Session creation requires auth |
| Qwen 0.25.1 | Native `qwen --acp` | Yes | Yes | Session creation requires auth |
| Cline 3.0.71 | Native `cline --acp` | Yes | No advertised | Session creation requires auth |
| pi-acp 0.0.34 | Third-party wrapper spawning `pi --mode rpc` | Yes | No advertised | Self-described MVP; registry lacked installed pi dependency |
| amp-acp 0.10.0 | Third-party wrapper around Amp | Yes | Yes | Session creation succeeded; real turn still requires Amp setup |
| Vibe 2.26.1 | Native `vibe-acp` | Yes | No advertised | Session creation requires auth |

[pi-acp's documented limitations](https://github.com/svkozak/pi-acp#limitations) are particularly relevant: MCP definitions supplied through ACP are stored but not wired through, and assistant thoughts are not a separate stream. It persists ACP-to-pi session mappings, adding state that must survive restarts. Moving pi behind ACP today would save casm-specific code at the cost of real fidelity. The wrapper's limitations are not limitations of current pi's native MCP client.

### Suggested integration contract

1. A configured executable/argument/environment profile, with a stable casm identity separate from the negotiated native session ID. Pin supported agent and wrapper versions. Do not install arbitrary registry entries automatically.
2. Negotiate capabilities. Require durable load/replay for a fully supported provider, because casm intentionally has no independent durable transcript archive. [Load and resume differ](https://agentclientprotocol.com/protocol/v1/session-setup): resume restores context without replay and cannot alone implement `history()`.
3. Normalize message/thought chunks, tool calls/updates, plans, notices and optional usage/config events. Reconstruct stable item identities across replay; test repeated chunks and reconnects. Keep child-session events out of parent history.
4. Map permission outcomes exactly, including deny/cancel and once/always choices. Add supported form elicitation; keep URL completion separate. Never silently approve an unsupported interactive request to prevent a hang.
5. Supply casm MCP at session creation/load only when the agent honors the requested transport and session scope. Verify two agents in one directory retain distinct caller identities. Do not mistake accepting `mcpServers` for actually connecting them.
6. Preserve casm FIFO queue semantics. ACP cancellation is not universal active-turn steering; advertise Queue first and only expose Steer when the selected implementation has verified semantics.
7. Advertise filesystem/terminal client capabilities only if implemented. Host-local execution helpers can fit casm's scope, but do not represent sandboxing or cross-machine file sync. Prefer agents that can execute locally without mandatory client delegation for the first pilot.
8. Treat user-initiated shell-in-context, provider account quotas, native MCP reload and arbitrary child history as explicit capability gaps until implemented. ACP terminal callbacks are agent-requested execution, not automatically casm's user shell command contract. Hide unsupported actions rather than pretending parity.

Acceptance suite: process restart + history replay; two simultaneous sessions in one cwd; tool output and final outcome; permission deny/cancel; structured question answer/cancel; cancellation during a tool; provider error/rate-limit propagation; image handling where advertised; MCP caller identity; child transcript separation; unavailable usage displayed as unknown. This is more valuable than maximizing a protocol percentage.

## Hands-on: ubuntu → llama-wake-proxy → fedora

The existing `fedora` helper was used with hold `casm-provider-review`. The initial sandboxed wake attempt could not open the network socket; retry with host networking woke Fedora successfully. Tests ran from ubuntu, with temporary agent configuration/state under `/tmp/provider-review`; no router builds, presets or user provider configuration were changed. The test used installed **OpenCode 1.19.0** and **pi 1.1.0**, not uninstalled latest pi 1.2.0.

Endpoint: `http://127.0.0.1:8080/v1`. Both agents used router model **`devstral-2-24b`**, reported as Devstral Small 2 24B Instruct 2512 `UD-Q4_K_XL`, 65,536 context, llama.cpp build `mainline_v060_fedora@b11429`, Vulkan/CUDA split. No model was resident at initial inspection. This was a functional smoke test, not a controlled speed or model-quality benchmark.

Each agent got a separate directory with `input.txt` containing `CASM_PROVIDER_PROBE_6419` and this prompt:

> Use a tool to read input.txt in the current directory. Then use a shell tool to compute 17 * 23. Do not modify files. Reply with the exact file content and the computed result.

| Observation | OpenCode | pi |
|---|---|---|
| Configuration | Custom `@ai-sdk/openai-compatible` provider; `baseURL` above; dummy local key; explicit context/output limits | Custom `models.json` provider, `api: openai-completions`, same URL/key/model/context |
| Mode | `run --pure --auto --format json`, explicit title on successful retry | `--mode json --print`, extensions/MCP/skills/context-file discovery disabled, thinking off |
| Tools actually executed | `read` returned marker; `bash` executed arithmetic and returned `17 * 23 = 391`, exit 0 | `read` returned marker; `bash` returned `391`, exit 0 |
| Final response | Marker and `391`; process exit 0 | Marker and `391`; `agent_settled` not aborted; process exit 0 |
| Caveat | First invocation produced no JSON result; title-agent log showed llama.cpp role-alternation Jinja error after retries. Explicit title + auto mode retry succeeded. Changes were not isolated individually, so title generation is the observed suspect, not a proven sole cause | Passed first invocation; minimal resource discovery means prompt/configuration was not identical to OpenCode's |
| Event shape observed | CLI emits completed tool parts, step boundaries, final text and token/cost records; do not confuse this CLI sample with the richer serve SSE stream | 74 message updates, two tool start/update/end sequences, message/turn lifecycle and settled event |

Pi's first model call reported about 1.4k input-plus-cache tokens; OpenCode's first completed model step about 12.7k. This illustrates prompt/tool overhead in these particular configurations, **not a fair performance comparison**: OpenCode discovered host skills and used a larger default tool/prompt surface, while pi discovery was disabled. Local cost fields were zero and say nothing about hardware cost. A single two-tool success is not evidence of reliable long coding tasks.

Reproduction essentials (substitute isolated configuration paths):

```sh
fedora hold 60 casm-provider-review
# OpenCode config: provider.local.npm = @ai-sdk/openai-compatible
# provider.local.options.baseURL = http://127.0.0.1:8080/v1
# provider.local.models.devstral-2-24b.limit = {context: 65536, output: 2048}
opencode run --pure --auto --title 'Local provider probe' \
  --model local/devstral-2-24b --format json '<prompt above>'
# Pi models.json: providers.local.api = openai-completions
# providers.local.baseUrl = http://127.0.0.1:8080/v1
pi --mode json --print --no-extensions --no-mcp --no-skills \
  --no-context-files --no-prompt-templates --provider local \
  --model devstral-2-24b --thinking off '<prompt above>'
fedora release casm-provider-review
```

A second invocation of each agent resumed its saved native session (OpenCode `--session` ID; pi `--session` file path). Asked to repeat the previous marker and result without tools, **both returned the marker and `391`, exited 0, and made no tool calls**. This validates basic process-restart conversation continuity, not active-turn recovery or casm history normalization. The Fedora hold was released after both checks; the proxy reported zero in-flight requests.

The tests did not exercise approval UI, structured questions, MCP reload or native subagents. Those assessments above are source/documentation evidence and remain acceptance work for a new integration.
