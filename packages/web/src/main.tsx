import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Row, Images } from "./transcript";
import type {
  Agent,
  Catalog,
  Item,
  ModelInfo,
  ProviderId,
} from "@casm/protocol";
import { Rpc, chat, chats, event, key, syncPending, type Host } from "./state";
import { resolveView, viewPath, type Selection } from "./navigation";
import { restoreDraft, saveDraft, flushDrafts } from "./drafts";
import { ProviderIcon } from "./provider-icon";
import { HostMenu, type HostState } from "./host-menu";
import { schedulesChanged } from "./host-schedules";
import { AgentActivity } from "./agent-activity-view";
import { AgentSummary } from "./agent-summary";
import { agentHierarchy } from "./agent-hierarchy";
import { modelLabels } from "./model-label";
import { projectKey, projectExpanded, readCollapsed, writeCollapsed, type CollapsedProjects } from "./project-collapse";
import { PendingQueue } from "./pending-queue";
import { Question } from "./question";
import { ChatWorking } from "./chat-working";
import { newMessageId, sendMode, visiblePending } from "./outbox";
import { PendingRows } from "./pending-strip";
import "./style.css";
// Same threshold the server uses for a slow peer probe.
const SLOW_HOST_MS = 2000;
const noModels: ModelInfo[] = [];
const coarsePointer = matchMedia("(pointer: coarse)");
// Memoized: transcript deltas re-render App often, and the sidebar can hold 100+ agents.
const AgentRow = memo(function AgentRow({ agent, host, depth, status, selected, online, models, onChoose }: {
  agent: Agent; host: string; depth: number; status: string; selected: boolean; online: boolean; models: ModelInfo[];
  onChoose: (s: Selection) => void;
}) {
  return (
    <button
      className={`agent ${selected ? "selected" : ""}`}
      data-depth={depth}
      aria-current={selected ? "page" : undefined}
      style={{ "--agent-depth": depth } as React.CSSProperties}
      onClick={() => onChoose({ host, project: agent.projectId, id: agent.id })}
    >
      <AgentSummary agent={agent} status={status} online={online} models={models} />
    </button>
  );
});
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
function App() {
  const [token, setToken] = useState(localStorage.getItem("casm.token") ?? "");
  const [entry, setEntry] = useState("");
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document
        .querySelector("#apple-icon")
        ?.setAttribute(
          "href",
          media.matches
            ? "/apple-touch-icon-dark.png"
            : "/apple-touch-icon.png",
        );
      document
        .querySelector("#app-manifest")
        ?.setAttribute(
          "href",
          media.matches
            ? "/manifest-dark.webmanifest"
            : "/manifest.webmanifest",
        );
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    // iOS keeps the layout viewport under the keyboard; size the app to what is visible.
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement.style;
    const update = () => {
      root.setProperty("--viewport-height", `${viewport.height}px`);
      root.setProperty("--viewport-top", `${viewport.offsetTop}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  const [path, setPath] = useState(location.pathname);
  const [routeError, setRouteError] = useState("");
  useEffect(() => {
    const pop = () => setPath(location.pathname);
    const hidden = () => {
      if (document.visibilityState === "hidden") flushDrafts();
    };
    window.addEventListener("popstate", pop);
    window.addEventListener("pagehide", flushDrafts);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      flushDrafts();
      window.removeEventListener("popstate", pop);
      window.removeEventListener("pagehide", flushDrafts);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  const [online, setOnline] = useState(false);
  const [hosts, setHosts] = useState<Host[]>([]);
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const [selection, select] = useState<{
    host: string;
    project: string;
    id?: string;
  }>();
  useEffect(() => {
    if (!hosts.length) return;
    const view = resolveView(path, hosts);
    setRouteError(view.error ?? "");
    select(view.selection);
  }, [path, hosts]);
  const selected = useRef(selection);
  selected.current = selection;
  const [, render] = useState(0);
  const redraw = () => render((x) => x + 1);
  const [error, setError] = useState("");
  const deferredSteers = useRef(new Map<string, string>()).current;
  // Status text of pending rows with an action in flight, by key(host, id).
  const rowNotes = useRef(new Map<string, string>()).current;
  const [sidebar, showSidebar] = useState(false);
  const [collapsed, setCollapsed] = useState<CollapsedProjects>(() => readCollapsed(localStorage));
  const toggleProject = (host: string, project: string) => {
    setCollapsed((previous) => {
      const next = { ...previous };
      const id = projectKey(host, project);
      if (next[id]) delete next[id]; else next[id] = true;
      writeCollapsed(localStorage, next);
      return next;
    });
  };
  const rpc = useRef<Rpc>(null);
  // Stable for memoized agent rows; always calls the latest choose().
  const chooseRef = useRef<(s: Selection) => void>(null);
  chooseRef.current = choose;
  const chooseAgent = useCallback((s: Selection) => chooseRef.current!(s), []);
  const [provider, setProvider] = useState<ProviderId>("claude");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState("");
  const [catalog, setCatalog] = useState<Catalog>({ models: [], modes: [] });
  // Only creating a new agent waits for the server; sends to existing agents
  // show at once and reconcile by message id.
  const [creating, setCreating] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError("");
      await fn();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  async function refreshPending(host: string, id: string, r = rpc.current!) {
    if (await syncPending(chat(key(host, id)), () => r.call("agent.pending", { id }, host))) redraw();
  }
  async function load(host: string, id: string, reconnect = false) {
    const c = chat(key(host, id));
    if (c.loading) return;
    // Cached history remains valid, but the queue can change while unselected.
    if (c.loaded && !reconnect) return refreshPending(host, id);
    c.loading = true;
    redraw();
    try {
      // Subscribe first; buffer notifications during the history snapshot to avoid losing deltas.
      const buffered: any[] = [];
      buffers.set(key(host, id), buffered);
      const sub = await rpc.current!.call("agent.subscribe", { id }, host);
      buffered.length = 0;
      const history = await rpc.current!.call(
        "agent.history",
        { id, limit: 100 },
        host,
      );
      await refreshPending(host, id);
      c.items = history.items;
      c.start = history.start;
      c.draft = "";
      c.reasoning = "";
      c.permissions = sub.permissions;
      c.questions = sub.questions;
      sub.turn.forEach((e) => event(c, e, true));
      buffered.forEach((e) => event(c, e));
      c.loaded = true;
    } finally {
      buffers.delete(key(host, id));
      c.loading = false;
      redraw();
    }
  }
  const buffers = useRef(new Map<string, any[]>()).current;
  const refreshes = useRef(0);
  // Reloads a chat whose peer dropped, retrying while it stays selected.
  function resubscribe(host: string, id: string, r: Rpc, delay = 1600) {
    setTimeout(() => {
      const s = selected.current;
      if (rpc.current !== r || s?.host !== host || s.id !== id || chat(key(host, id)).loaded) return;
      load(host, id, true).catch(() => resubscribe(host, id, r, Math.min(delay * 2, 15000)));
    }, delay);
  }
  async function refresh() {
    const r = rpc.current!;
    const info = await r.call("server.info", {});
    const peers = await r.call("peer.list", {});
    const list = [
      { id: "", name: info.name, serverId: info.id },
      ...peers.peers.map((p) => ({ id: p.name, name: p.name, serverId: p.serverId })),
    ];
    const generation = ++refreshes.current;
    // List every host at once; each fills in as it answers (a sleeping peer can take seconds).
    const previous = new Map(hostsRef.current.map((h) => [h.id, h]));
    setHosts(list.map((h) => ({ projects: [], agents: [], ...previous.get(h.id), ...h, error: undefined, loading: true })));
    await Promise.all(
      list.map(async (h) => {
        const started = performance.now();
        let next: Host;
        try {
          const [p, a, identity] = await Promise.all([
            r.call("project.list", {}, h.id),
            r.call("agent.list", {}, h.id),
            h.id ? r.call("server.info", {}, h.id) : Promise.resolve(info),
          ]);
          next = { ...h, serverId: identity.id, projects: p.projects, agents: a.agents, latencyMs: performance.now() - started };
        } catch (e) {
          next = {
            ...h,
            projects: [],
            agents: [],
            error: (e as Error).message,
          };
        }
        if (generation === refreshes.current)
          setHosts((hs) => hs.map((x) => (x.id === h.id ? next : x)));
      }),
    );
    const s = selected.current;
    if (s?.id) await load(s.host, s.id, true);
  }
  useEffect(() => {
    if (!token) return;
    const r = new Rpc(
      token,
      (v) => {
        setOnline(v);
        if (!v) for (const c of chats.values()) c.loaded = false;
      },
      (n) => {
        const host = n.host ?? "";
        const p = n.params;
        const k = key(host, p?.agentId ?? p?.agent?.id ?? "");
        if (n.method === "agent.event") {
          if (buffers.has(k)) buffers.get(k)!.push(p.event);
          else event(chat(k), p.event);
          redraw();
        }
        if (n.method === "agent.status" || n.method === "agent.changed") {
          setHosts((hs) =>
            hs.map((h) =>
              h.id !== host
                ? h
                : {
                    ...h,
                    agents:
                      n.method === "agent.changed"
                        ? [
                            ...h.agents.filter((a) => a.id !== p.agent.id),
                            p.agent,
                          ]
                        : h.agents.map((a) =>
                            a.id === p.agentId ? { ...a, status: p.status } : a,
                          ),
                  },
            ),
          );
          const s = selected.current;
          if (s?.id && s.host === host && (p.agentId ?? p.agent?.id) === s.id)
            void refreshPending(host, s.id, r).catch(() => {});
        }
        if (n.method === "schedule.changed" || n.method === "schedule.removed")
          schedulesChanged(host);
        if (
          n.method === "project.changed" ||
          n.method === "project.removed" ||
          n.method === "agent.removed"
        )
          void run(refresh);
        if (n.method === "peer.disconnected") {
          // Its subscriptions are gone: every chat cached for that host must
          // subscribe and read history again when shown, and the open one
          // retries until the peer is back.
          for (const [k, cached] of chats) if (k.startsWith(`${p.host}/`)) cached.loaded = false;
          const s = selected.current;
          if (s && s.host === p.host && s.id) resubscribe(s.host, s.id, r);
        }
      },
      () => void run(refresh),
    );
    rpc.current = r;
    return () => r.close();
  }, [token]);
  const host = hosts.find((h) => h.id === selection?.host);
  const agent = host?.agents.find((a) => a.id === selection?.id);
  const project = host?.projects.find((p) => p.id === selection?.project);
  const ckey = selection
    ? key(selection.host, selection.id ?? `new:${selection.project}`)
    : "";
  const c = chat(ckey);
  const rows = visiblePending(c);
  const busy = !!agent && agent.status !== "idle";
  const primary = sendMode(agent?.status, rows.length);
  const models = modelLabels(model, agent?.effectiveModel, catalog.models);
  const sessionModel = modelLabels(agent?.config.model, agent?.effectiveModel, catalog.models);
  if (selection && host)
    restoreDraft(
      c,
      host.name,
      selection.id ? `agent:${selection.id}` : `project:${selection.project}`,
    );
  useEffect(() => {
    // Not run(): opening a chat must not clear an error just reported (say a
    // failed first send to an agent created a moment ago).
    if (selection?.id && online)
      load(selection.host, selection.id!).catch((e) => setError(String((e as Error).message)));
    if (agent) {
      setProvider(agent.provider);
      setModel(agent.config.model ?? "");
      setMode(agent.config.mode ?? "");
    }
  }, [ckey, online]);
  useEffect(() => {
    if (!selection || !online) return;
    let active = true;
    setCatalog({ models: [], modes: [] });
    void rpc
      .current!.call("provider.catalog", { provider }, selection.host)
      .then((v) => {
        if (active) setCatalog(v);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [provider, selection?.host, online]);
  function choose(s: typeof selection) {
    if (s) {
      const next = viewPath(s, hostsRef.current);
      if (next !== location.pathname) {
        history.pushState(null, "", next + location.search);
        setPath(next);
      }
    } else if (location.pathname !== "/") {
      history.pushState(null, "", "/" + location.search);
      setPath("/");
    }
    setRouteError("");
    select(s);
    showSidebar(false);
  }
  // Clears the composer at once and shows the message where it will land: in
  // the transcript, or in the queue. The server's copy replaces it by id.
  async function send(steer = false) {
    if (!selection || (!c.input.trim() && !c.images.length) || creating) return;
    const s = selection;
    const text = c.input;
    const images = c.images;
    let id = s.id;
    let target = c;
    if (!id) {
      setCreating(true);
      try {
        const a = await rpc.current!.call(
          "agent.create",
          {
            projectId: s.project,
            provider,
            name: text.trim().slice(0, 70) || "Image message",
            config: { model, mode },
          },
          s.host,
        );
        id = a.id;
        setHosts((hs) =>
          hs.map((h) =>
            h.id === s.host
              ? {
                  ...h,
                  agents: [
                    ...h.agents.filter((existing) => existing.id !== a.id),
                    a,
                  ],
                }
              : h,
          ),
        );
        // The draft moves to the new agent: if its send fails, it is kept
        // there only, not also in the project's composer.
        target = chat(key(s.host, id));
        restoreDraft(
          target,
          hostsRef.current.find((h) => h.id === s.host)?.name ?? s.host,
          `agent:${id}`,
        );
        target.input = text;
        target.images = images;
        saveDraft(target, true);
        if (c.input === text) c.input = "";
        if (c.images === images) c.images = [];
        saveDraft(c, true);
        choose({ ...s, id });
      } catch (e) {
        setError(String((e as Error).message));
        return;
      } finally {
        setCreating(false);
      }
    }
    const agentId = id;
    const current = hostsRef.current.find((h) => h.id === s.host)?.agents.find((a) => a.id === agentId);
    const messageId =
      target.retry && target.retry.text === text && target.retry.images === images ? target.retry.id : newMessageId();
    target.retry = undefined;
    const queued = !steer && sendMode(current?.status, visiblePending(target).length) === "queue";
    const row = { id: messageId, agentId, text, ...(images.length ? { imageCount: images.length } : {}), reason: "queued" as const, createdAt: new Date().toISOString() };
    const item: Item = { kind: "user", id: messageId, text, ...(images.length ? { images } : {}) };
    if (queued) target.outbox = [...(target.outbox ?? []), row];
    else if (!target.items.some((i) => i.id === messageId)) target.items = [...target.items, item];
    if (target.input === text) target.input = "";
    if (target.images === images) target.images = [];
    saveDraft(target, true);
    redraw();
    try {
      setError("");
      // Only a real change: an unset model is "" in the picker.
      if (current && ((current.config.model ?? "") !== model || (current.config.mode ?? "") !== mode))
        await rpc.current!.call("agent.update", { id: agentId, config: { model, mode } }, s.host);
      const result = await rpc.current!.call(
        "agent.send",
        { id: agentId, text, images, messageId, whenBusy: steer ? "steer" : "queue" },
        s.host,
      );
      if (result.queued) {
        // It waits after all (a steer to a limited agent, a queue we didn't know of).
        target.items = target.items.filter((i) => i !== item);
        if (!queued) target.outbox = [...(target.outbox ?? []), row];
        if (steer && result.pendingId)
          deferredSteers.set(key(s.host, result.pendingId), result.deferredUntil
            ? `Steer deferred until ${new Date(result.deferredUntil).toLocaleString()} · saved for later`
            : "Steer queued · saved for later");
        await refreshPending(s.host, agentId).catch(() => {});
      }
      target.outbox = target.outbox?.filter((o) => o.id !== messageId);
      await load(s.host, agentId);
    } catch (e) {
      // Back in the composer, unless something new was typed meanwhile; the
      // same message sent again keeps its id, in case this one did arrive.
      target.outbox = target.outbox?.filter((o) => o.id !== messageId);
      target.items = target.items.filter((i) => i !== item);
      if (!target.input && !target.images.length) {
        target.input = text;
        target.images = images;
        target.retry = { id: messageId, text, images };
        saveDraft(target, true);
      }
      setError(String((e as Error).message));
    }
    redraw();
  }
  // Runs a pending-row action; the row shows `note` (or is hidden) until the
  // server's queue confirms. A row that is already gone needs no error.
  function pendingAction(host: string, agentId: string, messageId: string, note: string | null, call: () => Promise<unknown>) {
    const target = chat(key(host, agentId));
    const hidden = (target.hidden ??= new Set());
    const k = key(host, messageId);
    if (note) rowNotes.set(k, note);
    else hidden.add(messageId);
    redraw();
    void (async () => {
      try {
        await call();
      } catch (e) {
        const message = String((e as Error).message);
        if (!/no such pending/i.test(message)) setError(message);
      }
      await refreshPending(host, agentId).catch(() => {});
      hidden.delete(messageId);
      rowNotes.delete(k);
      redraw();
    })();
  }
  if (!token)
    return (
      <main className="login">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            localStorage.setItem("casm.token", entry.trim());
            setToken(entry.trim());
          }}
        >
          <h1>casm</h1>
          <p>Enter a token from this server to connect.</p>
          <input
            aria-label="Server token"
            type="password"
            required
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            autoFocus
          />
          <button>Connect</button>
        </form>
      </main>
    );
  return (
    <div className="app">
      <aside className={sidebar ? "open" : ""}>
        <header>
          <strong className="brand">
            <span className="brand-glyph" aria-hidden="true" />
            casm
          </strong>
          <button className="mobile" onClick={() => showSidebar(false)}>
            Close
          </button>
        </header>
        <nav aria-label="Agents">
          {hosts.map((h) => {
            const state: HostState = !online || h.error ? "offline"
              : h.loading && h.latencyMs === undefined ? "connecting"
              : (h.latencyMs ?? 0) > SLOW_HOST_MS ? "slow" : "online";
            const working = h.agents.filter((a) => a.status !== "idle" && !a.archivedAt).length;
            return (
            <section key={h.id} className="host">
              <h2>
                <HostMenu host={h.id} name={h.name} state={state} rpc={rpc.current} agents={h.agents} projects={h.projects}
                  detail={working ? `${working} working` : undefined} />
              </h2>
              {h.error && <p className="host-error" title={h.error}>{h.error}</p>}
              {!h.error && !h.loading && !h.projects.length && <p className="sidebar-empty">No projects on this host yet.</p>}
              {[...h.projects]
                .sort(
                  (a, b) =>
                    a.sort - b.sort ||
                    a.name.localeCompare(b.name) ||
                    a.id.localeCompare(b.id),
                )
                .map((p) => {
                  const expanded = projectExpanded(collapsed, h.id, p.id, selection);
                  const pinned = !!(selection?.id && selection.host === h.id && selection.project === p.id);
                  const agents = agentHierarchy(h.agents, p.id, h.serverId);
                  return (
                  <div key={p.id} className="project-group">
                    <div className="project-row">
                    <button className="project-toggle"
                      aria-label={`Toggle ${p.name}`}
                      aria-expanded={expanded}
                      disabled={pinned}
                      title={pinned ? "Current agent's project stays visible" : `${expanded ? "Collapse" : "Expand"} ${p.name}`}
                      onClick={() => toggleProject(h.id, p.id)}>
                      <span className="chevron" aria-hidden="true" />
                    </button>
                    <button
                      className={`project ${ckey === key(h.id, `new:${p.id}`) ? "selected" : ""}`}
                      title={`${p.name} · start a new agent`}
                      onClick={() => choose({ host: h.id, project: p.id })}
                    >
                      <span className="project-name">{p.name}</span>
                      {!expanded && agents.length > 0 && <span className="project-count" aria-hidden="true">{agents.length}</span>}
                      <span className="project-new">＋</span>
                    </button>
                    </div>
                    {expanded && !agents.length && <p className="sidebar-empty project-empty">No agents yet</p>}
                    {expanded && agents.map(({ agent: a, depth }) => {
                        const state = chat(key(h.id, a.id));
                        const status =
                          a.status === "idle" &&
                          (state.failed ||
                            state.pending.some((p) => p.reason === "failed"))
                            ? "failed"
                            : a.status;
                        return (
                          <AgentRow key={a.id} agent={a} host={h.id} depth={depth} status={status} online={online}
                            selected={selection?.id === a.id && selection.host === h.id}
                            models={h.id === selection?.host && a.provider === provider ? catalog.models : noModels}
                            onChoose={chooseAgent} />
                        );
                      })}
                  </div>
                  );
                })}
            </section>
            );
          })}
        </nav>
        <footer>
          <span className={online ? "" : "error"}>
            {online ? "Connected" : "Offline · reconnecting…"}
          </span>
          <button
            onClick={() => {
              localStorage.removeItem("casm.token");
              setToken("");
            }}
          >
            Token
          </button>
        </footer>
      </aside>
      <main className="chat">
        <header>
          <button className="mobile" onClick={() => showSidebar(true)}>
            <span className="menu-glyph" aria-hidden="true" />
            Agents
          </button>
          <div>
            <strong>
              {agent?.name ?? project?.name ?? "Select a project"}
            </strong>
            <small className="chat-model" title={agent ? sessionModel.sessionTitle : undefined}>
              {agent
                ? <><ProviderIcon provider={agent.provider} /> {sessionModel.sessionLabel} · <AgentActivity agent={agent} online={online} announce /></>
                : project
                  ? "New agent"
                  : "Choose a project to start a conversation"}
            </small>
          </div>
          {!online && <span className="error">Offline</span>}
        </header>
        {error && (
          <div role="alert" className="error banner">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        <div className="transcript">
          {routeError && (
            <div role="alert" className="empty">
              {routeError}
            </div>
          )}
          {!hosts.length && path !== "/" && (
            <div className="empty">Loading view…</div>
          )}
          {selection && (
            <Transcript
              key={ckey}
              ckey={ckey}
              older={() =>
                run(async () => {
                  if (!selection.id || c.loading || !c.start) return;
                  c.loading = true;
                  try {
                    const page = await rpc.current!.call(
                      "agent.history",
                      { id: selection.id, before: c.start, limit: 100 },
                      selection.host,
                    );
                    c.items = [
                      ...page.items.filter(
                        (i) => !c.items.some((x) => x.id === i.id),
                      ),
                      ...c.items,
                    ];
                    c.start = page.start;
                    redraw();
                  } finally {
                    c.loading = false;
                  }
                })
              }
            />
          )}
        </div>
        {selection && project && (
          <>
            <div className="pending" aria-label="Pending requests">
              {c.permissions.map((p) => (
                <div className="card" key={p.id}>
                  <strong>{p.title ?? `Permission: ${p.toolName}`}</strong>
                  <pre>{JSON.stringify(p.input, null, 2)}</pre>
                  {(
                    [
                      "allow",
                      ...(p.canAlwaysAllow ? ["allowAlways"] : []),
                      "deny",
                    ] as const
                  ).map((d) => (
                    <button
                      key={d}
                      disabled={!online}
                      onClick={() =>
                        void run(() =>
                          rpc.current!.call(
                            "agent.respondPermission",
                            {
                              id: selection.id!,
                              requestId: p.id,
                              decision: d as "allow" | "allowAlways" | "deny",
                            },
                            selection.host,
                          ),
                        )
                      }
                    >
                      {d === "allow"
                        ? "Allow"
                        : d === "deny"
                          ? "Deny"
                          : "Always allow"}
                    </button>
                  ))}
                </div>
              ))}
              {c.questions.map((q) => (
                <Question
                  key={q.id}
                  request={q}
                  answer={(answers) =>
                    void run(() =>
                      rpc.current!.call(
                        "agent.answerQuestion",
                        { id: selection.id!, requestId: q.id, answers },
                        selection.host,
                      ),
                    )
                  }
                />
              ))}
              <PendingQueue key={key(selection.host, selection.id ?? "new")} agentKey={key(selection.host, selection.id ?? "new")} messages={rows}>
              <PendingRows
                rows={rows}
                unconfirmed={new Set((c.outbox ?? []).filter((o) => !c.pending.some((p) => p.id === o.id)).map((o) => o.id))}
                online={online}
                labels={new Map(rows.flatMap((p) => {
                  const note = rowNotes.get(key(selection.host, p.id)) ?? deferredSteers.get(key(selection.host, p.id));
                  return note ? [[p.id, note] as const] : [];
                }))}
                actions={{
                  sendNow: (p) => pendingAction(selection.host, selection.id!, p.id, null, () =>
                    rpc.current!.call("agent.steerPending", { id: selection.id!, messageId: p.id }, selection.host)),
                  retry: (p) => pendingAction(selection.host, selection.id!, p.id, "Retrying…", () =>
                    rpc.current!.call("agent.retryPending", { id: selection.id!, messageId: p.id }, selection.host)),
                  cancel: (p) => pendingAction(selection.host, selection.id!, p.id, null, () =>
                    rpc.current!.call("agent.cancelPending", { id: selection.id!, messageId: p.id }, selection.host)),
                  edit: (p, text) => {
                    c.pending = c.pending.map((x) => (x.id === p.id ? { ...x, text } : x));
                    pendingAction(selection.host, selection.id!, p.id, "Saving…", () =>
                      rpc.current!.call("agent.editPending", { id: selection.id!, messageId: p.id, text }, selection.host).catch((e) => {
                        throw /no such pending/i.test(String(e.message)) ? new Error("That message was sent before the edit was saved.") : e;
                      }));
                  },
                }}
              />
              </PendingQueue>
            </div>
            <ChatWorking running={online && agent?.status === "running"} />
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <div className="pickers">
                <ProviderIcon provider={provider} />
                {!agent && (
                  <select
                    aria-label="Provider"
                    value={provider}
                    onChange={(e) => {
                      setProvider(e.target.value as ProviderId);
                      setModel("");
                      setMode("");
                    }}
                  >
                    {["claude", "codex", "pi", "opencode"].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                )}
                <select
                  aria-label="Model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="">{models.defaultLabel}</option>
                  {model && !catalog.models.some((m) => m.id === model) && (
                    <option>{model}</option>
                  )}
                  {catalog.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name ?? m.id}
                    </option>
                  ))}
                </select>
                {models.showSession && <small className="model-session" title={models.sessionTitle}>Session: {models.actual}</small>}
                <select
                  aria-label="Mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <option value="">Default mode</option>
                  {mode && !catalog.modes.some((m) => m.id === mode) && (
                    <option>{mode}</option>
                  )}
                  {catalog.modes.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name ?? m.id}
                    </option>
                  ))}
                </select>
              </div>
              {c.images.length > 0 && <Images images={c.images} remove={(index) => {
                c.images = c.images.filter((_, i) => i !== index);
                saveDraft(c);
                redraw();
              }} />}
              <textarea
                aria-label="Message"
                placeholder="Message agent…"
                value={c.input}
                onChange={(e) => {
                  c.input = e.target.value;
                  saveDraft(c);
                  redraw();
                }}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.items).filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => file !== null);
                  if (!files.length) return;
                  e.preventDefault();
                  const target = c;
                  const text = e.clipboardData.getData("text/plain");
                  if (text) {
                    const { selectionStart, selectionEnd } = e.currentTarget;
                    target.input = target.input.slice(0, selectionStart) + text + target.input.slice(selectionEnd);
                  }
                  void Promise.all(files.map((file) => new Promise<{ mediaType: string; data: string }>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve({ mediaType: file.type, data: String(reader.result).split(",")[1] });
                    reader.onerror = () => reject(new Error("Could not read pasted image"));
                    reader.readAsDataURL(file);
                  }))).then((images) => {
                    target.images = [...target.images, ...images];
                    saveDraft(target);
                    redraw();
                  }).catch((error) => setError(String(error)));
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    // Touch keyboards have no Shift+Enter: Return adds a line, Send sends.
                    !coarsePointer.matches &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    // Enter queues behind a running turn; Cmd/Ctrl+Enter steers into it.
                    void send(busy && (e.metaKey || e.ctrlKey));
                  }
                }}
              />
              <div className="actions">
                <small className="send-hint">
                  {busy
                    ? <>Enter to queue · <kbd>{mac ? "⌘" : "Ctrl"}+Enter</kbd> to steer · Shift+Enter for newline</>
                    : primary === "queue"
                      ? "Enter to queue after the waiting messages · Shift+Enter for newline"
                      : "Enter to send · Shift+Enter for newline"}
                </small>
                {busy && (
                  <>
                    <button
                      type="button"
                      disabled={!online}
                      onClick={() =>
                        void run(() =>
                          rpc.current!.call(
                            "agent.interrupt",
                            { id: agent.id },
                            selection.host,
                          ),
                        )
                      }
                    >
                      Interrupt
                    </button>
                    <button
                      type="button"
                      title={`Send into the running turn (${mac ? "⌘" : "Ctrl"}+Enter)`}
                      disabled={!online || (!c.input.trim() && !c.images.length) || creating}
                      onClick={() => void send(true)}
                    >
                      Steer
                    </button>
                  </>
                )}
                <button
                  title={primary === "queue" ? "Send after the running turn and the waiting messages (Enter)" : "Send (Enter)"}
                  disabled={!online || (!c.input.trim() && !c.images.length) || creating}
                >
                  {primary === "queue" ? "Queue" : "Send"}
                </button>
              </div>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
type TranscriptContext = {
  start: number;
  loading: boolean;
  empty: boolean;
  older: () => Promise<void>;
};
function TranscriptHeader({ context }: { context?: TranscriptContext }) {
  if (!context) return null;
  return context.start > 0 ? (
    <button className="older" onClick={() => void context.older()}>
      Load older messages
    </button>
  ) : context.empty ? (
    <div className="empty">
      {context.loading ? "Loading…" : "Start a conversation"}
    </div>
  ) : null;
}
const transcriptComponents = { Header: TranscriptHeader };
function Transcript({
  ckey,
  older,
}: {
  ckey: string;
  older: () => Promise<void>;
}) {
  const c = chat(ckey);

  const ref = useRef<VirtuosoHandle>(null);
  const [bottom, setBottom] = useState(true);
  const following = useRef(c.atBottom ?? true);
  const items: Item[] = [
    ...c.items,
    ...(c.reasoning
      ? [
          {
            kind: "reasoning" as const,
            id: "draft-reasoning",
            text: c.reasoning,
          },
        ]
      : []),
    ...(c.draft
      ? [{ kind: "assistant" as const, id: "draft-assistant", text: c.draft }]
      : []),
  ];
  // A pending-strip resize must keep a reader who was at the end at the end.
  useLayoutEffect(() => {
    if (following.current)
      requestAnimationFrame(() =>
        ref.current?.scrollToIndex({ index: "LAST" }),
      );
  }, [visiblePending(c).length, c.permissions.length, c.questions.length]);
  const first = 100000 + c.start;
  return (
    <div
      style={{ height: "100%", position: "relative" }}
      onWheelCapture={(e) => {
        if (e.deltaY < 0) following.current = false;
      }}
      onTouchMoveCapture={() => {
        following.current = false;
      }}
      onKeyDownCapture={(e) => {
        if (["ArrowUp", "PageUp", "Home"].includes(e.key))
          following.current = false;
      }}
      onPointerDownCapture={(e) => {
        if ((e.target as HTMLElement).hasAttribute("data-virtuoso-scroller"))
          following.current = false;
      }}
    >
      <Virtuoso
        ref={ref}
        data={items}
        firstItemIndex={first}
        initialTopMostItemIndex={
          c.scroll !== undefined
            ? { index: Math.max(first, c.scroll) }
            : { index: "LAST" }
        }
        computeItemKey={(_, i) => i.id}
        followOutput={() => (following.current ? "auto" : false)}
        atBottomStateChange={(v) => {
          setBottom(v);
          c.atBottom = v;
          if (v) following.current = true;
        }}
        rangeChanged={(r) => {
          c.scroll = r.startIndex;
        }}
        startReached={() => {
          if (c.loaded && c.start > 0) void older();
        }}
        itemContent={(_, item) => (
          <Row
            item={item}
            time={c.toolTimes?.[item.id]}
            expansion={(c.expanded ??= {})}
          />
        )}
        context={{
          start: c.start,
          loading: c.loading,
          empty: !items.length,
          older,
        }}
        components={transcriptComponents}
      />
      {!bottom && (
        <button
          className="latest"
          onClick={() => {
            following.current = true;
            ref.current?.scrollToIndex({ index: "LAST" });
          }}
        >
          Latest ↓
        </button>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
