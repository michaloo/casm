import { basename } from "node:path";
import { homedir } from "node:os";
import { ErrorCode, PROTOCOL_VERSION, type MethodName, type Params, type Result } from "@casm/protocol";
import { RpcError, type AgentManager, type Notify } from "./agents.ts";
import type { Store } from "./db.ts";

export type Conn = { subscriptions: Set<string> };

type Handlers = { [M in MethodName]: (p: Params<M>, conn: Conn) => Result<M> | Promise<Result<M>> };

export function createHandlers(store: Store, agents: AgentManager, notify: Notify, version: string): Handlers {
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
  const changed = (id: string) => {
    const agent = getAgent(id);
    notify("agent.changed", { agent });
    return agent;
  };

  return {
    "server.info": () => ({ name: "casm", version, protocol: PROTOCOL_VERSION, providers: agents.providerIds() }),

    "provider.catalog": (p) => agents.catalog(p.provider, p.refresh),

    "project.list": (p) => ({ projects: store.listProjects(p.includeArchived) }),
    "project.create": (p) => {
      if (p.parentId) getProject(p.parentId);
      const project = store.createProject(p);
      notify("project.changed", { project });
      return project;
    },
    "project.update": (p) => {
      getProject(p.id);
      if (p.parentId) {
        // Reject cycles: the new parent must not be the project or its descendant.
        for (let q = store.getProject(p.parentId); q; q = q.parentId ? store.getProject(q.parentId) : undefined)
          if (q.id === p.id) throw new RpcError(ErrorCode.Conflict, "a project cannot be nested inside itself");
      }
      const project = store.updateProject(p.id, p)!;
      notify("project.changed", { project });
      return project;
    },
    "project.delete": async (p) => {
      getProject(p.id);
      const ids = new Set([p.id]);
      // Collect descendants so their live agents are stopped before the cascade.
      for (let grew = true; grew; ) {
        grew = false;
        for (const q of store.listProjects(true))
          if (q.parentId && ids.has(q.parentId) && !ids.has(q.id)) (ids.add(q.id), (grew = true));
      }
      for (const a of store.listAgents({ includeArchived: true })) if (ids.has(a.projectId)) await agents.remove(a.id);
      store.deleteProject(p.id);
      notify("project.removed", { projectId: p.id });
      return { ok: true };
    },

    "agent.list": (p) => ({ agents: store.listAgents(p).map((a) => agents.withStatus(a)) }),
    "agent.get": (p) => getAgent(p.id),
    "agent.create": (p) => {
      getProject(p.projectId);
      const cwd = p.cwd ?? store.projectPath(p.projectId) ?? homedir();
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
      if (p.prompt) agents.send(stored.id, p.prompt);
      return getAgent(stored.id);
    },
    "agent.update": (p) => {
      getAgent(p.id);
      if (p.projectId) getProject(p.projectId);
      store.updateAgent(p.id, p);
      return changed(p.id);
    },
    "agent.delete": async (p) => {
      getAgent(p.id);
      await agents.remove(p.id);
      store.deleteAgent(p.id);
      notify("agent.removed", { agentId: p.id });
      return { ok: true };
    },
    "agent.history": (p) => agents.history(p.id, p.before, p.limit),
    "agent.subscribe": (p, conn) => {
      const state = agents.subscribeState(p.id);
      conn.subscriptions.add(p.id);
      return state;
    },
    "agent.unsubscribe": (p, conn) => {
      conn.subscriptions.delete(p.id);
      return { ok: true };
    },
    "agent.send": (p) => agents.send(p.id, p.text, p.whenBusy),
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
  };
}
