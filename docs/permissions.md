# Permissions

Design notes for `casm perms`: reviewing, auditing and editing what the coding
agents are allowed to do, across every machine casm manages.

**Status: deferred.** This is research and design, not the current MVP. The MVP
is [agent-in-docker.md](agent-in-docker.md), which does not depend on anything
here. Nothing in this document is implemented, and none of it is scheduled.

Kept because the research is expensive to redo: the per-agent permission models,
the rule syntaxes, Claude Code's live settings reload, and the workspace-trust
rules are all verified against the installed versions and would need
re-verifying rather than re-reading if discarded.

## Why

casm knows where every session is and what it is doing, but nothing about what it
may do. Two problems follow.

**Permission config silts up and nobody sees it.** A survey of this machine found
81 project-level settings files holding roughly 1150 rules. 381 of them are
one-off `WebFetch(domain:...)` entries and 237 are exact-literal `Bash(...)`
rules that can never match again, because they name a full command including its
arguments. They accumulate one "yes, don't ask again" at a time and are never
revisited, because nothing surveys them.

**`casm active` can already spot a session stuck on a permission prompt**
(`waiting approval?`) but can only report it. Being able to see the problem
across a fleet and not act on it is the gap this closes.

## The three agents are not equally capable

This is the constraint everything else follows from.

| | rule granularity | matching | live reload |
|---|---|---|---|
| claude | full: `Bash(docker *)`, `Read`, `Edit`, `WebFetch`, `mcp__*`, `Skill`, `Agent`, `Cd` | deny beats ask beats allow, at every scope, regardless of order | yes, ~1.5s |
| opencode | full: per-surface maps with glob patterns | **last matching rule wins**, so order is significant | unknown |
| pi | none built in | n/a | n/a |

The two matching models are opposites. Writing a translator that forgets this
produces rules that read correctly and behave backwards.

### Claude Code

Modes: `default` (alias `manual`), `acceptEdits`, `plan`, `auto`, `dontAsk`,
`bypassPermissions`. `dontAsk` auto-denies anything not matched by
`permissions.allow` or the built-in read-only Bash set, and never waits for
input.

Precedence, read out of the binary:
`policySettings` > `flagSettings` > `localSettings` > `projectSettings` >
`userSettings`. A deny at any level cannot be overridden by an allow at another.

Rule syntax notes that matter in practice:

- `Bash(ls *)` matches `ls -la` but not `lsof`. The space before `*` enforces a
  word boundary; `Bash(ls*)` matches both.
- `Bash(prefix:*)` is an equivalent spelling of a trailing wildcard. Both forms
  are in use on this machine (298 of the first, 63 of the second).
- Shell operators are parsed. Each subcommand must match independently, so
  `Bash(safe *)` does not permit `safe && rm -rf /`.
- Only `Read` and `Edit` path rules are consulted. `Write(...)`, `Glob(...)` and
  `NotebookEdit(...)` rules are accepted and then never matched, and Claude Code
  warns about them at startup.
- Wrapper stripping covers `timeout`, `time`, `nice`, `nohup`, `stdbuf` and bare
  `xargs`, but deliberately **not** `docker exec`, `npx`, `devbox run` or similar
  runners, because those execute their arguments as a command.

### opencode

```json
{ "permission": { "*": "ask", "bash": { "*": "deny", "docker *": "allow" } } }
```

Surfaces: `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`,
`external_directory`, `todowrite`, `question`, `webfetch`, `websearch`, `lsp`,
`doom_loop`, `skill`. Some of those (`todowrite`, `question`, `webfetch`,
`websearch`, `doom_loop`) take a flat action only, not a pattern map.

Injection for a single run, in order of preference:

- `OPENCODE_PERMISSION='<json>'` merges straight into `config.permission`. One
  env var, no temp file, and it wins.
- `OPENCODE_CONFIG=/path` loads a whole config file, but *between* global and
  project config, so a project `opencode.json` still overrides it.
  `OPENCODE_DISABLE_PROJECT_CONFIG=1` closes that door.

`opencode run` already auto-rejects anything unapproved, so it needs no
equivalent of `dontAsk`. `--auto` is its yolo flag and must never be passed
alongside a profile, since it approves everything.

### pi

pi has no permission system, and says so:

> "It intentionally does not include built-in MCP, sub-agents, permission
> popups, plan mode, to-dos, or background bash."

> "Pi does not include a built-in sandbox. Built-in tools can read files, write
> files, edit files, and run shell commands with the permissions of the pi
> process."

`defaultProjectTrust` and `--approve` / `--no-approve` gate whether
*project-local files* are loaded, not what tools may do. The only built-in lever
is bare tool gating: `--tools`, `--exclude-tools`, `--no-tools`,
`--no-builtin-tools`.

**With an extension it becomes manageable.** `@gotgenes/pi-permission-system`
(v24.0.0, published 2026-07-26, MIT, 30,368 downloads in the preceding month) is
actively maintained and uses almost exactly opencode's config shape, including
last-match-wins, so one translator serves both. Config lives at
`~/.pi/agent/extensions/pi-permission-system/config.json` globally and
`<cwd>/.pi/extensions/pi-permission-system/config.json` per project. Detect it
via those paths or the `packages` array in `~/.pi/agent/settings.json`.

It fails closed by **prompting**, not denying, so any `ask` rule would hang a
non-interactive run. Translate `ask` to `deny` on that path only.

Without the extension, pi is excluded from permission management and casm should
recommend `pi install npm:@gotgenes/pi-permission-system` rather than pretending
a profile was applied.

## Claude Code reloads settings while running

This is the finding that makes the feature more than config management.

Claude Code runs a dedicated chokidar watcher over every settings file. It
watches the containing directories at `depth:0`, filters to the exact settings
paths, and also watches the directory of any symlink target. On a change it
clears its module-level settings cache and rebuilds `toolPermissionContext` from
disk. `awaitWriteFinish` uses a `stabilityThreshold` of 1000 ms and a
`pollInterval` of 500 ms, so a change lands roughly 1 to 1.5 seconds after the
write settles. There is no TTL; invalidation is purely event-driven.

So **writing a rule into `.claude/settings.local.json` changes what a running
session may do**, without restarting it. Combined with casm already detecting
`waiting approval?` across the fleet, that means: see a session stuck on rig,
grant the rule, watch it continue.

Three caveats, all load-bearing:

1. **The 5-second echo window.** Claude Code stamps every settings file it writes
   itself and suppresses any change event on that path within the next 5000 ms,
   as an echo of its own write. A casm write landing in that window is swallowed.
   Retry once after the window rather than reporting success.
2. **Remote sessions are not watched.** The watcher is skipped entirely in
   remote-workspace and remote-control sessions, so live apply cannot be promised
   there.
3. **A `ConfigChange` hook can veto** the change.

It was not established whether the watcher runs under headless `-p`.

Whether opencode reloads its config live was never determined. Treat live apply
as claude-only until someone checks.

### What casm can and cannot see

"Yes, don't ask again" writes to `localSettings`, that is
`.claude/settings.local.json`. That explains the shape of this machine: 81 of
those files and zero checked-in `.claude/settings.json`.

But rules whose destination is `session` or `cliArg` are applied in memory and
**never written to disk**. Nor are rules passed as `--allowedTools` at launch. So
casm can only ever report what is configured on disk. The wording matters: say
"as configured on disk", never "everything this session can do".

A control protocol also exists (`set_permission_mode`, `apply_flag_settings`,
`get_settings`) over stdio for SDK-spawned sessions and over an
attestation-gated WebSocket for remote control. It is not a practical path for
casm, which does not own a user session's stdin. The settings-file write reaches
the same place with no new surface.

## Workspace trust, stated accurately

This is easy to get wrong and alarming when reported wrongly.

`permissions.allow` rules in a project's `.claude/settings.json` are read but not
applied until the workspace trust dialog is accepted, and in `-p` mode no dialog
appears, so they stay ignored. `.claude/settings.local.json` is normally your own
file and exempt, **unless the repository could have supplied it**, meaning it is
committed to git or `.claude` is a symlink. Allow rules there also apply without
trust when the directory is not inside a git repository at all.

Applied to this machine, of 81 settings files:

- **2 are git-tracked** and therefore genuinely subject to the trust check
  (`PicuPicu`, `TagPilot/customers/neonichiban/NI-WebsiteFrontend`).
- 34 are untracked inside a repo, so they apply without trust.
- 45 are outside any git repo, so they apply without trust.

`hasTrustDialogAccepted` in `~/.claude.json` is `false` for 66 of 120 projects,
and on its own means nothing. Do not key the audit off that flag.

## Command surface

### Review

```
casm perms                      # every agent, this machine + all hosts (fan-out)
casm perms --local | --host rig
casm perms --agent claude
casm perms <id-prefix>          # what applies to one session, and from which file
casm perms --audit              # dead rules, redundancy, risky grants
```

Default output is one block per host, one line per agent: mode, rule counts by
kind, and the source files. `casm perms <id>` resolves the session's `cwd` and
prints the merged ruleset with each rule's origin, which is `/permissions` seen
from outside the session and over ssh.

Reading is mostly already built. A session's effective rules are the merged
settings files at its `cwd`, which `enrich()` in `lib/agents.mjs` already
resolves. Claude transcripts additionally stamp `permissionMode` on every user
record and emit `{"type":"permission-mode",...}` on each switch, readable with the
same cheap tail-read that `contextUsage()` uses.

### Audit findings

- Exact-literal `Bash(...)` rules that cannot match again (237 here).
- `WebFetch(domain:...)` accumulation (381 here), foldable into `*.host` forms.
- Rules shadowed by a broader rule in the same or a higher scope.
- Rules Claude Code accepts but never consults: `Write(...)`, `Glob(...)`,
  `NotebookEdit(...)` with paths.
- Risky grants, named explicitly: bare `Bash`, `Bash(docker *)`, `Bash(sudo *)`,
  `Bash(curl *)`, and any `defaultMode` of `bypassPermissions`.
- Rules inert because of workspace trust, computed properly per the section
  above rather than from `hasTrustDialogAccepted`.

### Edit

```
casm perms prune <id|--project P> [--dry-run]   # drop dead and shadowed rules
casm perms apply <preset> --project P           # write a named preset
casm perms allow 'Bash(docker *)' --agent claude [--scope user|project]
casm perms deny  'Bash(sudo *)'   --agent claude
casm perms allow 'Bash(docker *)' --session <id-prefix>   # live, claude only
```

Writes go to `~/.claude/settings.json` or `~/.config/opencode/opencode.json` at
user scope, and `.claude/settings.local.json` or `opencode.json` at project
scope. Every write follows the discipline `saveConfig()` already uses in
`lib/util.mjs`: read, merge, write to `.tmp`, rename. Unknown keys must survive
untouched, because these files are shared with other tools. `--dry-run` prints a
diff and is the default for `prune`.

After any write, report which live sessions are affected and whether each will
pick it up (claude) or needs a restart (everything else).

## Relationship to containers

[agent-in-docker.md](agent-in-docker.md) treats a container as another casm host,
with casm installed inside it. That framing is why this document is deferred
rather than a prerequisite.

A container does not need permission management, because the container is the
boundary. It gets one fixed `/etc/claude-code/managed-settings.json` at create
time with `defaultMode: bypassPermissions` and
`allowManagedPermissionRulesOnly: true`, which turns permissions off inside and
prevents the mounted host rules from narrowing it. That is a single file, not a
feature.

The fine-grained rules described here matter for sessions running on real hosts,
where they are the only boundary there is. If this feature is ever built, it
applies unchanged over the docker transport, since permission config inside a
container is just permission config on a host, and the managed-settings file is
the seam it would write to.

## Non-negotiables

- casm enforces nothing. It reads and writes each agent's own settings; the agent
  enforces. Never describe any of this as a sandbox.
- Never claim a session's full capability, only what is configured on disk.
- Never report a live-apply as successful without confirming it was not eaten by
  the echo window.
