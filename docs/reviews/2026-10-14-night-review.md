# Night review, 2026-10-14

**Scope:** the 40 commits on `origin/casm-ng` since 2026-10-13 23:00 UTC, from `800edae` to `e3d4c15`. That covers the server, protocol, CLI, Apple/CasmKit and docs.

**Checks:**

| Check | Before fixes | After fixes |
|---|---|---|
| `npm run typecheck` | clean | clean |
| `npm test` | 175/175 pass | 176/176 pass |
| Spec drift | none | none |

- **Spec drift:** `npm run schema` regenerates `spec/protocol.json` byte-identical.
- **CasmKit vs. the spec:** these match: `agent.retryPending`, `PendingMessage.Reason.failed`, `peer.disconnected`, and `Agent.effectiveModel`.
- **CLI vs. the spec:** `peer.list` and `lastTurn` match.
- **Swift was not compiled.** ubuntu has no Swift toolchain, so the two Apple fixes below are one-line guards that still need an Xcode build on the Mac.

**The stable server was not touched.** All tests use in-process servers on ephemeral ports.

## Fixed (one commit each, each server/CLI fix with a test that fails without it)

| # | Sev | Commit | Finding |
|---|---|---|---|
| 1 | High | `52d1398` | **Claude prompts were almost never kept when a turn failed.** `AgentManager.emit` counted every `usage` event as an answer. Claude sends `usage {model}` on `system/init`, before replying. So a turn that failed after startup (API error, overloaded, server stop) had `answers > 0`, and `keepUnanswered` kept nothing. That defeats `93af8cd`, `d82c51b` and `ea12bcd` for the main provider. The tests missed it because the fake provider never sent init usage. Usage no longer counts as an answer. |
| 2 | Medium | `c733020` | **Prompts steered into a turn that hit a usage limit were dropped.** The limit branch of `endTurn` re-queued only `l.prompt`, then cleared `l.steered`. Unanswered steers are now kept as failed messages with the limit's note. |
| 3 | Medium | `344f0fe` | **A missing agent folder showed up as a fake usage limit.** `runNext` put any message it couldn't start back as `reason: "limit"`. A queued message for an agent whose folder is gone (newly reachable through `207155e`) showed "deferred: usage limit" and backed off for up to 3 h. Every later send then queued as limited too. `RpcError` refusals are now kept as `failed`, with the error as the note. |
| 4 | Medium | `26c0800` | **A kept failed message made skip-if-busy schedules skip indefinitely.** `schedules.fire` counted all pending messages, including `failed` ones that never send on their own. It now ignores `failed`. |
| 5 | Medium | `9c14354` | **Apple: sending twice during agent creation created two agents in one chat.** A second send while `agent.create` was in flight called `create()` again. Both creates registered the same `ChatModel`, so the first agent's events landed in the second's transcript. `create` now refuses while `firstMessage` is set, and the composer keeps the text. *Not compiled; see above.* |
| 6 | Low-medium | `c717106` | **CLI: two holes in the host refusal for server commands.** `casm -Hbeta peer list` (value attached to `-H`) got past `62d610a`'s refusal and printed local peers as beta's. Separately, an exported `CASM_HOST` made `casm serve` fail. `serve` shows no host's data, so `CASM_HOST` no longer blocks it; an explicit `-H` still does. |
| 7 | Low | `aa80c6e` | **iOS UI test crashed with no Thinking row.** `testFailedPendingAndThinkingRows` crashed on `element(boundBy: -1)` when no Thinking row appeared (a model with no reasoning). It now fails with a clear message. *Not compiled.* |

## Open: correctness (not fixed)

| # | Sev | Where | Finding | Suggested fix |
|---|---|---|---|---|
| 8 | Medium | `packages/server/src/agents.ts` `dropAnsweredFailed` | **Startup drops a kept prompt if the same text was answered earlier.** It matches the *last* user item with equal text that has any assistant reply after it. A kept "continue", "yes", or image-only (empty-text) prompt is dropped at the next start because an older identical prompt was answered. That prompt never reached the agent. | History items have no timestamps, so record the history length (or last item id) when the message is kept, and only look after it. This needs a design choice, so it was not fixed overnight. |
| 9 | Low | `apple/App/Shared/ChatModel.swift` `create` + `AppModel.selectionChanged` | **Leaving a new-agent chat mid-create pulls the user back.** If the user selects another agent while `agent.create` is in flight, the detached chat still runs `open()` and `onCreated` re-selects the new agent. If the create fails instead, the error and the typed text are lost. | Skip `open()`/`onCreated` when the chat is no longer active. |
| 10 | Low | `packages/cli/src/main.ts` (~318), `casm wait` | **`casm wait` can point at the wrong kept message.** It uses `findLast(reason === "failed")`, which can name an older kept message when this turn kept none (for example, it failed after a partial answer). | Have the server return the kept ids in `lastTurn`. |
| 11 | Low | `packages/server/src/server.ts` (~128), peer forwarding | **Forwarding strips unknown parameters.** It forwards the zod-parsed params, so a newer peer's extra parameters are silently removed. | Forward `req.params` once validation passes. |
| 12 | Low | `packages/server/src/server.ts`, peer forwarding | **Relayed notifications carry the peer's name.** They use `host: peer.name` even when the client addressed the peer by server id. | |
| 13 | Low | `packages/server/src/server.ts`, peer forwarding | **A client that disconnects during `peers.subscribe` leaks the peer subscription.** `client.remote.set` runs after the close handler. | |
| 14 | Low | `retryPending` | **Latent: a failed retry could keep the message twice.** If `session.send` threw synchronously, `endTurn → keepUnanswered` would re-add the message, and then the catch would add it again. Neither provider's `send` throws synchronously today. | |
| 15 | Low | `effectiveModel` | **Can stay stale after a mid-turn model change.** The old Claude session can still send `system/init` with the old model after the field was cleared. | |
| 16 | Low | `0a48cda`, context window lookup | **May guess wrong for 1M sessions.** The lookup uses the transcript model id, which has no `[1m]` suffix, so a 1M session can show over 100% context. | |
| 17 | Low | `14ee993` / `04e63bf` | **Two settings are forced on every session.** Claude sessions always get `thinking: {type: "adaptive", display: "summarized"}`, which may break on gateways or models without it. Codex always overrides the user's `model_reasoning_summary`. | |
| 18 | Low | `packages/cli/src/main.ts` `firstCommand` | **An option's value can be read as the command.** Only `-H`/`--host` values are skipped, so `casm --name peer run …` is routed to the server command. | |
| 19 | Low | `apple/App/Shared/Markdown.swift` | **Display math is only partly handled.** Multi-line `\[ … \]` isn't parsed. `$$a$$ and $$b$$` on one line becomes one block. | |
| 20 | Low | `testProjectTapStartsANewAgent` | **The UI test leaks agents.** It creates a new agent on every run and never removes it. | |

**Design note:** `agent.interrupt` also clears kept `failed` messages. A test asserts this, so it is intentional, but it works against "kept, not lost". Worth revisiting.

## Missing tests

**Server:**
- `dropAnsweredFailed` with repeated or empty prompt text.
- `retryPending` while the agent is busy (queued result) or limited (`deferredUntil`), and when the retry fails.
- Forwarding with a server-id host and with unknown params, plus peer error-code mapping.
- A client disconnecting during subscribe.
- The `effectiveModel` race after a mid-turn config change.
- The context window for `[1m]` models.

**CLI:**
- `casm retry`, and `casm wait` exit 5 with its message.
- The duplicate `token create` error.
- `token list --json` and `peer list --json` (including that tokens are never printed).
- The human-readable `casm peers` output.
- `casm shell` exiting 1 through `lastTurn.outcome === "failed"`.

**Apple / CasmKit:**
- The `ChatModel` new-agent flow: create success and failure, the first message being replaced by the agent's copy, and the per-project draft key.
- `Agent.effectiveModel` decoding: no fixture checks it.
- `peer.disconnected` host decoding.
- UsageChip "—" and exhausted states.
- Streaming `DraftRow` markdown and the reasoning `latestLine`.
- `ThinkingRow` trimming.
- `named()` alias matching for `[1m]` ids and names like "(1M context)".
