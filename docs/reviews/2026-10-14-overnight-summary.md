# Overnight summary: building casm with casm (2026-10-13 23:15 → 2026-10-14 06:30 UTC)

The main agent ran on ubuntu (agent `4983919b`) and coordinated agents on two hosts through casm.
59 commits landed on `casm-ng`, from `800edae` to `52c64a5`. All of them are pushed. `npm test` passes
180/180 and tsc is clean. `spec/protocol.json` matches the code.

## Agents

| Agent | Host | Provider | Did |
|---|---|---|---|
| `467f87b6` macOS: project → composer → new agent | macbook | Claude Opus, auto | Main task, thinking display, effective model, failed-pending UI, iOS parity, hourly UI passes |
| `5b3f87f3` peers replace CLI hosts | ubuntu | Claude Opus, auto | Host/peer merge, end-to-end sweep (`2026-10-14-night-e2e.md`), its 3 open items |
| `4de54d41` night review (from a schedule at 02:45) | ubuntu | Claude Opus, auto | Reviewed 40 commits (`2026-10-14-night-review.md`), 7 fixes, then 7 follow-ups |
| `f3e9af77` subagents+limits: claude | ubuntu | Codex | Its message waited out the Codex limit, resumed at the 23:32 reset, finished Claude subagent mapping (`ac1aabb`) |
| `57a25b94`, `dc72bdf7` (from schedules) | ubuntu | Codex, auto | Stuck at the first command on the Codex sandbox (see below). Archived and replaced by Claude agents |
| short-lived "deploy: Mac stable casm" | macbook | Claude Sonnet | Fast-forwarded and restarted the Mac stable server once (23:3x) |

## What was tested, and how it went

- **Across machines.** ubuntu ↔ macbook through casm peers.
  - **ubuntu → Mac:** `casm -H macbook run/send/--steer/history/shell/schedule add`.
  - **Mac → ubuntu:** the Mac agent reported to `4983919b` with `casm -H ubuntu send` (about 20 messages).
  - **Parent links:** set across hosts with `--parent <serverId>/<agentId>`.
  - **Unreachable peer:** when the MacBook went to sleep (around 04:50), `-H macbook` failed fast with "unreachable", without hanging.
- **Between agents.** Status reports, task hand-offs, and a warning to f3e9af77 before the Mac agent edited `claude.ts`.
  These were queued while the receiver was busy and delivered in order.
- **Steer.** Sent from ubuntu into a running Mac turn and confirmed ("steer received"). Later fixed: steers were dropped from Claude
  history (`e257193`), and lost when the turn died (`ea12bcd`) or hit a usage limit (`2a09253`).
- **Schedules.**
  - **ubuntu:** two `once` jobs that create an agent, `every 90m` to me with `--skip-if-busy`, a `once` review agent, and a `once` wrap-up.
    All fired on time.
  - **Mac:** an `every 60m` UI pass fired hourly, and skipped while the agent was busy as intended. An app "Send later" at 5:38 was delivered.
  - **Fixed along the way:** runs missed while the server was down now fire at startup (`c1456fc`). A kept failed message no longer makes
    `--skip-if-busy` skip forever (`0cb4e7e`).
- **Limits.**
  - **Codex:** a message waited out the exhausted 5-hour window and resumed after the reset with no help.
  - **Claude usage chip:** showed a reset time without a percent. Root cause: live rate-limit events wiped the account value
    (`b192c47`, app `bfa9017`).
  - **Context window:** Claude usage now includes it (`0a48cda`).
- **Subagents.** Claude subagent lifecycle and child history (`ac1aabb`). The e2e sweep checked parent linkage for Claude and Codex through
  MCP, through the CLI in an agent shell, and with `--parent`.
- **Server restarts with live agents.** The ubuntu stable server was redeployed 7 times. A message sent just after a restart was lost
  (seen live on the Mac). Fixed: prompts are kept as `failed` pending messages across stops and failed turns (`d82c51b`, `93af8cd`,
  `34ef07b`), and Retry/Cancel were added to the apps (`f9590c7`).

## Shipped features

- **Main task, macOS:** clicking a project opens an empty new-agent chat with the full composer. The first send creates the agent, and
  the same chat adopts it (`fc0371d`). Cmd-N preselects the project. Agents are named after the first message (`b625b9c`). The same works on
  iOS (`cf7d436`).
- **Thinking rows:** they were empty because Claude omits thinking by default and Codex sent no summaries. Now Claude uses
  `thinking: adaptive/summarized` and Codex uses `model_reasoning_summary: detailed` (`14ee993`, `04e63bf`). Streaming reasoning
  renders as the Thinking row it becomes (`e9a6e20`).
- **Effective model:** agents report the model they actually run (`35a1aee`, `59ccfef`). The picker no longer claims GPT-6.1-Sol while
  Codex runs gpt-6-astra.
- **One peer concept:** on a server machine, `casm -H x` goes through the local server's peer `x` (`8fbb267`). `hosts.json` is used only
  without a server, and `casm peers` lists the names. Server-only commands refuse `-H` (`62d610a`).
- **Missing folders:** project folders must exist. Sessions in a missing folder fail loudly instead of silently dropping messages
  (`207155e`, `bb37b0e`).
- **Smaller fixes:** CLI fixes (`800edae`, `4c962de`, `629962b`, `e973cc7`), display math as code (`f426f3f`, `a4f29da`), and app polish
  passes.

## Deploy state

- **ubuntu stable:** `52c64a5`, running since 03:15. DB backups are `~/.casm-ng/casm.db.bak-before-*`.
- **Mac stable:** still old code. The Mac agent's restart and app install were blocked by its Claude Code permission classifier.
  - **The Mac server runs from the dev checkout** `~/Projects/casm-ng`, not a pinned one like ubuntu's.
  - **Release app:** built at `bb381d3` in `apple/build/rel/…/casm.app`, not installed.
  - **The Mac server has no peers.** After its restart, `casm -H ubuntu` on the Mac only works through peers, so add one first:
    `casm peer add ubuntu ws://100.68.62.102:7373 <token>`.
- **The MacBook went to sleep around 04:50,** and its hourly UI schedule (`0ca7221f`) is still enabled. Disable it with
  `casm -H macbook schedule disable 0ca7221f` if you don't want it.

## Open questions for Michal

1. **Kept prompts dropped at startup (#8).** Recommendation: match by the item id casm sends (Claude keeps it), and never auto-drop for
   providers without stable ids. See the design note in `2026-10-14-night-review.md`.
2. **1M context (#16).** Transcripts don't record `[1m]`, so usage needs the agent config passed into the provider. Worth doing?
3. **Forced thinking and reasoning summaries (#17).** Always on now. Keep it, or make it a per-agent or global setting?
4. **One-time schedules that already fired** stay listed (disabled) with a last-run link. Keep this, or add "clear finished"?
5. **Codex sandbox on ubuntu.** bwrap fails (AppArmor userns), so Codex in `auto` asks permission for every command, and the restart
   dropped those requests. Options: `sudo apt install bubblewrap`, or allow `full-access` for night agents.
6. **Permissions for unattended work.** Your approval relayed through casm doesn't clear Claude Code's auto-mode classifier in other
   sessions. Deploys, Mac restarts, the app install, creating tokens and `full-access` agents all needed you. Allow rules (for example
   `Bash(casm:*)`, `casm service restart`, the app install commands) would let a night run finish end to end.
7. **Mac stable from the dev checkout.** Move it to a pinned worktree like ubuntu (`docs/development.md`)?
8. **Smaller items:** LaTeX is shown as code, not rendered (no native path without a dependency). CasmKit doesn't decode
   `agent.wait.lastTurn`. Claude doesn't report a model until `system/init`.
