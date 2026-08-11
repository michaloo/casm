# Changelog

## 0.9.0 - 2026-08-11

Containers stop being places you manage and become a property of a session, and
**codex joins claude code, opencode and pi** as a supported agent.

### Breaking

- **`casm container` is gone**, all of it. A session gets a container with
  `casm containerize <id>` or `casm new --containerized`; one that is stopped is
  started by whatever needs it; credentials are re-seeded on the way in; and the
  image builds on demand. To free disk, `docker rm` the container - it loses no
  conversation, and the next resume rebuilds it. `docker rmi casm/agents` is how
  you refresh the agent CLIs inside it.
- **Containers are no longer targets.** `--host <container>` and
  `<host>/<container>` addressing are gone, along with `--local-containers`. A
  containerized session is reached by its own id from the machine that owns it.
- **Sessions in 0.8-style containers are not read by 0.9.** They lived inside
  the container; they now live on the host. Copy them out with
  `casm pull <container> <id>` under 0.8.6 before upgrading, then
  `casm containerize <id>`.
- **Unknown options now fail** instead of being ignored. A misspelled
  `--containerized` used to start an ordinary session while you believed you
  were in a container.

### Added

- **`casm containerize <id>`** moves a session into a container of its own, and
  **`casm new --containerized`** starts one already inside. One session, one
  container: the environment an agent builds - packages it installed, a database
  it started - is part of that conversation and lasts as long as it does.
- **Transcripts live on the host, not in the container.** Each containerized
  session gets a store under `~/.local/share/casm/containers/<name>/`, and the
  agents inside are pointed at it with `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `PI_CODING_AGENT_SESSION_DIR` and `XDG_DATA_HOME`. `list`, `search`, `show`
  and `continue` therefore read a containerized session without ever entering
  its container, and removing the container loses nothing.
- **Containerizing is one-way.** The transcript moves rather than copies, so
  there is no second copy to drift - which is what the container-as-host model
  produced - and no route back that would quietly resume a prompts-off session
  with prompts on.
- **Rebuild from record.** If a container is gone when you resume, casm rebuilds
  it from what it recorded, on the same published ports, and re-runs
  `~/.casm/setup.sh` from the store. The agent is told it is in a container that
  can be reset and asked to record what it installs there.
- **codex support**: `cx` in listings, `codex resume <id>`, context from its
  `token_count` records, and containerized sessions like the rest. Its
  `<environment_context>` and AGENTS.md injections are filtered out of previews,
  turns and search, where they would otherwise be the first thing shown for
  every session.
- **`casm help` and `casm version`.** Help leads with the command table, then
  three dense use-case blocks. Bare `casm` prints help; an unknown command says
  so in one line instead of dumping it.
- A `▣` beside the project marks a containerized session in `list`, `search`,
  `active` and `continue`, with a one-line legend printed only when something in
  the output carries it.

### Fixed

- **Duplicate, diverging sessions.** Pushing to a container copied the
  transcript into it, so the same session existed twice and drifted apart. On
  one machine a session sat frozen at 775k on the host while the live copy in
  its container had moved a day further on, and `casm continue` offered both.
- **Every containerized claude session opened on a modal.** With
  `CLAUDE_CONFIG_DIR` pointing at the store, claude reads `.claude.json` from
  there, so casm's copy at `$HOME/.claude.json` was ignored and first-run
  onboarding ran on top of the resumed conversation. The bypass-mode warning did
  the same. Both are seeded now - an unattended session used to sit on that
  dialog forever.
- **Agent config was silently ignored inside containers.** `~/.claude/settings.json`,
  plugins and skills were mounted where the agent no longer looks. Config is now
  copied into the store, writable, and refreshed on rebuild - codex writes its
  model choice into `config.toml`, so a read-only mount made that fail on every
  start.
- Credentials follow the same rule: claude's and opencode's are seeded inside
  the store, pi's is not, because only its sessions are redirected.
- **`casm active` shows containerized sessions.** Their processes are in the
  container's pid namespace - filtered out of the host's on linux, invisible in
  a VM on macOS - so casm asks each running container, and answers the
  children check that separates `running tool` from `waiting approval?` from the
  same call.
- `casm search` marks containerized hits, which it previously did not.
- codex gets `--dangerously-bypass-approvals-and-sandbox` inside a container. It
  was the one agent still stopping to ask.
- `bubblewrap` is in the image, so codex stops warning about it on every start.

## 0.8.6 - 2026-08-09

### Fixed

- **Starting or resuming an opencode session did nothing**: opencode printed its
  command list and exited 1, which reads as casm having launched nothing at all.
  casm passed the working directory as `--dir`, which opencode removed - 1.18
  takes it as a positional (`opencode [project]`) and rejects the flag outright.
  Naming the directory is still not optional, since opencode otherwise ignores
  the spawn cwd and walks up to the nearest project root, which in a container
  means working outside the directory that was mounted for it. `-s <id>` for
  resume is unchanged. claude and pi were never affected.

- **Some casm commands left the terminal broken - text typed afterwards went
  invisible until `clear`.** Everything casm prints out of a transcript is
  untrusted terminal input, not text: agent sessions are full of pasted build
  logs, coloured diffs and screen captures, and roughly one in eleven claude
  sessions here carries ANSI escapes in its message text. Two ways that reached
  the terminal. `casm show` truncated a turn at 400 characters and `casm search`
  cut a 40-character window either side of the match, so a cut landing inside an
  escape emitted an unterminated one - a CSI runs until a byte in `0x40-0x7e`,
  so the terminal then swallowed the newline and the front of the shell prompt
  looking for it. And a complete sequence passed through drove the terminal
  directly: `ESC[8m` conceals everything typed after it, `ESC[?1049h` switches to
  the alternate screen, `ESC c` resets the lot. Transcript text is now stripped
  of escapes and control bytes where it enters casm - previews, search hits,
  `show` turns, session cwds and error messages - and `pad`/`truncate` refuse to
  leave a chopped sequence behind even when handed casm's own colours. Covered
  by tests in `lib/util.test.mjs`.
- casm now restores the terminal after handing it to an agent. An agent TUI that
  dies without unwinding - killed, or cut off with its ssh connection - leaves
  its attributes set and its cursor hidden on your terminal, and the shell
  prompt inherits them. `ssh -t` and `docker exec -it` restore the line
  discipline they changed, but nothing restores what the program drew. casm
  re-asserts an SGR reset and a visible cursor, the two that are always safe to
  repeat; leaving the alternate screen is not, so it stays the agent's job.
- `casm search` highlighted the wrong characters. The match offset was computed
  against the raw text but applied to the whitespace-collapsed copy, so the
  highlight drifted right by however many whitespace runs preceded the term.

- **A reboot stranded every container's sessions.** Containers came back
  `exited`, and casm only ever surveyed running ones, so their sessions vanished
  from `list`, `active` and `search` with nothing to say they existed;
  `--host <name>` failed with docker's `can only create exec sessions on running
  containers`. A stopped container is not a broken one - its sessions are
  untouched - so casm now starts it instead. Automatic in `container list`,
  `list`, `active`, `search`, `continue`, `resume`, `new`, `push` and `pull`,
  concurrently with everything else in the survey, and cheap enough not to
  notice: a `sleep infinity` container comes up in well under a second.
- New containers are created with `--restart unless-stopped`, so a reboot brings
  them back without casm being involved at all. `unless-stopped` and not
  `always`, so one you stop by hand stays stopped. Rootless podman also needs
  `systemctl --user enable podman-restart.service` for this, which is why the
  start-on-demand above exists rather than relying on the policy alone.

### Added

- `casm continue` now covers this machine **and its containers**, in one list
  ordered by recency, and resumes the pick wherever it lives. It was
  local-only, which meant the sessions most worth continuing - the ones an agent
  is running unattended in a container - were the ones you could not see.
  Deliberately not the configured ssh hosts, unlike `list`/`active`/`search`:
  `continue` ends by handing your terminal to an agent, and a numbered list that
  can silently drop you onto another machine is a mis-key waiting to happen. A
  container is different: it shares this machine's filesystem and mounts its
  project at the same path. Reach a host explicitly with `--host`.
- `casm container start [<name>...]` starts one, several, or all of them. Rarely
  needed by hand now that everything else does it, but useful in a script that
  wants a container up before it does anything with it.

### Changed

- The `continue` picker labels its two sections, `bookmarks` and `recent`.
  Bookmarks have always been pinned above the rest - that is what a pin is for -
  but with no header it read as a sorting bug, since a pinned session two days
  old sits above one from ten seconds ago.
- The picker gains a node column when the list spans more than one node, so it
  is clear which pick lands in a container.

## 0.8.5 - 2026-08-08

### Added

- Containers get a block of **published ports** so an agent can show you what it
  built. Five by default from 20000 up, published identically (20000 inside is
  20000 outside) to match how paths are mapped, so a URL the agent prints is a
  URL you can open. Each container gets its own block, chosen by skipping blocks
  already claimed by another casm container and any port something else on the
  machine is listening on. `CASM_PORTS` and `PORT` are set inside so an agent can
  discover its range without being told. `--ports N` resizes, `--no-ports` opts
  out. Ports are fixed at `docker run`, so changing the block means recreating
  the container.

### Fixed

- **Containers wedged after hours of real work: every command failed, `echo`
  included.** PID 1 was `sleep infinity`, which never calls `wait()`, so every
  orphaned process inside reparented to it and stayed a zombie forever. Each held
  a slot against `--pids-limit 256`, and once free slots ran out `fork()` failed,
  which kills even shell builtins because each one forks a subshell. Reported
  from a 4-hour session at 206/256 pids, 117 of them zombies; only a restart
  clears them, since nothing can force PID 1 to reap. Containers now run with
  `--init`, so PID 1 is a real init that reaps orphans (tini on docker,
  catatonit on podman). Verified: 200 orphaned processes now leave 0 zombies and
  7 total pids, where before 20 orphans left 40 permanent zombies.
- The default pid limit is raised from 256 to 1024. It is a fork-bomb backstop,
  not a workload budget, and a real session running npm, a bundler, a database
  and a test runner sits inside 256. The reaper above is the actual fix; this
  only removes a needlessly tight ceiling.
- A fresh container asked "do you trust this folder?" on first launch. The
  workspace-trust state lives in `~/.claude.json` under `projects`, which casm
  drops when seeding because it is host path history. Choosing `--dir` is the act
  of trusting that directory, so casm now seeds trust for exactly that one path -
  a prompt with no decision in it is just a prompt.

## 0.8.4 - 2026-08-08

### Changed

- **A bare target name is now always a local container**, and a container
  elsewhere is addressed as `<host>/<name>` (`fedora.local/agent1`,
  `user@box/agent1`). Container names are only unique within a machine, so the
  old fallthrough let a local container silently shadow a remote one of the same
  name and pointed pushes at the wrong machine; a name that existed only
  remotely was not addressable at all and failed with
  `Could not resolve hostname`. Remote containers are reached by ssh plus
  `docker exec`, and file transfer stages through a temp path on the machine in
  between, so `list`, `search`, `active`, `show`, `push`, `pull`, `resume` and
  `new` all work against them.
- Containers in the fleet survey are now labelled by the machine they are on
  (`fedora.local/agent1`), and a remote no longer prints a second `local` header
  inside its parent's. A bare container name in that listing meant a local
  container to the machine printing it and something else to the machine reading
  it.
- `container create` now always builds the image rather than telling you to run
  `casm container build` first, so a container can never be created from an image
  that predates the casm you are running. That is not hypothetical: a stale image
  survived an upgrade and produced containers with no sudo in them. The build is
  cached, so an unchanged Dockerfile costs well under a second (measured
  437-724ms) and runs quietly, while a changed one rebuilds what moved.
- `container build` now always skips the cache. Layer caching pins the agent CLIs
  to whenever the layer was built, so a cached rebuild would leave them untouched
  - which is not what asking for a rebuild means. It is the way to pull newer
  claude, opencode and pi into the image.

### Fixed

- On Linux, a session running in a container was reported twice by `casm active`:
  once by the container's own casm and again by the host's, because a container's
  processes are visible in the host process table there. The host's entry was the
  wrong one - it matched the process against whatever transcript was newest in
  that directory, which after a `casm pull` is a stale copy shown with a stale
  age. Processes belonging to a container are now skipped, identified by the
  runtime named in `/proc/<pid>/cgroup`. macOS was never affected, since it keeps
  containers in a VM.
- `casm push <container> <id>`, with the arguments the wrong way round, failed
  with `no session matching '<container>'`. It now recognises a host or container
  name in that position and prints the corrected command.
- podman's `Emulate Docker CLI using podman` banner, which it prints on the
  stderr of every invocation, no longer leaks into relayed output or into the
  middle of a transfer. It was only stripped from the probe path before.

## 0.8.3 - 2026-08-08

### Changed

- A container's `HOME` is now your own home path rather than `/casmhome`, so
  every path means the same thing on both sides. `~` resolves identically, and
  `~/Projects/thing` works inside when `--dir ~/Projects/thing` is mounted, which
  it previously did not: the absolute path resolved but the tilde path did not
  exist. The home directory inside stays container-local and nearly empty. Note
  that `--dir` is the writable blast radius, since agents inside run with
  permissions off and passwordless sudo.

### Fixed

- `casm push <id> <container>` could not find the project and offered to copy the
  whole thing in beside the copy already mounted. The candidate path was mapped
  home-relative, which is right for an ssh host with a different home but wrong
  for a container, where the project is mounted at the host's own path. It now
  pushes straight to that path when the session lives inside the container's
  `--dir`, and says so when it does not.
- `casm container rm` could hang indefinitely, leaving the container wedged in
  `Stopping`. podman waits for a graceful stop before killing, and the
  `docker rm -f` casm shells out to had no timeout, so a container holding a
  live exec session (an interactive agent) blocked the command with no
  explanation. It now passes `-t 0` on podman, which skips the wait, and bounds
  every removal with a hard timeout that prints the manual command if it trips.
  Measured on Fedora: `podman rm -f` took 10s against a container whose exec
  session ignores SIGTERM, `podman rm -f -t 0` took 0s. Docker has no such flag
  and already kills immediately.

## 0.8.2 - 2026-08-08

### Added

- Agents in a container get **passwordless sudo**, so they can install their own
  dependencies. Previously they ran as a non-root user with no sudo in the image,
  so `apt-get install` and `npm i -g` both failed and only project-local package
  managers worked. Root inside a container does not cross the container
  boundary, which is already the trust boundary here. `--no-sudo` opts out.
  Verified on Docker and on rootless podman under `--userns=keep-id`.

### Fixed

- A container could invalidate the host's claude login. The linux path copied
  `~/.claude/.credentials.json` wholesale, refresh token included, while macOS
  stripped it, so on linux the host and container shared one refresh token and
  whichever refreshed first took out the other. This is not theoretical: it
  happened to a Fedora host during testing. Both platforms now go through one
  `claudeCredential()` that always strips the refresh token, so a container can
  use its access token but never rotate yours.
- `container create` and `container auth` now report the seeded token's expiry,
  and say so plainly when the host's access token has **already** expired. A
  stripped credential cannot refresh itself, so seeding an expired one produced a
  container that looked authorised and then failed on the first prompt with
  `Login expired · Please run /login`.

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
