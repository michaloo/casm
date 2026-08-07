# Changelog

## 0.7.1 - 2026-08-07

- package metadata only: `repository`/`homepage`/`bugs` now point at
  github.com/michaloo/casm, which also makes the README's demo image render on
  npmjs.com. No code changes.

## 0.7.0 - 2026-08-07

### Added

- **Bookmarks**: `casm bookmark <id-prefix> [alias]` (alias: `casm bm`) pins
  sessions you intend to come back to. Bookmarked sessions sort to the top of
  `casm continue` with a `★` marker, and an alias works anywhere an id-prefix
  does: `casm resume casm-work`, `casm show casm-work`, `casm push casm-work
  fedora`. `casm bookmark` lists (marking entries whose session is gone),
  `casm bookmark rm <alias|id-prefix>` unpins. Stored in
  `~/.config/casm/config.json` next to `hosts`.
- **Context column**: every listing (`list`, `continue`, `active`, `bookmark`,
  `pull`) shows the tokens that filled the model's window on the session's
  newest turn (input + cache read + cache write, from each agent's own usage
  records - claude/pi transcripts, opencode db). Blank for sessions with no
  turns yet. `list --json` carries it as a raw `ctx` field.

### Fixed

- `casm list --json` run by hand no longer goes through the all-hosts fan-out,
  which interleaved per-host headers with the JSON and made it unparseable.
  `--json` is single-node machine output by definition.
- `list --id` now accepts ids pasted with the trailing `…` that listings print,
  matching the normalization `show`/`resume`/`push`/`pull` already did.
- opencode `pull` checks for the `opencode` binary up front instead of dying
  with a raw `spawn opencode ENOENT` mid-import.

## 0.6.0 - 2026-08-06

First npm release, as `casm-cli`.

- **Fleet by default**: `active`, `list`, and `search` cover this machine plus
  every configured host; scope with `--local` or `--host <ssh-target>`. Remote
  probes run in parallel; remote invocations are pinned to `--local` so two
  machines listing each other cannot recurse.
- **Hosts are plain ssh targets** managed with `casm host add/list/rm`
  (usernames, ports, identities belong in `~/.ssh/config`). `host list` probes
  every host: ready / no casm / unreachable.
- **`casm continue`**: interactive picker over the most recent local sessions;
  chdirs into the picked session's directory and resumes it by id with its own
  agent.
- **`casm pull` covers all three agents** (was claude-only) and talks to the
  remote's own casm (`list --json`) instead of scraping transcripts over ssh.
- **`casm show`** finds a session wherever it lives: local first, then every
  configured host; `--host` targets one.
- **Exact claude session identity** in `active` via claude's own
  `~/.claude/sessions/<pid>.json` (right session even with two claudes in one
  directory, plus claude's display name). Status is still derived from the
  transcript: generating / running tool / waiting approval? / working /
  stalled? / idle. Utility invocations (`opencode db`, `pi install`,
  `claude mcp`) are no longer listed as sessions.
- **Same-id transfers surface divergence**: transfers keep the session id, so
  `show` prints an `also on <host>` line for every other machine holding that
  id, and push/pull refuse to overwrite an existing copy - `--force` says whose
  copy it is replacing and how recently it was touched.
- Session ids can be abbreviated everywhere (unique prefix); listings truncate
  ids with `…` and pasting that back works.

## 0.5.0

Internal pre-npm version: list/search/show/resume across claude code, opencode
and pi; push/pull of claude sessions between machines over ssh.
