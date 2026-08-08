# Changelog

## 0.8.1 - 2026-08-08

### Fixed

- Containers were unusable under rootless podman: it maps the host user to
  container root, so `--user <hostuid>` landed on a subuid owning none of the
  bind mounts and the project tree appeared root-owned and read-only from
  inside. casm now detects podman and uses `--userns=keep-id` instead, which
  keeps the uid non-root and the mounts writable. Verified on Fedora with
  SELinux enforcing, where `keep-id` and the existing
  `--security-opt label=disable` are both required.
- claude asked you to log in again in a fresh container even though its
  credential was seeded. `~/.claude.json` holds the account and onboarding state
  claude needs alongside the credential, and it was never copied. It now is,
  minus `projects`, `githubRepoPaths`, `mcpServers` and the cache blobs, which
  takes it from 284kB of host path history to about 9kB.
- Containers only turned permissions off for claude. opencode still gated tools
  in the interactive TUI, and a `permission` block in the mounted host
  `opencode.jsonc` would have applied inside the container too. `create` now
  writes `/etc/opencode/opencode.json`, opencode's managed config, allowing every
  documented surface. It is a default rather than a lock: `OPENCODE_PERMISSION`
  and a user config both outrank it, so a deliberate override still wins. pi has
  no permission gates, so it needed nothing.

## 0.8.0 - 2026-08-08

### Added

- **Containers as hosts**: `casm container build | create | list | rm`. A
  container is a host reached over `docker exec` instead of ssh, with casm
  running inside it, so `list`/`search`/`active`/`show`/`push`/`pull` and
  `--host` work against it unchanged; running containers join the default
  fan-out. `create` mounts the project read-write at its own host path, mounts
  agent config read-only for parity, seeds auth (from the macOS Keychain for
  claude, access token only), installs a dedicated ssh key from `~/.config/casm/ssh/id_ed25519`, and
  writes `/etc/claude-code/managed-settings.json` so agents inside run
  unprompted. Containers run as your uid; their sessions live inside them, so
  `casm container rm` destroys them.
- **`casm container auth <name>`**: re-seed a running container's credentials
  from this host. Needed because the claude credential is seeded **without its
  refresh token**, so a container can never rotate the one your host login uses;
  it stops at expiry instead. `--with-refresh-token` opts out of that.
- **`casm new`**: start a session rather than resume one, on any node
  (`--agent`, `--host`, `--dir`).
- **`--local-containers`**: scope `active`/`list`/`search` to this machine and
  its own containers, without fanning out to configured ssh hosts. Remote
  invocations now use it, so a host reports its containers' sessions as well as
  its own; a container is a leaf and is still pinned to `--local`. Both flags
  are sent to an ssh host so a pre-0.8 casm there stays local instead of fanning
  out to its own hosts.
- **`--host` on `resume` and `continue`**: interactive commands now work on a
  remote node, handing over the terminal with `ssh -t` or `docker exec -it`.
  Previously they were local-only.

### Changed

- Every remote operation goes through one transport layer (`lib/nodes.mjs`)
  covering local, ssh and `docker exec`. `ssh()`/`sshTry()`/`casmRemote()` are
  gone from `lib/util.mjs`; `rsync` and `docker cp` sit behind one interface.
- Each agent now exposes `resumeArgv(s, cwd)` returning an argv array instead of
  `resumeCmd(s, path)` returning a string. `launch()` used to rebuild argv by
  splitting that string on spaces, which broke any argument containing one.
- opencode is pinned with `--dir` on resume and on new sessions; without it
  opencode ignores the spawn cwd and walks up to the nearest project root.

### Fixed

- The docker daemon probe used `docker info --format {{.ServerVersion}}`, which
  podman's shim rejects, so casm reported docker unavailable on podman hosts
  even when it was working. It now runs plain `docker info`.

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
