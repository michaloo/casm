# MCP tools for agents

casm can give an agent its own MCP server, so the agent can orchestrate other
agents without shelling out to the CLI: list hosts and their limits, start
agents here or on a peer, message them, wait for them and answer their
permission requests and questions.

![an agent starts and waits for another agent on a peer](media/cli-orchestration.svg)

## Turning it on

```console
$ casm run --project acme-api --provider claude --model haiku --casm-tools "…"
```

or `casmTools: true` in the agent's config through the protocol (a
schedule's new-agent preset takes the same config). It works
with Claude, Codex, pi and OpenCode:

- Claude and Codex get the server in their session's MCP configuration.
- pi gets it from a casm extension that registers it for that session only
  (never written to pi's `mcp.json`).
- OpenCode's MCP config is shared by its server, so casm's OpenCode plugin
  offers the same tools as plugin tools named `casm_<tool>`, calling the
  endpoint with the session's own token.

Each agent session gets its own bearer token, so casm knows which agent is
calling: agents it creates get it as their **parent**, and its messages carry
it as the **sender** (shown as `from lead · studio` in the recipient's
history). Claude shows the tools as `mcp__casm__<tool>`.

## Tools

Most tools take an optional `host`: the name of a peer of this server. Omit it
for this server. `agent` accepts an ID, an ID prefix or an exact name.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `list_hosts` | none | This server and its peers, whether each is reachable, the providers each offers and their subscription limits. |
| `get_limits` | `host?`, `refresh?` | Each provider's limit windows on a host: used %, reset time, status. |
| `list_pending` | `host?` | Queued, limit-deferred and failed messages, and agents waiting for a permission or answer. |
| `get_usage` | `host?`, `agent` | Context-window usage and cost of one agent. |
| `list_projects` | `host?` | Projects on a host (ID, name, path, group). |
| `list_agents` | `host?`, `project?` | Agents with status, provider, project and parent. |
| `create_agent` | `host?`, `project`, `provider`, `cwd?`, `prompt?`, `model?`, `mode?`, `env?`, `name?` | Creates an agent (the caller becomes its parent) and optionally starts it on a prompt. |
| `send` | `host?`, `agent`, `text` | Sends a message; queued behind a running turn. |
| `wait` | `host?`, `agent`, `timeout_s?` | Waits until the agent is idle or blocked (default 50 s, below Codex's 60 s tool timeout). Returns the status, last reply and any open requests. If `timedOut`, call it again. If the provider hit a limit, says when it retries. |
| `get_history` | `host?`, `agent`, `limit?` | The last entries of the transcript as text (default 20). |
| `answer_permission` | `host?`, `agent`, `request_id`, `decision` (`allow`, `allowAlways`, `deny`), `message?` | Answers a permission request. |
| `answer_question` | `host?`, `agent`, `request_id`, `answers?` | Answers a question; `answers` maps prompt ID to a label, text, list or boolean. Omit to dismiss. |

## Example

The agent `lead` (with `--casm-tools`) was asked to start a helper on the
peer `worker` and report its reply. Its transcript:

```console
$ casm history lead
> Use the casm MCP tool list_hosts, then in 3 short bullet lines tell me each host, whether it's reachable and its providers. Then use create_agent to start a claude agent with model haiku on host worker in project acme-api named 'helper' …
  ✓ mcp__casm__list_hosts {}
  ✓ mcp__casm__create_agent {"project":"acme-api","provider":"claude","model":"haiku","host":"worker","name":"helper","prompt":"Say hello from wo...
  ✓ mcp__casm__wait {"agent":"helper","host":"worker"}

**Hosts:**
- **studio** — local, reachable; providers: claude, codex, pi, opencode
- **worker** — remote, reachable; providers: claude, codex, pi, opencode

**Agent reply:**
> Hello from worker! 👋 I'm ready to help you with the acme-api project. What would you like to work on?
```

And on `worker`, the helper's history records who asked:

```console
$ casm -H worker history helper
from lead · studio
> Say hello from worker.

Hello from worker! 👋 I'm ready to help you with the acme-api project. What would you like to work on?
```

## Without MCP

Every agent also gets the [agent prompt](concepts.md#the-agent-prompt), which
teaches it the `casm` CLI. Inside an agent `CASM_AGENT_ID` and friends are
set, so `casm run`, `casm send` and `casm wait` from its shell link and attribute
the same way. MCP is the better fit for providers that run shell commands
only with permission, and for structured results.

## The endpoint

`POST /mcp` on the casm server: MCP Streamable HTTP with plain JSON responses
(no SSE stream, no MCP sessions), supporting `initialize`, `ping`,
`tools/list` and `tools/call`, protocol versions 2024-11-05 to 2025-11-25. It
rejects anything but a per-agent token with 401.

To inspect or reconnect an agent's *other* MCP servers, see
[MCP controls](mcp-controls.md).
