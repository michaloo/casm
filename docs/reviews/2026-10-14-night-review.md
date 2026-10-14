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

## Follow-up: items #9–#20

The Mac agent fixed the Apple items:

| # | Commit | Finding |
|---|---|---|
| 9 | `2dc33dd` | Leaving a new-agent chat mid-create no longer pulls the user back. |
| 19 | `a4f29da` | Multi-line `\[ … \]` is display math; `$$a$$ and $$b$$` on one line stays inline. |
| 20 | `bb381d3` | The project-tap UI test deletes the agent it creates. |

The server and CLI items are fixed below, one commit each, each with a test that fails without it:

| # | Commit | Finding and fix |
|---|---|---|
| 10 | `6c3a1ca` | **`casm wait` could name an older kept message.** `agent.wait`'s `lastTurn` now carries `kept`: the ids the turn kept, oldest first. `casm wait` names the first. This is a protocol addition and `spec/protocol.json` is regenerated. CasmKit doesn't decode `lastTurn`, so nothing changes there. |
| 11 | `b21989f` | **Forwarding stripped unknown params.** A forwarded request now goes to the peer as sent, after local validation. |
| 12 | `919f90e` | **Relayed notifications carried the peer's name.** They now carry the host the client named, as the spec says. A client that used the server id gets the server id back. `peer.disconnected` does the same. |
| 13 | `d93dba9` | **A client gone mid-subscribe leaked the peer subscription.** It is now ended. `RunningServer.peers.relayed` counts relayed subscriptions so the test can see the leak. |
| 14 | `092880f` | **A retry whose send throws kept the message twice.** The original goes back only when the failed turn didn't keep it already. |
| 15 | `da55d9a` | **`effectiveModel` stayed stale after a mid-turn model change.** Model reports from a session due for reload after the turn are now ignored. |
| 18 | `e973cc7` | **A flag's value before the command was taken for the command.** For example, `casm -p token projects` (a project named "token") went to the server's token command. The values of all flags that take one are skipped now. |

Not fixed, because each needs a decision:

| # | Sev | Finding | Why it was left |
|---|---|---|---|
| 8 | Medium | **`dropAnsweredFailed` can drop a kept prompt that was never delivered.** It happens when an earlier prompt with the same text was answered. | See the design note below. Behaviour unchanged. |
| 16 | Low | **The context window for 1M Claude sessions.** | Transcripts record `claude-opus-5-5` with no `[1m]`; I checked against real session files on ubuntu. The history path (`usage()` after a restart) can't tell a 1M session from a 200k one by model id alone. The `windows` map is shared per provider and keyed by that id, so 1M and 200k sessions of one model can overwrite each other's window. A fix needs the agent's configured model passed into `usage()`, with the map keyed by it, which changes the provider interface. Live sessions get the window from `result.modelUsage` and are right after the first turn. |
| 17 | Low | **Forced `thinking: adaptive/summarized` (Claude) and `model_reasoning_summary` (Codex).** | These were deliberate product choices in `14ee993` and `04e63bf`. Making them conditional, for example skipping them when `ANTHROPIC_BASE_URL` points to a local gateway or when the user's `config.toml` sets the key, is a call for Michal. No failure has been seen yet. |

### Design note for Michal: #8, dropping kept prompts at startup

**The problem.** After a server stop, an unanswered prompt is kept as a `failed` pending message. The agent's process can outlive the server and answer it anyway. To avoid a duplicate retry, startup drops a kept message when the agent's history shows that prompt answered. The match is by **text**: the last user item with the same text that has any assistant item after it.

Short or repeated prompts ("continue", "yes", "go on", image-only with empty text) usually have an older answered copy in history. So a prompt that never reached the agent is silently deleted. That is a quiet loss, the worst outcome for the "kept, not lost" feature. The case it guards against, a duplicate visible to the user, is much milder.

**What we can rely on:**
- casm gives every prompt an item id and passes it to `session.send(text, itemId)`.
  - **Claude** sends it as the SDK user message `uuid` and writes it to the transcript, and history items use that uuid as their id. A prompt that reached Claude can therefore be found by **exact id**.
  - **Codex** gets it as `clientUserMessageId`, on steers only. I haven't checked whether the thread history returns it.
  - **OpenCode** and **pi** ignore it.
- History items carry no timestamps.
- At shutdown, `keepUnanswered` is synchronous. There's no time to read history then.

**Options:**
1. **Store the sent item id on the kept message, and match by id (exact).** Add `sentItemId` to the pending row (a nullable column). At startup, drop the message only if a history item with that id exists and an assistant item follows it.
   - For Claude this is exact both ways: no false drops, and duplicates are still caught.
   - Other providers need option 2 or 3 alongside.
2. **Anchor on history position.** When a turn starts, record the id of the last history item, by reading history async while the turn runs. Store it as `afterItemId` on a kept message, and only match text after the anchor.
   - Works for every provider.
   - Costs a history read per turn and adds a race: the turn may end before the read does.
   - Text matching still can't tell two identical prompts sent after the anchor apart (rare).
3. **Never auto-drop for providers without stable ids.** Keep the message, with a note such as "the agent may have answered this after the server stopped; check the transcript before retrying".
   - Nothing is ever lost, but the user may see a message that was in fact delivered.
4. **Status quo** (text match): duplicates are caught for every provider, at the cost of silent loss on repeated text.

**Recommendation: 1 + 3.**
- Use exact id matching for Claude, the provider where the outlived-process case was actually seen.
- Extend it to Codex if a check shows its thread history keeps `clientUserMessageId`.
- Use option 3 for OpenCode and pi.

It's small: one nullable column, the id threaded through `keepUnanswered` (`l.prompt` / `l.steered` would carry the item id `sendToSession` generates), and a branch in `dropAnsweredFailed`. It replaces a silent loss with, at worst, a visible and cancellable duplicate. Option 2 is the fallback if you'd rather keep automatic dropping for every provider.

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
