// WebSocket + JSON-RPC 2.0 transport. Clients authenticate with
// `Authorization: Bearer <token>` on the upgrade request, or `?token=<token>`
// in the URL (browsers can't set headers on a WebSocket). Other GET requests
// serve the web client's static files from `webRoot`.
import { createServer, type Server } from "node:http";
import { serveStatic } from "./static.ts";
import { hostname } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { CasmError } from "@casm/client";
import {
  ErrorCode,
  PROTOCOL_VERSION,
  methods,
  type Agent,
  type MethodName,
  type Params,
  type NotificationName,
  type NotificationParams,
  type RpcRequest,
  type RpcResponse,
} from "@casm/protocol";
import { AgentManager, RpcError, type Notify } from "./agents.ts";
import { Store } from "./db.ts";
import { createHandlers, type Conn } from "./methods.ts";
import { Scheduler } from "./schedules.ts";
import { PeerPool } from "./peers.ts";
import { Files } from "./files.ts";
import { AgentPrompt } from "./agent-prompt.ts";
import { PushService, type PushSend } from "./push.ts";
import type { Provider } from "./providers/types.ts";

export type ServerOptions = {
  store: Store;
  providers: Provider[];
  host: string;
  port: number;
  version: string;
  // Display name for this server (defaults to the machine's hostname).
  name?: string;
  log?: (msg: string) => void;
  // Connect timeout for peer servers (tests use a short one).
  peerTimeoutMs?: number;
  // The state directory ($CASM_HOME): agent-prompt.md, config.json and the
  // download-link secret. Without it agents get the default agent prompt, which
  // can't be changed, and download links last until the server restarts.
  home?: string;
  // The built web client (packages/web/dist), served at /. Without it, / says to use a WebSocket.
  webRoot?: string;
  // Delivers Web Push requests (tests replace the real HTTP POST).
  pushSend?: PushSend;
};

export type RunningServer = {
  http: Server;
  port: number;
  // How clients on this machine reach it (loopback when bound to every address).
  url: string;
  agents: AgentManager;
  scheduler: Scheduler;
  push: PushService;
  peers: PeerPool;
  close: () => Promise<void>;
};

// `remote`: subscriptions forwarded to peers, keyed "<peer>\n<agentId>", with
// the host the client named (relayed notifications carry it back).
type Client = Conn & { ws: WebSocket; name: string; remote: Map<string, { ref: string; stop: () => void }> };

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  const clients = new Set<Client>();

  const notify: Notify = <N extends NotificationName>(method: N, params: NotificationParams<N>, agentId?: string) => {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const c of clients) if (!agentId || c.subscriptions.has(agentId)) c.ws.send(msg);
  };

  const agents = new AgentManager(opts.store, new Map(opts.providers.map((p) => [p.id, p])), notify, new AgentPrompt(opts.home ?? null));
  const identity = { id: opts.store.serverId(), name: opts.name ?? hostname(), version: opts.version };
  const peers = new PeerPool(opts.store, opts.peerTimeoutMs);
  const files = new Files({ store: opts.store, peers, home: opts.home });
  const push = new PushService({ store: opts.store, home: opts.home, log, send: opts.pushSend });
  let scheduler: Scheduler | undefined;
  const handlers = createHandlers(opts.store, agents, notify, identity, peers, () => scheduler!, files, push);
  scheduler = new Scheduler(opts.store, agents, notify, (p) =>
    (handlers["agent.create"] as (p: Params<"agent.create">, c: Conn) => Promise<Agent>)(p, { subscriptions: new Set(), name: "schedule" }),
  );

  const http = createServer((req, res) => {
    // Unauthenticated, so clients can check compatibility before connecting.
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ...identity, protocol: PROTOCOL_VERSION }),
      );
      return;
    }
    // Signed, short-lived links stand in for a token here (see files.ts).
    if (files.serve(req, res, log)) return;
    if (opts.webRoot && serveStatic(opts.webRoot, req, res)) return;
    res.writeHead(426, { "content-type": "text/plain" }).end("casm: connect with a WebSocket\n");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  http.on("upgrade", (req, socket, head) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : new URL(req.url ?? "/", "http://x").searchParams.get("token");
    const name = token ? opts.store.checkToken(token) : undefined;
    if (!name) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, name, subscriptions: new Set(), remote: new Map() };
      clients.add(client);
      log(`client connected: ${name}`);
      ws.on("close", () => {
        clients.delete(client);
        for (const r of client.remote.values()) r.stop();
        log(`client disconnected: ${name}`);
      });
      ws.on("message", (data) => void handle(client, data.toString()));
    });
  });

  async function handle(client: Client, raw: string) {
    let req: RpcRequest;
    try {
      req = JSON.parse(raw);
    } catch {
      return reply(client, { jsonrpc: "2.0", id: null, error: { code: ErrorCode.ParseError, message: "invalid JSON" } });
    }
    const id = req.id ?? null;
    const method = methods[req.method as MethodName];
    if (!method) return reply(client, { jsonrpc: "2.0", id, error: { code: ErrorCode.MethodNotFound, message: `unknown method ${req.method}` } });
    const parsed = method.params.safeParse(req.params ?? {});
    if (!parsed.success)
      return reply(client, { jsonrpc: "2.0", id, error: { code: ErrorCode.InvalidParams, message: parsed.error.message } });
    // A request for a peer is forwarded; this server's own name or id means here.
    // It goes as sent: the peer may know params this server doesn't.
    const host = typeof req.host === "string" && req.host !== identity.name && req.host !== identity.id ? req.host : undefined;
    try {
      const handler = handlers[req.method as MethodName] as (p: unknown, c: Conn) => unknown;
      const result = host ? await forward(client, host, req.method as MethodName, req.params ?? {}) : await handler(parsed.data, client);
      if (id !== null) reply(client, { jsonrpc: "2.0", id, result });
    } catch (e) {
      const code = e instanceof RpcError || e instanceof CasmError ? e.code : ErrorCode.Internal;
      if (code === ErrorCode.Internal) log(`${req.method} failed: ${e instanceof Error ? e.stack : e}`);
      reply(client, { jsonrpc: "2.0", id, error: { code, message: e instanceof Error ? e.message : String(e) } });
    }
  }

  // Through the server's peer connections. Subscriptions are
  // relayed: the peer's notifications for the agent reach this client.
  async function forward(client: Client, ref: string, method: MethodName, params: unknown): Promise<unknown> {
    // Forward the sender's name snapshot from its origin before crossing hosts.
    // This is provenance for trusted clients, not a new authorization mechanism.
    if (method === "agent.send" || method === "agent.create") {
      const p = params as { sender?: { serverId: string; agentId: string; name?: string; host?: string; schedule?: { id: string; name: string } } };
      if (p.sender?.serverId === identity.id && !p.sender.schedule) {
        const source = opts.store.getAgent(p.sender.agentId);
        if (!source) throw new RpcError(ErrorCode.NotFound, "sender agent not found");
        params = { ...p, sender: { ...p.sender, name: source.name, host: identity.name } };
      }
    }
    const peer = peers.find(ref);
    if (!peer) {
      const known = peers.list().map((p) => p.name).join(", ") || "none";
      throw new RpcError(ErrorCode.NotFound, `unknown host "${ref}": not a peer of ${identity.name} (peers: ${known})`);
    }
    const key = `${peer.name}\n${(params as { id?: string }).id}`;
    const send = (msg: object, host = ref) => client.ws.send(JSON.stringify({ jsonrpc: "2.0", ...msg, host }));
    try {
      if (method === "agent.subscribe") {
        const { id } = params as Params<"agent.subscribe">;
        client.remote.get(key)?.stop();
        const { state, unsubscribe } = await peers.subscribe(peer, id, {
          notify: (m, p) => send({ method: m, params: p }),
          lost: () => {
            const gone = [...client.remote].filter(([k]) => k.startsWith(`${peer.name}\n`));
            for (const [k] of gone) client.remote.delete(k);
            for (const host of new Set(gone.map(([, r]) => r.ref))) send({ method: "peer.disconnected", params: { host } }, host);
          },
        });
        // The client may have gone while the peer answered; its close handler already ran.
        if (!clients.has(client)) unsubscribe();
        else client.remote.set(key, { ref, stop: unsubscribe });
        return state;
      }
      if (method === "agent.unsubscribe") {
        client.remote.get(key)?.stop();
        client.remote.delete(key);
        return { ok: true };
      }
      // The peer's link is wrapped in one of ours: the client downloads through this server.
      if (method === "fs.downloadLink") {
        const p = params as Params<"fs.downloadLink">;
        return files.proxyLink(peer, p.path, p.inline, await peers.caller(peer)("fs.downloadLink", p));
      }
      return await peers.caller(peer)(method, params as never);
    } catch (e) {
      // The peer's own errors keep their code; the connection's become Unreachable.
      if (e instanceof CasmError) throw e;
      throw new RpcError(ErrorCode.Unreachable, e instanceof Error ? e.message : String(e));
    }
  }

  function reply(client: Client, res: RpcResponse) {
    if (res.id === null && !("error" in res)) return;
    client.ws.send(JSON.stringify(res));
  }

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => resolve());
  });
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  log(`listening on ws://${opts.host}:${port}`);
  // The URL for clients on this machine: loopback unless bound to one address.
  const wildcard = ["", "0.0.0.0", "::", "[::]"].includes(opts.host);
  const localHost = wildcard ? "127.0.0.1" : opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  agents.setContext({ serverId: identity.id, serverName: identity.name });
  // Messages queued and runs missed while the server was down go out now, not on the first timer tick.
  agents.runDuePending();
  void scheduler.tick();
  void agents.dropAnsweredFailed().catch((e) => log(`checking failed messages: ${e}`));

  return {
    http,
    port,
    url: `ws://${localHost}:${port}`,
    agents,
    scheduler,
    peers,
    push,
    async close() {
      scheduler?.stop();
      await agents.shutdown();
      peers.close();
      for (const c of clients) c.ws.close();
      wss.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
