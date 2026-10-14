# Legacy casm → casm-ng parity

Compared on 2026-10-14: `origin/main` at
`41cee3e8bbc8ebcc8891bcc23e590fbb86997735` (`casm-cli` 0.9.2), against
casm-ng through `4cf7323`. This is a source audit, not a live migration or a
claim that native providers were exercised on every platform. `main` was not
modified. The primary NG client is `packages/web`; native apps remain on the
separate `apple` branch and do not count as shipped web functionality here.

**casm-ng is not yet a complete replacement for legacy container, credential
refresh, session-migration, or terminal-resume workflows.** It does replace the
managed-agent orchestration workflow with a server, RPC CLI and browser client.
Session search was spun off as [cass](https://github.com/michaloo/cass), per
Michal's project direction; it should not be rebuilt in NG merely for parity.
This audit does not assert which additional legacy commands cass implements.

## Status meanings and evidence

- **done**: an equivalent capability exists in NG within the stated scope.
- **replaced**: the need has an explicit different workflow; compatibility with
  the old command/data model is not implied.
- **intentionally dropped**: explicit scope direction exists, cited below.
- **missing**: no equivalent found; a decision to drop it has not been inferred.

Legacy evidence: `origin/main:bin/casm.mjs` (complete dispatch/flag table),
`lib/commands.mjs` (all command implementations), `lib/agents.mjs` (four provider
stores/resume/transfer adapters), `lib/nodes.mjs`, `lib/docker.mjs`,
`lib/util.mjs`, README, package metadata, and CHANGELOG. In particular, the
README's transfer table omits Codex, but its adapter implements push/pull too.

NG evidence: [CLI dispatch/help](../packages/cli/src/main.ts),
[protocol](../packages/protocol/src/index.ts),
[agent lifecycle](../packages/server/src/agents.ts),
[providers](../packages/server/src/providers), [web](../packages/web/src),
[README](../README.md), [design scope](design.md), and
[development/deployment](development.md).

## Session discovery, inspection and terminal interaction

| Legacy feature / command | Status | NG equivalent or remaining gap |
|---|---|---|
| Claude, Codex, OpenCode and pi support (`cc/cx/oc/pi` display labels) | done | All four provider adapters exist; NG uses canonical provider IDs. Display abbreviations are not command aliases. |
| `list`: discover every native session, including ones started outside casm | missing | `agents` / `agent.list` lists NG database agents only. No import/adopt/discover RPC for arbitrary native sessions. |
| `list -n`, `--agent`, `--project`, `--id`; newest-first native session previews | missing | `agents --project` scopes managed agents; no equivalent native-store search/filter/pagination workflow. Native ID and NG agent ID are distinct. |
| Read native conversation history without duplicating transcript storage | done | `history <agent> -n` / `agent.history` reads provider storage, with normalized items and pagination. Requires an NG-managed agent. |
| `show <native-id>` without creating/managing an agent | missing | Managed-agent history does not adopt arbitrary legacy/native IDs. |
| `search <term> -n --agent`, contextual matches over native transcripts | intentionally dropped | Session-search CLI moved to cass. NG has no transcript search endpoint; `fs.search` searches workspace paths, not conversations. |
| Search across configured SSH hosts and container transcript stores | intentionally dropped | Part of the extracted legacy session-search concern; verify desired host/container coverage in cass separately. |
| `continue`: numbered recent-session TUI/picker, Enter selects first, q aborts | replaced | Browser sidebar/chat selection replaces the picker for NG-managed agents. No terminal picker is implemented in NG. Legacy is a numbered terminal prompt, not a separate full-screen TUI application. |
| `continue --agent`, `-n`, `--host`, local containers included, bookmarks first | missing | No equivalent terminal picker/filter surface. Browser host/project navigation does not discover old native/container sessions or pin bookmarks. |
| `resume <id>` launches the native interactive agent in that session's cwd | missing | NG `send` reopens a managed native session through its provider protocol; it does not hand over a TTY to the native CLI. |
| Resume the exact session ID; fallback cwd when original directory disappeared | replaced | Managed agents retain native session IDs. NG requires a valid project/cwd and exposes reload/restart; it does not silently fall back to the caller's cwd. |
| `new --agent --dir --host`: create an ordinary session | replaced | `project create`, then `run --project --provider --cwd`; peer selection is `-H`. Browser starts a managed agent from a project. |
| Unique ID-prefix resolution and ambiguity errors | done | NG resolves project/agent IDs, unique prefixes and exact names. These resolve NG records, not legacy transcript IDs. |
| `bookmark` / `bm`, optional aliases, list/remove aliases, pinned cold sessions | missing | Agent names provide a convenient reference, but not bookmark pinning or legacy alias migration. |
| Show session age, project, opening message and context column in terminal lists | replaced | NG agent list/status plus `usage`, `history`; browser agent names/model labels and chat. No identical legacy recent-session overview. |
| `show` reports duplicate session copies on other hosts (`also on`) | missing | Peer agents are independent records; no native-session duplicate inventory across hosts. |

## Multi-host operation and session transfer

| Legacy feature / command | Status | NG equivalent or remaining gap |
|---|---|---|
| SSH targets: config nicknames, `user@host`, ports/keys/jump hosts from SSH config | replaced | Persistent authenticated WebSocket peer servers; SSH/tunnelling is external. `host add` has different arguments and semantics. |
| `host add/list/rm` (including `ls`, `remove/del/delete` aliases) | replaced | Server `peer add/list/rm` and `peers --probe`; client-only machines use `host add/list/rm` with URL/token. Old aliases/config are not migrated. |
| Host readiness probe distinguishes SSH failure from missing remote casm | replaced | Peer probe reports reachability/latency/slow/error over RPC; no remote SSH installation probe. |
| `--host` routing for read and interactive commands | replaced | `-H/--host` routes RPC to a peer or configured client host. It is not a remote TTY launcher. |
| Default parallel all-host fan-out for `list`, `search`, `active`; `--all/--local` | missing | CLI selects one server/peer per command. Web lists hosts/peers, but has no general CLI all-peer fan-out. NG `agents --all` means include archived, not all hosts. |
| `push <id> <host>` and `pull <host> [id]` | missing | No session export/import or relocation RPC/CLI. Creating a child on another peer does not transfer history. |
| Path discovery: home mapping, same-name project search, custom `--to` | missing | No migration target picker or project-path remapping. |
| Optional rsync of the entire project before push | missing | Source/project transfer must be performed outside NG. |
| Transfer preview `--dry-run`, collision refusal, explicit `--force` overwrite | missing | No corresponding transfer operation or safety semantics. |
| Claude JSONL plus companion directory, pi session files, OpenCode export/import | missing | NG can read/resume its managed stores but cannot migrate these formats across hosts. |
| Codex rollout push/pull and native-ID preservation | missing | Present in legacy `lib/agents.mjs` despite omission from README's move table; no NG equivalent. Legacy Codex transfer copies the rollout, unlike OpenCode's directory rewrite. |
| Agent-scoped migration, no cross-provider conversion; duplicate copies may diverge | missing | No migration implementation. Parent/child provenance is not history migration or a merge mechanism. |
| Pull lists remote candidates, supports selection/prefixes, protects local copies | missing | No remote native-session discovery or import. |

## Activity and process lifecycle

| Legacy feature / command | Status | NG equivalent or remaining gap |
|---|---|---|
| `active`: enumerate externally launched agent processes | missing | NG knows processes/sessions it owns; no general process-table discovery. |
| Inferred generating/tool/waiting/stalled/idle status | replaced | Managed live events expose running/waiting/idle, permissions/questions, subagent activity and failures. No age-based `stalled?` equivalent. |
| Deduplicate container processes and match them to container-native stores | missing | No container process/store registry. |
| Context usage for each active/session row | done | `usage`, `agents --usage`, protocol usage and provider account limits; web exposes host limits, not full per-chat usage parity. |
| Native process exit/signal status and spawn failure propagation | replaced | Asynchronous turns report completion/failure; `run/send --wait`, `wait`, pending recovery and exit codes expose outcomes. No interactive native-process exit passthrough. |
| Continue work from a different client machine | done | Browser/CLI can reconnect to the same server-owned agent. This does not move its execution machine or survive a server restart as a live turn. |

## Containers, sandbox boundary and authentication

All rows here describe the legacy implementation, not a proposed NG design.
Provider permission modes and a worktree are not substitutes for a container's
filesystem/process boundary.

| Legacy feature / command | Status | NG equivalent or remaining gap |
|---|---|---|
| `new --containerized` dedicated container per session | missing | NG launches provider processes on the server host. No session container backend. |
| `containerize <id>` one-way move after provisioning succeeds | missing | No conversion/import path for existing host sessions. |
| Docker and rootless Podman support, automatic image build, custom `--image` | missing | No bundled container provisioning/runtime integration. |
| Automatic project-derived container naming and collision suffixes | missing | No container registry/naming mechanism. |
| Project-only bind mount at the original path; host UID/GID ownership | missing | NG cwd containment validates paths, but is not container isolation. |
| Per-container writable agent configuration, skills/plugins copied rather than host-home mount | missing | Providers normally use server user's native configuration. No isolated copied configuration store. |
| Default resource bounds (memory, CPU, PID), init process, restart policy, SELinux/Podman handling | missing | No NG container lifecycle/resource manager. |
| Bypass permission policy inside the container, nonroot user/passwordless sudo | missing | Model-specific modes are available on the host; no automatically confined bypass environment. |
| Host-side durable container transcripts; list/search without entering container | missing | NG native stores are durable, but no legacy container-store discovery/mapping. |
| Resume starts a stopped container; recreates deleted container from stock image | missing | NG provider reload is a process restart, not container reconstruction. |
| Keep session state and published ports across container recreation | missing | No corresponding persistence/provisioning contract. |
| `$CASM_SETUP` notes and container brief; agent chooses what to reinstall | missing | Host agent prompt exists, but no container setup-note lifecycle. Legacy 0.9.2 deliberately does not replay setup scripts on rebuild. |
| Five ports starting at 20000, `--ports N`, `--no-ports`, `CASM_PORTS` and `PORT` | intentionally dropped | NG design explicitly drops the port allocator. A future container decision must separately address the legacy published-port workflow. |
| Copy provider credentials on create/resume; Claude refresh token stripped | missing | No container credential seeding. NG server/peer bearer tokens authenticate clients, not provider subscriptions. |
| macOS Keychain credential extraction, expiry/missing-auth reporting | missing | Native providers use their existing login; no replacement for legacy container auth diagnostics. |
| `auth [id]`: refresh one/all existing containers without resuming the session | missing | No NG `auth` command; `token create` is not an equivalent. |
| SSH key setup, Git identity/config seeding and per-container configuration relocation | missing | No container provisioning hooks; host tools retain their existing configuration. |
| Remove a container with Docker, preserve host transcript, recreate on resume | missing | `rm <agent>` deletes an NG record; it is not disposable-container reset. |

## Installation, scripting and compatibility

| Legacy feature | Status | NG equivalent or remaining gap |
|---|---|---|
| `npm i -g casm-cli`, dependency-free package, Node 18+ | missing | NG requires Node 24+ and workspace dependencies. Checkout installer exists; publishable global npm package/bundle is not set up. |
| macOS/Linux command-line operation | done | Node CLI plus launchd/systemd service templates. No macOS runtime test was performed in this audit. |
| No daemon required; commands read files/run SSH directly | replaced | Persistent casm server owns managed agents and authenticates RPC clients. |
| `help`, version output | replaced | `--help` and `info` expose CLI usage/server version. Legacy `version/-v/--version` command compatibility is absent. |
| Machine-readable `list --json` on one node | replaced | NG `--json` exposes typed RPC results for managed records; JSON shapes are different. |
| Strict flag rejection, `--name=value`, value validation | replaced | Node `parseArgs` rejects unknown global flags and accepts equals syntax. NG has a global option table, not legacy per-command validation; an irrelevant known flag can be accepted. Do not assume old script validation semantics. |
| Exit failure for bad IDs, unavailable hosts, launch errors | done | CLI/RPC error paths and explicit wait outcomes exist; meanings/output are not legacy-compatible. |
| `~/.config/casm/config.json` hosts/bookmarks/container registry | missing | NG uses `$CASM_HOME` (default `~/.casm-ng`), SQLite, local credentials and client hosts. No automatic importer for legacy config. |
| Defensive native transcript parsing | done | All four adapters normalize native history; format/version coverage differs and requires its own tests. |
| Old script command names and agent/native ID semantics | missing | No compatibility shim for `list/show/new/resume/continue/push/pull/auth/containerize/bm`. |

## Scope distinctions and replacement decision

Legacy `docs/permissions.md` explicitly labels `casm perms` audit/edit/profile
management as deferred research, not implemented functionality. It is not a
regression or a parity requirement. Likewise, the old `casm container` command
group was removed in legacy 0.9.0; only its surviving session-centric behavior
is inventoried above. Known legacy gaps (for example copying pi native packages
into Linux containers and Codex first-run project trust) are not promised parity.

NG adds capabilities beyond legacy: server-owned queued/steered turns, explicit
permission/question responses, persisted pending recovery, subscription-limit
backoff, schedules, parent/child orchestration, MCP, browser chat, project
instructions and memories. These are valuable replacements for orchestration,
but do not close the missing container or migration workflows.

Before replacing `main`, Michal needs to decide:

1. Whether container sessions and `auth` stay in a separate legacy tool or are
   required in NG. If required, define the container boundary and credential
   lifecycle before enabling bypass modes as a replacement workflow.
2. Whether arbitrary native-session adoption, terminal resume, bookmarks and
   push/pull belong in cass/another utility or need NG entry points. Only search
   extraction is an established decision in this audit.
3. Whether to keep a separate legacy executable/config alongside `casm` until
   those decisions are implemented. Reusing the name is not command/data
   compatibility, and no automatic migration is present.
4. Whether a published npm package, multi-host CLI fan-out, and any legacy script
   compatibility are release requirements or explicitly dropped conveniences.

This document records the gaps for that decision; it does not authorize deleting
legacy state, switching the default branch, or changing the stable service.
