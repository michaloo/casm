// casm's own MCP server, offered to agents with `config.casmTools`. Streamable
// HTTP at POST /mcp, answered with plain JSON (no SSE stream, no MCP session):
// only initialize, ping, tools/list and tools/call. The bearer token is minted
// per agent session, so every call knows which agent made it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { methods, type Item, type MethodName, type ProviderId } from "@casm/protocol";
import type { AgentManager } from "./agents.ts";
import type { Conn, Handlers, Identity } from "./methods.ts";
import type { Call, PeerPool } from "./peers.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 4 * 1024 * 1024;
// Below Codex's default 60 s MCP tool timeout; callers just wait again.
const DEFAULT_WAIT_S = 50;

// The `mcpServers` entry for the casm MCP server, in each agent's own config
// format. Null when the agent can't take a per-session HTTP MCP server.
export function casmMcpEntry(provider: ProviderId, url: string, token: string): unknown {
  const auth = { Authorization: `Bearer ${token}` };
  switch (provider) {
    case "claude":
      return { type: "http", url, headers: auth };
    case "codex":
      return { url, http_headers: auth };
    // Registered for the session by pi-extension.ts. Direct exposure declares
    // the tools to the model like Claude's and Codex's, not only to codemode.
    case "pi":
      return { url, headers: auth, exposure: "direct", description: "casm: create, message and wait for coding agents on this host and its peers" };
    // OpenCode's MCP config belongs to the shared `opencode serve`, so it can't
    // carry a per-agent token.
    default:
      return null;
  }
}

class ToolError extends Error {}

type Target = { host: string; serverId: string; local: boolean; call: Call };

export type McpContext = {
  identity: Identity;
  agents: AgentManager;
  handlers: Handlers;
  peers: PeerPool;
};

const host = z.string().optional().describe("Host name (a peer of this server). Omit for this server.");
const agentRef = z.string().describe("Agent id, id prefix or exact name");

const tools = {
  list_hosts: {
    description:
      "List this casm server and its peer servers (other machines you can run agents on), with reachability, the agents each offers and their subscription limits (used % per window). Prefer providers with headroom for long work.",
    input: z.object({}),
  },
  get_limits: {
    description:
      "Subscription/account limits per agent provider on a host: each window's used %, reset time and status. Check before delegating long work; `refresh` queries providers that support it.",
    input: z.object({ host, refresh: z.boolean().optional() }),
  },
  list_pending: {
    description:
      "Everything waiting on a host: messages queued behind running turns, deferred by usage limits or scheduled for later, and agents waiting for a permission or an answer.",
    input: z.object({ host }),
  },
  get_usage: {
    description: "Context-window usage and cost of one agent (tokens used of the window, model).",
    input: z.object({ host, agent: agentRef }),
  },
  list_projects: {
    description: "List projects on a host. Agents are created inside a project, which sets their working directory.",
    input: z.object({ host }),
  },
  list_agents: {
    description: "List agents on a host with their status (idle, running, waiting for a permission or answer).",
    input: z.object({ host, project: z.string().optional().describe("Project id, id prefix or name") }),
  },
  create_agent: {
    description:
      "Create a coding agent on a host (this one or a peer) and optionally start it on a prompt. It works in the project folder, or in `cwd`, a folder inside it (e.g. a git worktree). You become its parent. Use wait to get its reply.",
    input: z.object({
      host,
      project: z.string().describe("Project id, id prefix or name (see list_projects)"),
      cwd: z.string().optional().describe("Folder inside the project to work in, relative to the project path or absolute (e.g. a git worktree .worktrees/<task>). Defaults to the project folder."),
      provider: z.enum(["claude", "codex", "pi", "opencode"]).describe("Which agent to run (see list_hosts for what each host offers)"),
      prompt: z.string().optional(),
      model: z.string().optional(),
      mode: z.string().optional().describe("Permission/agent mode, provider specific"),
      name: z.string().optional(),
    }),
  },
  send: {
    description: "Send a message to an agent. If it is busy the message is queued behind the running turn.",
    input: z.object({ host, agent: agentRef, text: z.string() }),
  },
  wait: {
    description: `Wait until an agent is idle or blocked (waiting for a permission or answer), up to timeout_s (default ${DEFAULT_WAIT_S}). Returns its status, its last reply and any pending requests. If timedOut is true, call wait again.`,
    input: z.object({ host, agent: agentRef, timeout_s: z.number().positive().optional() }),
  },
  get_history: {
    description: "Read the last entries of an agent's transcript.",
    input: z.object({ host, agent: agentRef, limit: z.number().int().positive().optional().describe("Entries, default 20") }),
  },
  answer_permission: {
    description: "Answer a pending permission request of an agent (see wait / list pending).",
    input: z.object({
      host,
      agent: agentRef,
      request_id: z.string(),
      decision: z.enum(["allow", "allowAlways", "deny"]),
      message: z.string().optional().describe("Reason, shown to the agent on deny"),
    }),
  },
  answer_question: {
    description: "Answer a pending question of an agent. answers maps prompt id to a value (option label, text, list of labels or boolean). Omit answers to dismiss.",
    input: z.object({
      host,
      agent: agentRef,
      request_id: z.string(),
      answers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.boolean()])).optional(),
    }),
  },
} as const;

type ToolName = keyof typeof tools;

// The tool names an agent with casmTools sees (Claude shows them as mcp__casm__<name>).
export const CASM_TOOL_NAMES = Object.keys(tools) as ToolName[];
type Args<T extends ToolName> = z.infer<(typeof tools)[T]["input"]>;

function pick<T extends { id: string; name: string }>(list: T[], ref: string, what: string, where: string): T {
  const exact = list.find((x) => x.id === ref || x.name === ref);
  if (exact) return exact;
  const byPrefix = list.filter((x) => x.id.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0];
  throw new ToolError(byPrefix.length ? `"${ref}" matches several ${what}s on ${where}` : `no ${what} "${ref}" on ${where}`);
}

function renderItem(i: Item): string {
  switch (i.kind) {
    case "user":
      return `user: ${i.text}`;
    case "assistant":
      return `assistant: ${i.text}`;
    case "reasoning":
      return `reasoning: ${i.text.slice(0, 200)}`;
    case "tool": {
      const input = JSON.stringify(i.input ?? {});
      return `tool ${i.name} (${i.status}): ${input.length > 200 ? input.slice(0, 197) + "..." : input}`;
    }
    case "notice":
      return `notice: ${i.text}`;
    case "plan":
      return `plan: ${i.entries.map((e) => `[${e.status}] ${e.text}`).join("; ")}`;
    case "subagent":
      return `subagent ${i.id} [${i.status}] ${i.title}${i.activity ? ` - ${i.activity}` : ""}${i.summary ? `\n${i.summary}` : ""}`;
  }
}

export function createMcp(ctx: McpContext) {
  const { identity, handlers, peers } = ctx;
  const conn: Conn = { subscriptions: new Set() };

  const localCall: Call = async (method, params) => {
    const parsed = methods[method as MethodName].params.parse(params);
    return (handlers[method] as (p: unknown, c: Conn) => unknown)(parsed, conn) as never;
  };
  const local: Target = { host: identity.name, serverId: identity.id, local: true, call: localCall };

  function target(ref: string | undefined): Target {
    if (!ref || ref === identity.name || ref === identity.id || ref === "local") return local;
    const peer = peers.find(ref);
    if (!peer) {
      const known = [identity.name, ...peers.list().map((p) => p.name)].join(", ");
      throw new ToolError(`unknown host "${ref}" (known: ${known})`);
    }
    return { host: peer.name, serverId: peer.serverId ?? "", local: false, call: peers.caller(peer) };
  }

  async function findAgent(t: Target, ref: string) {
    const { agents } = await t.call("agent.list", { includeArchived: true });
    return pick(agents, ref, "agent", t.host);
  }

  const run: { [T in ToolName]: (args: Args<T>, caller: string) => Promise<unknown> } = {
    async list_hosts() {
      const here = {
        name: identity.name,
        serverId: identity.id,
        local: true,
        reachable: true,
        providers: ctx.agents.providerIds(),
        limits: await ctx.agents.limits().catch(() => []),
      };
      const others = await Promise.all(
        peers.list().map(async (p) => {
          try {
            const call = peers.caller(p);
            const info = await call("server.info", {});
            const limits = await call("provider.limits", {}).then((r) => r.limits, () => []);
            return { name: p.name, serverId: info.id, local: false, reachable: true, providers: info.providers, limits };
          } catch (e) {
            return { name: p.name, serverId: p.serverId, local: false, reachable: false, error: (e as Error).message };
          }
        }),
      );
      return [here, ...others];
    },

    async get_limits(a) {
      return (await target(a.host).call("provider.limits", { refresh: a.refresh })).limits;
    },

    async list_pending(a) {
      return target(a.host).call("pending.list", {});
    },

    async get_usage(a) {
      const t = target(a.host);
      const agent = await findAgent(t, a.agent);
      return { agent: agent.id, ...(await t.call("agent.usage", { id: agent.id })) };
    },

    async list_projects(a) {
      const t = target(a.host);
      const { projects } = await t.call("project.list", {});
      return projects.map((p) => ({ id: p.id, name: p.name, path: p.path, group: p.group }));
    },

    async list_agents(a) {
      const t = target(a.host);
      const { projects } = await t.call("project.list", { includeArchived: true });
      const projectId = a.project ? pick(projects, a.project, "project", t.host).id : undefined;
      const { agents } = await t.call("agent.list", { projectId });
      const names = new Map(projects.map((p) => [p.id, p.name]));
      return agents.map((x) => ({
        id: x.id,
        name: x.name,
        provider: x.provider,
        status: x.status,
        project: names.get(x.projectId) ?? x.projectId,
        parent: x.parent,
      }));
    },

    async create_agent(a, caller) {
      const t = target(a.host);
      const { projects } = await t.call("project.list", {});
      const project = pick(projects, a.project, "project", t.host);
      const created = await t.call("agent.create", {
        projectId: project.id,
        cwd: a.cwd,
        provider: a.provider,
        name: a.name,
        config: Object.fromEntries(Object.entries({ model: a.model, mode: a.mode }).filter(([, v]) => v)),
        parent: { serverId: identity.id, agentId: caller, host: identity.name },
        prompt: a.prompt,
        sender: ctx.agents.messageSender(caller),
      });
      return { host: t.host, id: created.id, name: created.name, status: created.status, cwd: created.cwd };
    },

    async send(a, caller) {
      const t = target(a.host);
      const agent = await findAgent(t, a.agent);
      return t.call("agent.send", { id: agent.id, text: a.text, sender: ctx.agents.messageSender(caller) });
    },

    async wait(a) {
      const t = target(a.host);
      const agent = await findAgent(t, a.agent);
      const r = await t.call("agent.wait", { id: agent.id, timeoutMs: (a.timeout_s ?? DEFAULT_WAIT_S) * 1000 });
      // A usage limit leaves it idle with the prompt deferred until the reset.
      const { deferred } = await t.call("agent.get", { id: agent.id });
      if (deferred) return { ...r, deferred, note: "This agent's provider hit a usage limit; its prompt will be retried automatically at `deferred.until`. Consider another provider or host (get_limits)." };
      if (r.status !== "waiting") return r;
      const s = await t.call("agent.subscribe", { id: agent.id });
      await t.call("agent.unsubscribe", { id: agent.id });
      return { ...r, permissions: s.permissions, questions: s.questions };
    },

    async get_history(a) {
      const t = target(a.host);
      const agent = await findAgent(t, a.agent);
      const h = await t.call("agent.history", { id: agent.id, limit: a.limit ?? 20 });
      return [h.start > 0 ? `(${h.start} earlier entries)` : "", ...h.items.map(renderItem)].filter(Boolean).join("\n") || "(empty)";
    },

    async answer_permission(a) {
      const t = target(a.host);
      const agent = await findAgent(t, a.agent);
      return t.call("agent.respondPermission", { id: agent.id, requestId: a.request_id, decision: a.decision, message: a.message });
    },

    async answer_question(a) {
      const t = target(a.host);
      const agent = await findAgent(t, a.agent);
      return t.call("agent.answerQuestion", { id: agent.id, requestId: a.request_id, answers: a.answers });
    },
  };

  const toolList = Object.entries(tools).map(([name, t]) => {
    const { $schema: _, ...inputSchema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
    return { name, description: t.description, inputSchema };
  });

  async function callTool(name: string, args: unknown, caller: string) {
    const tool = tools[name as ToolName];
    if (!tool) return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success)
      return { content: [{ type: "text", text: `invalid arguments: ${z.prettifyError(parsed.error)}` }], isError: true };
    try {
      const result = await (run[name as ToolName] as (a: unknown, c: string) => Promise<unknown>)(parsed.data, caller);
      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
  }

  type Msg = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: Record<string, unknown> };

  async function handleMessage(m: Msg, caller: string): Promise<object | null> {
    // Notifications (initialized, cancelled) and responses need no answer.
    if (m.id === undefined || m.id === null || !m.method) return null;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize": {
        const asked = m.params?.protocolVersion as string | undefined;
        return ok({
          protocolVersion: asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "casm", version: identity.version },
          instructions: `casm server "${identity.name}". Create and drive coding agents here or on peer hosts (list_hosts).`,
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: toolList });
      case "tools/call":
        return ok(await callTool(String(m.params?.name ?? ""), m.params?.arguments, caller));
      default:
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } };
    }
  }

  function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
    if (body === undefined) return res.writeHead(status, headers).end();
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const auth = req.headers.authorization ?? "";
    const caller = auth.startsWith("Bearer ") ? ctx.agents.agentForMcpToken(auth.slice(7).trim()) : undefined;
    if (!caller)
      return send(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized: casm MCP needs the agent token casm put in its config" } });
    // No server-initiated stream and no MCP sessions.
    if (req.method !== "POST") return send(res, 405, undefined, { allow: "POST" });

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return send(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request too large" } });
    }
    let msg: Msg | Msg[];
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } });
    }
    if (Array.isArray(msg)) {
      const replies = (await Promise.all(msg.map((m) => handleMessage(m, caller)))).filter(Boolean);
      return replies.length ? send(res, 200, replies) : send(res, 202);
    }
    const reply = await handleMessage(msg, caller);
    return reply ? send(res, 200, reply) : send(res, 202);
  };
}
