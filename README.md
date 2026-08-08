# casm

**Simple multi-node coding-agent session manager (claude code / opencode / pi) over SSH and Docker.**

List, search, and resume sessions for **Claude Code** (`cc`), **opencode** (`oc`), and **pi** (`pi`) - on local machine, via SSH, or in a Docker container.
**Move sessions between machines over SSH** so you can continue them where you're working.
Sessions are agent-scoped: a session always moves to the *same* agent on the other machine, never across agents.

No npm dependencies. Node 18+. macOS and Linux.

## Install

**On every machine you want to manage** - casm talks to its own copy on the other end, so it has to be installed and on PATH everywhere.

```sh
npm i -g casm-cli        # installs the `casm` command
```

---

## Continue from anywhere

The reason casm exists. `casm continue` lists your 10 most recent sessions
across all three agents, newest first, with age, agent, project, context size
and opening message. Pick a number and casm changes into that session's own
directory and hands the terminal to its agent, resuming **by id** so you land in
the session you picked rather than whatever was newest in that folder.

![casm continue: 10 recent sessions across claude, opencode and pi; pick one and it resumes in the right directory](docs/media/continue.gif)

```sh
casm continue                   # the 10 most recent, pick one
casm continue --agent opencode  # one agent only
casm continue --host rig        # or on another machine entirely
```

Bookmarked sessions sort to the top with a `★`. Enter takes the newest, `q`
aborts. If the original directory is gone it says so and starts where you are.

## Search and resume

Full-text search across every transcript, every agent and every machine, with
the matching line shown in context. Then resume the hit wherever it lives.

![casm search: full-text hit across transcripts, then casm show to read the session](docs/media/search.gif)

```sh
casm search "oculink"             # every agent, every machine, every container
casm search "flaky test" --agent claude
casm show 019e4ee3 -n 20          # read it first
casm resume 019e4ee3              # ...then pick it up
```

Ids can be abbreviated anywhere to a unique prefix, and a bookmark alias works
in every place an id does.

## See what every machine is doing

One command for the whole fleet: which agents are running, on which machine or
container, in which project, and whether they are working or sat waiting for
you.

```sh
casm active                     # this machine + every host + every container
casm active --local             # just here
```

Statuses are inferred from each agent's own transcript: `generating`,
`running tool`, `waiting approval?`, `working`, `stalled?`, `idle`. The one
worth watching for is `waiting approval?` - an agent that has been sitting on a
permission prompt while you were somewhere else.

## Move a session between machines

Start something on the laptop, finish it on the workstation. The session keeps
its id and its full history; only the project path is adjusted for the target.

```sh
casm push c66fbd0b rig          # interactive: casm finds the project over there
casm push c66fbd0b rig --to /home/me/proj
casm pull rig                   # what is on rig?
casm pull rig c66fbd0b          # bring one back
```

Sessions are agent-scoped: claude to claude, opencode to opencode, pi to pi,
detected from the id with no flag needed. Both copies then exist under the same
id and drift apart independently, so `casm show` prints an `also on <host>` line
for every other machine holding it.

## Run an agent in a container

Give an agent a box it cannot damage, then work in it normally. Inside the
container permissions are off for all three agents, so nothing interrupts you,
and the container is the boundary instead.

```sh
# 1. give the agent a box. builds the image if it is missing, mounts the project
#    read-write at its own path, seeds your agent credentials, publishes 5 ports
casm container create work --dir ~/Projects/thing

# 2. move a session you already started into it. the project is mounted at the
#    same path it has on the host, so the session's directory is valid inside
casm push c66fbd0b work

# 3. pick it up in there. casm changes into the project and hands over the
#    terminal, exactly as it does locally - only now the agent runs unprompted,
#    because the container is the boundary instead of the permission prompts
casm resume c66fbd0b --host work

# or skip the move and just start something new inside
casm new --host work

# from the outside it is a host like any other
casm list --host work        # its sessions
casm active                  # running containers join the fleet survey
casm container rm work       # destroys the sessions inside it
```

None of that is special-cased: a container is a host reached over `docker exec`
instead of ssh, with casm running inside it, so every command works against it
unchanged. A container on another machine is addressed as `<host>/<name>`.

Each container gets five published ports from 20000 up, mapped identically, so a
dev server the agent starts is reachable from the host at the same number.
`CASM_PORTS` and `PORT` are set inside so the agent knows its range.

### What is mounted where

`--dir` is mounted **at its own host path**, and `HOME` inside the container is
your own home path too. So every path means the same thing on both sides: `~`
resolves the same, a transcript written inside is readable outside, and nothing
needs translating anywhere.

| host | in the container | |
|---|---|---|
| `<--dir>` | the same absolute path, and the working directory | rw |
| `~/.claude/settings.json`, `plugins`, `skills` | the same paths | ro |
| `~/.config/opencode/opencode.jsonc`, `skills` | the same paths | ro |
| `~/.pi/agent/settings.json`, `models.json` | the same paths | ro |
| `~/.gitconfig` | the same path | ro |
| everything else under `~` | not mounted | absent |

Each container also gets five published ports from 20000 up, mapped identically,
so a dev server the agent starts is reachable from the host at the same number.
`CASM_PORTS` and `PORT` are set inside so the agent knows its range. Blocks do
not overlap between containers. `--ports N` resizes and `--no-ports` opts out;
like mounts, the block is fixed at create time.

The home directory inside is container-local and nearly empty: the read-only
config above, the credentials casm seeds, and whatever the agents write. Your
actual home is not mounted, so `~/Documents` does not exist in there. Only
`--dir` is writable through to the host.

That means **whatever you point `--dir` at, the agent can write** - it runs with
permissions off and passwordless sudo, so treat `--dir` as the blast radius and
pick it deliberately. Pointing it at `~` mounts your whole home read-write.

Credentials are copied in rather than mounted, and state directories are neither,
so the container's sessions are its own.

All three agents run unprompted inside: `create` writes
`/etc/claude-code/managed-settings.json` (`defaultMode: bypassPermissions`,
`allowManagedPermissionRulesOnly: true`, so host `deny` rules cannot narrow it)
and `/etc/opencode/opencode.json`; pi has no gates. Both are root-owned, so the
agents cannot rewrite their own rules. opencode's is a default rather than a
lock: set `OPENCODE_PERMISSION` or a user config and yours wins. Containers run
as your uid and are registered in `~/.config/casm/config.json` next to `hosts`.

---

## Targets

A target is anywhere casm can run:

| | |
|---|---|
| `local` | this machine |
| `<name>` | a container here, and only ever here |
| `<ssh-target>` | a machine: a `~/.ssh/config` name, or `user@host` |
| `<ssh-target>/<name>` | a container on that machine |

Container names are only unique per machine, so a bare name never reaches a
remote one. Usernames, ports, identity files and jump hosts belong in
`~/.ssh/config`.

```sh
casm host add rig                # adds it, then checks ssh + casm on the far end
casm host list                   # every host: ready / no casm / unreachable
casm host rm rig
casm container list              # containers, their state, ports and project
```

Hosts are a plain list in `~/.config/casm/config.json`, containers a map beside
it.

## All commands

```sh
casm continue                  # pick from your 10 most recent local sessions, resume it
casm new                       # start a new session (--agent, --host, --dir)
casm search "oculink"          # full-text search across agents and machines
casm resume 019e4ee3           # resume by id, cd into the session directory and resume in appropriate coding agent
casm resume 019e4ee3 --host rig  # resume it on another machine
casm active                    # list currently active sessions from all nodes
casm list -n 30                # newest sessions across all agents and machines
casm list --agent opencode     # one agent only
casm show ses_110bdd           # preview a session, here or on any host (agent auto-detected)
casm host list                 # configured hosts + their reachability
casm container list            # containers casm manages
```

`continue`, `resume` and `new` take `--host`, as do `list`, `search`, `active`
and `show`. A target is `local`, a container name (always one of **yours**, on
this machine), an ssh target, or `<ssh-target>/<container>` for a container on
another machine. Container names are only unique per machine, so a bare name
never reaches a remote one.

`active`, `list` and `search` cover this machine, every configured host and
every running container. Scope them with `--local` (this machine alone),
`--local-containers` (this machine and its containers) or `--host <name>`. A
remote host is asked for itself and its own containers, never for its hosts, so
the survey cannot loop.

## Bookmarks

Pin the sessions you intend to come back to:

```sh
casm bookmark 19dc764f casm-work   # bookmark with an alias (casm bm works too)
casm bookmark fc1cbe91             # bookmark without one
casm bookmark                      # list bookmarks
casm bookmark rm casm-work         # unpin (the session itself is untouched)
```

Bookmarked sessions are pinned to the top of `casm continue` with a `★`, and an
alias works anywhere an id-prefix does: `casm resume casm-work`,
`casm show casm-work`, `casm push casm-work fedora`. Stored in
`~/.config/casm/config.json` next to `hosts`; bookmarks are per-machine and
refer to local sessions.

## How push works

One SSH probe reports whether the session's project path exists on the target
(local home mapped to remote home), plus any same-name directories elsewhere;
then a menu offers: push into the exact path / a found directory / rsync the
whole local project dir first / a custom path. After the move it prints the
resume command (e.g. `cd … && claude --resume <id>`) you can easily paste in your remote SSH.

Per-agent transfer mechanics:

| Agent | Session storage | Move mechanism |
|---|---|---|
| claude | `~/.claude/projects/<path-slug>/<uuid>.jsonl` (+ `<uuid>/` companion dir) | file copy into matching slug dir |
| pi | `~/.pi/agent/sessions/<path-slug>/<ts>_<uuid>.jsonl` | file copy into matching slug dir |
| opencode | sqlite (`~/.local/share/opencode/opencode.db`) | `opencode export` → rewrite `directory` → `opencode import` on remote |

Except project path session files and data are otherwise not modified, including session ID.

## Session status matching

Claude code records every active session at `~/.claude/sessions/<pid>.json`
(`sessionId`, `cwd`, `status`, `name`, `updatedAt`). casm reads it for session matching.
Anything else - opencode, pi, and claude versions with no `sessions/` directory
- is matched by process cwd and read from the newest transcript there, which is
best effort: two sessions of the same agent in one directory both resolve to
whichever transcript was written last, so one of them is misreported.

`casm active` prints one status per running agent process:

- **working** - the transcript ends on a user message written less than 5 minutes ago.
- **generating** - the transcript was written to in the last 10 seconds.
- **running tool** - the transcript ends on a pending `tool_use` and the agent process has children.
- **waiting approval?** - the transcript ends on a pending `tool_use` and the
  process has no children, i.e. it is sitting on a permission prompt.
- **stalled?** - the transcript ends on a user message 5 minutes old or more.
- **idle** - the transcript ends on an assistant message with nothing pending,
  or holds no messages at all; or opencode/pi have not written for 10 seconds.

`generating` is tested first, so the states below it only appear once the
transcript has been quiet for 10 seconds: a permission prompt reads as
`generating` for its first 10 seconds, then flips to `waiting approval?`.

A claude session that has been started but not yet talked to has no transcript
to read, and only there does casm fall back to claude's own `status` (`busy`
shown as `working`) until the first message lands.

Other meta values:

- **none** - no agent processes running on that machine.
- **unknown cwd** - the process is running but its directory could not be read.
- **no session found** - the directory is known, but no transcript there matches.

## Requirements & caveats

- Every managed machine needs casm on PATH (`npm i -g casm-cli`, so node ≥18)
  plus ssh and rsync.
- opencode push/pull additionally needs the `opencode` binary on both ends.
- opencode listing/search needs the `sqlite3` CLI (`dnf/brew install sqlite`).
- opencode `export` is captured via file redirect - its piped stdout
  truncates (bun stdout flush bug).
- Transcript formats are internal to each agent and may change between
  versions; parsing is defensive (bad lines skipped) but may degrade.
- Old tool results inside a moved conversation still reference source-machine
  paths; agents handle that fine going forward.
- Containers hold their sessions internally, so `casm container rm` destroys
  them; `casm pull <name> <id>` first.
- Container auth is copied at create time, not mounted, always **without the
  refresh token**, so a container can use your credential but never rotate the
  one your host login depends on. claude's comes from
  `~/.claude/.credentials.json` on Linux and from the Keychain on macOS
  (`security find-generic-password -l 'Claude Code-credentials'`). The container
  therefore stops working when the access token expires; `casm container auth
  <name>` tops it up, and `create` tells you when it expires. `--no-keychain`
  opts out entirely, for `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN`;
  `--with-refresh-token` keeps the refresh token if you want the container to
  renew itself, at the cost of it being able to invalidate your host login.
- Containers run with `--init`, so orphaned processes are reaped rather than
  accumulating as zombies against the pid limit. Resource limits are
  4G memory / 1024 pids / 2 cpus.
- Agents inside get passwordless sudo, so they can `apt-get install` what they
  need. The image is slim, so `sudo apt-get update` is needed first. `--no-sudo`
  opts out.
- Containers get a dedicated key at `~/.config/casm/ssh/id_ed25519`, installed
  at the default path inside. `~/.ssh` is not mounted; git on the mounted
  project is normally done from the host.
- Lima-backed Docker mounts only the paths Lima exposes; `~` needs
  `writable: true` in `lima.yaml`.

## Alternatives

`claude --cloud` / `claude teleport` (official, relays via claude.ai);
[agent-sessions](https://github.com/vineethkrishnan/agent-sessions) and
similar local TUI browsers (multi-agent but single-machine, no migration).
