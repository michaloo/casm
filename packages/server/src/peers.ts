// Outbound connections to peer casm servers, cached per peer. Used by the MCP
// tools so an agent here can drive agents on another host.
import { CasmClient } from "@casm/client";
import type { MethodName, Params, Result } from "@casm/protocol";
import type { Store, StoredPeer } from "./db.ts";

// A sleeping laptop must fail fast, not hang the calling agent.
export const PEER_CONNECT_TIMEOUT_MS = 3000;
// Calls other than agent.wait should answer quickly; a silent peer is treated as gone.
const PEER_CALL_TIMEOUT_MS = 15_000;

export type Call = <M extends MethodName>(method: M, params: Params<M>) => Promise<Result<M>>;

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
    const client = CasmClient.connect(peer.url, peer.token, { timeoutMs: this.timeoutMs }).catch((e: Error) => {
      this.conns.delete(peer.name);
      throw new Error(`host "${peer.name}" is unreachable (${e.message})`);
    });
    this.conns.set(peer.name, { url: peer.url, token: peer.token, client });
    return client;
  }

  private drop(name: string, c?: CasmClient) {
    const cached = this.conns.get(name);
    this.conns.delete(name);
    if (c) c.close();
    else void cached?.client.then((x) => x.close(), () => {});
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
