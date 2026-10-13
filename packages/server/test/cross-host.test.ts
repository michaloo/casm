// Cross-host agents: peers, the casm MCP endpoint and parent links, with two
// in-process servers ("alpha" and "beta") and a scripted fake provider.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CasmClient } from "@casm/client";
import type { Item } from "@casm/protocol";
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
      shell() {
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
  assert.deepEqual(w.data, { status: "idle", timedOut: false, lastReply: "echo: remote hello" });
  assert.deepEqual((await tool("send", { host: "beta", agent: created.data.id.slice(0, 8), text: "again" })).data, { queued: false });
  assert.equal((await tool("wait", { host: "beta", agent: "child" })).data.lastReply, "echo: again");

  const listed = await tool("list_agents", { host: "beta", project: "BetaProj" });
  assert.equal(listed.data[0].name, "child");
  assert.equal(listed.data[0].parent.agentId, parentId);
  const h = await tool("get_history", { host: "beta", agent: "child", limit: 2 });
  assert.equal(h.text, "(2 earlier entries)\nuser: again\nassistant: echo: again");
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
