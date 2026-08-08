# Containers as casm hosts

Design notes for running coding agents in Docker by treating a container as
another casm host, reached over `docker exec` instead of `ssh`.

Status: **implemented**. This document is the design record; the README
documents the shipped behaviour. Where the two differ, the README wins.

## MVP scope

This document is the MVP. The permission-management feature described in
[permissions.md](permissions.md) is **deferred** and is not a dependency: no
profiles, no `casm perms`, no rule audit, no per-agent rule translators.

The container still needs to be permissive, but that is one fixed file written at
create time (see [Making the container permissive](#making-the-container-permissive)),
not a feature with a command surface.

In scope:

- a transport abstraction so a node can be reached over `ssh`, `docker exec` or
  locally
- `casm container create` / `list` / `rm`
- containers usable anywhere `--host` is accepted, which makes `list`, `search`,
  `active`, `show`, `push` and `pull` work against them with no further changes
- `resume` and `continue` learning to run on a remote node, which they cannot do
  today
- `casm new`, to start a session rather than resume one

Out of scope for now: everything in permissions.md, image building beyond a
single default image, and any per-session permission tailoring.

## The idea

A container is a machine. casm already manages machines. So rather than teach
casm to run agents *inside* containers from the outside, install casm **in** the
container and manage it exactly like any other host.

Everything expensive in the earlier sketch disappears with this framing. There is
no session-store mounting, no host/container path translation, no
containerisation record keyed by session id, no container labels standing in for
claude's live-session files. The agent writes its transcript to its own
`~/.claude/projects`, casm-in-container reads it, and casm-on-host asks over
`docker exec` the same way it asks rig over ssh.

The cost is one new transport and one honest tradeoff: **sessions live inside the
container, so destroying the container destroys them.** casm's existing
`push`/`pull` is the mitigation, and it works unchanged once a container is a
node.

## Transport, not a new concept

casm's remote surface is small. Every remote thing it does goes through five
functions in `lib/util.mjs` and `lib/commands.mjs`:

| what | ssh today | docker equivalent |
|---|---|---|
| run a command, get stdout | `ssh(host, cmd)` | `docker exec <c> bash -lc <cmd>` |
| non-throwing probe | `sshTry(host, cmd, timeout)` | same, non-throwing |
| run casm remotely | `casmOn(node, args)` | `docker exec <c> bash -lc 'casm ...'` |
| copy files | `rsync host:path` | `docker cp` |
| hand over the terminal | *does not exist yet* | `docker exec -it` |

So the change is a `node` abstraction with two implementations:

```js
// node = { kind: 'ssh' | 'docker' | 'local', target }
exec(node, cmd)
tryExec(node, cmd, timeout)
casmOn(node, args)
copyTo(node, src, dest) / copyFrom(node, src, dest)
interactive(node, argv, cwd)
```

`fanOut()` in `bin/casm.mjs`, `probeHost()`, `remoteSessions()`, `findCopies()`
and the push/pull bodies all keep their logic and swap `ssh`/`rsync` for the node
functions. `list`, `search`, `active`, `show`, `push` and `pull` then work
against containers with no further work.

## What is genuinely new

Three things, and only three.

### 1. Interactive commands must learn to go remote

`resume` and `continue` are local-only today because `launch()` in
`lib/commands.mjs` ends in `spawnSync(bin, args, {cwd, stdio: 'inherit'})`. That
is the right primitive; it just needs a target:

| node | how the terminal is handed over |
|---|---|
| local | `spawnSync(bin, args, {cwd, stdio: 'inherit'})` (unchanged) |
| ssh | `spawnSync('ssh', ['-t', target, `cd ${shq(cwd)} && ${cmd}`], {stdio: 'inherit'})` |
| docker | `spawnSync('docker', ['exec', '-it', '-w', cwd, name, ...argv], {stdio: 'inherit'})` |

`-t` and `-it` are what make the agent's TUI render, colours work and Ctrl+C
behave. This is a small change with a large payoff beyond containers:
`casm resume <id> --host rig` starts working too, which casm has never been able
to do.

This is also where the `resumeCmd` refactor becomes mandatory. `launch()`
currently rebuilds argv by string-splitting
(`cmd.split(" && ")[1].split(" ")`), which shatters any argument containing a
space. Replace each agent's `resumeCmd(s, targetPath)` with an argv-returning
`resumeArgv(s)` plus a `displayCmd()` helper for the printed `cd … && …` line
that push/pull show.

### 2. A verb for starting a session

casm can resume sessions but has never started one. The scenario needs that:

```
casm new [--host <node>] [--agent claude] [--dir <path>]
```

Launches a fresh interactive agent on the target node, in `--dir`. Local by
default, so it is useful outside containers too. No permission flags: on a
container the managed-settings file has already made it permissive, and anywhere
else the agent's own defaults apply.

`--dir` defaults to the container's mounted project directory when the node is a
container, since that is the only interesting place to work.

### 3. Container lifecycle

```
casm container create <name> --dir <path> [--agent claude,opencode,pi] [--image ...]
casm container list
casm container rm <name>            # warns: sessions inside are destroyed
```

`create` does the work the scenario describes: start a long-lived container with
`<path>` bind-mounted, install casm and the selected agents, and seed auth from
the host so the agent inside starts as a clone of the one outside.

Registered in `~/.config/casm/config.json` beside `hosts`, following the shape
`bookmarks` already uses:

```json
{
  "hosts": ["rig"],
  "containers": {
    "scratch": { "dir": "/Users/michal/Projects/foo", "image": "casm/agents", "agents": ["claude"] }
  }
}
```

Container names then work anywhere a host does: `casm list --host scratch`,
`casm active --host scratch`, `casm new --host scratch`.

## Container requirements

### Persistent, not ephemeral

This is the one place the design departs from both prior implementations.
simple-agent-bench and agentbox both use `--rm` and discard the container after
each run, which is right for a benchmark and for a throwaway dev shell. Here the
container holds the sessions, so it must survive: `docker run -d --name casm-<name>`
with no `--rm`.

`casm container rm` must say plainly that sessions inside are lost, and point at
`casm pull <name> <id>` to extract anything worth keeping first. That command
already exists and works over the docker transport for free.

### Non-root, at the host uid

Two independent reasons, both hard requirements:

1. **`bypassPermissions` is blocked as root.** From Claude Code's docs: the flag
   "is blocked when running as root or via sudo on Linux and macOS, because root
   access combined with no permission prompts can modify any file or service on
   the system", with the guidance to "use the dev container configuration, which
   runs Claude Code as a non-root user". A full-permissions preset in a root
   container simply will not start.
2. **Bind-mount ownership.** Files the container writes into the mounted project
   directory must be owned by you on the host, not root.

So run as the host uid. This machine is `501:20`. Numeric `--user 501:20` works
even though gid 20 is `staff` on macOS and `dialout` on Debian; only the numbers
cross the boundary. The image should also contain a matching home directory, or
the agents have nowhere to write their config.

Note that sab's Dockerfile sets `ENV HOME=/root` and runs as root, so it cannot
be reused unmodified for this.

### Host-path bind mounting

Mount the project directory at its own host path (`-v ${dir}:${dir}`), the way
simple-agent-bench does. Then every path recorded in a transcript is valid on
both sides, and `casm push`/`pull` between the host and the container need no
path mapping at all, because the project directory is literally the same files.

### Lima

Docker on this machine is Lima-backed (`~/.lima/docker/sock`), not Docker
Desktop. Bind mounts only reach paths Lima exposes to its VM.
`~/.lima/docker/lima.yaml` currently has:

```yaml
mounts:
- location: "~"
  writable: true
```

so mounting anything under `~` works, but that is a configured precondition and
Lima's default is read-only. `casm container create` should check it and fail
with a clear message rather than producing a container whose mount silently does
nothing.

## Auth sync: the part that needs care

"The agent inside starts as a clone of the host agent" is easy for two of the
three agents and genuinely awkward for the third.

| agent | what to copy | size | works on macOS host? |
|---|---|---|---|
| opencode | `~/.local/share/opencode/auth.json` | 4K | yes |
| pi | `~/.pi/agent/auth.json` | 4K | yes |
| claude | `~/.claude/.credentials.json` | - | **no, does not exist** |

On macOS, Claude Code stores credentials in the encrypted Keychain, not on disk.
This host has no `~/.claude/.credentials.json` at all, so a file-copy approach
seeds nothing and produces a container that cannot authenticate. On a Linux host
the file does exist and copying works, so behaviour differs by host OS and casm
must handle both.

### Reading the macOS Keychain: works, but read the caveat

`security find-generic-password` does retrieve it, verified on this machine:

```sh
security find-generic-password -l 'Claude Code-credentials' -w
```

Both `-l` (label) and `-s` (service) match; the item is
`svce="Claude Code-credentials"`, `acct="<your username>"`. It returns a 508-byte
JSON document whose single top-level key is `claudeAiOauth`, which is exactly the
shape Linux claude expects at `~/.claude/.credentials.json`. So mechanically this
works and needs no token step.

**The catch is token rotation.** The blob contains both an `accessToken` and a
`refreshToken`, with `expiresAt` and `refreshTokenExpiresAt`. On this machine the
access token expires the same day and the refresh token about three days out, so
rotation is frequent rather than theoretical. Copy that credential into a
container and two independent clients now hold the same refresh token. Whichever
refreshes first can invalidate the other, and the failure mode is **your host
login stops working**, which is a bad thing for a container helper to be able to
do.

So, in order of preference:

1. **`claude setup-token`** on the host, minting a separate one-year OAuth token
   passed as `CLAUDE_CODE_OAUTH_TOKEN`. Nothing is shared, so nothing rotates out
   from under the host. This is the safest option and what `--no-keychain` is
   for; it costs one manual step. Its documented limitation is acceptable here:
   the token "can only make model requests", so no Remote Control and no
   claude.ai connectors, while locally configured MCP servers still work.
2. **`ANTHROPIC_API_KEY`**, passed name-only (`-e VAR`, so the value never
   appears in argv or `docker inspect`).
3. **Keychain copy**. Implemented as the default, since it is the only option
   that needs no setup step. The value is piped in over stdin, so it never
   reaches the host disk or an argv where `ps` would show it, and the **refresh
   token is stripped**: host and container would otherwise hold the same one and
   whichever refreshed first could invalidate the other. Verified that claude
   runs normally on an access token alone, so the container simply stops at
   expiry - a visible failure, fixed by `casm container auth <name>`, rather than
   a silent theft of the host login. There is no setting to disable refresh
   (checked: none of the 432 `CLAUDE_CODE_*` variables covers it), so removing
   the token is the only lever. `--with-refresh-token` opts back in.
4. **Log in inside the container once.** The credential lives there and dies with
   the container.

On a Linux host, `~/.claude/.credentials.json` exists and options 1 and 3 collapse
into the same thing, with the same rotation caveat attached to copying it.

Also copy `~/.claude.json`, which holds account and onboarding state that claude
wants before it will run non-interactively. Do **not** copy it wholesale: it is
288K here and carries a `projects` map with 120 entries of paths and history that
has no business in a fresh container. Write a minimal one with just the
onboarding keys.

Same caution for opencode: seed `~/.local/share/opencode/auth.json`, not
`~/.config/opencode`, which is 49M on this machine because it contains
`node_modules`.

## Host parity via read-only mounts

Read-only mounts are the right mechanism for config: the container tracks the
host automatically with no re-seeding, and the agent cannot modify what it is
given. But it has to be done at **file and subdirectory granularity**, never at
the level of an agent's home directory, because all three agents write state
directly alongside their config.

Evidence from this machine. `~/.claude` holds 20 entries, of which exactly three
are config or extensions (`settings.json`, `plugins/`, `skills/`) and the rest
are state that must be writable: `projects/`, `sessions/`, `history.jsonl`,
`cache/`, `debug/`, `shell-snapshots/`, `telemetry/`, `stats-cache.json`,
`file-history/`, `plans/`, `tasks/`, and more. `~/.pi/agent` mixes `settings.json`
and `models.json` with `auth.json`, `sessions/`, `bin/` and `npm/`. Mounting
either directory read-only breaks the agent outright. simple-agent-bench hit the
same wall and worked around it with tmp-overlays, noting that "pi creates
`~/.pi/agent/*.lock` even for a read".

### Mount table

| host path | mode | why |
|---|---|---|
| `~/.claude/settings.json` | ro | config and permission rules parity |
| `~/.claude/plugins`, `~/.claude/skills` | ro | plugin and skill parity, as asked |
| `~/.claude/projects`, `sessions`, and the other 15 state entries | **not mounted** | container-local, writable, and where its own sessions live |
| `~/.config/opencode/opencode.jsonc` | ro | config parity |
| `~/.config/opencode/skills` | ro | skill parity |
| `~/.config/opencode/node_modules` | **never** | see below |
| `~/.pi/agent/settings.json`, `models.json` | ro | config parity |
| `~/.pi/agent/sessions`, `auth.json`, `bin`, `npm` | **not mounted** | state and secrets |
| `~/.gitconfig` | ro | identity parity, with the caveat below |

**Do not mount `~/.config/opencode/node_modules`.** It is 49M here and contains
`@msgpackr-extract/msgpackr-extract-darwin-arm64/node.napi.glibc.node`, a
darwin-arm64 native binary. Mounted into a Linux container it cannot load. This
is the specific reason to mount `opencode.jsonc` and `skills/` individually
rather than the parent directory, and it is also why mounting beats copying here:
copying would have moved 49M of unusable binaries.

### Host permission rules must not leak in

Mounting `~/.claude/settings.json` read-only would otherwise import the host's
permission rules, and any `deny` there would narrow a container that exists
precisely to be looser. Deny beats allow at every scope, and rules keep applying
in `bypassPermissions` too: modes "set the baseline", and "these controls apply
in every mode, including `bypassPermissions`", where only allow rules become
redundant. So this is a real conflict, not a theoretical one.

There is a second vector for the same problem. The project directory is bind
mounted, so any `<project>/.claude/settings.local.json` arrives with it. This
machine has 81 such files.

**Both are solved by giving the container its own managed settings.** Managed
settings are the highest-precedence source and cannot be overridden by any other
scope, including CLI flags. The container is Linux, so casm writes at create
time:

`/etc/claude-code/managed-settings.json`
```json
{
  "permissions": {
    "allowManagedPermissionRulesOnly": true,
    "defaultMode": "bypassPermissions"
  }
}
```

`allowManagedPermissionRulesOnly` "prevents user and project settings from
defining `allow`, `ask`, or `deny` permission rules. Only rules in managed
settings apply." That makes every rule in the mounted host settings and in the
project's own settings inert in one move, while everything else in those files -
model, status line, enabled plugins, skills - still flows through for the parity
you want.

The file is root-owned inside the container and the agent runs non-root, so it
cannot edit its own policy. That is the same reasoning Claude Code's sandbox uses
when it denies writes to settings files.

Two things to check at create time:

- **`disableBypassPermissionsMode`** is not covered by
  `allowManagedPermissionRulesOnly` and "works from any scope", so a host user
  setting containing it would still block bypass inside the container. Detect it
  and warn. This host's `~/.claude/settings.json` has no `permissions` key at
  all, so nothing leaks today.
- **A `permission` block in the mounted `opencode.jsonc`** would have the same
  effect for opencode, which has no managed-settings equivalent to lean on.
  Neutralise it with `OPENCODE_PERMISSION` (merged over `config.permission`, and
  with last-match-wins a trailing `"*": "allow"` takes effect) plus
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`. This host's `opencode.jsonc` carries only
  `$schema`, `plugin` and `provider`, so there is nothing to neutralise yet.

pi needs nothing here: it has no permission system, and if the permissions
extension is installed its config lives under `~/.pi/agent/extensions/`, which is
not mounted.

### git identity

Mount `~/.gitconfig` read-only for ongoing parity. One check is needed at create
time: a macOS gitconfig commonly carries `credential.helper = osxkeychain`,
`gpg.program`, signing keys, or `includeIf` paths that do not exist in a Linux
container, and each fails confusingly rather than loudly. This host's config is
clean (name and email only, no helpers or signing), so the mount is safe here,
but casm should scan for those keys and warn rather than assume.

### ssh: mount config, not keys

This is the one place to push back on the read-only idea, because read-only
solves the wrong threat. It prevents the agent from *modifying* your keys. It
does nothing about *reading* them, and an agent running with permissions off
inside the container, with network access, can read a mounted private key and
send it anywhere. The
protection you want here is not availability of write, it is absence of the
secret.

So keep the dedicated key: generate one on first use at
`~/.config/casm/ssh/id_ed25519`, share it across containers, and install it at
create time. This follows agentbox, which isolates keys under its own directory
for the same reason. It is revocable without touching your real identity, and it
is one key to add to GitHub rather than one per container.

`~/.ssh` is not mounted at all, config included. The key sits at the default
path, so ssh needs no config to find it, and a mounted host config only adds a
compatibility surface: macOS options such as `UseKeychain` make ssh refuse to
start on any invocation rather than warn. Git work on a mounted project is
normally done from the host, which is the flow this assumes.

`casm container create` should print the public key with a hint to add it as a
deploy or account key, rather than producing a container that fails its first
`git push`. If the mounted project is a git worktree with an existing remote, the
remote URL comes along with it: an `https` remote will ask for credentials the
container does not have, an `ssh` remote will use the casm key. Worth detecting
and saying which.

## Image

Default to `casm/agents`, overridable with `--image` on both
`casm container create` and per-invocation.

The image must carry: node 18 or later (casm itself needs it), the selected
agents, and a non-root user at the host uid with a real home directory. Base it
on simple-agent-bench's `docker/Dockerfile` and `docker/images.json`, which
already layer the three agent CLIs onto an official base with npm-pinnable build
args, and change the user handling, since sab runs as root with `HOME=/root`.

sab's `images.json` also maps language-specific bases (`sab/python`, `sab/go`,
`sab/rust`, ...). The same mechanism is worth keeping so a container can be
created against a toolchain that matches the project, rather than forcing
everything through one node image.

**Do not build implicitly.** `casm container create` should fail with the exact
build command when the image is missing, rather than starting a multi-minute
build inside what looks like a quick command. Provide `casm container build` as
the explicit helper.

## Making the container permissive

Not a feature, and not configurable in the MVP. The container is the safety
boundary, so agents inside it should simply stop asking. `casm container create`
writes this once, per agent, and nothing else in casm needs to know about it.

**claude** gets `/etc/claude-code/managed-settings.json`:

```json
{
  "permissions": {
    "allowManagedPermissionRulesOnly": true,
    "defaultMode": "bypassPermissions"
  }
}
```

Managed settings are the highest-precedence source and cannot be overridden by
any other scope, including CLI flags. Two jobs in one file: it sets the mode, and
`allowManagedPermissionRulesOnly` makes the mounted host rules and the project's
own `.claude/settings.local.json` inert, as described in
[Host permission rules must not leak in](#host-permission-rules-must-not-leak-in).

Doing it here rather than with `--permission-mode` is deliberate. It holds
however the session starts, including a plain `claude` typed inside the
container, so casm does not have to be in the loop on every launch.

**opencode** gets `OPENCODE_PERMISSION` with a trailing `"*": "allow"` and
`OPENCODE_DISABLE_PROJECT_CONFIG=1`, set as container environment so they apply
to every invocation.

**pi** needs nothing. It has no permission gates.

Requires the non-root user described in
[Container requirements](#non-root-at-the-host-uid): `bypassPermissions` is
blocked outright when running as root.

Per-session or per-project tailoring is the deferred `casm perms` feature. If it
is ever built, the managed-settings file is the seam it would write to.

## Why the agent goes inside, rather than driving docker from outside

Kept from the earlier analysis, because it is the reason this shape was chosen.

Granting a host agent `Bash(docker *)` is not a boundary:
`docker run --rm -v /:/host --privileged alpine sh -c '...'` matches that rule
and owns the machine. Claude Code's docs single out this class, noting exec-style
runners are deliberately excluded from wrapper stripping because they execute
their arguments as commands. The built-in Bash sandbox cannot back it up either:

> "docker commands fail: docker is incompatible with the sandbox. Add `docker *`
> to `excludedCommands` to run it outside the sandbox."

> "allowing access to `/var/run/docker.sock` effectively grants access to the
> host system through the Docker socket."

And Anthropic's guidance points the same way:

> "Always run `--dangerously-skip-permissions` sessions inside a container, a VM,
> or the sandbox runtime, so that file tools, MCP servers, and hooks are also
> inside the boundary."

## Prior art

**simple-agent-bench** (`~/Projects/llm-workstation/simple-agent-bench`) is our
own harness and covers the same three agents. `src/docker.js` is MIT and depends
only on node builtins, so its `buildRunArgs` / `createContainer` /
`removeContainer` / `stripShimNoise` port cleanly. Take from it: host-path bind
mounts, name-only `-e` credential passthrough, resource limits
(`--memory 4G --pids-limit 256 --cpus`), `--security-opt label=disable` for
SELinux hosts like the fedora box, podman parity via standard-CLI-only usage, and
label-based stray cleanup. Its `docker/Dockerfile` plus `docker/images.json` are
also the right starting point for the image, with the root-user change noted
above. Leave `src/adapters/*` behind: every one builds a headless `-p`
invocation, which is not what this feature is.

**agentbox** (github.com/fletchgqc/agentbox) runs agents interactively in
ephemeral containers and bind-mounts `~/.claude`, `~/.config/opencode` and
`~/.local/share/opencode`. Worth reading for the interaction model. Not followed
here on two points: its containers are ephemeral, which cannot hold sessions; and
its position is that YOLO mode is the whole answer, offering isolation instead of
permission scoping rather than alongside it. It supports claude and opencode, not
pi.

## Minimal build order

1. Node/transport abstraction, with `ssh` and `local` as the first two
   implementations. Pure refactor, no behaviour change.
2. `resumeArgv()` replacing `resumeCmd()`, and transport-aware `launch()`. Ship
   `casm resume --host rig` on ssh alone; it is useful immediately and proves the
   transport before Docker is involved.
3. Docker transport.
4. `casm container create/list/rm` and the image.
5. `casm new`.

## Decided

- **Image**: default `casm/agents`, `--image` to override, never built
  implicitly. See [Image](#image).
- **Config parity**: read-only mounts at file and subdirectory granularity, never
  whole agent home directories. See [the mount table](#mount-table).
- **Keeping the container loose**: the container writes its own
  `/etc/claude-code/managed-settings.json` with
  `allowManagedPermissionRulesOnly: true`, so neither the mounted host settings
  nor the project's own settings can narrow it.
- **Git identity**: mount `~/.gitconfig` read-only, with an incompatible-keys
  check at create time.
- **ssh**: one dedicated casm key at `~/.config/casm/ssh/id_ed25519`, shared
  across containers and installed at the default path. `~/.ssh` is never
  mounted, config included.
- **Claude auth on macOS**: `claude setup-token` by default; Keychain extraction
  available as an explicit opt-in with the rotation warning.

## Open questions

- Whether `casm container rm` should offer to pull sessions out first rather than
  only warning. Leaning yes, since `casm pull` already does the work and losing
  a session to a one-word command is a bad surprise.
- What happens when the host directory is already mounted into a running
  container and `create` is called again for the same path. Reuse, refuse, or
  make a second container.
- Whether containers should appear in the default `list`/`active` fan-out
  alongside ssh hosts, or only when named with `--host`. Fan-out is more useful
  but means every casm invocation shells out to `docker ps`, which is slow when
  the daemon is not running. The Lima socket on this machine was down during
  design, which is exactly the case that would make casm feel broken.
