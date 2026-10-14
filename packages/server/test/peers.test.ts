// Peer timeouts against a peer that answers late, like a heavily loaded laptop.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { Store } from "../src/db.ts";
import { PEER_CONNECT_TIMEOUT_MS, PeerPool } from "../src/peers.ts";

// Accepts the WebSocket upgrade after `delayMs`, then answers server.info.
async function latePeer(delayMs: number) {
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer();
  http.on("upgrade", (req, socket, head) =>
    setTimeout(() => wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => {
        const { id } = JSON.parse(raw.toString());
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: { id: "late-id", name: "late", version: "x", protocol: 1, providers: [] } }));
      });
    }), delayMs),
  );
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => (wss.clients.forEach((c) => c.terminate()), new Promise<void>((r) => http.close(() => r()))),
  };
}

const stores: Store[] = [];
const pools: PeerPool[] = [];
after(() => {
  for (const p of pools) p.close();
  for (const s of stores) s.close();
});

function pool(url: string, timeoutMs?: number, slowMs?: number) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "casm-peers-")), "casm.db"));
  store.setPeer({ name: "mac", url, token: "t", serverId: "late-id" });
  stores.push(store);
  const p = new PeerPool(store, timeoutMs, slowMs);
  pools.push(p);
  return { p, peer: store.listPeers()[0]! };
}

test("peers get 10 s by default", () => {
  assert.equal(PEER_CONNECT_TIMEOUT_MS, 10_000);
});

test("a peer that answers late is slow, not unreachable; too late is unreachable", async () => {
  const late = await latePeer(400);
  try {
    // Within the timeout but over the slow threshold.
    const { p, peer } = pool(late.url, 3000, 200);
    const r = await p.probe(peer);
    assert.equal(r.reachable, true, r.error ?? "");
    assert.equal(r.slow, true);
    assert.ok(r.latencyMs! >= 400, `latency ${r.latencyMs}`);
    // The connection is kept: calls go through it without waiting again.
    assert.equal((await p.caller(peer)("server.info", {})).name, "late");
    const again = await p.probe(peer);
    assert.deepEqual([again.reachable, again.slow], [true, false]);
    assert.ok(again.latencyMs! < 200);

    // Past the timeout.
    const short = pool(late.url, 150);
    const gone = await short.p.probe(short.peer);
    assert.equal(gone.reachable, false);
    assert.match(gone.error!, /unreachable|within 150 ms/);
    await assert.rejects(short.p.caller(short.peer)("server.info", {}), /unreachable/);
  } finally {
    await late.close();
  }
});
