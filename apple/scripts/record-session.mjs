// Records a live casm session (raw JSON-RPC frames) as a fixture for the CasmKit contract tests.
// usage: node apple/scripts/record-session.mjs ws://127.0.0.1:7373 <token> <projectId> > out.jsonl
// Runs one haiku turn that needs a permission (approved), then a second turn that is interrupted.
import WebSocket from "ws";

const [url, token, projectId] = process.argv.slice(2);
const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
let nextId = 1;
const pending = new Map();
const waiters = [];
const frames = [];

ws.on("message", (raw) => {
  const text = raw.toString();
  frames.push(text);
  const msg = JSON.parse(text);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) for (const w of [...waiters]) w(msg);
});

const call = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
const until = (pred) =>
  new Promise((resolve) => {
    const w = (m) => pred(m) && (waiters.splice(waiters.indexOf(w), 1), resolve(m));
    waiters.push(w);
  });

await new Promise((r) => ws.once("open", r));
await call("server.info", {});
await call("project.list", {});
const { result: agent } = await call("agent.create", {
  projectId, provider: "claude", name: "recorder", config: { model: "haiku", mode: "default" },
});
await call("agent.subscribe", { id: agent.id });
const isEvent = (type) => (m) => m.method === "agent.event" && m.params.agentId === agent.id && m.params.event.type === type;

await call("agent.send", { id: agent.id, text: "Think briefly, then write a file called hello.txt containing 'hi' with the Write tool. Then reply with a short markdown summary that includes a bullet list and a bash code block." });
const perm = await until(isEvent("permission"));
await call("agent.subscribe", { id: agent.id }); // mid-turn snapshot with a pending permission
await call("agent.respondPermission", { id: agent.id, requestId: perm.params.event.request.id, decision: "allow" });
await until(isEvent("turnEnded"));

await call("agent.send", { id: agent.id, text: "Count slowly from 1 to 200, one number per line." });
await until(isEvent("delta"));
await call("agent.interrupt", { id: agent.id });
await until(isEvent("turnEnded"));
await call("agent.history", { id: agent.id, limit: 50 });
await call("agent.list", {});
await call("agent.delete", { id: agent.id });
await new Promise((r) => setTimeout(r, 300));
process.stdout.write(frames.join("\n") + "\n");
ws.close();
