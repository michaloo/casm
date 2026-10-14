import type {
  Agent,
  AgentEvent,
  Item,
  MethodName,
  Params,
  Result,
  PendingMessage,
  PermissionRequest,
  QuestionRequest,
  Project,
} from "@casm/protocol";
export type Chat = {
  items: Item[];
  start: number;
  loaded: boolean;
  loading: boolean;
  draft: string;
  reasoning: string;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  pending: PendingMessage[];
  input: string;
  scroll?: number;
  atBottom?: boolean;
};
export type Host = {
  serverId: string | null;
  id: string;
  name: string;
  projects: Project[];
  agents: Agent[];
  error?: string;
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
    });
  return chats.get(k)!;
}
export function event(c: Chat, e: AgentEvent) {
  if (e.type === "item") {
    const i = c.items.findIndex((x) => x.id === e.item.id);
    if (i < 0) c.items.push(e.item);
    else c.items[i] = e.item;
    if (e.item.kind === "assistant") c.draft = "";
    if (e.item.kind === "reasoning") c.reasoning = "";
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
export class Rpc {
  socket?: WebSocket;
  next = 0;
  stopped = false;
  timer?: ReturnType<typeof setTimeout>;
  pending = new Map<
    number,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    public token: string,
    public status: (v: boolean) => void,
    public notify: (n: any) => void,
    public ready: () => void,
  ) {
    this.connect();
  }
  connect() {
    const override =
      new URLSearchParams(location.search).get("server") ??
      import.meta.env.VITE_CASM_URL;
    const url = new URL(override || location.href);
    url.protocol =
      url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
    url.pathname = "/";
    url.search = "";
    url.searchParams.set("token", this.token);
    const s = (this.socket = new WebSocket(url));
    s.onopen = () => {
      this.status(true);
      this.ready();
    };
    s.onmessage = (m) => {
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
      this.status(false);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Connection lost"));
      }
      this.pending.clear();
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), 1500);
    };
    s.onerror = () => s.close();
  }
  call<M extends MethodName>(
    method: M,
    params: Params<M>,
    host = "",
  ): Promise<Result<M>> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Offline"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Request timed out"));
      }, 30000);
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
    this.socket?.close();
  }
}
