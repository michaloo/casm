import type {
  Agent,
  AgentEvent,
  Item,
  ImageData,
  MethodName,
  Params,
  Result,
  PendingMessage,
  PermissionRequest,
  QuestionRequest,
  Project,
} from "@casm/protocol";
import { holdImage } from "./image-preview";
export type Chat = {
  expanded?: Record<string, boolean>;
  failed?: boolean;
  toolTimes?: Record<string, { start: number; end?: number }>;
  items: Item[];
  start: number;
  loaded: boolean;
  loading: boolean;
  draft: string;
  reasoning: string;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  pending: PendingMessage[];
  // Optimistic queue state (see outbox.ts): rows sent but not yet listed by the
  // server, and rows being sent now or cancelled.
  outbox?: PendingMessage[];
  inFlight?: Map<string, Item>;
  hidden?: Set<string>;
  // A message whose send failed and was put back in the composer: sending the
  // same text and images again reuses its id, so the server sends it once.
  retry?: { id: string; text: string; images: ImageData[] };
  input: string;
  images: ImageData[];
  draftStorageKey?: string;
  scroll?: number;
  atBottom?: boolean;
  // A stretch of older history shown instead of the live end (find-window.ts).
  window?: { items: Item[]; start: number };
  // Shown from the offline copy saved at this time, until a fresh load.
  cachedAt?: number;
  // The offline copy was looked up (whether or not it had this chat).
  cacheRead?: boolean;
  // Its transcript was dropped from memory (see leave()); live rows are
  // ignored until it is loaded again.
  evicted?: boolean;
};
export type Host = {
  id: string;
  serverId?: string | null;
  name: string;
  projects: Project[];
  agents: Agent[];
  error?: string;
  // Still answering the latest refresh; projects/agents are the previous ones.
  loading?: boolean;
  latencyMs?: number;
};
export const chats = new Map<string, Chat>();
export const key = (host: string, id: string) => `${host}/${id}`;
export function chat(k: string): Chat {
  if (!chats.has(k))
    chats.set(k, {
      items: [],
      start: 0,
      loaded: false,
      loading: false,
      draft: "",
      reasoning: "",
      permissions: [],
      questions: [],
      pending: [],
      input: "",
      images: [],
    });
  return chats.get(k)!;
}
// History loads, notifications and sends can request snapshots concurrently.
// Only the most recently requested snapshot may update this chat's queue.
const pendingReads = new WeakMap<Chat, symbol>();
export async function syncPending(c: Chat, read: () => Promise<{ messages: PendingMessage[] }>) {
  const request = Symbol();
  pendingReads.set(c, request);
  const result = await read();
  if (pendingReads.get(c) !== request) return false;
  c.pending = result.messages;
  return true;
}
// Transcripts kept in memory besides the open one: switching back to these is
// instant. Older ones are dropped and read again (offline copy, then server)
// when reopened, so a long session with many chats stays bounded.
export const RECENT_CHATS = 4;
const recent: string[] = [];
// Opens `k`; returns the chats that fell out of the recent ones, to drop with
// evict(). One that is loading or sending stays until it is done.
export function leave(k: string, keep = RECENT_CHATS): string[] {
  const at = recent.indexOf(k);
  if (at >= 0) recent.splice(at, 1);
  recent.unshift(k);
  const out: string[] = [];
  for (let i = keep + 1; i < recent.length; i++) {
    const c = chats.get(recent[i]);
    if (c && (c.loading || c.inFlight?.size || c.outbox?.length)) continue;
    out.push(...recent.splice(i--, 1));
  }
  return out;
}
export function evict(c: Chat) {
  c.items = [];
  c.start = 0;
  c.loaded = false;
  c.evicted = true;
  c.draft = "";
  c.reasoning = "";
  c.scroll = undefined;
  c.atBottom = undefined;
  c.window = undefined;
  c.cachedAt = undefined;
  c.cacheRead = false;
  // Kept for rows reloaded later; only the newest are worth keeping.
  if (c.toolTimes) c.toolTimes = Object.fromEntries(Object.entries(c.toolTimes).slice(-200));
}
// Items as kept in memory: inline image data moves into Blobs.
export function hold<T extends Item>(item: T): T {
  if ((item.kind !== "user" && item.kind !== "tool") || !item.images?.some((i) => i.data)) return item;
  return { ...item, images: item.images.map(holdImage) };
}
// Keep unconfirmed immediate sends across a reconnect snapshot. History and
// pending rows take precedence; confirmed live events are replayed afterwards.
export function replaceHistory(c: Chat, items: Item[]) {
  const known = new Set([...items.map((i) => i.id), ...c.pending.map((p) => p.id)]);
  c.items = [...items, ...[...(c.inFlight?.values() ?? [])].filter((i) => !known.has(i.id))];
}

export function event(c: Chat, e: AgentEvent, replay = false) {
  if (e.type === "turnStarted") c.failed = false;
  if (e.type === "turnEnded") c.failed = e.outcome === "failed";
  // A dropped transcript reads its history again when reopened.
  if (c.evicted && (e.type === "item" || e.type === "delta" || e.type === "toolOutput")) return;
  if (e.type === "item") {
    const item = hold(e.item);
    if (item.kind === "tool" && !replay) {
      const times = (c.toolTimes ??= {});
      if (item.status === "running")
        times[item.id] ??= { start: Date.now() };
      else if (times[item.id]) times[item.id].end ??= Date.now();
    }
    const i = c.items.findIndex((x) => x.id === item.id);
    if (i < 0) c.items.push(item);
    else c.items[i] = item;
    if (item.kind === "assistant") c.draft = "";
    if (item.kind === "reasoning") c.reasoning = "";
  }
  if (e.type === "delta") {
    if (e.kind === "assistant") c.draft += e.text;
    else c.reasoning += e.text;
  }
  if (e.type === "toolOutput") {
    const t = c.items.find((x) => x.id === e.itemId);
    if (t?.kind === "tool") t.output = (t.output ?? "") + e.text;
  }
  if (e.type === "permission")
    c.permissions = [
      ...c.permissions.filter((x) => x.id !== e.request.id),
      e.request,
    ];
  if (e.type === "question")
    c.questions = [
      ...c.questions.filter((x) => x.id !== e.request.id),
      e.request,
    ];
  if (e.type === "permissionResolved")
    c.permissions = c.permissions.filter((x) => x.id !== e.requestId);
  if (e.type === "questionResolved")
    c.questions = c.questions.filter((x) => x.id !== e.requestId);
  if (e.type === "turnEnded") {
    c.draft = "";
    c.reasoning = "";
  }
}
// The casm server's HTTP origin: this page's, unless ?server= or VITE_CASM_URL
// names another (the Vite dev server). Download links are relative to it.
export function serverURL(): URL {
  const override = new URLSearchParams(location.search).get("server") ?? import.meta.env.VITE_CASM_URL;
  const url = new URL(override || location.href);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}
// How the client notices a socket that died without closing (a sleeping
// laptop, a dropped network): no message for `heartbeat` ms starts a probe,
// and a probe or a connection attempt that takes too long drops the socket.
export const timing = { heartbeat: 20_000, probe: 10_000, resume: 5_000, connect: 10_000, retry: 1_500 };
export class Rpc {
  socket?: WebSocket;
  // The socket once its `auth` succeeded; nothing else is sent before.
  authed?: WebSocket;
  next = 0;
  stopped = false;
  timer?: ReturnType<typeof setTimeout>;
  beat?: ReturnType<typeof setInterval>;
  // When the server last sent anything; 0 before the first connection.
  lastSeen = 0;
  probing = false;
  pending = new Map<
    number,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  token: string;
  status: (v: boolean) => void;
  notify: (n: any) => void;
  ready: () => void;
  // True while a probe runs after a long silence: the view may be stale.
  suspect: (v: boolean) => void;
  constructor(
    token: string,
    status: (v: boolean) => void,
    notify: (n: any) => void,
    ready: () => void,
    suspect: (v: boolean) => void = () => {},
  ) {
    this.token = token;
    this.status = status;
    this.notify = notify;
    this.ready = ready;
    this.suspect = suspect;
    this.connect();
    this.beat = setInterval(() => {
      if (Date.now() - this.lastSeen >= timing.heartbeat) this.check();
    }, timing.heartbeat);
  }
  get open() {
    return this.socket === this.authed && this.socket?.readyState === WebSocket.OPEN;
  }
  connect() {
    clearTimeout(this.timer);
    const url = serverURL();
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // The token goes in the first message, never the URL (proxies and logs keep URLs).
    const s = (this.socket = new WebSocket(url));
    const opening = setTimeout(() => this.drop(s), timing.connect);
    s.onopen = () => {
      this.call("auth", { token: this.token }, "", timing.connect).then(
        () => {
          if (s !== this.socket) return;
          clearTimeout(opening);
          this.authed = s;
          this.lastSeen = Date.now();
          this.status(true);
          this.ready();
        },
        () => this.drop(s),
      );
    };
    s.onmessage = (m) => {
      this.lastSeen = Date.now();
      const n = JSON.parse(m.data);
      if (n.id !== undefined) {
        const p = this.pending.get(n.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(n.id);
          n.error ? p.reject(new Error(n.error.message)) : p.resolve(n.result);
        }
      } else this.notify(n);
    };
    s.onclose = () => {
      clearTimeout(opening);
      this.closed(s);
    };
    s.onerror = () => s.close();
  }
  private closed(s: WebSocket) {
    if (s !== this.socket) return;
    this.socket = undefined;
    this.probing = false;
    this.suspect(false);
    this.status(false);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Connection lost"));
    }
    this.pending.clear();
    if (!this.stopped) this.timer = setTimeout(() => this.connect(), timing.retry);
  }
  // A dead socket may never fire close (its closing handshake can't
  // complete): treat it as closed now and reconnect.
  drop(s = this.socket) {
    if (!s || s !== this.socket) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close();
    } catch {}
    this.closed(s);
  }
  // Confirms the connection now (the page was resumed, focused, or the
  // network changed): reconnects at once when closed, probes when open.
  check(timeout = timing.probe) {
    if (this.stopped) return;
    const s = this.socket;
    if (!s) return this.connect();
    // Something arrived this very moment (focus events come in bursts).
    if (s.readyState !== WebSocket.OPEN || this.probing || Date.now() - this.lastSeen < 1000) return;
    if (Date.now() - this.lastSeen >= timing.heartbeat) this.suspect(true);
    this.probing = true;
    this.call("server.info", {}, "", timeout).then(
      () => {
        if (s !== this.socket) return;
        this.probing = false;
        this.suspect(false);
      },
      () => {
        if (s !== this.socket) return;
        this.probing = false;
        this.drop(s);
      },
    );
  }
  call<M extends MethodName>(
    method: M,
    params: Params<M>,
    host = "",
    timeout = 30000,
  ): Promise<Result<M>> {
    if (this.socket?.readyState !== WebSocket.OPEN || (method !== "auth" && this.socket !== this.authed))
      return Promise.reject(new Error("Offline"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Request timed out"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
          ...(host ? { host } : {}),
        }),
      );
    });
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.beat);
    this.socket?.close();
  }
}
