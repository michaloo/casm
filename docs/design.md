# casm NG — design (draft, 2026-10-13)

A simpler Paseo:
- projects → agents → one chat UI;
- projects grouped by host;
- agents scriptable across hosts;
- schedules that run inside agents.

Optional features you enable separately: voice and Slack.

Paseo 0.11.2 (`~/Explorations/getpaseo/paseo`, Apache-2.0) was read as a reference only. casm NG has
no Paseo imports or integrations and runs independently of it.

## 1. Scope and phases

**Phase 1:** server, macOS client, iOS client.
- **Server:**
  - projects, agents, the four providers, permissions;
  - schedules;
  - cross-host agent calls;
  - CLI.
- **Clients:**
  - host-grouped sidebar;
  - chat;
  - permissions;
  - schedules UI.

**Phase 2, separate opt-in features:**
- **Voice:** dictation and voice mode (section 6).
- **Slack** (section 7).

| Keep | Drop |
|---|---|
| Projects (organizational only, nestable, tags), grouped by host | Git workspaces, worktrees, branches, checkout/PR/diff UI |
| Agents = config + one native session, reload/restart | Terminal, browser, file-browser tabs |
| One chat UI per agent | Workspace scripts, hooks, port allocator |
| Multi-host clients + cross-host agent calls | Relay, pairing, tunnelling, any network tooling |
| Schedules inside an existing agent by default | Separate Hub service, orgs/seats/billing |
| Providers: Claude Code, Codex, pi, OpenCode | Bundled daemon in the app, plugin system |
| | Built-in GitHub integration (use a GitHub MCP + a schedule) |
| | Server-side timeline storage; Paseo import |
| | Cloud APIs of any kind |

## 2. Domain model

```
Host (client-side: name, url, token)
└─ Project       id, name, parentId?, path?, tags[], sort, archivedAt?
   ├─ Project …  nesting is organization only; a child without a path inherits the parent's
   └─ Agent      id, projectId, name, provider, cwd, config {model, mode, effort, systemPrompt,
      │          mcpServers, env}, nativeSessionId, parent? {host, agentId}, tags[], archivedAt?
      └─ Schedule id, agentId, prompt, cadence {every | cron+tz}, busy, session, enabled
```

- **Project:** organization only. No git detection, scripts or hooks. `path` is the default cwd for
  new agents. Tags are free strings; a "label" is a tag with a color.
- **Agent:** saved config plus a pointer to one native session.
  - **Reload:** restart the provider process on the same native session.
  - **Restart:** point the agent at a new native session with the same config. The old session isn't
    tracked by casm, but it is still in the provider's own store.
- **`parent`:** set when another agent (possibly on another host) created this one. The UI uses it to
  show subagents under their caller.

### Project details: AGENTS.md and memories
casm doesn't keep project instructions or memories itself. It shows what the agents already use,
keyed by the project folder. AGENTS.md is editable; memories are read-only (the agents own them):

- **AGENTS.md** (`project.agentsMd`, `project.setAgentsMd`): `<path>/AGENTS.md`, which Codex,
  OpenCode, pi and Claude Code all read. `content` is null when the file doesn't exist.
- **Memories** (`project.memories`): one block per installed agent with something stored,
  `{provider, scope: project|global, location, entries[{id, title?, text, updatedAt?}]}`.
  Each provider implements the optional `memories(cwd)`.
  - **Claude Code:** `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<folder>/memory/`, where `<folder>` is
    the main checkout of the git repo containing the path (worktrees share it), else the path, with
    every non-alphanumeric character replaced by `-` (over 200 chars: cut and suffixed with a hash).
    The user setting `autoMemoryDirectory` replaces it with one global dir. Entries are `MEMORY.md`
    (the index loaded into every session) and each note file, titled from the index link.
  - **Codex** (`[features] memories = true`): one global store, `$CODEX_HOME/memories/`, generated
    in the background from idle threads and rewritten on each consolidation. Entries: `memory_summary.md` (injected into every session), the `MEMORY.md` "Task Group"
    blocks whose `applies_to: cwd=` tag covers the folder (or names no path), and the
    `rollout_summaries/*.md` whose `cwd:` header does.
  - **OpenCode, pi:** no memory store by default, so nothing is listed.

## 3. Server

```
 macOS app ─┐                            ┌─ claude-agent-sdk
 iOS app   ─┼─ WebSocket (one per host) ─ casm serve ─ codex app-server
 casm CLI  ─┘                            │  ├─ pi --mode rpc
 other casm servers (cross-host calls) ─────────┘  └─ opencode serve
```

- **Language and runtime:** TypeScript on Node. Three of the four provider SDKs are TS.
- **One binary:** `casm` is both the server (`casm serve`, `casm token`) and the client. Every
  agent host needs both halves anyway, because cross-host calls make the server a client.
- **Platforms:** Linux (systemd user unit) and macOS (launchd agent), installed on its own. The apps
  never bundle or spawn it.
- **Network:** listens on a configured address and port. Networking is the user's business.
- **Auth:** per-client bearer token (`casm token create`). On start, the server writes
  `$CASM_HOME/local.json` (its loopback URL and a fresh `local-cli` token), which the CLI on the same
  machine uses.

### State: bare minimum, no drift
The provider's own store is the single source of truth for conversations. casm stores only what can't
be derived:

| Stored (SQLite, a handful of tables) | Not stored, derived on demand |
|---|---|
| projects, agents (config + `nativeSessionId`), schedules, client tokens, peer hosts | transcripts / timelines |
| | agent status (running / idle / waiting): derived from the live process |
| | run history beyond `lastRunAt` / `lastResult` per schedule |

- **Opening an agent:** the client calls `agent.history(agentId, before?, limit)`. The server reads the
  provider's native store (Claude JSONL, `codex thread/read`, pi session file, OpenCode
  `session.messages`) and returns normalized items. This is slower than a cache, and that is the
  accepted trade-off.
- **Live turns:** while a turn is running, the server keeps its events in memory. A client that
  connects mid-turn gets history plus the buffered turn. The buffer is dropped when the turn ends,
  because the native store has it by then.
- **Pending permission prompts:** in memory only. A server restart ends the turn anyway.
- **Clients:** no persistent cache in v1; they re-fetch on open.
- **What can still go out of sync:** an agent's `nativeSessionId` can point at a session that was
  deleted outside casm. The server reports it as missing; nothing tries to reconcile it. (Claude: casm
  assigns new session ids itself, so the agent points at its session before Claude writes it; a
  session Claude never stored starts anew under the same id, with a notice.)
- **A server stop mid-turn:** a prompt the agent hasn't answered yet is kept as a `failed` pending
  message (retry or cancel it), since its turn and its live events are gone. Prompts queued behind a
  turn are sent again when the server starts.

### Protocol (open by design)

Other people should be able to write clients (a TUI, an Emacs mode, a menu-bar app, scripts) in any
language, without depending on our code.
- **Language-neutral spec:** `spec/protocol.json` is the JSON Schema for every method and
  notification, generated from the zod source of truth. A test fails if it is stale.
  - Paseo only has zod plus a TS SDK, and its protocol package is labeled unstable.
  - HAPI has prose docs and fixtures, but its schema package is private.
- **Compatibility:** `GET /health` (no auth) reports the protocol version. Changes are additive
  (new optional fields, new methods), and clients must ignore unknown fields.
- **Unix composability:** every CLI command takes `--json`. Exit codes are meaningful (`wait` exits 3
  if the agent is not idle).
- **Still to add:** golden fixtures of recorded sessions as a conformance suite for third-party
  decoders (HAPI does this).

- JSON-RPC 2.0 over one WebSocket.
- **Methods:** `project.*`, `agent.*` (create, list, history, send, steer, interrupt, reload, restart,
  setConfig, respondPermission, wait), `schedule.*`, `host.*`.
- **Notifications:** `agent.event`, `agent.status`.
- **Forwarding:** a request with a top-level `host` (a peer name or server id) is forwarded to that
  peer; see "Cross-host agents and scripting".
- **Schemas:** zod in a shared `protocol` package, also exported as JSON Schema for Swift codegen.
- **Size target:** a few dozen methods (Paseo has ~200).

### Providers (native protocols)
| Provider | Transport | Resume | Permissions | History source |
|---|---|---|---|---|
| Claude Code | `claude-agent-sdk` `query()` with streaming input | `options.resume` | `canUseTool` | `~/.claude/projects/…/<id>.jsonl` |
| Codex | `codex app-server` JSON-RPC stdio | `thread/resume` | approval requests | `thread/read` |
| pi | `pi --mode rpc` JSONL | `--session <file>` | none native (extension UI requests) | session file |
| OpenCode | shared `opencode serve` + SDK/SSE | session id | `permission.asked` | `session.messages` |

Each adapter implements: `start`, `resume`, `send`, `steer`, `interrupt`, `events`, `history`,
`respondPermission`, `catalog`. A generic ACP adapter can come later.

### Cross-host agents and scripting
- **The CLI is the primitive.** `casm` talks to any server:
  - `casm --host macbook agents`
  - `casm --host macbook run --project X --provider claude "…" --wait`
  - `casm --host macbook send <agent> "…"`, then `casm wait <agent>`
  - JSON output for scripts.
- **One list of hosts per machine: the server's peers.** Each server has a peer list (`casm peer add
  macbook <url> <token>`, verified with `server.info` and stored with the peer's server id).
  - On a machine running a server, the CLI connects to it (`local.json`) and `-H macbook` sends each
    request with `host: "macbook"`. The server forwards it through `PeerPool`, the same cached peer
    connections the MCP tools use. So the CLI, the MCP tools and the agents' own `casm` calls all reach
    the same hosts with the same names, and only the server holds peer tokens.
  - `agent.subscribe` through a peer is relayed: the server holds one subscription per peer agent
    on the shared connection, fans the peer's `agent.event` / `agent.status` out to its local
    subscribers (marked with `host`), and sends `peer.disconnected {host}` when that connection drops.
  - Forwarding is one hop: the forwarded request carries no `host`, so a peer's peers are not
    reachable through it.
  - `hosts.json` (`casm host add`) is only for a CLI on a machine without a server, the same role as
    the apps' host list.
- **Agents call agents on other hosts.** Each server also exposes
  an opt-in MCP server to its own agents (`AgentConfig.casmTools`), at `POST /mcp` on its HTTP port,
  built on the same client library, with tools:
  - `list_hosts`, `list_projects`, `list_agents`
  - `create_agent(host, project, provider, prompt, model, mode, name)`
  - `send(host, agent, text)`, `wait(host, agent, timeout_s)` (status + last reply + pending requests)
  - `get_history(host, agent, limit)`
  - `answer_permission`, `answer_question`, so a parent can unblock its child

  Example: an agent on ubuntu calls `create_agent(host: "macbook", …)`. The ubuntu server forwards
  the call to the macbook server, which runs the agent with `parent = {ubuntu's server id, callerId,
  host: "ubuntu"}`.
- **MCP transport:** hand-rolled streamable HTTP subset (initialize, ping, tools/list, tools/call;
  JSON responses, no SSE, no MCP session). The bearer token is minted per agent session, kept in memory
  and identifies the caller. Claude Code and Codex take it per session; pi has no MCP client and
  OpenCode's MCP config is shared by every session of its one server, so those two use the CLI.
- An agent can equally shell out to `casm --host macbook …`, which goes through its server's peers. Sessions get `CASM_SERVER_ID`,
  `CASM_SERVER_NAME` and `CASM_AGENT_ID`, which `casm run` uses as the parent. The MCP tools exist so
  the agent doesn't need shell access or a token in its environment.
- **Unreachable host** (a sleeping laptop): fail fast with a clear error (error 1005 for forwarded
  requests), no queuing.
- **No cross-host state:** the child lives only on its own host, and the caller polls or waits.

## 4. Clients (SwiftUI, macOS + iOS)

- **Sidebar grouping:** `Host → Projects (nested) → Agents` by default. The host is the top level
  because a project's path only means something on one machine. Alternative groupings (by tag,
  flattened "all hosts") are client-side views.
  - Host header: name and online/offline state.
  - Agent rows: provider, status (running / waiting for permission / idle) and subagent nesting.
- **`CasmKit` Swift package**, shared by both apps:
  - generated protocol `Codable` types;
  - WebSocket client (`URLSessionWebSocketTask`);
  - host list;
  - reconnect handling;
  - Keychain tokens.
- **Contract tests:** recorded server sessions are decoded by the Swift types, so schema drift fails
  CI.
- **Per platform:**
  - macOS: three-column `NavigationSplitView`, keyboard shortcuts, a menu bar extra for running and
    blocked agents.
  - iOS: a navigation stack over the same views.
- **Chat transcript risk:** a long, streaming list with markdown, code, tool calls and diffs. Spike it
  early with a 2k-message session. The fallback is a `WKWebView` for the transcript only.
- **OS floor:** iOS 26 / macOS 26 for now. The MacBook has Xcode 26.6, and moving to 27 later is cheap
  because nothing has shipped. iPhone 13 mini is supported.
- **Builds:** the apps build on the MacBook (Xcode); the server and protocol are testable on ubuntu.

## 5. Schedules inside agents

- **Target:** the owning agent by default. Choose `session: fresh` for a new session per run.
- **Busy policy:** `queue` (default; at most one pending), `skip` or `steer`.
- **Session policy:** `continue` (default), `fresh`, or `rotate {everyRuns: N}`.
- **Unattended permissions:** scheduled turns use a configured permission mode. A permission prompt
  marks the agent as waiting; the run doesn't fail silently.
- **Kept per schedule:** only `lastRunAt` and `lastResult`. The transcript is in the agent itself.
- **Server restart mid-run:** the run is marked interrupted. With `queue`, it runs again on start.
- **GitHub issues this way, with no built-in integration:**
  - An agent gets a GitHub MCP server or `gh`, plus a schedule such as "every 15 min: handle new
    issues labeled `agent`, comment back, relabel `agent:done`".
  - Dedup state lives on GitHub in the labels, so casm stores nothing.

## 6. Voice (phase 2, opt-in feature)

Two features on one speech layer:
- **Dictation:** speak into the composer, edit, send.
- **Voice mode:** hands-free loop with an agent: listen → transcribe → send prompt → speak the reply
  → listen again, with push-to-talk or VAD, and barge-in (talking stops playback).

**Fixed regardless of where the models run:**
- Audio capture, VAD, turn-taking and playback live on the client (that's where the mic and speaker are).
- No extra "voice LLM". In voice mode the client marks prompts as `voice: true` and the daemon appends
  an instruction ("answer briefly, in speakable prose, no code blocks"). The client speaks only the
  final assistant message, never tool output.
- On iOS the `audio` background mode keeps a voice session (and its socket) alive with the screen
  locked. Needs checking with a Personal Team build.
- No cloud APIs.

**Requirement: multilingual from the first voice release.** English and Polish are both first-class (the user speaks both,
often mixing in English technical terms), and nothing should be hard-wired to one language for future users.

What that means:
- **Pick the language per utterance, not per app.** Whisper-family models detect the language
  themselves and cope with Polish sentences full of English terms. Apple's transcribers need a locale
  up front, so with them the app needs a quick language toggle (keyboard-style) plus a remembered
  default per agent.
- **Choose the TTS voice from the reply's language** (`NLLanguageRecognizer` on the text), so a Polish
  answer gets a Polish voice without settings.
- **Tell the agent the reply language:** "answer in the language the user spoke".

**Engines.** Both client- and server-side stay possible behind two `CasmKit` protocols,
`SpeechInput` (audio → text stream) and `SpeechOutput` (text → audio stream), chosen per stage:

| | Client-side (on device) | Server-side (daemon) |
|---|---|---|
| STT | `SpeechTranscriber` (no Polish as of iOS 26, recheck on 27); `DictationTranscriber` (keyboard-dictation locales, should include Polish); **WhisperKit** (CoreML Whisper, ~100 languages, auto-detect) | sherpa-onnx Parakeet: en WER 2.5–3.4 but **pl WER 44**; Qwen3-ASR pl WER 67 (voice-bench, 2026-10-12). Whisper (whisper.cpp) not yet measured |
| TTS | `AVSpeechSynthesizer` enhanced/premium voices (many languages incl. Polish), Personal Voice | Supertonic 3: 31 languages incl. Polish, RTF 0.26, first audio ~1.6 s on ubuntu's CPU |
| Latency | No network hop; streaming partials | Audio up/down per turn, plus CPU contention with agents |
| Server cost | None | ~1.1–1.4 GB RAM for STT on top of TTS |
| Works when | Daemon unreachable (dictation) | Any client incl. CLI/future ones; same voice everywhere |

**Current leaning, pending the bench:**
- **STT on device:** WhisperKit as the multilingual default, with Apple's transcribers as a fast
  option for supported locales.
  - Model size on the iPhone 13 mini (A15, 4 GB) is the question: large-v3-turbo may be too heavy, so
    measure small/medium vs turbo.
- **TTS:** Apple voices by default, server Supertonic as the option where it sounds better.

The server path for STT only wins if Whisper on the host beats on-device for Polish. The ubuntu CPU is
slow for large Whisper models.

**Bench before building:** extend voice-bench with:
- a Polish dev set that includes code-switched speech (Polish with English tech terms);
- these engines: WhisperKit (several sizes), `DictationTranscriber` and `SpeechTranscriber` on the
  MacBook and iPhone, and whisper.cpp on the host;
- for TTS, a listening pass over Polish and English replies from Apple voices vs Supertonic.

## 7. Slack (phase 2, opt-in feature)

- **Connection:** Socket Mode, outbound only.
- **Binding:** project-level, `{channels[], allowedUsers[], route: agent | perThread}`.
  - `perThread` creates an agent per Slack thread from a template agent.
- **Replying:** the agent replies via an MCP tool bound to its thread. Reactions show progress
  (👀 → ⏳ → ✅). Events are deduplicated by `event_id`.
- **Thread-to-agent map:** the only Slack state casm keeps.
- **Notifications:** the Slack app can also DM "agent needs permission / finished".

## 8. Distribution without an Apple Developer account

| Stage | macOS | iOS | Notifications |
|---|---|---|---|
| Personal use | Xcode build on the MacBook, signed with the free Personal Team ("Apple Development") cert | Xcode Personal Team install: profile expires after 7 days, max 3 sideloaded apps; SideStore can auto-refresh on the phone | Slack DM; local notifications while the app is alive |
| Friends | Unsigned/ad-hoc `.app` in a DMG on GitHub Releases ("Open Anyway" / `xattr`); Sparkle updates (own EdDSA key, free) | Unsigned `.ipa` they sign themselves with AltStore/SideStore (same 7-day limit) | Slack |
| Paid ($99/yr, one account for both) | Developer ID + notarization in CI | TestFlight → App Store, no expiry | APNs push |

Going native removes the free web-app fallback on iOS, so the 7-day re-signing is the price of staying
unpaid. Native is also where the paid account pays off most (APNs, background refresh, Live
Activities for running agents). Plan: stay unpaid through the spike and core milestones, decide before
the iOS polish milestone.

Free builds get no push and no long-lived background socket: iOS suspends the app, so the client
reconnects and catches up by cursor on foreground.

## 9. Milestones (phase 1)

1. **Server core:**
   - SQLite schema, WebSocket + JSON-RPC, tokens;
   - Claude adapter with history read from the native store;
   - CLI.
2. **macOS client spike:**
   - `CasmKit` and codegen;
   - host-grouped sidebar;
   - chat with the 2k-message transcript test;
   - permissions.
3. **Remaining providers:** Codex, pi, OpenCode adapters.
4. **iOS client** on the shared views.
5. **Schedules:** queue and rotate policies.
6. **Cross-host:** peers, the MCP tools and parent links in the UI.

## 10. Open questions

- Name.
- History normalization depth: how much of each provider's tool-call detail the shared item format
  carries in v1.
- Transcript rendering: pure SwiftUI or a `WKWebView` transcript. Decide after the spike.
- Phase 2: client-side or server-side speech engines, decided by the bench in section 6.

## 11. Prior art (checked 2026-10-13)

Nothing matches exactly. The closest:

- **Paseo:** the feature superset. Not native (Expo/Electron) and built around worktrees.
- **HAPI** (github.com/tiann/hapi, AGPL-3.0, active):
  - All four agents including pi.
  - A native SwiftUI iOS app.
  - A central hub plus a runner on each machine, with remote spawn and MCP peer tools.
  - No native macOS app and no cron schedules found. The hub sits between clients and machines, and
    it wraps the agent CLIs rather than using their native protocols.
  - Worth studying: the runner design and the peer MCP tools.
- **Agmente** (github.com/rebornix/Agmente, MIT): a SwiftUI iOS client that speaks ACP and the codex
  app-server protocol. A reference for `CasmKit`.
- **Netclode** (github.com/angristan/netclode, no license found): SwiftUI iOS and macOS apps for a
  single sandboxed k3s host.
- **Others:** Happy (needs a sync server; Claude/Codex only), OpenChamber (OpenCode only),
  Claude Remote Control and Codex mobile (vendor relays, one agent each).

What only casm NG would combine:
- native SwiftUI on macOS and iOS;
- clients connecting directly to many servers;
- native agent protocols;
- per-host projects instead of worktrees;
- schedules inside a session;
- on-device multilingual voice.
