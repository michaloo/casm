// Typed casm client for Node (CLI, scripts, and server-to-server calls).
import WebSocket from "ws";
import type {
  MethodName,
  NotificationName,
  NotificationParams,
  Params,
  Result,
  RpcResponse,
} from "@casm/protocol";

export class CasmError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Listener = (params: unknown) => void;

export class CasmClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  private closeListeners = new Set<() => void>();

  private ws: WebSocket;
  private host: string | undefined;

  private constructor(ws: WebSocket, host: string | undefined) {
    this.ws = ws;
    this.host = host;
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
      for (const fn of this.closeListeners) fn();
    });
  }

  // `timeoutMs` bounds the connect + handshake, so an unreachable host fails fast.
  // `host` names a peer of the server at `url`: every call is forwarded to it.
  static connect(url: string, token: string, opts: { timeoutMs?: number; host?: string } = {}): Promise<CasmClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: opts.timeoutMs });
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            ws.terminate();
            reject(new Error(`cannot connect to ${url}: no answer within ${opts.timeoutMs} ms`));
          }, opts.timeoutMs)
        : undefined;
      ws.once("close", () => clearTimeout(timer));
      ws.once("open", () => (clearTimeout(timer), resolve(new CasmClient(ws, opts.host))));
      ws.once("unexpected-response", (_req, res) =>
        reject(new Error(res.statusCode === 401 ? `unauthorized at ${url} (check the token)` : `HTTP ${res.statusCode} from ${url}`)),
      );
      ws.once("error", (e) => reject(new Error(`cannot connect to ${url}: ${e.message}`)));
    });
  }

  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    const id = this.nextId++;
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("connection closed"));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(this.host ? { host: this.host } : {}) }));
    });
  }

  on<N extends NotificationName>(name: N, fn: (params: NotificationParams<N>) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn as Listener);
    return () => set.delete(fn as Listener);
  }

  onClose(fn: () => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    this.ws.close();
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw) as RpcResponse | { method: string; params: unknown };
    if ("method" in msg) {
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      return;
    }
    const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id as number);
    if ("error" in msg) p.reject(new CasmError(msg.error.code, msg.error.message));
    else p.resolve(msg.result);
  }
}
