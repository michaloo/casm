// Cross-host agents: peers, the casm MCP endpoint and parent links, with two
// in-process servers ("alpha" and "beta") and a scripted fake provider.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { CasmClient, type CasmError } from "@casm/client";
import { ErrorCode, type Item } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { verifyPeer } from "../src/peers.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import type { OpenOptions, Provider } from "../src/providers/types.ts";

const opened: OpenOptions[] = [];
const histories = new Map<string, Item[]>();
let sessions = 0;

// Replies "echo: <text>"; "ask" asks a permission first, "question" asks a question.
const provider: Provider = {
  id: "claude",
  open(opts) {
    opened.push(opts);
    const abort = new AbortController();
    const sid = opts.resumeId ?? `native-x${++sessions}`;
    setImmediate(() => opts.emit({ type: "sessionId", id: sid }));
    return {
      send(text) {
        void (async () => {
          await new Promise((r) => setTimeout(r, 10));
          let reply = `echo: ${text}`;
          if (text.includes("ask")) {
            const a = await opts.askPermission({ id: "perm-1", toolName: "Bash", input: { command: "ls" }, canAlwaysAllow: false }, abort.signal);
            reply = `permission: ${a.decision}`;
          } else if (text.includes("question")) {
            const a = await opts.askQuestion({ id: "q-1", prompts: [{ id: "color", text: "Color?", kind: "text" }] }, abort.signal);
            reply = `answer: ${JSON.stringify(a)}`;
          }
          histories.set(sid, [...(histories.get(sid) ?? []), { kind: "user", id: `u${text}`, text }, { kind: "assistant", id: `a${text}`, text: reply }]);
          opts.emit({ type: "item", item: { kind: "assistant", id: `a${text}`, text: reply } });
          opts.emit({ type: "turnEnded", outcome: "completed" });
        })();
      },
      shell(command, itemId) {
        // "fail…" commands exit non-zero.
        const item = { kind: "tool" as const, id: itemId, name: "shell", origin: "user" as const, input: { command } };
        opts.emit({ type: "item", item: { ...item, status: "running" } });
        opts.emit({ type: "toolOutput", itemId, text: `ran ${command}\n` });
        opts.emit({ type: "item", item: { ...item, status: command.startsWith("fail") ? "error" : "done" } });
        opts.emit({ type: "turnEnded", outcome: "completed" });
      },
      async interrupt() {
        abort.abort();
      },
      async close() {},
    };
  },
  async history(sessionId) {
    return histories.get(sessionId) ?? [];
  },
  async catalog() {
    return { models: [], modes: [] };
  },
  async usage() {
    return null;
  },
  async commands() {
    return [];
  },
};

type Host = { store: Store; server: RunningServer; client: CasmClient; token: string; url: string };

async function host(name: string, peerTimeoutMs?: number): Promise<Host> {
  const store = new Store(join(mkdtempSync(join(tmpdir(), `casm-${name}-`)), "casm.db"));
  const token = store.createToken("test");
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test", name, peerTimeoutMs });
  const url = `ws://127.0.0.1:${server.port}`;
  return { store, server, token, url, client: await CasmClient.connect(url, token) };
}

let alpha: Host;
let beta: Host;
let blackhole: TcpServer;
const held: Socket[] = [];
// The parent agent on alpha and its MCP credentials.
let parentId: string;
let mcpUrl: string;
let mcpAuth: string;

before(async () => {
  alpha = await host("alpha", 500);
  beta = await host("beta");
  // Accepts TCP connections and never answers: a host that is "there" but asleep.
  blackhole = createTcpServer((s) => held.push(s));
  await new Promise<void>((r) => blackhole.listen(0, "127.0.0.1", r));
  await beta.client.call("project.create", { name: "BetaProj", path: "/tmp" });
});

after(async () => {
  for (const s of held) s.destroy();
  blackhole.close();
  for (const h of [alpha, beta]) {
    h.client.close();
    await h.server.close();
    h.store.close();
  }
});

let rpcId = 0;
async function mcp(method: string, params?: unknown, auth = mcpAuth) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: auth },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const { body } = await mcp("tools/call", { name, arguments: args });
  const r = body.result as { content: { text: string }[]; isError?: boolean };
  const text = r.content[0].text;
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: !!r.isError, text, data: data as any };
}

test("peer add verifies the peer and peer.list hides its token", async () => {
  const info = await verifyPeer(beta.url, beta.token);
  assert.equal(info.name, "beta");
  await assert.rejects(verifyPeer(beta.url, "wrong"), /unauthorized/);
  alpha.store.setPeer({ name: "beta", url: beta.url, token: beta.token, serverId: info.id });
  alpha.store.setPeer({ name: "asleep", url: `ws://127.0.0.1:${(blackhole.address() as { port: number }).port}`, token: "x", serverId: null });

  const { peers } = await alpha.client.call("peer.list", {});
  assert.deepEqual(peers.map((p) => p.name), ["asleep", "beta"]);
  assert.equal(peers[1].serverId, info.id);
  assert.ok(!JSON.stringify(peers).includes(beta.token));
  const probed = await alpha.client.call("peer.list", { probe: true });
  assert.deepEqual(probed.peers.map((p) => p.reachable), [false, true]);
});

test("casmTools puts the casm MCP server and CASM_* env into the session", async () => {
  const p = await alpha.client.call("project.create", { name: "AlphaProj", path: "/tmp" });
  const plain = await alpha.client.call("agent.create", { projectId: p.id, provider: "claude", prompt: "hi" });
  await alpha.client.call("agent.wait", { id: plain.id });
  const plainOpts = opened.at(-1)!;
  assert.equal(plainOpts.config.mcpServers, undefined);
  assert.equal(plainOpts.config.env?.CASM_AGENT_ID, plain.id);

  const a = await alpha.client.call("agent.create", { projectId: p.id, provider: "claude", config: { casmTools: true }, prompt: "hi" });
  await alpha.client.call("agent.wait", { id: a.id });
  const o = opened.at(-1)!;
  const entry = o.config.mcpServers!.casm as { type: string; url: string; headers: { Authorization: string } };
  assert.equal(entry.type, "http");
  assert.equal(entry.url, `http://127.0.0.1:${alpha.server.port}/mcp`);
  assert.deepEqual(
    { id: o.config.env!.CASM_SERVER_ID, name: o.config.env!.CASM_SERVER_NAME, agent: o.config.env!.CASM_AGENT_ID },
    { id: (await alpha.client.call("server.info", {})).id, name: "alpha", agent: a.id },
  );
  // Only the session sees these; the stored config is unchanged.
  assert.deepEqual((await alpha.client.call("agent.get", { id: a.id })).config, { casmTools: true });
  parentId = a.id;
  mcpUrl = entry.url;
  mcpAuth = entry.headers.Authorization;
});

test("MCP rejects missing and bad agent tokens", async () => {
  assert.equal((await mcp("tools/list", {}, "")).status, 401);
  assert.equal((await mcp("tools/list", {}, "Bearer casm_agent_nope")).status, 401);
  // A client token is not an agent token.
  assert.equal((await mcp("tools/list", {}, `Bearer ${alpha.token}`)).status, 401);
});

test("MCP initialize, notifications and tools/list", async () => {
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.ok(init.body.result.capabilities.tools);
  const note = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: mcpAuth },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(note.status, 202);
  assert.equal((await fetch(mcpUrl, { headers: { authorization: mcpAuth } })).status, 405);
  const { body } = await mcp("tools/list");
  const names = body.result.tools.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, [
    "answer_permission",
    "answer_question",
    "create_agent",
    "get_history",
    "get_limits",
    "get_usage",
    "list_agents",
    "list_hosts",
    "list_pending",
    "list_projects",
    "send",
    "wait",
  ]);
  const create = body.result.tools.find((t: { name: string }) => t.name === "create_agent");
  assert.deepEqual(create.inputSchema.required.sort(), ["project", "provider"]);
});

test("list_hosts and list_projects, local and remote", async () => {
  const hosts = await tool("list_hosts");
  assert.deepEqual(
    hosts.data.map((h: { name: string; reachable: boolean }) => [h.name, h.reachable]),
    [["alpha", true], ["asleep", false], ["beta", true]],
  );
  assert.deepEqual((await tool("list_projects")).data.map((p: { name: string }) => p.name), ["AlphaProj"]);
  assert.deepEqual((await tool("list_projects", { host: "beta" })).data.map((p: { name: string }) => p.name), ["BetaProj"]);
});

test("create_agent, send, wait, list_agents and get_history on a peer; parent is the calling agent", async () => {
  const alphaId = (await alpha.client.call("server.info", {})).id;
  const created = await tool("create_agent", { host: "beta", project: "BetaProj", provider: "claude", prompt: "remote hello", name: "child" });
  assert.equal(created.isError, false, created.text);
  assert.equal(created.data.host, "beta");
  const child = await beta.client.call("agent.get", { id: created.data.id });
  assert.deepEqual(child.parent, { serverId: alphaId, agentId: parentId, host: "alpha" });

  const w = await tool("wait", { host: "beta", agent: "child", timeout_s: 5 });
  assert.deepEqual(w.data, { status: "idle", timedOut: false, lastReply: "echo: remote hello", lastTurn: { outcome: "completed" } });
  assert.deepEqual((await tool("send", { host: "beta", agent: created.data.id.slice(0, 8), text: "again" })).data, { queued: false });
  assert.equal((await tool("wait", { host: "beta", agent: "child" })).data.lastReply, "echo: again");

  const listed = await tool("list_agents", { host: "beta", project: "BetaProj" });
  assert.equal(listed.data[0].name, "child");
  assert.equal(listed.data[0].parent.agentId, parentId);
  const h = await tool("get_history", { host: "beta", agent: "child", limit: 2 });
  assert.equal(h.text, "(2 earlier entries)\nuser: again\nassistant: echo: again");
});

test("create_agent takes a folder inside the project, resolved on the peer", async () => {
  // BetaProj is /tmp on beta.
  const sub = mkdtempSync("/tmp/casm-sub-");
  const created = await tool("create_agent", { host: "beta", project: "BetaProj", provider: "claude", cwd: basename(sub) });
  assert.equal(created.isError, false, created.text);
  assert.equal((await beta.client.call("agent.get", { id: created.data.id })).cwd, sub);
  const outside = await tool("create_agent", { host: "beta", project: "BetaProj", provider: "claude", cwd: "../etc" });
  assert.equal(outside.isError, true);
  assert.match(outside.text, /must be inside the project folder/);
  rmSync(sub, { recursive: true });
});

test("create_agent locally also sets the parent", async () => {
  const created = await tool("create_agent", { project: "AlphaProj", provider: "claude", prompt: "local" });
  const child = await alpha.client.call("agent.get", { id: created.data.id });
  assert.equal(child.parent?.agentId, parentId);
  assert.equal((await tool("wait", { agent: created.data.id })).data.lastReply, "echo: local");
});

test("answer_permission and answer_question unblock a remote child", async () => {
  const c = await tool("create_agent", { host: "beta", project: "BetaProj", provider: "claude", prompt: "please ask" });
  const w = await tool("wait", { host: "beta", agent: c.data.id });
  assert.equal(w.data.status, "waiting");
  assert.equal(w.data.permissions[0].id, "perm-1");
  await tool("answer_permission", { host: "beta", agent: c.data.id, request_id: "perm-1", decision: "allow" });
  assert.equal((await tool("wait", { host: "beta", agent: c.data.id })).data.lastReply, "permission: allow");

  await tool("send", { host: "beta", agent: c.data.id, text: "a question" });
  const q = await tool("wait", { host: "beta", agent: c.data.id });
  assert.equal(q.data.questions[0].id, "q-1");
  await tool("answer_question", { host: "beta", agent: c.data.id, request_id: "q-1", answers: { color: "teal" } });
  assert.equal((await tool("wait", { host: "beta", agent: c.data.id })).data.lastReply, 'answer: {"color":"teal"}');
});

test("errors come back as tool errors; an unreachable host fails fast", async () => {
  const unknownAgent = await tool("send", { host: "beta", agent: "nobody", text: "x" });
  assert.equal(unknownAgent.isError, true);
  assert.match(unknownAgent.text, /no agent "nobody" on beta/);
  const unknownHost = await tool("list_agents", { host: "mars" });
  assert.match(unknownHost.text, /unknown host "mars" \(known: alpha, asleep, beta\)/);
  const bad = await tool("create_agent", { project: "AlphaProj" });
  assert.match(bad.text, /invalid arguments/);

  const t0 = Date.now();
  const asleep = await tool("list_agents", { host: "asleep" });
  assert.equal(asleep.isError, true);
  assert.match(asleep.text, /host "asleep" is unreachable/);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test("casm run links the child from CASM_* env or --parent", async () => {
  const cli = join(import.meta.dirname, "../../cli/src/main.ts");
  const run = async (args: string[], env: Record<string, string>) => {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "--json", "run", "--project", "BetaProj", ...args, "hi"], {
      env: { ...process.env, CASM_URL: beta.url, CASM_TOKEN: beta.token, ...env },
    });
    return JSON.parse(stdout).parent;
  };
  assert.deepEqual(await run([], { CASM_SERVER_ID: "srv", CASM_SERVER_NAME: "alpha", CASM_AGENT_ID: "agt" }), {
    serverId: "srv",
    agentId: "agt",
    host: "alpha",
  });
  assert.deepEqual(await run(["--parent", "s2/a2"], { CASM_SERVER_ID: "srv", CASM_AGENT_ID: "agt" }), { serverId: "s2", agentId: "a2" });
  assert.equal(await run(["--parent", "none"], { CASM_SERVER_ID: "srv", CASM_AGENT_ID: "agt" }), null);
});

// Clients (the CLI on a server machine) reach peers through their own server:
// a request with `host` is forwarded over the same peer connections as the MCP tools.
test("requests with a host are forwarded to that peer", async () => {
  const viaBeta = await CasmClient.connect(alpha.url, alpha.token, { host: "beta" });
  const viaSelf = await CasmClient.connect(alpha.url, alpha.token, { host: "alpha" });
  try {
    assert.equal((await viaBeta.call("server.info", {})).name, "beta");
    assert.deepEqual((await viaBeta.call("project.list", {})).projects.map((p) => p.name), ["BetaProj"]);
    // This server's own name (or id) means here.
    assert.equal((await viaSelf.call("server.info", {})).name, "alpha");
    // The peer's errors keep their code.
    await assert.rejects(viaBeta.call("agent.get", { id: "nope" }), (e: CasmError) => e.code === ErrorCode.NotFound && /agent nope/.test(e.message));
  } finally {
    viaBeta.close();
    viaSelf.close();
  }

  const mars = await CasmClient.connect(alpha.url, alpha.token, { host: "mars" });
  await assert.rejects(mars.call("agent.list", {}), (e: CasmError) => e.code === ErrorCode.NotFound && /unknown host "mars": not a peer of alpha \(peers: asleep, beta\)/.test(e.message));
  mars.close();

  const asleep = await CasmClient.connect(alpha.url, alpha.token, { host: "asleep" });
  const t0 = Date.now();
  await assert.rejects(asleep.call("agent.list", {}), (e: CasmError) => e.code === ErrorCode.Unreachable && /host "asleep" is unreachable/.test(e.message));
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  asleep.close();
});

test("a forwarded request carries the client's params as sent, unknown keys included", async () => {
  // A peer that answers every request with the params it got.
  const echo = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  echo.on("connection", (ws) => ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.params }));
  }));
  await new Promise((r) => echo.once("listening", r));
  alpha.store.setPeer({ name: "echo", url: `ws://127.0.0.1:${(echo.address() as { port: number }).port}`, token: "t", serverId: null });
  const c = await CasmClient.connect(alpha.url, alpha.token, { host: "echo" });
  try {
    assert.deepEqual(await c.call("agent.get", { id: "a1", fromNewerClient: true } as never), { id: "a1", fromNewerClient: true });
  } finally {
    c.close();
    alpha.store.removePeer("echo");
    echo.close();
  }
});

test("relayed notifications carry the host the client named, a server id included", async () => {
  const project = (await beta.client.call("project.list", {})).projects.find((p) => p.name === "BetaProj")!;
  const agent = await beta.client.call("agent.create", { projectId: project.id, provider: "claude" });
  const betaId = beta.store.serverId();
  const ws = new WebSocket(alpha.url, { headers: { authorization: `Bearer ${alpha.token}` } });
  const got: { id?: number; method?: string; host?: string }[] = [];
  ws.on("message", (d) => got.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.once("open", r));
  try {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent.subscribe", params: { id: agent.id }, host: betaId }));
    for (let i = 0; i < 50 && !got.some((m) => m.id === 1); i++) await new Promise((r) => setTimeout(r, 10));
    await beta.client.call("agent.send", { id: agent.id, text: "hi" });
    await beta.client.call("agent.wait", { id: agent.id });
    await new Promise((r) => setTimeout(r, 50));
    const relayed = got.filter((m) => m.method);
    assert.ok(relayed.length > 0);
    assert.deepEqual([...new Set(relayed.map((m) => m.host))], [betaId]);
  } finally {
    ws.close();
  }
});

test("a client that disconnects while a peer subscription is being set up leaves nothing subscribed", async () => {
  const project = (await beta.client.call("project.list", {})).projects.find((p) => p.name === "BetaProj")!;
  const agent = await beta.client.call("agent.create", { projectId: project.id, provider: "claude" });
  const before = alpha.server.peers.relayed;
  const ws = new WebSocket(alpha.url, { headers: { authorization: `Bearer ${alpha.token}` } });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent.subscribe", params: { id: agent.id }, host: "beta" }));
  ws.terminate();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alpha.server.peers.relayed, before);
});

test("subscriptions through a peer relay its notifications until unsubscribed or disconnected", async () => {
  const project = (await beta.client.call("project.list", {})).projects.find((p) => p.name === "BetaProj")!;
  const agent = await beta.client.call("agent.create", { projectId: project.id, provider: "claude", name: "relayed" });
  const watchers = await Promise.all([0, 1].map(() => CasmClient.connect(alpha.url, alpha.token, { host: "beta" })));
  const replies: string[][] = [[], []];
  watchers.forEach((w, i) =>
    w.on("agent.event", ({ agentId, event }) => {
      if (agentId === agent.id && event.type === "item" && event.item.kind === "assistant") replies[i].push(event.item.text);
    }),
  );
  const turn = async (text: string) => {
    await beta.client.call("agent.send", { id: agent.id, text });
    await beta.client.call("agent.wait", { id: agent.id });
    await new Promise((r) => setTimeout(r, 50));
  };
  try {
    for (const w of watchers) assert.equal((await w.call("agent.subscribe", { id: agent.id })).status, "idle");
    await turn("one");
    assert.deepEqual(replies, [["echo: one"], ["echo: one"]]);
    // One local client leaving keeps the shared peer subscription for the other.
    await watchers[0].call("agent.unsubscribe", { id: agent.id });
    await turn("two");
    assert.deepEqual(replies, [["echo: one"], ["echo: one", "echo: two"]]);
  } finally {
    for (const w of watchers) w.close();
  }

  // A peer that goes away ends the forwarded subscriptions, once per client.
  const gamma = await host("gamma");
  await gamma.client.call("project.create", { name: "GammaProj", path: "/tmp" });
  const g = (await gamma.client.call("project.list", {})).projects[0];
  const ga = await gamma.client.call("agent.create", { projectId: g.id, provider: "claude" });
  alpha.store.setPeer({ name: "gamma", url: gamma.url, token: gamma.token, serverId: null });
  const w = await CasmClient.connect(alpha.url, alpha.token, { host: "gamma" });
  const lost: string[] = [];
  w.on("peer.disconnected", ({ host }) => lost.push(host));
  await w.call("agent.subscribe", { id: ga.id });
  gamma.client.close();
  await gamma.server.close();
  gamma.store.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(lost, ["gamma"]);
  w.close();
  alpha.store.removePeer("gamma");
});

test("the CLI on a server machine reaches peers through its server; hosts.json is for machines without one", async () => {
  const cli = join(import.meta.dirname, "../../cli/src/main.ts");
  const home = mkdtempSync(join(tmpdir(), "casm-cli-"));
  const casm = (args: string[], env: Record<string, string> = {}) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CASM_")));
    return promisify(execFile)(process.execPath, [cli, ...args], { env: { ...clean, CASM_HOME: home, ...env } });
  };
  // What `casm serve` writes on alpha's machine.
  writeFileSync(join(home, "local.json"), JSON.stringify({ url: alpha.url, token: alpha.token }));
  assert.equal(JSON.parse((await casm(["--json", "info"])).stdout).name, "alpha");
  assert.equal(JSON.parse((await casm(["-H", "beta", "--json", "info"])).stdout).name, "beta");
  assert.equal(JSON.parse((await casm(["--json", "info"], { CASM_HOST: "beta" })).stdout).name, "beta");
  const projects = JSON.parse((await casm(["-H", "beta", "--json", "projects"])).stdout);
  assert.deepEqual(projects.map((p: { name: string }) => p.name), ["BetaProj"]);
  await assert.rejects(casm(["-H", "mars", "agents"]), /unknown host "mars": not a peer of alpha/);
  // Server commands read this machine's DB, so they refuse a host rather than show local data as its.
  await assert.rejects(casm(["-H", "beta", "--json", "peer", "list"]), /this machine's server only, not on host "beta".*casm -H beta peers/);
  await assert.rejects(casm(["token", "list"], { CASM_HOST: "beta" }), /not on host "beta" \(from CASM_HOST\)/);
  await assert.rejects(casm(["-Hbeta", "peer", "list"]), /this machine's server only, not on host "beta"/);
  assert.match((await casm(["serve", "--help"], { CASM_HOST: "beta" })).stdout, /serve/);
  // A flag's value before the command isn't mistaken for it (a project named "token").
  assert.ok(Array.isArray(JSON.parse((await casm(["-p", "token", "--json", "projects"])).stdout)));
  // `casm peers` lists the names -H takes.
  assert.deepEqual(JSON.parse((await casm(["--json", "peers"])).stdout).map((p: { name: string }) => p.name), ["asleep", "beta"]);
  await assert.rejects(casm(["host", "add", "beta", beta.url, beta.token]), /runs a casm server.*casm peer add beta/s);

  // Streaming commands work through the peer; shell exits 1 when the command fails.
  const agent = JSON.parse((await casm(["-H", "beta", "--json", "run", "--project", "BetaProj", "--parent", "none", "--wait", "hi"])).stdout);
  assert.equal(agent.lastReply, "echo: hi");
  const id = (await beta.client.call("agent.list", {})).agents.findLast((x) => x.parent === null)!.id;
  assert.equal((await casm(["-H", "beta", "shell", id, "echo", "ok"])).stdout, "ran echo ok\n");
  await assert.rejects(casm(["-H", "beta", "shell", id, "fail", "now"]), (e: { code: number; stdout: string }) => e.code === 1 && e.stdout === "ran fail now\n");

  // Without a server here, -H picks from hosts.json.
  rmSync(join(home, "local.json"));
  await casm(["host", "add", "beta", beta.url, beta.token]);
  assert.equal(JSON.parse((await casm(["--json", "info"])).stdout).name, "beta");
  await assert.rejects(casm(["-H", "alpha", "info"]), /unknown host "alpha" \(known: beta\)/);
});
