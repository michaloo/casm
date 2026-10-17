import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { ErrorCode, PROTOCOL_VERSION, type MethodName, type Params, type ProviderId, type Result } from "@casm/protocol";
import { RpcError, type AgentManager, type Notify } from "./agents.ts";
import type { Store } from "./db.ts";
import type { Scheduler } from "./schedules.ts";
import { searchFiles } from "./fs-search.ts";
import type { Files } from "./files.ts";
import { HostSampler } from "./host-stats.ts";
import { CostReader } from "./costs.ts";
import { hostAgentsMd, setHostAgentsMd } from "./host-details.ts";
import { listMemories, readAgentsMd, writeAgentsMd } from "./project-details.ts";
import type { PeerPool } from "./peers.ts";
import type { PushService } from "./push.ts";
import { DEFAULT_AGENT_PROMPT, PLACEHOLDERS, type AgentPromptState } from "./agent-prompt.ts";

// `name`: the client token's name (or what started the call, e.g. a schedule).
export type Conn = { subscriptions: Set<string>; name?: string };

export type Handlers = { [M in MethodName]: (p: Params<M>, conn: Conn) => Result<M> | Promise<Result<M>> };

export type Identity = { id: string; name: string; version: string };

// An agent folder inside the project: `cwd` absolute or relative to the
// project path, existing, and still inside the project once symlinks and ".."
// are resolved. Returned as given (resolved), so paths keep the project's spelling.
export function agentCwd(projectPath: string, cwd: string): string {
  const wanted = resolve(projectPath, cwd);
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const root = real(projectPath);
  const target = real(wanted);
  if (!root) throw new RpcError(ErrorCode.InvalidParams, `the project folder does not exist on this host: ${projectPath}`);
  if (!target || !statSync(target).isDirectory()) throw new RpcError(ErrorCode.InvalidParams, `no such directory on this host: ${wanted}`);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new RpcError(ErrorCode.InvalidParams, `cwd must be inside the project folder ${projectPath}: ${cwd} resolves to ${target}`);
  return wanted;
}

export function createHandlers(
  store: Store,
  agents: AgentManager,
  notify: Notify,
  identity: Identity,
  peers: PeerPool,
  schedules: () => Scheduler,
  files: Files,
  push: PushService,
): Handlers {
  const getProject = (id: string) => {
    const p = store.getProject(id);
    if (!p) throw new RpcError(ErrorCode.NotFound, `project ${id} not found`);
    return p;
  };
  const getAgent = (id: string) => {
    const a = store.getAgent(id);
    if (!a) throw new RpcError(ErrorCode.NotFound, `agent ${id} not found`);
    return agents.withStatus(a);
  };
  const sender = (source: Params<"agent.send">["sender"]) => {
    if (!source) return undefined;
    // Local names come from the store, not a stale or client-supplied label.
    if (source.serverId === identity.id) {
      if (source.schedule) {
        const schedule = store.getSchedule(source.schedule.id);
        if (!schedule) throw new RpcError(ErrorCode.NotFound, "sender schedule not found");
        return agents.scheduleSender(schedule.id, schedule.name);
      }
      return { ...source, name: getAgent(source.agentId).name, host: identity.name };
    }
    return source;
  };
  // Mode ids are a fixed per-agent list, so a wrong one (say Claude's "default"
  // sent to Codex) is rejected. Models aren't checked: agents accept ids beyond
  // their catalog (full Claude model ids, OpenCode provider/model pairs).
  const checkMode = async (provider: ProviderId, mode: string | undefined) => {
    if (!mode) return;
    const modes = await agents.catalog(provider).then((c) => c.modes, () => null);
    if (modes && !modes.some((m) => m.id === mode))
      throw new RpcError(ErrorCode.InvalidParams, `unknown ${provider} mode "${mode}" (modes: ${modes.map((m) => m.id).join(", ") || "none"})`);
  };
  const changed = (id: string) => {
    const agent = getAgent(id);
    notify("agent.changed", { agent });
    return agent;
  };

  // For one agent, or an example one.
  const agentPromptInfo = (state: AgentPromptState, agentId?: string): Result<"server.agentPrompt"> => {
    const vars = agentId
      ? agents.promptVars(getAgent(agentId))
      : { host: identity.name, agentId: "0b5e7c1d-1a2b-4c3d-8e9f-example00001", agentName: "example", project: "example-project",
          cwd: "/path/to/example-project", provider: "claude" };
    const { enabled, content, custom, path } = state;
    return { enabled, content, custom, path, default: DEFAULT_AGENT_PROMPT, placeholders: [...PLACEHOLDERS], rendered: agents.agentPrompt.render(vars, state) };
  };

  const sampler = new HostSampler();
  const costs = new CostReader(store, () => agents.installedProviders());
  return {
    "host.stats": async () => await sampler.read(agents.runningCount()),
    "host.agentsMd": async () => ({ files: await hostAgentsMd() }),
    "host.setAgentsMd": (p) => setHostAgentsMd(p.path, p.content, p.expectedSha256),
    "server.agentPrompt": (p) => agentPromptInfo(agents.agentPrompt.state(), p.agentId),
    "server.setAgentPrompt": (p) => {
      if (!agents.agentPrompt.home) throw new RpcError(ErrorCode.Conflict, "this server keeps no state directory for an agent prompt");
      return agentPromptInfo(agents.agentPrompt.set(p));
    },
    // Answered by the transport (server.ts), which owns the connection's auth state.
    auth: () => ({ ok: true }),

    "server.info": () => ({ ...identity, protocol: PROTOCOL_VERSION, providers: agents.providerIds() }),

    "fs.search": async (p) => {
      const root = p.agentId ? getAgent(p.agentId).cwd : p.cwd;
      if (!root || !isAbsolute(root)) throw new RpcError(ErrorCode.InvalidParams, "give an agentId or an absolute cwd");
      return { root, entries: await searchFiles(root, p.query, p.limit) };
    },

    "fs.read": (p) => files.read(p),
    "fs.downloadLink": (p) => files.link(p),

    "peer.list": async (p) => ({
      peers: await Promise.all(
        peers.list().map(async (x) => ({
          name: x.name,
          url: x.url,
          serverId: x.serverId,
          ...(p.probe ? await peers.probe(x) : {}),
        })),
      ),
    }),

    "provider.catalog": (p) => agents.catalog(p.provider, p.refresh),
    "provider.limits": async (p) => ({ limits: await agents.limits(p.provider, p.refresh) }),
    "provider.costs": (p) => costs.costs(p.days),

    "project.list": (p) => ({ projects: store.listProjects(p.includeArchived) }),
    "project.create": (p) => {
      if (!isAbsolute(p.path)) throw new RpcError(ErrorCode.InvalidParams, "path must be absolute");
      const { createFolder, ...fields } = p;
      const existing = statSync(p.path, { throwIfNoEntry: false });
      if (existing && !existing.isDirectory()) throw new RpcError(ErrorCode.InvalidParams, `not a directory on this host: ${p.path}`);
      if (!existing) {
        if (!createFolder) throw new RpcError(ErrorCode.InvalidParams, `no such directory on this host: ${p.path}`);
        try {
          mkdirSync(p.path, { recursive: true });
        } catch (error) {
          throw new RpcError(ErrorCode.InvalidParams, `could not create ${p.path}: ${(error as Error).message}`);
        }
      }
      const project = store.createProject({ ...fields, name: p.name ?? (basename(p.path) || p.path) });
      notify("project.changed", { project });
      return project;
    },
    "project.update": (p) => {
      getProject(p.id);
      const project = store.updateProject(p.id, p)!;
      notify("project.changed", { project });
      return project;
    },
    "project.delete": async (p) => {
      getProject(p.id);
      schedules().projectRemoved(p.id);
      for (const a of store.listAgents({ projectId: p.id, includeArchived: true })) await agents.remove(a.id);
      store.deleteProject(p.id);
      notify("project.removed", { projectId: p.id });
      return { ok: true };
    },
    "project.agentsMd": (p) => readAgentsMd(getProject(p.id).path),
    "project.setAgentsMd": (p) => writeAgentsMd(getProject(p.id).path, p.content, p.expectedSha256),
    "project.memories": async (p) => ({ agents: await listMemories(agents.installedProviders(), getProject(p.id).path) }),
    "agent.list": (p) => ({ agents: store.listAgents(p).map((a) => agents.withStatus(a)) }),
    "agent.get": (p) => getAgent(p.id),
    "agent.create": async (p) => {
      await checkMode(p.provider, p.config?.mode);
      const project = getProject(p.projectId);
      const cwd = p.cwd ? agentCwd(project.path, p.cwd) : project.path;
      const stored = store.createAgent({
        projectId: p.projectId,
        name: p.name ?? `${p.provider} · ${basename(cwd)}`,
        provider: p.provider,
        cwd,
        config: p.config ?? {},
        parent: p.parent,
        tags: p.tags,
      });
      notify("agent.changed", { agent: agents.withStatus(stored) });
      if (p.prompt || p.images?.length) agents.send(stored.id, { text: p.prompt ?? "", images: p.images, sender: sender(p.sender) });
      return getAgent(stored.id);
    },
    "agent.update": async (p) => {
      const current = getAgent(p.id);
      await checkMode(current.provider, p.config?.mode);
      // Config fields merge; an empty string clears a field.
      const config = p.config
        ? Object.fromEntries(Object.entries({ ...current.config, ...p.config }).filter(([, v]) => v !== "" && v !== undefined))
        : undefined;
      // A different model makes the reported one stale until the next session reports again.
      const effectiveModel = config && config.model !== current.config.model ? null : undefined;
      store.updateAgent(p.id, { ...p, config, effectiveModel });
      if (config) agents.configChanged(p.id);
      return changed(p.id);
    },
    "agent.delete": async (p) => {
      getAgent(p.id);
      await agents.remove(p.id);
      schedules().agentRemoved(p.id);
      store.deleteAgent(p.id);
      notify("agent.removed", { agentId: p.id });
      return { ok: true };
    },
    "agent.history": (p) => agents.history(p.id, p.before, p.limit),
    "agent.find": (p) => agents.find(p.id, p.query, { limit: p.limit, kinds: p.kinds }),
    "agent.subscribe": (p, conn) => {
      const state = agents.subscribeState(p.id);
      conn.subscriptions.add(p.id);
      return state;
    },
    "agent.unsubscribe": (p, conn) => {
      conn.subscriptions.delete(p.id);
      return { ok: true };
    },
    "agent.send": (p) =>
      agents.send(p.id, { text: p.text, images: p.images, sender: sender(p.sender), ...(p.messageId ? { id: p.messageId } : {}) }, p.whenBusy, p.whenLimited),
    "schedule.list": (p) => ({ schedules: schedules().list(p) }),
    "schedule.create": (p) => schedules().create(p),
    "schedule.update": (p) => schedules().update(p),
    "schedule.delete": (p) => {
      schedules().delete(p.id);
      return { ok: true };
    },
    "schedule.runNow": (p) => schedules().runNow(p.id),
    "agent.pending": (p) => {
      getAgent(p.id);
      return { messages: agents.pendingMessages(p.id) };
    },
    "agent.retryPending": (p) => agents.retryPending(p.id, p.messageId),
    "agent.steerPending": (p) => agents.steerPending(p.id, p.messageId),
    "agent.editPending": (p) => {
      agents.editPending(p.id, p.messageId, p.text);
      return { ok: true };
    },
    "agent.cancelPending": (p) => ({ cancelled: agents.cancelPending(p.id, p.messageId) }),
    "pending.list": () => ({ messages: agents.pendingMessages(), blocked: agents.blocked() }),
    "agent.usage": async (p) => ({ usage: await agents.usage(p.id) }),
    "agent.subagentHistory": async (p) => ({ items: await agents.subagentHistory(p.id, p.subagentId, p.limit) }),
    "agent.subagents": async (p) => ({ subagents: await agents.subagents(p.id, p.limit) }),
    "agent.mcpStatus": (p) => agents.mcpStatus(p.id),
    "agent.mcpReconnect": (p) => agents.mcpReconnect(p.id, p.server),
    "agent.mcpToggle": (p) => agents.mcpToggle(p.id, p.server, p.enabled),
    "agent.commands": async (p) => ({ commands: await agents.commands(p.id, p.refresh) }),
    "agent.shell": (p) => {
      agents.shell(p.id, p.command);
      return { ok: true };
    },
    "agent.interrupt": async (p) => {
      await agents.interrupt(p.id);
      return { ok: true };
    },
    "agent.reload": async (p) => {
      await agents.reload(p.id);
      return { ok: true };
    },
    "agent.restart": async (p) => {
      await agents.restart(p.id);
      return { ok: true };
    },
    "agent.answerQuestion": (p) => {
      agents.answerQuestion(p.id, p.requestId, p.answers ?? null);
      return { ok: true };
    },
    "agent.respondPermission": (p) => {
      agents.respondPermission(p.id, p.requestId, { decision: p.decision, message: p.message });
      return { ok: true };
    },
    "agent.wait": (p) => agents.wait(p.id, p.timeoutMs),

    "push.list": (p) => push.list(p.endpoint),
    "push.subscribe": (p) => push.subscribe(p),
    "push.unsubscribe": (p) => push.unsubscribe(p),
    "push.test": (p) => push.test(p.id, identity.name),
    "push.notify": (p, conn) => push.notify(p, { server: identity, turnSender: (id) => agents.turnSender(id) }, conn.name ?? "client"),
  };
}
