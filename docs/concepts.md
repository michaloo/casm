# Concepts

casm is a small server that runs coding agents (Claude Code, Codex, OpenCode and
pi) on one machine, and lets clients and other agents drive them: the CLI
(also from inside an agent), the web client, or your own program speaking the
[protocol](protocol.md). This page explains the moving parts. The
[CLI reference](cli.md) shows each of them in use.

- [Hosts and peers](#hosts-and-peers)
- [Projects](#projects)
- [Agents](#agents)
- [Subagents and child agents](#subagents-and-child-agents)
- [Messages and the queue](#messages-and-the-queue)
- [Permissions and questions](#permissions-and-questions)
- [Schedules](#schedules)
- [Limits and usage](#limits-and-usage)
- [Provenance: who sent a message](#provenance-who-sent-a-message)
- [Files](#files)
- [Agents running agents](#agents-running-agents)
- [The agent prompt](#the-agent-prompt)
- [What casm deliberately does not do](#what-casm-deliberately-does-not-do)

## Hosts and peers

A **host** is one machine running `casm serve`. It owns its projects, agents,
queues and schedules in a SQLite database under `$CASM_HOME` (default
`~/.casm-ng`), and it runs the agents itself, with the provider binaries
installed on that machine. `casm serve` offers only the providers it finds on
`PATH`:

```console
$ casm info
studio  casm 0.0.1  protocol 1  id 00786160-a49c-4329-b6de-f06cc171d505
agents: claude, codex, pi, opencode
```

A **peer** is another host this server can call. You register it once with a
URL and a token created on the peer; from then on any request can carry a
`host` and the server forwards it there, one hop. The CLI's `-H worker`, the
web client's host sections and agents running `casm -H worker …` all use the
same peer list.

```text
          ┌──────────── studio (casm serve) ────────────┐
CLI ──────┤  projects · agents · queues · schedules     ├──── peer: worker (casm serve)
web ──────┤  Claude SDK · Codex app-server · pi · OpenCode│         its own projects and agents
agents ───┘                                              └──── peer: buildbox …
```

Forwarding is coordination, not migration: an agent started with
`casm -H worker run …` lives, runs and stores its state on `worker`. Peering
never copies files, sessions or credentials between machines. Peer tokens stay
on the server; clients never see them.

While a client is connected, the server keeps a connection to each peer and
passes on the peer's own changes (agents created, renamed, archived or removed,
status changes, projects and schedules) to every client, tagged with the
peer's name, so a peer's host section stays current like the local one. Only
the peer's own changes travel, one hop: what a peer relays from its own peers
is not passed on, so two servers that peer each other don't echo. A lost peer
is retried (backing off to once a minute); clients get `peer.status` when it
goes and when it is back, and the web client then reloads that host.

A machine without a server can still use the CLI against a remote host with
`casm host add` (a client-side `hosts.json`). On a machine that runs a server,
`-H` always names one of that server's peers.

## Projects

A **project** is a named, existing folder on one host, with an optional group
and tags. Every agent belongs to a project and works in its folder, or in a
sub-folder of it (`--cwd`, for example a git worktree such as
`.worktrees/feature-x`). casm doesn't create folders, worktrees or branches; it
organizes work. The same folder can be a project on several hosts, as
independent records.

A project's `AGENTS.md` can be edited with a conflict check (CLI
`casm project agents-md --edit`, or **Project options** in the web client),
and the providers' memories for the folder are shown read-only
(`casm project memories`).

## Agents

An **agent** is a saved conversation with one provider: its provider, model,
mode (permission mode), effort, environment, working folder, and the
provider's native session ID. The transcript itself stays in the provider's
own store (Claude's JSONL files, Codex's rollouts, OpenCode's database, pi's
session files); casm reads and normalizes it on demand. That's also why an
agent can be continued in the provider's own tool.

| Provider | What it's for |
| --- | --- |
| **Claude Code** | Your Claude subscription; casm shows its 5-hour and weekly limits and defers work when it runs out. |
| **Codex** | Your ChatGPT/Codex subscription, with the same limit handling. |
| **OpenCode** | A full coding agent with permissions, questions and subagents, and broad model-provider integrations, including local models. |
| **pi** | A bare, minimal, very steerable agent for advanced users. It has no permission system; its tools run without asking. |

[Providers](providers.md) has the verified per-provider feature matrix.

An agent's status is `idle`, `running` or `waiting` (blocked on a permission or
a question). **Reload** reopens the provider process on the same session;
**restart** starts a fresh native session on the next turn; **archive** hides
an agent but keeps it; **rm** deletes the record (not the provider's files).

## Subagents and child agents

Two different things, both shown nested under their parent:

- **Subagents** are spawned *by the provider itself*: Claude's Task/Agent tool,
  Codex sub-agents, OpenCode child sessions. They appear as `subagent` items in
  the parent's transcript; `casm subagents` lists them and
  `casm history <agent> --subagent <id>` reads one's own transcript.
- **Child agents** are full casm agents that another agent created through casm
  (`casm run` from inside an agent). casm records
  a **parent link** `{serverId, agentId, host}`, also across peers, so a
  child on `worker` still points at its parent on `studio`. Inside an agent,
  `CASM_SERVER_ID` and `CASM_AGENT_ID` are set, so a plain `casm run` links the
  new agent automatically (`--parent none` opts out).

## Messages and the queue

Sending to an idle agent starts a turn. Sending to a busy one **queues** the
message; it doesn't interrupt. Each agent's queue is strictly first in, first
out, one message per turn:

```console
$ casm send writer "Then give it a title."
queued behind the running turn
$ casm pending
32886c92  839d28e3  writer                    queued     Then give it a title.
11d6f848  839d28e3  writer                    queued     Then list three themes.
```

Ways to act on the queue, each an explicit choice:

| Action | CLI | Effect |
| --- | --- | --- |
| **Steer** | `casm send <agent> <text> --steer` | Puts the text into the *running* turn instead of queueing it. |
| **Send now** | `casm send-now <agent> <id>` | Takes one pending message out of order and steers it in (or starts a turn when idle). |
| **Edit** | web client, `agent.editPending` | Changes a queued message's text without changing its place. |
| **Cancel** | `casm cancel <agent> <id>` / `--all` | Drops pending messages. |
| **Retry now** | `casm retry <agent> <id>` | Retries a failed or limit-deferred message now. |
| **Interrupt** | `casm interrupt <agent>` | Stops the current turn, keeps the queue, and continues with the next message. |

A pending message has a **reason**:

- `queued`: waiting behind a running turn.
- `limit`: the provider hit a usage limit; the message waits for the reset
  time (`notBefore`). Provider-limit gates survive restarts and hold other agents
  of the same provider, too.
- `failed`: the turn failed before the agent produced anything (session
  couldn't resume, provider logged out or unreachable). It stays at the front
  and holds the queue until you **retry** or **cancel** it, so nothing is
  silently lost or reordered.

**Turns the agent starts itself.** An agent can leave work running in the
background and end its turn: a background Bash or Monitor in Claude, a
background subagent in Claude or OpenCode, an extension's trigger in pi. When
that work reports back, the provider starts a turn on its own. casm runs it as
a normal turn: the status goes to `running`, a notice such as "Woken by a
background task: …" stands where a prompt would be, the reply streams into the
chat, and permissions, questions and interrupt work as usual. A message sent
meanwhile queues behind it (or steers in with `--steer`), and goes next.
A message sent the moment before such a turn starts may share a turn with it:
the provider decides. See [Background jobs](providers.md#background-jobs) for
what each provider supports.

Pending messages are stored in SQLite and survive a server restart. A running
turn does not: the provider process ends with the server.

Clients can pass their own UUID as the message ID (`--message-id`). Re-sending
the same ID after a lost response reconciles with the accepted message instead
of sending it twice.

## Permissions and questions

When a provider asks before running a tool, the agent turns `waiting` and the
request is available to every client: the web client's banner, `casm permissions`
/ `approve` / `deny` (also from a parent agent's shell). Questions (Claude's
AskUserQuestion, Codex user input, OpenCode questions, pi dialogs) work the
same way with `casm questions` / `answer`. Provider permission modes
(`--mode`) decide how much is asked; they are provider settings, not a casm
sandbox.

## Schedules

A **schedule** belongs to a project. On a cadence it either messages one of
the project's agents or creates a new agent in the project from a preset:

- `--cron "0 9 * * 1-5"`: five-field cron in the server's local time.
- `--every 30m`: an interval.
- `--at 18:30`, `--at "in 2h"` or an ISO time: once. When the run goes
  through (`sent`, `queued` or `created`), the schedule is deleted; the
  message still says which schedule sent it. A failed or skipped run leaves it
  disabled with its last outcome, to run again or delete.

A run goes through the normal send path, so a message to a busy or limited
agent becomes pending like any other; `--skip-if-busy` skips that run instead.
Each schedule keeps its next run and last outcome (`sent`, `queued`, `skipped`,
`created`, `failed`). A run missed while the server was down happens once on
the next tick. Deleting an agent deletes the schedules that message it;
deleting a project deletes all of its schedules.

## Limits and usage

casm tracks each provider's subscription windows as the provider reports them
(Claude's 5-hour and weekly windows, Codex's primary and secondary windows):

```console
$ casm limits
claude  (max)  as of 2026-10-14T21:06:43.411Z
  5-hour            76% used  resets 2026-10-14T22:30:00.263294+00:00
  weekly             5% used  resets 2026-10-21T19:00:00.263314+00:00
codex  (prolite)  as of 2026-10-14T21:06:44.710Z
  weekly            58% used  resets 2026-10-21T11:23:53.000Z
```

When a turn fails on a usage limit, casm parses the reset time, keeps the
prompt as a `limit` pending message, and sends it when the window resets. Per
agent, `casm usage` shows context-window use and cost where the provider
reports them:

```console
$ casm usage reviewer
ctx 30k/200k (15%)  $0.06  claude-haiku-4-5-20251001
```

## Provenance: who sent a message

Every prompt can carry a **sender**: the agent (and host) that sent it, or the
schedule that fired it. Messages without one are from a person. The CLI stamps
it automatically inside an agent (from its `CASM_*` environment), and
transcripts show it:

```console
$ casm -H worker history helper
from lead · studio
> Say hello from worker.
```

It is metadata for display and auditing, not authorization. Details:
[message provenance](message-provenance.md).

## Files

Files inside project folders are **readable, never writable**, through casm:
`casm cat` prints a text file, `casm get` downloads any file, and the web client
previews paths that agents mention. Paths must resolve (after symlinks and `..`)
inside a registered project folder on that host, and the server's own state
directory is never served:

```console
$ casm cat /etc/hostname
casm: /etc/hostname is not inside a project folder on this host
```

Downloads use short-lived signed links (`GET /dl/<token>`, about five minutes),
so no client token appears in a URL. A peer's file streams through the server
you're connected to.

## Agents running agents

Agents coordinate through the same `casm` CLI you use, run from their shell;
casm has no MCP tools of its own. Every agent session gets `CASM_SERVER_ID`,
`CASM_SERVER_NAME`, `CASM_AGENT_ID` and `CASM_AGENT_NAME` in its environment,
so `casm run` makes the agent the new agent's parent and `casm send` carries
it as the sender, here or on a peer with `-H`. The
[agent prompt](#the-agent-prompt) tells every agent how. A lead agent's shell
might run:

```console
$ casm peers --probe
$ casm -H worker run --project acme-api --provider claude --model haiku --name helper "Say hello from worker."
$ casm -H worker wait helper
$ casm -H worker history helper
```

[MCP controls](mcp-controls.md) covers inspecting and reconnecting an agent's
*own* MCP servers (`casm mcp`, `/mcp` in the web client).

## The agent prompt

Each host puts a short **agent prompt** in front of every agent's own system
prompt, so agents know they run inside casm, who they are and how to use the
`casm` CLI. `casm agent-prompt <agent>` shows it filled in for one agent:

```console
$ casm agent-prompt reviewer
built-in default, filled in for this agent:

You are running as an agent inside casm, an agent orchestrator, on host studio.
You are agent "reviewer" (id 83b4f029-…, claude) in project acme-api, working in /tmp/code/acme-api.
casm provides the `casm` CLI for working with other agents, schedules and limits. …
```

`casm agent-prompt --edit` saves a custom `agent-prompt.md` in `$CASM_HOME`
(placeholders: `{{host}}`, `{{agentId}}`, `{{agentName}}`, `{{project}}`,
`{{cwd}}`, `{{provider}}`); `--reset` goes back to the default;
`--disable` turns it off. Changes apply to the next session an agent opens.

## What casm deliberately does not do

- No sandboxing or containers: agents run with their host user's permissions
  and their provider's permission settings.
- No importing or syncing of sessions or files between machines.
- No relay or cloud account: you provide the network (a VPN such as
  Tailscale, or an HTTPS proxy).
- No full-text session search; that's the separate tool
  [cass](https://github.com/michaloo/cass).

[design.md](design.md) explains the architecture behind these choices.
