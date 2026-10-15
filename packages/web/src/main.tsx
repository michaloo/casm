import { Launcher, LauncherDestination, SearchGlyph, type LauncherAction } from "./launcher";
import { rememberAgent } from "./launcher-search";
import "./register-service-worker";
import { ComposerPickers } from "./composer-pickers";
import { ProjectOptions } from "./project-settings";
import { useSlashCommands, type CasmCommand } from "./slash-commands";
import { McpPanel } from "./mcp-panel";
import { replaceHistory } from "./state";
import { offlineCache } from "./offline-idb";
import { reconcile, type OfflineCache } from "./offline-cache";
import { ConnectionBanner, offlineNote } from "./connection";
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { Rpc, chat, chats, event, key, syncPending, timing, type Host } from "./state";
import { filePathFromRoute, resolveView, viewPath, type Selection } from "./navigation";
import { FilePreview } from "./files";
import { FileLinksContext, insideRoot } from "./file-links";
import { restoreDraft, saveDraft, flushDrafts } from "./drafts";
import { ProviderIcon } from "./provider-icon";
import { HostSection } from "./host-section";
import { HostActions, HostIdentity, hostStateLabel, type HostState } from "./host-menu";
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
import { ChevronGlyph } from "./row-menu";
import { NewAgentStarters, NewAgentWelcome } from "./new-agent";
import "./fonts/fonts.css";
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
  const [launcher, setLauncher] = useState(false);
  const [launcherAction, setLauncherAction] = useState<LauncherAction>();
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      // Keep the existing modal's focus/unsaved-edit guard in charge.
      if (token && !document.querySelector("dialog[open]:not(.launcher)")) setLauncher(true);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [token]);


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
  // online: the socket is open. fresh: everything shown has been fetched
  // over it since it opened. checking: a probe after a long silence runs.
  const [online, setOnline] = useState(false);
  const [fresh, setFresh] = useState(false);
  const freshRef = useRef(fresh);
  freshRef.current = fresh;
  const [checking, setChecking] = useState(false);
  const everOnline = useRef(false);
  // When what is shown while not fresh was last known current.
  const [savedAt, setSavedAt] = useState<number>();
  const [networkOffline, setNetworkOffline] = useState(!navigator.onLine);
  const cache = useRef<OfflineCache>(undefined);
  const [cacheReady, setCacheReady] = useState(false);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>()).current;
  // Saves a freshly loaded transcript to the offline copy, debounced.
  function persistChat(k: string, delay = 2000) {
    clearTimeout(saveTimers.get(k));
    saveTimers.set(k, setTimeout(() => {
      saveTimers.delete(k);
      const c = chats.get(k);
      if (c?.loaded) void cache.current?.saveChat(k, c).catch(() => {});
    }, delay));
  }
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
  useEffect(() => {
    if (selection?.id) rememberAgent(localStorage, selection.host, selection.id);
  }, [selection?.host, selection?.id]);
  // The open file preview: from a file link (host of the open chat) or the /f/ route.
  const [preview, setPreview] = useState<{ host: string; path: string; route?: boolean }>();
  const routeFile = filePathFromRoute(path);
  useEffect(() => {
    if (!routeFile || !hosts.length) return;
    // The host whose projects hold it (?host= picks one), else this server, which explains a refusal.
    const named = new URLSearchParams(location.search).get("host");
    const owner = hosts.find((h) => named ? h.name === named : insideRoot(routeFile, h.projects.map((p) => p.path)));
    if (!owner && !named && hosts.some((h) => h.loading)) return;
    const next = { host: owner?.id ?? "", path: routeFile, route: true };
    setPreview((open) => open?.route && open.host === next.host && open.path === next.path ? open : next);
  }, [routeFile, hosts]);
  const closePreview = () => {
    if (preview?.route && location.pathname.startsWith("/f/")) {
      history.pushState(null, "", "/" + location.search.replace(/([?&])host=[^&]*&?/, "$1").replace(/[?&]$/, ""));
      setPath("/");
    }
    setPreview(undefined);
  };
  const selected = useRef(selection);
  selected.current = selection;
  const [, render] = useState(0);
  const redraw = () => render((x) => x + 1);
  const [error, setError] = useState("");
  const [mcp, setMcp] = useState<{ host: string; id: string; name: string }>();
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandNotice, setCommandNotice] = useState("");
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
  const [effort, setEffort] = useState("");
  const [catalog, setCatalog] = useState<Catalog>({ models: [], modes: [] });
  // Model names for the sidebar, per "<host>\n<provider>" of the agents listed;
  // the server caches catalogs, so this is one request per pair and connection.
  const [rowModels, setRowModels] = useState<Record<string, ModelInfo[]>>({});
  const rowModelsAsked = useRef(new Set<string>());
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
    if (await syncPending(chat(key(host, id)), () => r.call("agent.pending", { id }, host))) {
      if (chat(key(host, id)).loaded) persistChat(key(host, id));
      redraw();
    }
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
      const merged = reconcile(c.items, c.start, history.items, history.start);
      replaceHistory(c, merged.items);
      c.start = merged.start;
      c.cachedAt = undefined;
      c.draft = "";
      c.reasoning = "";
      c.permissions = sub.permissions;
      c.questions = sub.questions;
      sub.turn.forEach((e) => event(c, e, true));
      buffered.forEach((e) => event(c, e));
      c.loaded = true;
      persistChat(key(host, id), 0);
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
    try {
      if (s?.id) await load(s.host, s.id, true);
    } finally {
      // A chat whose peer is down reports its own error; the rest is current.
      if (rpc.current === r && r.open) setFresh(true);
    }
  }
  useEffect(() => {
    if (!token) return;
    let active = true;
    // The saved copy renders at once; the connection then replaces it.
    void offlineCache().then(async (c) => {
      await c.open(token);
      const saved = await c.sidebar();
      if (!active) return;
      cache.current = c;
      setCacheReady(true);
      if (saved && !hostsRef.current.length) {
        setHosts(saved.hosts);
        setSavedAt((at) => at ?? saved.savedAt);
      }
    }).catch(() => {});
    const r = new Rpc(
      token,
      (v) => {
        if (v) everOnline.current = true;
        setOnline(v);
        if (!v) {
          for (const c of chats.values()) c.loaded = false;
          if (freshRef.current) setSavedAt(r.lastSeen || Date.now());
          setFresh(false);
        }
      },
      (n) => {
        const host = n.host ?? "";
        const p = n.params;
        const k = key(host, p?.agentId ?? p?.agent?.id ?? "");
        if (n.method === "agent.event") {
          if (buffers.has(k)) buffers.get(k)!.push(p.event);
          else {
            event(chat(k), p.event);
            if (chat(k).loaded) persistChat(k);
          }
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
      setChecking,
    );
    rpc.current = r;
    return () => {
      active = false;
      r.close();
    };
  }, [token]);
  useEffect(() => {
    // A sleeping laptop or a phone app in the background may come back with a
    // socket that looks open but is dead: confirm it on every way back.
    const check = () => rpc.current?.check(timing.resume);
    const visible = () => {
      if (document.visibilityState === "visible") check();
    };
    const network = () => {
      setNetworkOffline(!navigator.onLine);
      check();
    };
    const connection = (navigator as { connection?: EventTarget }).connection;
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    connection?.addEventListener("change", check);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
      connection?.removeEventListener("change", check);
    };
  }, []);
  useEffect(() => {
    if (!fresh || !cache.current) return;
    const timer = setTimeout(() => void cache.current?.saveSidebar(hostsRef.current).catch(() => {}), 1000);
    return () => clearTimeout(timer);
  }, [hosts, fresh, cacheReady]);
  const host = hosts.find((h) => h.id === selection?.host);
  const projectRoots = host?.projects.map((p) => p.path).join("\n") ?? "";
  const fileLinks = useMemo(() => host && projectRoots ? {
    roots: projectRoots.split("\n"),
    open: (path: string) => setPreview({ host: host.id, path }),
  } : null, [host?.id, projectRoots]);
  const previewRootsKey = hosts.find((h) => h.id === preview?.host)?.projects.map((p) => p.path).join("\n") ?? "";
  const previewRoots = useMemo(() => previewRootsKey ? previewRootsKey.split("\n") : [], [previewRootsKey]);
  const agent = host?.agents.find((a) => a.id === selection?.id);
  const project = host?.projects.find((p) => p.id === selection?.project);
  const ckey = selection
    ? key(selection.host, selection.id ?? `new:${selection.project}`)
    : "";
  const c = chat(ckey);
  const slash = useSlashCommands({ rpc: rpc.current, host: selection?.host ?? "", agentId: agent?.id,
    value: c.input, setValue: (text) => { c.input = text; saveDraft(c); redraw(); },
    action: composerAction, enabled: online && !commandBusy });
  async function composerAction(name: CasmCommand) {
    if (!agent || !selection || !rpc.current || commandBusy) return;
    const target = c; const draft = c.input;
    setCommandBusy(true); setCommandNotice("");
    try {
      if (name === "mcp") setMcp({ host: selection.host, id: agent.id, name: agent.name });
      else { await rpc.current.call(`agent.${name}`, { id: agent.id }, selection.host); setCommandNotice(`/${name} completed for ${agent.name}.`); }
      if (target.input === draft) { target.input = ""; saveDraft(target); redraw(); }
    } catch (e) { setError(String(e)); }
    finally { setCommandBusy(false); }
  }
  // A project's new-agent screen: a welcome with the composer near the center.
  const starting = !!(selection && !selection.id && project && host);
  const rows = visiblePending(c);
  const busy = !!agent && agent.status !== "idle";
  const primary = sendMode(agent?.status, rows.length);
  const sessionModel = modelLabels(agent?.config.model, agent?.effectiveModel, catalog.models);
  if (selection && host)
    restoreDraft(
      c,
      host.name,
      selection.id ? `agent:${selection.id}` : `project:${selection.project}`,
    );
  useEffect(() => {
    // The saved copy of this transcript, until (or instead of) a fresh load.
    if (!selection?.id || !cacheReady || c.cacheRead) return;
    const target = c;
    void cache.current!.chat(ckey).then((saved) => {
      target.cacheRead = true;
      if (saved && !target.loaded && !target.items.length) {
        target.items = saved.items;
        target.start = saved.start;
        target.pending = saved.pending;
        target.cachedAt = saved.savedAt;
      }
      redraw();
    }, () => {
      target.cacheRead = true;
      redraw();
    });
  }, [ckey, cacheReady]);
  useEffect(() => {
    // Not run(): opening a chat must not clear an error just reported (say a
    // failed first send to an agent created a moment ago).
    if (selection?.id && online)
      load(selection.host, selection.id!).catch((e) => setError(String((e as Error).message)));
    if (agent) {
      setProvider(agent.provider);
      setModel(agent.config.model ?? "");
      setMode(agent.config.mode ?? "");
      setEffort(agent.config.effort ?? "");
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
  useEffect(() => {
    if (!online) {
      rowModelsAsked.current.clear();
      return;
    }
    for (const h of hosts) {
      if (h.error) continue;
      for (const p of new Set(h.agents.map((a) => a.provider))) {
        const k = `${h.id}\n${p}`;
        if (rowModelsAsked.current.has(k)) continue;
        rowModelsAsked.current.add(k);
        void rpc.current!.call("provider.catalog", { provider: p }, h.id)
          .then((v) => setRowModels((m) => ({ ...m, [k]: v.models })))
          .catch(() => rowModelsAsked.current.delete(k));
      }
    }
  }, [hosts, online]);
  // A same-origin path from a notification click (the service worker posts it).
  function openPath(url: string) {
    const next = new URL(url, location.origin);
    if (next.origin !== location.origin) return;
    if (next.pathname !== location.pathname) {
      history.pushState(null, "", next.pathname + location.search);
      setPath(next.pathname);
    }
    showSidebar(false);
  }
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  useEffect(() => {
    const sw = navigator.serviceWorker;
    const message = (e: MessageEvent) => {
      if (e.data?.type === "casm:navigate" && typeof e.data.url === "string") openPathRef.current(e.data.url);
    };
    // Opening the app counts as seeing what the badge counted.
    const seen = () => {
      if (document.visibilityState === "visible") void (navigator as { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => {});
    };
    seen();
    sw?.addEventListener("message", message);
    document.addEventListener("visibilitychange", seen);
    return () => {
      sw?.removeEventListener("message", message);
      document.removeEventListener("visibilitychange", seen);
    };
  }, []);
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
    // Offline the draft stays in the composer (and on this device) instead.
    if (!online || !selection || (!c.input.trim() && !c.images.length) || creating || commandBusy) return;
    if (slash.sendAction()) return;
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
            config: { model, mode, effort },
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
    if (!queued) (target.inFlight ??= new Map()).set(messageId, item);
    if (queued) target.outbox = [...(target.outbox ?? []), row];
    else if (!target.items.some((i) => i.id === messageId)) target.items = [...target.items, item];
    if (target.input === text) target.input = "";
    if (target.images === images) target.images = [];
    saveDraft(target, true);
    redraw();
    try {
      setError("");
      // Only a real change: an unset model is "" in the picker.
      if (current && ((current.config.model ?? "") !== model || (current.config.mode ?? "") !== mode || (current.config.effort ?? "") !== effort))
        await rpc.current!.call("agent.update", { id: agentId, config: { model, mode, effort } }, s.host);
      const result = await rpc.current!.call(
        "agent.send",
        { id: agentId, text, images, messageId, whenBusy: steer ? "steer" : "queue" },
        s.host,
      );
      target.inFlight?.delete(messageId);
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
      target.inFlight?.delete(messageId);
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
      {launcher && <Launcher hosts={hosts} models={rowModels} online={online} choose={chooseAgent} action={setLauncherAction} close={() => setLauncher(false)} />}
      {launcherAction && <LauncherDestination target={launcherAction} rpc={rpc.current} online={online} choose={chooseAgent} close={() => setLauncherAction(undefined)}
        created={(host, project) => {
          setHosts(list => list.map(item => item.id === host ? { ...item, projects: [...item.projects.filter(p => p.id !== project.id), project] } : item));
          choose({ host, project: project.id });
        }} />}

      {preview && rpc.current && online && <FilePreview key={`${preview.host}\n${preview.path}`} rpc={rpc.current} host={preview.host} path={preview.path}
        roots={previewRoots} close={closePreview} />}
      {mcp && rpc.current && <McpPanel {...mcp} rpc={rpc.current} close={() => { setMcp(undefined); document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(); }} />}
      <aside className={sidebar ? "open" : ""}>
        <header>
          <strong className="brand">
            <span className="brand-glyph" aria-hidden="true" />
            casm
          </strong>
          <button type="button" className="launcher-trigger" aria-label="Open launcher" title="Launcher: Cmd/Ctrl+K" onClick={() => setLauncher(true)}><SearchGlyph /></button>
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
            <HostSection key={h.id} host={h.id} name={h.name} status={`${hostStateLabel(state)}${working ? ` · ${working} working` : ""}`}
              identity={<HostIdentity name={h.name} state={state} bare />}
              menu={<HostActions host={h.id} name={h.name} state={state} rpc={rpc.current} agents={h.agents} projects={h.projects}
                  openAgent={(a) => choose({ host: h.id, project: a.projectId, id: a.id })}
                  openProject={project => {
                    setHosts(list => list.map(item => item.id === h.id ? { ...item, projects: [...item.projects.filter(p => p.id !== project.id), project] } : item));
                    choose({ host: h.id, project: project.id });
                  }}
                  />}>
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
                    {/* The whole row folds; new agents start from the project modal or the launcher. */}
                    <div className={`project-row ${ckey === key(h.id, `new:${p.id}`) ? "selected" : ""}`}>
                    <button className="project-toggle"
                      aria-label={`Toggle ${p.name}`}
                      aria-expanded={expanded}
                      disabled={pinned}
                      title={pinned ? "Current agent's project stays visible" : `${expanded ? "Collapse" : "Expand"} ${p.name}`}
                      onClick={() => toggleProject(h.id, p.id)}>
                      <ChevronGlyph />
                      <span className="project-name">{p.name}</span>
                      {!expanded && agents.length > 0 && <span className="project-count" aria-hidden="true">{agents.length}</span>}
                    </button>
                    <ProjectOptions host={h.id} project={p} agentCount={h.agents.filter((a) => a.projectId === p.id && !a.archivedAt).length}
                      rpc={rpc.current} online={state === "online" || state === "slow"} newAgent={() => choose({ host: h.id, project: p.id })} />
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
                            models={h.id === selection?.host && a.provider === provider && catalog.models.length ? catalog.models : rowModels[`${h.id}\n${a.provider}`] ?? noModels}
                            onChoose={chooseAgent} />
                        );
                      })}
                  </div>
                  );
                })}
            </HostSection>
            );
          })}
        </nav>
        <footer>
          <span className={online ? "" : "error"}>
            {online ? fresh ? "Connected" : "Syncing…" : "Offline · reconnecting…"}
          </span>
          <button
            title="Change the token; clears the copy saved on this device"
            onClick={() => {
              localStorage.removeItem("casm.token");
              void cache.current?.clear();
              setToken("");
            }}
          >
            Token
          </button>
        </footer>
      </aside>
      <main className={`chat${starting ? " start" : ""}`}>
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
                ? <><ProviderIcon provider={agent.provider} /> <span className="chat-model-label">{sessionModel.sessionLabel}</span> <AgentActivity agent={agent} status={agent.status === "idle" && (c.failed || c.pending.some(p => p.reason === "failed")) ? "failed" : agent.status} online={online} announce /></>
                : project
                  ? "New agent"
                  : "Choose a project to start a conversation"}
            </small>
          </div>
          <button type="button" className="launcher-trigger" aria-label="Open launcher" title="Launcher: Cmd/Ctrl+K" onClick={() => setLauncher(true)}><SearchGlyph /></button>
          {!online && <span className="error">Offline</span>}
        </header>
        <ConnectionBanner online={online} fresh={fresh} checking={checking} networkOffline={networkOffline}
          connected={everOnline.current} savedAt={c.cachedAt ?? savedAt} />
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
          {selection?.id && !online && !c.items.length && c.cacheRead ? (
            <div className="empty offline-missing">
              <strong>Not available offline</strong>
              <p>This conversation was not saved on this device. It loads when the connection is back.</p>
            </div>
          ) : starting ? <NewAgentWelcome project={project} host={host!.name} /> : selection && (
            <FileLinksContext.Provider value={fileLinks}>
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
            </FileLinksContext.Provider>
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
                      title={online ? undefined : offlineNote}
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
                  disabled={!online}
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
            </div>
            <PendingQueue key={key(selection.host, selection.id ?? "new")} agentKey={key(selection.host, selection.id ?? "new")} messages={rows}
              status={<ChatWorking running={online && agent?.status === "running"} />}>
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
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              {slash.palette}
              {commandNotice && <p role="status" className="command-notice">{commandNotice}</p>}
              <ComposerPickers provider={provider} fixedProvider={!!agent} catalog={catalog}
                model={model} effectiveModel={agent?.effectiveModel} mode={mode} effort={effort}
                setProvider={value => { setProvider(value); setModel(""); setMode(""); setEffort(""); }}
                setModel={value => { setModel(value); setEffort(""); }} setMode={setMode} setEffort={setEffort} />
              {c.images.length > 0 && <Images images={c.images} remove={(index) => {
                c.images = c.images.filter((_, i) => i !== index);
                saveDraft(c);
                redraw();
              }} />}
              <textarea
                {...slash.inputProps}
                aria-label="Message"
                placeholder={starting ? `What should the agent do in ${project.name}?` : "Message agent…"}
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
                  if (slash.onKeyDown(e)) return;
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
                  {!online ? "Offline · your draft is kept on this device and can be sent after reconnecting" : busy
                    ? <>Enter to queue · <kbd>{mac ? "⌘" : "Ctrl"}+Enter</kbd> to steer · Shift+Enter for newline</>
                    : primary === "queue"
                      ? "Enter to queue after the waiting messages · Shift+Enter for newline"
                      : "Enter to send · Shift+Enter for newline"}
                </small>
                {busy && (
                  <>
                    <button
                      type="button"
                      className="interrupt"
                      disabled={!online}
                      title={online ? undefined : offlineNote}
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
                      className="steer"
                      disabled={!online || (!c.input.trim() && !c.images.length) || creating}
                      title={online ? `Send into the running turn (${mac ? "⌘" : "Ctrl"}+Enter)` : offlineNote}
                      onClick={() => void send(true)}
                    >
                      Steer
                    </button>
                  </>
                )}
                <button
                  className={primary === "queue" ? "queue" : "send"}
                  title={!online ? offlineNote : primary === "queue" ? "Send after the running turn and the waiting messages (Enter)" : "Send (Enter)"}
                  disabled={!online || (!c.input.trim() && !c.images.length) || creating}
                >
                  {primary === "queue" ? "Queue" : "Send"}
                </button>
              </div>
            </form>
            {starting && <NewAgentStarters agents={host!.agents.filter((a) => a.projectId === project.id)} mac={mac}
              open={(a) => choose({ host: selection.host, project: a.projectId, id: a.id })}
              fill={(prompt) => {
                c.input = c.input.trim() ? `${c.input.trimEnd()}\n\n${prompt}` : prompt;
                saveDraft(c);
                redraw();
                requestAnimationFrame(() => {
                  const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
                  box?.focus();
                  box?.setSelectionRange(box.value.length, box.value.length);
                });
              }} />}
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
  // Virtuoso lands short of the end when items measure taller than estimated
  // (opening a long history, a reply that wraps, a shrinking composer), and
  // its followOutput only follows from the exact bottom. While following and
  // near the end, pin the true end on every growth or append; a reader who
  // scrolled away stays put.
  const nearEnd = useRef(true);
  // Until the true end has been reached once (Virtuoso opens a long history
  // hundreds of pixels short), "near" means within a screen; after that only
  // Virtuoso's estimate jitter counts, so a reader moved up by a script, focus
  // or find-in-page is not pulled back.
  const reached = useRef(false);
  const scroller = useRef<HTMLElement | null>(null);
  // scrollTop as of the last scroll event or pin.
  const lastTop = useRef(0);
  const away = (el: HTMLElement) => {
    // A jump up whose scroll event has not arrived yet (scrollTo, focus,
    // find-in-page): content shrinking clamps to the end and appends never
    // move scrollTop up, so neither looks like this.
    if (el.scrollTop < lastTop.current - 2 && el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight) nearEnd.current = false;
    return !nearEnd.current;
  };
  const pin = (el: HTMLElement) => { el.scrollTop = el.scrollHeight; lastTop.current = el.scrollTop; };
  const stick = () => {
    const el = scroller.current;
    if (!following.current || !el || away(el)) return;
    pin(el);
    // Virtuoso may re-apply its estimate in the same frame; settle once more.
    requestAnimationFrame(() => {
      if (following.current && !away(el) && el.scrollHeight - el.scrollTop - el.clientHeight > 0.5) pin(el);
    });
  };
  const box = useRef<HTMLDivElement>(null);
  const resized = useRef<ResizeObserver>(undefined);
  useEffect(() => {
    if (!box.current) return;
    // Watch the rendered rows themselves: Virtuoso follows by its estimate,
    // then rows measure taller (or grow: Thinking, tool output, a streamed
    // reply) without another scroll. The box covers a shrinking viewport.
    const observer = (resized.current = new ResizeObserver(() => stick()));
    observer.observe(box.current);
    // Virtuoso's own follow lands on its estimate, a little short of the end.
    // Where the last scroll left the reader: appends never scroll, so they
    // keep it; a scroll-up or a jump elsewhere clears it.
    const settle = () => {
      const el = scroller.current;
      if (!el) return;
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      lastTop.current = el.scrollTop;
      if (gap <= 1) reached.current = true;
      nearEnd.current = gap < (reached.current ? 80 : el.clientHeight);
      if (gap < 80) stick();
    };
    const el = scroller.current;
    // Capture on the wrapper runs before Virtuoso's own scroll handler, so
    // nearEnd is current before its re-render mutates the rows below.
    box.current.addEventListener("scroll", settle, { capture: true, passive: true });
    // Some re-layouts (a streamed row replaced by its final item, rows above
    // resizing) change no observed box and fire no scroll; any DOM change does.
    const mutated = new MutationObserver(() => stick());
    if (el) mutated.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style"] });
    const wrapper = box.current;
    return () => { observer.disconnect(); mutated.disconnect(); wrapper.removeEventListener("scroll", settle, { capture: true }); };
  }, []);
  useEffect(() => {
    // Virtuoso may swap its list element (empty → rows); observing twice is a no-op.
    const list = box.current?.querySelector("[data-testid=virtuoso-item-list]");
    if (list) resized.current?.observe(list, { box: "border-box" });
    requestAnimationFrame(stick);
  }, [items.length]);
  const first = 100000 + c.start;
  return (
    <div
      ref={box}
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
        totalListHeightChanged={stick}
        scrollerRef={(el) => { scroller.current = el as HTMLElement | null; }}
        atBottomStateChange={(v) => {
          if (v) following.current = true;
          setBottom(v);
          c.atBottom = v;
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
      {/* Only after the reader scrolled up, never while following lags a growing end. */}
      {!bottom && !following.current && (
        <button
          className="latest"
          onClick={() => {
            following.current = true;
            nearEnd.current = true;
            ref.current?.scrollToIndex({ index: "LAST", align: "end" });
            requestAnimationFrame(stick);
            setBottom(true);
          }}
        >
          Latest ↓
        </button>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
