# Night test: inter-agent communication and schedules, 2026-10-15

**Setup:** an isolated dev server (`CASM_DEV_HOME=/tmp/casm-comms`, port 7601) with a scratch project, and for the
cross-host case a second dev server (`/tmp/casm-comms-b`, port 7602) peered with it. Disposable agents only: Claude
`haiku`, OpenCode `opencode/big-pickle`, and pi on the local `laguna-xs-2.1` model through fedora (held for the run).
The stable service and the :5173 Vite service were not touched. Agents spawned by a dev server inherit `CASM_URL`,
`CASM_TOKEN` and `CASM_HOME` of that dev server, so their `casm` commands stay on it.

**Decisions made unattended:**
- Agents ran in `default` mode and every permission was approved by hand (`casm approve`). Creating a bypass-permissions
  agent, and approving an MCP `create_agent` call from a Claude agent, were refused by the environment's safety
  classifier; I did not work around either. `create_agent` over MCP was tested from a pi agent instead (pi has no
  permission system, so its MCP calls need no approval).
- Cross-host: the macbook peer answers `casm peers --probe` (reachable, 5 ms), but using it needs a token from the
  stable server and would touch non-disposable state, so the cross-host case ran between two peered dev servers on
  loopback. The macbook itself was **not** exercised.

Timings are wall clock on ubuntu, from the command to the observed result.

## Results

| # | Scenario | Expected | Actual | Time | Status |
|---|---|---|---|---|---|
| 1 | Spawn via CLI (`casm run` inside an agent) | child exists, `parent` = spawning agent and its server/host | `kid-cli` got `parent {agentId, serverId, host}` | agent id in 0.3 s, first reply ~5 s | pass |
| 2 | Spawn via MCP `create_agent` | same | from a pi agent: `kid-mcp` created with the parent link, `mcp__casm__wait` returned its reply. From a Claude agent: the approval was refused by the classifier, so not run | ~25 s (pi, local model) | pass (pi); blocked (Claude) |
| 3 | Host agent prompt applied | child's system prompt names its id, host, project, cwd | child answered "agent kid-cli on host casm-dev" and described the casm CLI; `casm agent-prompt kid-cli` shows the filled prompt | 4 s | pass |
| 4 | `--env K=V` | var visible in the agent | `MARKER=hello42`, plus `CASM_URL`/`CASM_AGENT_ID`/`CASM_SERVER_ID` of the dev server | 5 s | pass |
| 5 | Child reports back with `casm send` | parent gets the message with the sender's name and host | history shows `from kid-cli · casm-dev` and `sender{serverId, agentId, name, host}` | 12 s incl. approval | pass |
| 6 | Strict FIFO while busy | essay, then SECOND, then THIRD in order, one per turn | listed `queued` x2 in order; history order FIRST, SECOND, THIRD | 32 s | pass |
| 7 | Steer into a running turn | message absorbed in the running turn | pi (slow model): steer arrived between tool calls and was answered `STEERED-PI`. Claude haiku finishes too fast to catch mid-turn; its steer was delivered as the next item | 22 s (pi) | pass |
| 8 | Interrupt keeps the queue | turn stops, next message runs | `[Interrupted]` on the essay, `AFTER-INTERRUPT` answered; `wait` printed "the turn was interrupted" | 1 s | pass |
| 9 | Failed head: Retry now / Cancel | failed prompt kept, queue held; retry tries again; cancel releases the queue | bogus model: prompt kept as `failed`, `wait` exit 5 with the error, a second send stayed `queued` behind it, `retry` ran it again (failed again, kept), `cancel` of the head let the next message run, `cancel --all` emptied it | 8 s | pass (note: a failed retry keeps the message under a **new id**, by design: "the agent may have recorded the old one") |
| 10 | Idempotent `--message-id` | one delivery | two sends while queued, one after delivery: exactly one `IDEMP` in history, one pending entry | 25 s | pass |
| 11 | `wait` / `history` | exit codes 3 (busy), 5 (failed); history shows items and senders | as documented | - | pass |
| 12 | Schedule `--at` (once) | fires at the time, then disables itself | due 21:12:59, sent 21:13:04 (tick lateness), `disabled`, `last sent` | +5 s | pass, but late (**bug 1**) |
| 13 | Schedule `--every 1m` | fires every minute | fired, but each run moved the next one by the tick lateness: 21:12:59 → 21:14:04 → 21:14:51 (**bug 1**) | drift 5-11 s per run | fail, fixed |
| 14 | Schedule `--cron "* * * * *"` | fires on the minute | fired 21:13:00-21:13:05 | <=5 s late | pass |
| 15 | `--skip-if-busy` | skipped while busy, sent when idle | `schedule run` while the target ran: `skipped`; the unit test also covers a failed head and the idle case | 1 s | pass |
| 16 | Schedule that creates an agent from a preset | new agent named `<name> · <time>` with the preset's model, env and the prompt; schedule disables after a once | `preset-run · Oct 14, 09:15 PM`, config `{model: haiku, env: {FOO: bar}}`, replied `PRESET-OK`, sender = schedule | 80 s incl. the 1 min wait | pass |
| 17 | Missed runs after a server restart | each missed schedule fires once on start | server down 21:17:02-21:18:30 with a once, an every and a cron due: after restart all three fired once within 6 s, nothing repeated, next runs computed from now | 6 s | pass |
| 18 | Target agent busy | message queued as pending behind the turn | `queued`, sender = schedule, delivered in order | 2 s | pass |
| 19 | Target agent limited | message pending behind the limit-held message, delivered in order after recovery | not reproducible live (no cheap way to hit a real limit); new unit test `schedules.test.ts` covers it | unit | pass (unit) |
| 20 | disable / enable / edit / delete | each takes effect | disable stopped firing and showed `disabled`; enable restored `next`; delete removed. **Edit was RPC-only** (`schedule.update`); now `casm schedule edit` | 2 s | pass, CLI gap fixed |
| 21 | Sender shows the schedule name | history says which schedule sent it | sender carries `schedule {id, name}`. The CLI printed the default name `→ kid-cli` as `from → kid-cli`, which read like a person; now `from schedule → kid-cli` / `from schedule <name>` | - | pass, wording fixed |
| 22 | Claude <-> OpenCode | each reaches the other with the right sender | `oc` sent to `kid-cli` (bash `casm send`); `kid-cli` replied to `oc`; both histories show the other as sender | 30 s | pass |
| 23 | pi <-> OpenCode <-> Claude | pi uses MCP `send`/`wait` | `pipi` -> `oc` (answered DONE), `oc` -> `pipi`, `pipi` -> `kid-cli` (`PI-TO-CLAUDE-OK` via `wait`) | 45 s | pass |
| 24 | Cross-host message | message arrives with the remote sender | agent on server B ran `casm -H a send kid-cli ...`; A's history shows it with B's server id and agent | 33 s incl. approval | pass (loopback peers) |
| 25 | Cross-host to the macbook | one message | not run, see decisions | - | skipped |

**Counts (25 scenarios): 21 pass, 3 pass after a fix (13 drift, 20 no CLI edit, 21 wording), 1 blocked (2, Claude half,
passed from pi), 1 skipped (25, macbook). 0 unexplained failures.** Row 13 was re-verified live on the fixed server:
runs at 21:29:49, 21:30:49, 21:31:49, next 21:32:49.

Verification: `npm run typecheck`, `npm test` (314 pass), `npm run build`, web Playwright 125/128 on the first run;
the 3 failures were `visual transcript · mobile` timeouts waiting for a scroll position under load (this run's agents
and other workers were using the machine), unrelated to this change, and all six `visual transcript` cases pass on a
rerun after the rebase.

## Bugs and fixes

1. **Schedules fired up to 15 s late and `every` drifted** (`packages/server/src/schedules.ts`). The scheduler ticked
   every 15 s, and after a run the next one was `tick time + interval`, so each late tick pushed every later run back
   (an `every 1m` schedule ran at :04, :51 and so on instead of once a minute). Fix: tick every 5 s; an interval counts
   from when the run was due, falling back to now after a long gap so a missed run still happens once. Test:
   `schedules.test.ts` ("an interval counts from when the run was due...").
2. **No way to edit a schedule from the CLI.** Added `casm schedule edit <schedule> [--name] [--cron|--every|--at] [prompt]`.
3. **`casm history` showed a schedule's default name as a person** (`from → kid-cli`); it now says `from schedule ...`.

New test: a schedule firing at a limited agent leaves a pending message with the schedule as sender; edit, disable and
enable apply; the held message and the scheduled one go in order after recovery.

## Observations, no change

- A retried failed message that fails again gets a new pending id (`agents.ts` `keepUnanswered`, deliberate). Scripts
  must re-read `casm pending` after a retry.
- `--every` has a one-minute minimum; `--every 30s` becomes 1 m.
- Both dev servers are named `casm-dev`, so the host in a cross-host sender looks identical on both sides; give peers
  different `--name`s when reading provenance.
- Claude haiku finishes short essays in about 2 s, which makes a mid-turn steer hard to hit; use a tool call or a slow
  local model to test it.
