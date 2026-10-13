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

  private ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
    });
  }

  static connect(url: string, token: string): Promise<CasmClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
      ws.once("open", () => resolve(new CasmClient(ws)));
      ws.once("unexpected-response", (_req, res) =>
        reject(new Error(res.statusCode === 401 ? `unauthorized at ${url} (check the token)` : `HTTP ${res.statusCode} from ${url}`)),
      );
      ws.once("error", (e) => reject(new Error(`cannot connect to ${url}: ${e.message}`)));
    });
  }

  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  on<N extends NotificationName>(name: N, fn: (params: NotificationParams<N>) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn as Listener);
    return () => set.delete(fn as Listener);
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
