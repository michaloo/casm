// WebSocket + JSON-RPC 2.0 transport. Clients authenticate with
// `Authorization: Bearer <token>` on the upgrade request.
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
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
import { createMcp } from "./mcp.ts";
import { PeerPool } from "./peers.ts";
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
};

export type RunningServer = {
  http: Server;
  port: number;
  agents: AgentManager;
  scheduler: Scheduler;
  close: () => Promise<void>;
};

type Client = Conn & { ws: WebSocket; name: string };

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  const clients = new Set<Client>();

  const notify: Notify = <N extends NotificationName>(method: N, params: NotificationParams<N>, agentId?: string) => {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const c of clients) if (!agentId || c.subscriptions.has(agentId)) c.ws.send(msg);
  };

  const agents = new AgentManager(opts.store, new Map(opts.providers.map((p) => [p.id, p])), notify);
  const identity = { id: opts.store.serverId(), name: opts.name ?? hostname(), version: opts.version };
  const peers = new PeerPool(opts.store, opts.peerTimeoutMs);
  let scheduler: Scheduler | undefined;
  const handlers = createHandlers(opts.store, agents, notify, identity, peers, () => scheduler!);
  scheduler = new Scheduler(opts.store, agents, notify, (p) =>
    (handlers["agent.create"] as (p: Params<"agent.create">, c: Conn) => Promise<Agent>)(p, { subscriptions: new Set() }),
  );
  const mcp = createMcp({ identity, agents, handlers, peers });

  const http = createServer((req, res) => {
    // Unauthenticated, so clients can check compatibility before connecting.
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ...identity, protocol: PROTOCOL_VERSION }),
      );
      return;
    }
    if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
      mcp(req, res).catch((e) => {
        log(`mcp request failed: ${e instanceof Error ? e.stack : e}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
      return;
    }
    res.writeHead(426, { "content-type": "text/plain" }).end("casm: connect with a WebSocket\n");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  http.on("upgrade", (req, socket, head) => {
    const auth = req.headers.authorization ?? "";
    const name = auth.startsWith("Bearer ") ? opts.store.checkToken(auth.slice(7).trim()) : undefined;
    if (!name) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, name, subscriptions: new Set() };
      clients.add(client);
      log(`client connected: ${name}`);
      ws.on("close", () => (clients.delete(client), log(`client disconnected: ${name}`)));
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
    try {
      const handler = handlers[req.method as MethodName] as (p: unknown, c: Conn) => unknown;
      const result = await handler(parsed.data, client);
      if (id !== null) reply(client, { jsonrpc: "2.0", id, result });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : ErrorCode.Internal;
      if (code === ErrorCode.Internal) log(`${req.method} failed: ${e instanceof Error ? e.stack : e}`);
      reply(client, { jsonrpc: "2.0", id, error: { code, message: e instanceof Error ? e.message : String(e) } });
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
  // Agents run on this machine, so they reach the MCP endpoint over loopback
  // unless the server is bound to one specific address.
  const wildcard = ["", "0.0.0.0", "::", "[::]"].includes(opts.host);
  const mcpHost = wildcard ? "127.0.0.1" : opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  agents.setContext({ serverId: identity.id, serverName: identity.name, mcpUrl: `http://${mcpHost}:${port}/mcp` });

  return {
    http,
    port,
    agents,
    scheduler,
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
