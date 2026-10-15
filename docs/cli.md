# CLI reference

`casm` is both the server (`casm serve`, `casm token`, `casm peer`) and its
command-line client. Every example below is real output from a two-host test
setup: a server named `studio` with a peer named `worker`, a demo project
`acme-api`, and cheap Claude Haiku agents. IDs and times will differ for you.

![casm run, wait and history](media/cli-quickstart.svg)

- [Global options](#global-options)
- [Server: serve, service, token, peer](#server)
- [Hosts, peers, info](#hosts-and-peers)
- [Projects](#projects)
- [Agents: run, agents, send, wait, history, watch](#agents)
- [The queue: pending, cancel, retry, send-now, interrupt](#the-queue)
- [Permissions and questions](#permissions-and-questions)
- [Schedules](#schedules)
- [Limits, usage, models](#limits-usage-and-models)
- [Files: cat, get](#files)
- [Subagents, shell, MCP](#subagents-shell-and-mcp)
- [The agent prompt](#the-agent-prompt)
- [Agents running agents](#agents-running-agents)
- [Lifecycle: reload, restart, archive, rm](#lifecycle)
- [Exit codes and scripting](#exit-codes-and-scripting)

## Global options

```text
casm [-H host] [--json] <command> …
```

- `-H <peer>` (or `CASM_HOST`): run the command on a peer of this machine's
  server. On a machine without a server, `-H` picks an entry of
  `$CASM_HOME/hosts.json` instead (see `casm host add`).
- `--json`: machine-readable output (the protocol result), for scripts.
- `<agent>` and `<project>` accept an ID, an ID prefix or an exact name.
- `casm --help` prints the full usage.

The CLI finds the local server through `$CASM_HOME/local.json`, written by
`casm serve` on every start. `CASM_URL` + `CASM_TOKEN` point it at another
server instead.

## Server

### casm serve

```text
casm serve [--listen host:port] [--name n]
```

Runs the server in the foreground. Defaults: `127.0.0.1:7373`, name = the
machine's hostname. `$CASM_HOME/config.json` can set `listen`, `name`,
`peerTimeoutMs` (default 10000) and `agentPrompt: false`.

```console
$ casm serve --listen 127.0.0.1:7481 --name studio
[2026-10-14T21:06:15.772Z] listening on ws://127.0.0.1:7481
[2026-10-14T21:06:15.773Z] agents: claude, codex, pi, opencode
[2026-10-14T21:06:15.776Z] no client tokens for other machines yet: run "casm token create <name>"
```

Only providers whose binaries are on `PATH` are offered;
`CASM_CLAUDE_PATH`, `CASM_CODEX_PATH`, `CASM_PI_PATH` and `CASM_OPENCODE_PATH`
override the binary.

### casm service

Installed by `scripts/install.sh`, the `casm` launcher forwards `casm service …`
to `scripts/service.sh`: a systemd user unit on Linux, a launchd agent on macOS.

```text
casm service install     write the unit/plist (capturing the current PATH) and (re)start it
casm service uninstall   stop it and remove the unit/plist
casm service status
casm service logs [-f]   recent server log (-f to follow)
casm service restart
```

`install` captures `PATH` so the service finds `claude`, `codex`, `pi` and
`opencode`; run it again after moving those or switching Node versions.
Restarting the service ends running turns (queued messages survive).

### casm token

Client credentials for browsers, other machines' CLIs and peers. Treat them as
passwords.

```console
$ casm token create web
casm_…   (printed once)
$ casm token list
local-cli	2026-10-14T21:06:15.774Z
$ casm token revoke web
```

`local-cli` is the token `casm serve` writes to `local.json` for this
machine's CLI; it's replaced on every start.

### casm peer

```text
casm peer add <name> <ws-url> <token>    verified now: the peer must answer
casm peer list [--probe]                 also: casm peers [--probe]
casm peer rm <name>
```

```console
$ casm peer add worker ws://127.0.0.1:7482 "$TOKEN_FROM_WORKER"
added peer worker: server "worker" (ed129bd6-4b4f-4904-8120-ede23f3854a4), agents: claude, codex, pi, opencode
$ casm peer list
worker	ws://127.0.0.1:7482	ed129bd6-4b4f-4904-8120-ede23f3854a4
$ casm peers --probe
worker	ws://127.0.0.1:7482  reachable 13 ms
```

`serve`, `token` and `peer` act on this machine's server only and refuse `-H`.

## Hosts and peers

```console
$ casm info
studio  casm 0.0.1  protocol 1  id 00786160-a49c-4329-b6de-f06cc171d505
agents: claude, codex, pi, opencode
$ casm -H worker projects
61e129f5  acme-api  /tmp/code/acme-api
```

On a machine **without** a server, register hosts for the CLI itself:

```text
casm host add <name> <ws-url> <token> [--default]
casm host list | host rm <name>
```

![peers, -H, permissions](media/cli-peers.svg)

## Projects

```text
casm projects
casm project create <dir> [--name n] [--group g] [--tag t]...
casm project group <project> [group]       set or clear the group
casm project rm <project>
casm project agents-md <project> [--edit]  print <dir>/AGENTS.md; --edit opens $EDITOR
casm project memories <project>            each provider's memories for the folder
```

```console
$ casm project create /tmp/code/acme-api --name acme-api --group work --tag node
26d72695-ed09-476a-8e3b-d735ed84f33c
$ casm project create /tmp/code/web-shop --name web-shop --group work
6eb09d7f-d056-49d7-832f-1da5e33b3983
$ casm projects
work/
26d72695    acme-api  /tmp/code/acme-api  #node
6eb09d7f    web-shop  /tmp/code/web-shop
```

## Agents

### casm run

```text
casm run --project p [--cwd dir] [--provider claude] [--name n] [--model m] [--mode m]
         [--parent serverId/agentId|none] [--env K=V]... [--wait] <prompt>
```

Creates an agent and sends it the first prompt. Prints the new agent's ID, or
with `--wait`, its reply.

- `--provider`: `claude` (default), `codex`, `opencode` or `pi`.
- `--model`, `--mode`: as listed by `casm models`; `--mode` is the provider's
  permission mode (Claude: `default`, `acceptEdits`, `plan`, `auto`,
  `bypassPermissions`).
- `--cwd`: a folder inside the project, relative or absolute, such as a git
  worktree: `--cwd .worktrees/feature-x`.
- `--env K=V`: the agent's environment, for example a provider base URL.

```console
$ casm run --project acme-api --provider claude --model haiku --name reviewer "Read src/orders.js and tell me in two sentences what it does."
83b4f029-3d6b-46e9-9e63-60ddba8ca5a8
$ casm run --project acme-api --provider opencode --model opencode/big-pickle --name pickle "Reply with just the word ready."
2a468d3a-b548-4f8a-9429-5a5648a67e4a
```

On a peer, with `--wait`:

```console
$ casm -H worker run --project acme-api --provider claude --model haiku --name remote-tests --wait "Run npm test with the Bash tool and report the result in one line."
agent is waiting for you: casm permissions bff4cda3 / casm questions bff4cda3
$ echo $?
3
```

### casm agents

```text
casm agents [--project p] [--all] [--usage]
```

```console
$ casm agents
2a468d3a  idle     opencode  acme-api / pickle
83b4f029  running  claude    acme-api / reviewer  2 pending  1 subagent
$ casm agents --usage
2a468d3a  idle     opencode  acme-api / pickle  ctx 14k/200k (7%)  opencode/big-pickle
83b4f029  idle     claude    acme-api / reviewer  ctx 33k/200k (16%)  $0.10  claude-haiku-4-5-20251001
```

`--all` includes archived agents.

### casm send

```text
casm send <agent> <text> [--steer] [--wait] [--fail-if-limited] [--message-id UUID]
```

Starts a turn when the agent is idle (prints nothing), queues the message when
it's busy, or with `--steer` puts it into the running turn:

```console
$ casm send reviewer "Afterwards, list the files in test/."
queued behind the running turn
$ casm send reviewer "Actually, stop at 10." --steer
```

- `--wait`: wait for the reply, like `casm wait`.
- `--fail-if-limited`: exit with an error instead of queueing when the
  provider is over its usage limit.
- `--message-id`: your own UUID; resend it after an uncertain response and the
  server reconciles instead of delivering twice.

![queue, steer and cancel](media/cli-queue-steer.svg)

### casm wait

```text
casm wait <agent> [--timeout seconds]
```

Waits until the agent is idle or blocked and prints its last reply.

```console
$ casm wait reviewer --timeout 120
This file defines an in-memory order database with a static array of three orders and exports two functions to access them. `listOrders()` returns all orders, and `getOrder(id)` retrieves a single order by its ID.
```

Exit codes: `0` idle, `3` still busy (timeout) or waiting for a permission or
answer, `4` deferred by a usage limit, `5` the turn failed.

### casm history

```text
casm history <agent> [-n count] [--subagent id]
```

```console
$ casm history reviewer
> Read src/orders.js and tell me in two sentences what it does.
  (thinking) The user wants me to read src/orders.js and describe what it does in two sentences. I should use the Read tool to look a
  ✓ Read {"file_path":"/tmp/code/acme-api/src/orders.js"}
  (thinking) The file is simple. It has:

This file defines an in-memory order database with a static array of three orders and exports two functions to access them. `listOrders()` returns all orders, and `getOrder(id)` retrieves a single order by its ID.
```

`>` marks prompts, `✓`/`…`/`✗` tool calls (done, running, failed), and a
`from <agent> · <host>` line prompts that another agent sent (`from schedule
<name>` for a schedule). It shows the last 50 entries; `-n` changes that.

### casm watch

Streams live events until Ctrl-C:

```console
$ casm watch reviewer
[running] watching reviewer; Ctrl-C to stop

> Count from 1 to 40, one number per line, using a bash loop with sleep 0.5 between numbers (run it with the Bash tool), then say done.
  … Bash {"command":"for i in {1..40}; do echo $i; sleep 0.5; done","description":"Count 1 to 40 with 0.5s delay between numbe...
  ? permission toolu_018tMD1j4Jst1ZffNs59VUzU: Count 1 to 40 with 0.5s delay between numbers {"command":"for i in {1..40}; …"}
```

## The queue

See [messages and the queue](concepts.md#messages-and-the-queue) for the rules.

### casm pending

```text
casm pending [agent]
```

Messages waiting for their agent (behind a turn, over a limit, or failed) and
agents waiting for a permission or an answer:

```console
$ casm pending
83b4f029  reviewer  waiting for you: 1 permission prompt(s)
2b9be91e  83b4f029  reviewer                  queued     Afterwards, list the files in test/.
c2da06b0  83b4f029  reviewer                  queued     Then tell me the package version.
$ casm pending reviewer --json
{
  "messages": [
    {
      "id": "2b9be91e-9cfd-4bce-8df4-e86731cd9a26",
      "agentId": "83b4f029-3d6b-46e9-9e63-60ddba8ca5a8",
      "text": "Afterwards, list the files in test/.",
      "reason": "queued",
      "createdAt": "2026-10-14T21:07:00.034Z"
    },
    …
  ],
  "blocked": [
    { "agentId": "83b4f029-3d6b-46e9-9e63-60ddba8ca5a8", "permissions": 1, "questions": 0 }
  ]
}
```

### casm cancel, retry, send-now

```text
casm cancel <agent> [message-id|--all]
casm retry <agent> <message-id>              retry a failed or limit-deferred message now
casm send-now <agent> <message-id> [--wait]  steer a pending message in now (or start a turn if idle)
```

Message IDs accept a prefix:

```console
$ casm pending reviewer
e2be083f  83b4f029  reviewer                  queued     Then say hi.
88219b3d  83b4f029  reviewer                  queued     And say bye.
$ casm cancel reviewer 88219b3d
cancelled 1
$ casm send-now reviewer e2be083f
$ casm pending reviewer
nothing pending
```

`retry` only applies to messages held back by a failure or a limit; while the
agent is busy, a retried message goes after the current turn.

### casm interrupt

```console
$ casm interrupt reviewer
```

Stops the running turn. The queue is kept and continues with its next message.

## Permissions and questions

```text
casm permissions <agent>
casm approve <agent> <request> [--always]
casm deny <agent> <request> [--message text]
casm questions <agent>
casm answer <agent> <request> <prompt>=<value>...   repeat a prompt for several choices
casm answer <agent> <request> --dismiss
```

```console
$ casm permissions reviewer
toolu_018tMD1j4Jst1ZffNs59VUzU  Count 1 to 40 with 0.5s delay between numbers  {"command":"for i in {1..40}; do echo $i; sleep 0.5; done","description":"Count 1 to 40 with 0.5s delay between numbers"}
$ casm approve reviewer toolu_018tMD1j4Jst1ZffNs59VUzU
```

Request IDs must be complete (no prefixes). `--always` allows the tool for the
rest of the session where the provider supports it; `deny --message` tells the
agent why.

## Schedules

```text
casm schedules [--agent a]
casm schedule add (--cron "0 9 * * 1-5" | --every 30m | --at 18:30|"in 2h"|ISO) <prompt>
                  (--agent a [--skip-if-busy] | --project p --provider claude [--model m] [--mode m] [--env K=V]... [--name n])
casm schedule edit <schedule> [--name n] [--cron e | --every d | --at t] [new prompt]
casm schedule run | enable | disable | rm <schedule>
```

```console
$ casm schedule add --every 30m --agent reviewer --skip-if-busy "Run npm test; report failures only."
f96acc72-309b-45cc-80ba-7100ac384581  next 10/14/2026, 9:59:19 PM
$ casm schedule add --cron "0 9 * * 1-5" --project acme-api --provider claude --model haiku --name triage "Summarize yesterday's commits."
cad7af3b-341b-4138-a30c-9fbbc0e834a9  next 10/15/2026, 9:00:00 AM
$ casm schedule add --at "in 2h" --agent reviewer "Check whether the order total rounding is fixed."
39a696c5-99be-47b1-b2d3-f55e81c196a5  next 10/14/2026, 11:07:50 PM
$ casm schedules
f96acc72  every 30m  → reviewer  next 10/14/2026, 9:59:19 PM
cad7af3b  triage  cron 0 9 * * 1-5  new claude agent  next 10/15/2026, 9:00:00 AM
39a696c5  once 10/14/2026, 11:07:50 PM  → reviewer  next 10/14/2026, 11:07:50 PM
```

`schedule edit` changes a schedule's name, cadence or prompt; `schedule run`
fires one now; `enable`/`disable` pause it; `rm` deletes it. Cron uses the
server's local time; `--every` counts from each due time, not from when the
previous run finished.

![schedules, limits, usage](media/cli-schedules.svg)

## Limits, usage and models

```text
casm limits [--provider p] [--refresh]
casm usage <agent>
casm models [--provider p] [--refresh]
```

```console
$ casm limits
claude  (max)  as of 2026-10-14T21:29:21.212Z
  5-hour            88% used  warning  resets 2026-10-14T22:29:59.993167+00:00
  weekly             6% used  resets 2026-10-21T18:59:59.993191+00:00
codex  (prolite)  as of 2026-10-14T21:29:22.123Z
  weekly            60% used  resets 2026-10-21T11:23:53.000Z
$ casm usage reviewer
ctx 30k/200k (15%)  $0.06  claude-haiku-4-5-20251001
$ casm models --provider claude
claude
  * default  Default (recommended)  effort: low, medium, high, xhigh, max
    opus  Opus 5.5  effort: low, medium, high, xhigh, max
    fable  Fable 5.1  effort: low, medium, high, xhigh, max
    sonnet  Sonnet 5.5  effort: low, medium, high, xhigh, max
    haiku  Haiku 4.5
    …
    modes: plan, default, acceptEdits, auto, bypassPermissions
```

Limits appear once a provider has reported them (Codex can be asked directly;
Claude reports them from its sessions). `--refresh` queries providers that
support it.

## Files

Read-only, and only inside project folders on the host:

```text
casm cat <path> [--force]     print a text file; --force prints a binary one too
casm get <path> [-o out]      download a file (default: its name, here); -o - writes to stdout
```

```console
$ casm cat /tmp/code/acme-api/src/orders.js | head -3
const orders = [
  { id: 1, customer: "Ada", total: 42.5, status: "shipped" },
  { id: 2, customer: "Linus", total: 17, status: "pending" },
$ casm get /tmp/code/acme-api/README.md -o /var/tmp/README.md
saved /var/tmp/README.md (123 bytes)
$ casm -H worker cat /tmp/code/acme-api/package.json | head -3
{
  "name": "acme-api",
  "version": "0.3.0",
$ casm cat /etc/hostname
casm: /etc/hostname is not inside a project folder on this host
```

## Subagents, shell and MCP

```text
casm subagents [agent] [-n count]     subagents the agents run themselves
casm shell <agent> <command>          run a command in the agent's folder, recorded in its history
casm mcp <agent> [--reconnect [server]]
```

```console
$ casm subagents reviewer
83b4f029  reviewer              done     Count 1 to 40 with 0.5s delay between numbers
          1 2 3 4 5 6 … 39 40
          casm history 83b4f029 --subagent toolu_018tMD1j4Jst1ZffNs59VUzU
$ casm shell reviewer "git log --oneline"
a40a335 initial orders API
$ casm mcp pickle
No MCP servers configured.
```

`casm shell` is the CLI form of `!cmd` in the web composer: the command and its
output become part of the agent's history. It exits 1 if the command fails.
`casm mcp` lists the agent's MCP servers with their status and tool counts;
see [MCP controls](mcp-controls.md).

## Notifications

```text
casm notify <message> [--title t] [--url path] [--device name]
```

Notifies the user: a Web Push notification to every device subscribed on the
host (enabled in the web client's host options, see
[notifications](web-client.md#notifications)), or only the one whose label or
id is `--device`, and a toast in every open web client. Run from an agent, it
is titled `<agent> · <project>` (with the schedule's name when a schedule
started the turn) and a click opens the agent; `--title` and `--url` (a path on
the web client, like `/h/<host>/a/<agent>`) override that. Agents run it when
you ask to be told about something; the default agent prompt says so.

```console
$ casm notify "Deploy finished: 3 services healthy"
delivered to 2 of 2 devices
$ casm notify "Only the phone" --device iphone
delivered to 1 of 1 device
```

At most 10 notifications a minute per agent; beyond that it fails with "too
many notifications" and when to try again. With no devices subscribed it still
shows in open web clients and says so. An expired subscription is removed and
reported. `-H <peer>` notifies the peer's devices.

## The agent prompt

```text
casm agent-prompt [agent]            show it, filled in for <agent> or an example agent
casm agent-prompt --edit | --reset   edit $CASM_HOME/agent-prompt.md in $EDITOR | back to the default
casm agent-prompt --enable | --disable
```

See [the agent prompt](concepts.md#the-agent-prompt).

## Agents running agents

Agents use this same CLI from their shell to spawn, message and steer other
agents; casm has no MCP tools of its own.

![a lead agent starts a helper on a peer with the CLI](media/cli-orchestration.svg)

Inside an agent, `CASM_SERVER_ID`,
`CASM_SERVER_NAME`, `CASM_AGENT_ID` and `CASM_AGENT_NAME` are set, so the agent
is the parent of what it starts and the sender of what it sends, also across
peers with `-H`. The [agent prompt](#the-agent-prompt) teaches it the commands.

| To | Run |
| --- | --- |
| See the hosts it can use, their reachability and agents | `casm peers --probe`, `casm -H <peer> info` |
| Check limits before delegating long work | `casm [-H <peer>] limits`, `casm usage <agent>` |
| Find a project, list agents | `casm projects`, `casm agents [--project p]` |
| Start an agent (it becomes the parent) | `casm [-H <peer>] run --project p [--cwd dir] [--provider …] [--model m] [--name n] "<prompt>"` |
| Message it, or steer its running turn | `casm send <agent> "<text>"`, `casm send <agent> "<text>" --steer` |
| Wait for its reply, read its transcript | `casm wait <agent> [--timeout s]`, `casm history <agent> [-n count]` |
| See what is waiting | `casm pending` |
| Unblock it | `casm permissions` / `approve` / `deny`, `casm questions` / `answer` |

`casm wait` exits `3` while the agent is still busy or waiting for an answer
and `4` when a usage limit deferred its prompt (see
[exit codes](#exit-codes-and-scripting)), so an agent can loop on it or pick
another provider or host. A lead agent on `studio` starting a helper on
`worker`:

```console
$ casm -H worker run --project acme-api --provider claude --model haiku --name helper "Say hello from worker."
$ casm -H worker wait helper
Hello from worker! 👋 I'm ready to help you with the acme-api project. What would you like to work on?
```

The helper's history on `worker` records who asked:

```console
$ casm -H worker history helper
from lead · studio
> Say hello from worker.

Hello from worker! 👋 I'm ready to help you with the acme-api project. What would you like to work on?
```

Providers that ask before running shell commands need a permission mode that
lets the agent run `casm` (for example Claude's `acceptEdits` with an allow
rule, or `bypassPermissions`).

## Lifecycle

```text
casm reload <agent>     reopen the provider process on the same session
casm restart <agent>    start a new native session on the next turn
casm archive <agent>    hide it (casm agents --all still lists it)
casm rm <agent>         delete casm's record (the provider's own files stay)
```

## Exit codes and scripting

- `0` success; `1` an error (message on stderr).
- `casm wait` / `--wait`: `3` still busy or waiting for you, `4` deferred by a
  usage limit, `5` the turn failed.
- `--json` prints the protocol result for any client command:

```console
$ casm --json agents | jq -r '.[] | "\(.name) \(.status)"'
```

Inside an agent, `CASM_SERVER_ID`, `CASM_SERVER_NAME`, `CASM_AGENT_ID` and
`CASM_AGENT_NAME` are set: `casm run` links children to it and `casm send`
records it as the sender.
