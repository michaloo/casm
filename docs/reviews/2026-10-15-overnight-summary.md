# Overnight summary: 2026-10-14 20:45 → 2026-10-15 06:30 UTC

26 commits landed on `main`, from `8588b96` to `4433da7`. The **stable server and the `:5173` preview both
run `4433da7`**; the server restarted at 02:41 UTC. Final checks: typecheck, **317 unit** tests, build,
**Playwright 138/138** on Chromium and WebKit iPhone, and `spec/protocol.json` unchanged.

## What each worker did

| Worker | Result | Key commits |
|---|---|---|
| **PWA**, Codex `53e01fae` | Installable on iPhone (Share → Add to Home Screen) and on macOS Safari (File → Add to Dock). Opaque Apple, 192/512 and maskable icons, a stable manifest and Apple meta tags. The service worker is versioned, caches the shell only, and runs on secure origins only. The README has an "Install as an app" section. Michal installed it on Safari last night | `98908ee` |
| **Inter-agent + schedules test**, Sonnet `8fae8e30` | 25 scenarios on an isolated dev server: 21 pass, 3 pass after fixes, 1 blocked, 1 skipped (see `docs/reviews/2026-10-15-night-comms.md`). Fixes: `every` schedules no longer drift because they anchor to the due time, the tick dropped from 15 s to 5 s, a new `casm schedule edit`, and history shows "from schedule X" | `c84e960`, `4ca2d47` |
| **UX**, Opus `738d57ec` | Follow-bottom pins the true end, so replies are no longer cut off and "Latest ↓" only appears after a real scroll-up. A crisp queue pill and a proper queue panel. Settings got a section rail, a real editor, memory search and a prompt preview. **Unified modals**: ⋯ opens the Host modal (Usage · Schedules · Instructions) or the Project modal (AGENTS.md · Memories · Info) directly. The `+ New project` button sits on the host row. The Files tab and host-wide memories are removed | `68200e4`, `737d500`, `8588b96`, `6d7261c` |
| **Docs + media**, Opus `719f1721` | `docs/`: index, getting started, concepts, CLI (real output), web client, MCP tools, protocol and troubleshooting, plus a restructured README. `docs/media`: 3.2 MB of 2x light/dark stills, GIFs (send/steer, queue, schedule create, file preview, new project) and animated CLI SVGs, with tooling in `scripts/docs-media`. It also fixed the sidebar model names, turned Usage into provider cards and labelled the composer pickers | `174fa0a`, `07817d4`, `529c741`, `59ef925`, `62a3bef`, `7407b0e`, `8b12565` |
| **Test stabilizer**, Sonnet `a6835dd1` | The suite is reliable: 5 of 5 full runs green, and `--repeat-each=10` green on every formerly flaky spec, even under CPU load. It found a **real product bug**: an expanded tool or Thinking row remounted collapsed when the list virtualized it away (`ea3946c`). Each test now gets its own seeded server, and the reveal helper no longer deadlocks | `ea3946c`, `7c57c4a`, `116ea35`, `5a51731` |
| **Night review**, Opus `e22cd270` (02:30) | Reviewed 22 commits. It fixed schedule edits restarting the countdown and `send --wait` exiting 0 on a limit deferral (it now exits 4), and corrected doc ports and attribution | `053f213`, `965cad4`, `9a21e00`, `4433da7` |

## Decisions needed

1. **Claude spawning agents via MCP.** In auto mode, Claude's own safety classifier refuses MCP
   `create_agent`; the same call works through pi and through the CLI. Options:
   - (a) casm pre-approves `mcp__casm__*` in the Claude sessions it manages when casm tools are on;
   - (b) document that agents spawn agents with the CLI (`casm run`);
   - (c) leave it as it is.
2. **Codex project trust.** Add TagPilot (and Pingado) as trusted projects in `~/.codex/config.toml`.
   This silences the warning, and it also gives Codex agents in those projects the workspace-write
   sandbox under casm's `auto` mode.
3. **License.** The new `main` has no LICENSE. The legacy casm was MIT.

## Open issues (low)

- Sidebar catalog lookups retry on every hosts update after a failure.
- There's no "Latest ↓" button after a find-in-page jump.
- `--every` accepts clock or ISO times.
- Unused dark PWA assets sit in `public/`.
- Small doc gaps: the `CASM_LISTEN`/`CASM_NAME` env vars, `local.json` semantics, `get --force`, the
  meanings of error 1003, and token revoke on open sockets.
- Codex is at 60% of its weekly budget (resets Oct 21), so keep it on small tasks. Claude is at 9% weekly.

## State

- **Workers:** all finished and archived. Codex `53e01fae` is idle.
- **Schedules:** this summary was the last one. The 30-minute coordinator is disabled.
