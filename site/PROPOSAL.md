# casm landing page: proposal

The mockup is [`index.html`](index.html): one file, inline CSS and SVG (the
logo glyph only), no JS, no web fonts or CDNs, light and dark via
`prefers-color-scheme`. Checked at 1440 and 375 px in Chromium, with no
horizontal overflow.

## Positioning

casm is an unopinionated, self-hosted agent orchestrator. It provides
primitives and does not impose a workflow. The page states this in plain
technical language: no slogans, no claims without a source.

## Structure

1. **Intro.** Headline: "casm is a self-hosted orchestrator for Claude Code,
   Codex, OpenCode and pi." A three-sentence lede, the install commands from
   `docs/getting-started.md`, the requirements line.
2. **Architecture.** Server, protocol, clients, peers: one bullet each.
3. **Primitives.** A table: primitive, CLI command, what it does.
4. **What casm does not do.** Four bullets.
5. **What leaves your machine.** A table (data, stored, sent to) and the
   "do not expose 7373" note.
6. **Footer.** Links to the docs on GitHub.

## Sources

| Claim | Source |
|---|---|
| Node + SQLite in `~/.casm-ng` | `packages/server/src/db.ts` (`node:sqlite`) |
| JSON-RPC 2.0 over one WebSocket port, token per connection | `docs/network.md` "What casm exposes", `spec/protocol.json` |
| systemd user unit / launchd agent | `scripts/service.sh` |
| Peering forwards, copies nothing | `docs/concepts.md` "Hosts and peers" |
| Primitives and `wait` exit codes | `casm --help` |
| Does not do: sandboxing, sync, relay | `docs/concepts.md` "What casm deliberately does not do" |
| No worktrees, branches, PRs, task boards | Absence: no such command in `casm --help`; `--cwd` takes a sub-folder |
| No telemetry; outbound is peers and Web Push | `docs/network.md` "What casm exposes" (Outbound) |
| Default bind `127.0.0.1:7373`; never expose 7373 | `docs/network.md` "Requirements" |

## Open questions

1. Install: is an npm package or a one-line installer planned?
2. Hosting: GitHub Pages under a project domain? No analytics on the site.
3. Should the page show a screenshot (`docs/media/web-agent-*.png`)? It is
   left out to keep the page text-only.
