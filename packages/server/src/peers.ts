// Outbound connections to peer casm servers, cached per peer. Used by the MCP
// tools so an agent here can drive agents on another host, and by the server
// to forward client requests addressed to a peer (`host` in the request).
import { CasmClient } from "@casm/client";
import type { MethodName, Params, Result } from "@casm/protocol";
import type { Store, StoredPeer } from "./db.ts";

// A sleeping laptop must fail fast, not hang the calling agent.
export const PEER_CONNECT_TIMEOUT_MS = 3000;
// Calls other than agent.wait should answer quickly; a silent peer is treated as gone.
const PEER_CALL_TIMEOUT_MS = 15_000;

export type Call = <M extends MethodName>(method: M, params: Params<M>) => Promise<Result<M>>;

// A local client's subscription to an agent on a peer: gets the peer's
// notifications for that agent, and `lost` once if the connection drops.
export type Sink = { notify: (method: string, params: unknown) => void; lost: () => void };

// Connects, asks for the peer's identity and disconnects. Used by `casm peer add`.
export async function verifyPeer(url: string, token: string, timeoutMs = PEER_CONNECT_TIMEOUT_MS) {
  const c = await CasmClient.connect(url, token, { timeoutMs });
  try {
    return await withTimeout(c.call("server.info", {}), timeoutMs, `${url} did not answer server.info`);
  } finally {
    c.close();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms))),
  ]).finally(() => clearTimeout(timer));
}

export class PeerPool {
  private conns = new Map<string, { url: string; token: string; client: Promise<CasmClient> }>();
  // Per peer connection: agent id → local subscribers. Shared, so the peer
  // sees one subscription however many local clients watch the agent.
  private subs = new Map<CasmClient, Map<string, Set<Sink>>>();
  private store: Store;
  private timeoutMs: number;

  constructor(store: Store, timeoutMs = PEER_CONNECT_TIMEOUT_MS) {
    this.store = store;
    this.timeoutMs = timeoutMs;
  }

  list(): StoredPeer[] {
    return this.store.listPeers();
  }

  // By name or server id.
  find(ref: string): StoredPeer | undefined {
    const peers = this.store.listPeers();
    return peers.find((p) => p.name === ref) ?? peers.find((p) => p.serverId === ref);
  }

  private client(peer: StoredPeer): Promise<CasmClient> {
    const cached = this.conns.get(peer.name);
    if (cached && cached.url === peer.url && cached.token === peer.token) {
      return cached.client.then((c) => (c.isOpen ? c : (this.drop(peer.name, c), this.client(peer))));
    }
    if (cached) this.drop(peer.name);
    const client = CasmClient.connect(peer.url, peer.token, { timeoutMs: this.timeoutMs }).then(
      (c) => this.relay(c),
      (e: Error) => {
        this.conns.delete(peer.name);
        throw new Error(`host "${peer.name}" is unreachable (${e.message})`);
      },
    );
    this.conns.set(peer.name, { url: peer.url, token: peer.token, client });
    return client;
  }

  private drop(name: string, c?: CasmClient) {
    const cached = this.conns.get(name);
    this.conns.delete(name);
    if (c) c.close();
    else void cached?.client.then((x) => x.close(), () => {});
  }

  private relay(c: CasmClient): CasmClient {
    const subs = new Map<string, Set<Sink>>();
    this.subs.set(c, subs);
    for (const method of ["agent.event", "agent.status"] as const)
      c.on(method, (p) => {
        for (const sink of subs.get(p.agentId) ?? []) sink.notify(method, p);
      });
    c.onClose(() => {
      this.subs.delete(c);
      for (const sinks of subs.values()) for (const sink of sinks) sink.lost();
    });
    return c;
  }

  // Subscribes `sink` to an agent on the peer; `unsubscribe` ends it.
  async subscribe(peer: StoredPeer, agentId: string, sink: Sink) {
    const c = await this.client(peer);
    const subs = this.subs.get(c);
    if (!subs || !c.isOpen) throw new Error(`host "${peer.name}" disconnected`);
    let sinks = subs.get(agentId);
    if (!sinks) subs.set(agentId, (sinks = new Set()));
    sinks.add(sink);
    const unsubscribe = () => {
      if (!sinks.delete(sink) || sinks.size || subs.get(agentId) !== sinks) return;
      subs.delete(agentId);
      if (c.isOpen) void c.call("agent.unsubscribe", { id: agentId }).catch(() => {});
    };
    try {
      const state = await withTimeout(c.call("agent.subscribe", { id: agentId }), PEER_CALL_TIMEOUT_MS, `host "${peer.name}" did not answer agent.subscribe`);
      return { state, unsubscribe };
    } catch (e) {
      unsubscribe();
      throw e;
    }
  }

  // A typed call on the peer. agent.wait may take as long as its own timeout.
  caller(peer: StoredPeer): Call {
    return async (method, params) => {
      const c = await this.client(peer);
      const waitMs = method === "agent.wait" ? ((params as { timeoutMs?: number }).timeoutMs ?? 10 * 60_000) : 0;
      try {
        return await withTimeout(c.call(method, params), PEER_CALL_TIMEOUT_MS + waitMs, `host "${peer.name}" did not answer ${method}`);
      } catch (e) {
        // A timed-out or broken connection is dropped so the next call reconnects.
        if (!c.isOpen || (e instanceof Error && e.message.includes("did not answer"))) this.drop(peer.name, c);
        throw e;
      }
    };
  }

  async probe(peer: StoredPeer): Promise<{ reachable: boolean; error?: string }> {
    try {
      await this.caller(peer)("server.info", {});
      return { reachable: true };
    } catch (e) {
      return { reachable: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  close() {
    for (const name of [...this.conns.keys()]) this.drop(name);
  }
}
