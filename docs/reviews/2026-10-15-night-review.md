# Night review: origin/main since 2026-10-14 20:45 UTC, 2026-10-15

**Scope:** 22 commits, `68200e4` (20:47 UTC) through `5a51731` (00:16 UTC), reviewed in a fresh worktree
(`.worktrees/night-review`, branch `w-night-review`). That covers: transcript follow/pin, the queue pill and panel,
the Apple PWA (app shell worker), schedules (anchored intervals, 5 s tick, `casm schedule edit`), host and project
modals (Files tab and host-wide memories removed), sidebar model names, tool/thinking expansion, Usage cards,
composer picker labels, the user guide and media, and Playwright fixture changes (a fresh server per test). The stable
server was not touched. Playwright used its own port (7795) and home (`/var/tmp/night-review/web-home`).

## Checks

| Check | Result |
|---|---|
| `NODE_ENV= npm ci` | ok |
| `npm run typecheck` | ok |
| `npm run schema` | `spec/protocol.json` unchanged |
| `TMPDIR=/var/tmp/casm-unit npm test` | ok, before and after the fixes |
| `npm run build` | ok |
| web Playwright (Chromium 1440 + WebKit iPhone 13 mini) | 138 passed, 0 failed, 0 flaky (7.7 min) |

## Findings, by severity

### Fixed (each in its own commit, with a test)

1. **Medium: editing a schedule restarted an interval's countdown** (`packages/server/src/schedules.ts`,
   `update`). `schedule.update` recomputed `nextRunAt` from now on every call. Renaming a schedule or changing its
   prompt (`casm schedule edit --name …`, new tonight) pushed an `every 24h` schedule back by up to a day. Every save
   from the web edit form did the same, because it resends the unchanged cadence. Now only a changed cadence or
   re-enabling recomputes the next run. Test: `schedules.test.ts` (fails without the fix).
2. **Medium: `casm send --wait` exited 0 when a usage limit deferred the message** (`packages/cli/src/main.ts`).
   The new docs/cli.md documents exit 4 for this case, and `run --wait` returns 4. `send --wait` printed "queued
   until …" and exited 0, so a script took the deferred send for a finished turn. It now exits 4. Test:
   `cli-send-wait.test.ts` (fails without the fix).
3. **Low, docs:** `docs/protocol.md` used port 7481 in its curl and client examples. The default is 7373, so the
   examples failed as copied. It also now says that remote clients need `listen`. `docs/cli.md` said schedules show
   as `from <agent> · <host>`; the CLI prints `from schedule <name>`. It also didn't say that history defaults to the
   last 50 entries.

### Open (not fixed: lower confidence, design calls, or wide changes)

4. **Low-medium, efficiency: sidebar model lookups retry on every host update** (`main.tsx`, `rowModels`
   effect). A failed `provider.catalog` call deletes its key, and the effect runs again on every `hosts` change. If a
   provider's catalog keeps failing on a host, the client asks again on every agent status event. Suggestion: remember
   failures per connection, as with successes.
5. **Low, UX: no "Latest ↓" after a non-gesture jump** (`main.tsx`, `Transcript`). The button now needs
   `!following.current`, and only wheel, touch, keys and scrollbar pointer clear `following`. If find-in-page, focus or
   a script moves the reader up, `nearEnd` stops the pin (as intended), but `following` stays true, so no "Latest"
   button appears. The reader has to scroll back down by hand.
6. **Low, CLI: `--every` goes through `parseWhen`** (`schedule add`/`edit`). `--every 18:30` or an ISO time is
   accepted and silently becomes "minutes until then". A duration-only parser would reject them. (This predates
   tonight; `edit` copies it.)
7. **Low, behaviour change to confirm:** `6d7261c` removed the project Files tab and folder browser, and host-wide
   memory search. The commit message says this is intentional. A folder path in a transcript now shows "This is a
   folder…" instead of a listing. The docs match the new behaviour.
8. **Low, cleanup:** `packages/web/public` still ships `manifest-dark.webmanifest`, `apple-touch-icon-dark.png` and
   `icon-dark-192.png`. Nothing references them since the single-manifest PWA change.
9. **Low, efficiency:** the transcript's `MutationObserver` watches the whole scroller subtree (child list, text and
   `style`), so every streamed token calls `stick()` plus a rAF. This is cheap per call, but worth profiling on long
   streams on a phone.

### Docs accuracy (the new user guide)

Verified against the source: every relative link, anchor and media path resolves; the MCP tool list matches
`mcp.ts`; CLI commands, flags and defaults (`127.0.0.1:7373`, `~/.casm-ng`, `--provider claude`, exit codes
3/4/5) match; the PWA doc matches the worker, the manifest and the server headers.

Remaining inaccuracies (not fixed, all low):
- `docs/cli.md` / `README.md` / getting-started: `casm host add` / `hosts.json` is "for a machine without a server",
  but the CLI keys off `$CASM_HOME/local.json`, which `casm serve` writes and nothing removes. A machine that once ran a
  server keeps preferring it.
- `CASM_LISTEN`, `CASM_NAME`, `CASM_WEB_ROOT` and the `web` config key are undocumented, and they override
  `config.json`.
- `docs/cli.md`: `get` refuses to overwrite without `--force` (undocumented); `retry --wait` and `service logs N` are
  missing; exit code 2 (server usage) and `shell` exit 3 are not listed; the `token list` and `subagents` examples
  don't look like real output (the subagent id is the permission request id from another example).
- `docs/protocol.md` / `concepts.md`: a re-sent `messageId` is deduplicated only while the message is pending, or until
  the server restarts (delivered ids are kept in memory). Error code 1003 also covers archived agents, reused message
  ids and unavailable providers. `/dl/<token>` is really `/dl/<payload>.<mac>/<filename>`. Reload interrupts a running
  turn and resumes on the next send.
- `docs/troubleshooting.md`: "revoked tokens stop working at once" holds only for new connections; open sockets stay
  up until they reconnect. On a peer disconnect the CLI exits ("lost the connection"); only the web client reloads.
- `docs/web-client.md`: the schedule form repeats in minutes, hours or days, not just "every N minutes".
- `scripts/docs-media/README.md`: `showcase-server.ts` resolves `packages/web/dist` from the cwd, so it must run from
  the repo root.
