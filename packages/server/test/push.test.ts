// Web Push: the RFC 8291/8292 encoding, VAPID key persistence, devices and
// push.notify (attribution, targeting, rate limit, expired subscriptions),
// with the push service replaced by a recorder.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CasmClient, CasmError } from "@casm/client";
import { ErrorCode } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { PushService, type PushSend } from "../src/push.ts";
import { encrypt, generateVapidKeys, vapidAuthorization, type PushRequest } from "../src/web-push.ts";
import type { Provider } from "../src/providers/types.ts";

const hmac = (key: Buffer, ...data: Buffer[]) => data.reduce((h, d) => h.update(d), createHmac("sha256", key)).digest();

// A browser's side of a subscription: its keys, and RFC 8291 decryption.
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    decrypt(body: Buffer) {
      const salt = body.subarray(0, 16);
      const idlen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idlen);
      const ikm = hmac(hmac(auth, ecdh.computeSecret(asPublic)), Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic, Buffer.from([1]));
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])).subarray(0, 12);
      const data = body.subarray(21 + idlen);
      const d = createDecipheriv("aes-128-gcm", cek, nonce);
      d.setAuthTag(data.subarray(-16));
      const plain = Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
      assert.equal(plain.at(-1), 2, "a single, last record");
      return plain.subarray(0, -1).toString();
    },
  };
}

test("payloads decrypt on the browser's side (RFC 8291 aes128gcm)", () => {
  const b = browser();
  const body = encrypt(Buffer.from("héllo push"), b.keys.p256dh, b.keys.auth);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(b.decrypt(body), "héllo push");
});

test("the VAPID header is an ES256 JWT for the endpoint's origin, signed by the public key it names", () => {
  const keys = generateVapidKeys();
  const header = vapidAuthorization("https://web.push.apple.com/QGx/abc", keys, "https://casm.example", Date.parse("2026-10-15T00:00:00Z"));
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)!;
  assert.ok(m);
  assert.equal(m[4], keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(m[1], "base64url").toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
  assert.deepEqual(claims, { aud: "https://web.push.apple.com", exp: Date.parse("2026-10-15T12:00:00Z") / 1000, sub: "https://casm.example" });
  const pub = Buffer.from(keys.publicKey, "base64url");
  assert.equal(pub.length, 65);
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")));
});

test("VAPID keys are generated once into the state directory, private to the user, and never logged", () => {
  const home = mkdtempSync(join(tmpdir(), "casm-push-keys-"));
  const store = new Store(join(home, "db"));
  const logged: string[] = [];
  try {
    const first = new PushService({ store, home, log: (m) => logged.push(m) }).vapid();
    const file = join(home, "push-vapid.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(new PushService({ store, home }).vapid(), first);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).publicKey, first.publicKey);
    assert.ok(!logged.join("\n").includes(String(first.privateJwk.d)));
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// --- through a server

const provider: Provider = {
  id: "claude",
  open(opts) {
    setImmediate(() => opts.emit({ type: "sessionId", id: "native" }));
    return {
      // "hold" keeps the turn running until the test ends it.
      send(text) {
        if (!text.includes("hold")) setImmediate(() => opts.emit({ type: "turnEnded", outcome: "completed" }));
        else held = () => opts.emit({ type: "turnEnded", outcome: "completed" });
      },
      shell() {}, async interrupt() {}, async close() {},
    };
  },
  async history() { return []; }, async usage() { return null; },
  async commands() { return []; }, async catalog() { return { models: [], modes: [] }; },
  async limits() { return null; },
};
let held = () => {};

let home: string;
let store: Store;
let token: string;
let server: RunningServer;
let client: CasmClient;
let sent: PushRequest[] = [];
// The push service's answer per endpoint (default 201).
let answer = new Map<string, { status: number; headers?: Record<string, string> }>();
const pushSend: PushSend = async (req) => {
  sent.push(req);
  const a = answer.get(req.endpoint) ?? { status: 201 };
  return { status: a.status, headers: new Headers(a.headers), body: a.status >= 400 ? "nope" : "" };
};

before(async () => {
  home = mkdtempSync(join(tmpdir(), "casm-push-"));
  store = new Store(join(home, "casm.db"));
  token = store.createToken("test");
  server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test", home, name: "pushhost", pushSend });
  client = await CasmClient.connect(server.url, token);
});

after(async () => {
  client.close();
  await server.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  for (const d of store.listPushDevices()) store.removePushDevice(d.id);
  sent = [];
  answer = new Map();
});

const subscribe = (label: string, b = browser(), endpoint = `https://push.example/${label}-${randomBytes(4).toString("hex")}`) =>
  client.call("push.subscribe", { subscription: { endpoint, keys: b.keys }, label, origin: "https://casm.example" }).then((d) => ({ ...d, endpoint, browser: b }));

test("devices subscribe, list with the public key, renew in place and unsubscribe", async () => {
  const phone = await subscribe("iPhone");
  await subscribe("Mac · Safari");
  const again = await client.call("push.subscribe", { subscription: { endpoint: phone.endpoint, keys: phone.browser.keys }, label: "iPhone (renamed)" });
  assert.equal(again.id, phone.id);
  const list = await client.call("push.list", { endpoint: phone.endpoint });
  assert.equal(list.publicKey, server.push.vapid().publicKey);
  assert.deepEqual(list.devices.map((d) => [d.label, d.service, d.current]), [["iPhone (renamed)", "push.example", true], ["Mac · Safari", "push.example", false]]);
  assert.ok(!JSON.stringify(list).includes(phone.endpoint), "endpoints stay on the server");
  assert.deepEqual(await client.call("push.unsubscribe", { endpoint: phone.endpoint }), { removed: true });
  assert.deepEqual(await client.call("push.unsubscribe", { id: phone.id }), { removed: false });
  assert.equal((await client.call("push.list", {})).devices.length, 1);
  await assert.rejects(client.call("push.subscribe", { subscription: { endpoint: "https://push.example/x", keys: { p256dh: "short", auth: "short" } }, label: "bad" }), /keys/);
});

test("an agent's notification is titled after it, links to it and reaches every device", async () => {
  const project = await client.call("project.create", { path: home, name: "casm-ng" });
  const agent = await client.call("agent.create", { projectId: project.id, provider: "claude", name: "builder" });
  const phone = await subscribe("iPhone");
  const mac = await subscribe("Mac");
  const info = await client.call("server.info", {});
  const r = await client.call("push.notify", { message: "Tests are green", sender: { serverId: info.id, agentId: agent.id } });
  const url = `/h/pushhost/a/${agent.id}`;
  assert.deepEqual({ ...r.notification, id: "", at: "" }, { id: "", at: "", title: "builder · casm-ng", body: "Tests are green", url, agentId: agent.id });
  assert.deepEqual([r.delivered, r.devices, r.failed], [2, 2, []]);
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), [phone.endpoint, mac.endpoint].sort());
  const req = sent.find((s) => s.endpoint === phone.endpoint)!;
  assert.equal(req.headers["content-encoding"], "aes128gcm");
  assert.equal(req.headers.urgency, "high");
  assert.ok(Number(req.headers.ttl) > 0);
  assert.match(req.headers.authorization, /^vapid t=.+, k=/);
  assert.deepEqual(JSON.parse(phone.browser.decrypt(req.body)), { title: "builder · casm-ng", body: "Tests are green", tag: r.notification.id, url });
  assert.ok((await client.call("push.list", {})).devices.every((d) => d.lastUsedAt));
});

test("a scheduled turn's notification names the schedule; --title and --url override", async () => {
  const project = await client.call("project.create", { path: home, name: "sched-proj" });
  const agent = await client.call("agent.create", { projectId: project.id, provider: "claude", name: "nightly" });
  const info = await client.call("server.info", {});
  const s = await client.call("schedule.create", { name: "Morning check", cadence: { type: "every", minutes: 60 }, target: { type: "agent", agentId: agent.id }, prompt: "hold the check", enabled: false });
  await client.call("schedule.runNow", { id: s.id });
  const sender = { serverId: info.id, agentId: agent.id };
  const r = await client.call("push.notify", { message: "done", sender });
  assert.equal(r.notification.title, "nightly · sched-proj · schedule Morning check");
  held();
  await client.call("agent.wait", { id: agent.id });
  const custom = await client.call("push.notify", { message: "done", title: "Deploy", url: "/h/pushhost/p/x/new", sender });
  assert.deepEqual([custom.notification.title, custom.notification.url], ["Deploy", "/h/pushhost/p/x/new"]);
  await assert.rejects(client.call("push.notify", { message: "x", url: "https://evil.example/" }), /url must be a path/);
  await assert.rejects(client.call("push.notify", { message: "x", url: "//evil.example/" }), /url must be a path/);
  const plain = await client.call("push.notify", { message: "from a shell" });
  assert.deepEqual([plain.notification.title, plain.notification.url], ["casm · pushhost", undefined]);
  const remote = await client.call("push.notify", { message: "hi", sender: { serverId: "elsewhere", agentId: "a1", name: "mac-agent", host: "macbook" } });
  assert.deepEqual([remote.notification.title, remote.notification.url], ["mac-agent · macbook", undefined]);
});

test("--device targets one device by label or id, and names the choices when none matches", async () => {
  const phone = await subscribe("iPhone");
  await subscribe("Mac");
  const r = await client.call("push.notify", { message: "only the phone", device: "iphone" });
  assert.deepEqual([r.delivered, r.devices], [1, 1]);
  assert.deepEqual(sent.map((s) => s.endpoint), [phone.endpoint]);
  assert.equal((await client.call("push.notify", { message: "by id", device: phone.id })).delivered, 1);
  await assert.rejects(client.call("push.notify", { message: "x", device: "Pixel" }), /no device "Pixel".*devices: iPhone, Mac/);
});

test("expired subscriptions are removed (404/410); 429 pauses the device; failures are reported", async () => {
  const gone = await subscribe("Old iPad");
  const busy = await subscribe("Busy");
  const ok = await subscribe("Fine");
  answer.set(gone.endpoint, { status: 410 });
  answer.set(busy.endpoint, { status: 429, headers: { "retry-after": "120" } });
  const r = await client.call("push.notify", { message: "x" });
  assert.equal(r.delivered, 1);
  assert.deepEqual(r.failed.map((f) => f.device).sort(), ["Busy", "Old iPad"]);
  assert.deepEqual((await client.call("push.list", {})).devices.map((d) => d.label).sort(), ["Busy", "Fine"]);
  sent = [];
  const again = await client.call("push.notify", { message: "y" });
  assert.deepEqual(sent.map((s) => s.endpoint), [ok.endpoint], "the paused device is skipped");
  assert.match(again.failed[0].error, /slow down/);
  answer.set(ok.endpoint, { status: 403 });
  await assert.rejects(client.call("push.test", { id: ok.id }), (e: CasmError) => e.code === ErrorCode.Unreachable && /403: nope/.test(e.message));
  answer.delete(ok.endpoint);
  assert.deepEqual(await client.call("push.test", { id: ok.id }), { ok: true });
});

test("push.notify allows 10 a minute per sender, then says when to try again", async () => {
  let now = Date.parse("2026-10-15T10:00:00Z");
  const local = new Store(":memory:");
  const push = new PushService({ store: local, now: () => now, send: pushSend });
  const ctx = { server: { id: "s", name: "h" }, turnSender: () => undefined };
  const a = { serverId: "s", agentId: "agent-a" };
  try {
    for (let i = 0; i < 10; i++) await push.notify({ message: `${i}`, sender: a }, ctx, "test");
    await assert.rejects(push.notify({ message: "11th", sender: a }, ctx, "test"), (e: CasmError) => e.code === ErrorCode.Busy && /at most 10 a minute; try again in 60 s/.test(e.message));
    await push.notify({ message: "another agent", sender: { serverId: "s", agentId: "agent-b" } }, ctx, "test");
    now += 61_000;
    await push.notify({ message: "a minute later", sender: a }, ctx, "test");
  } finally {
    local.close();
  }
});

test("casm notify attributes the agent it runs in, targets --device and reports delivery", async () => {
  const project = await client.call("project.create", { path: home, name: "cli-proj" });
  const agent = await client.call("agent.create", { projectId: project.id, provider: "claude", name: "worker" });
  const phone = await subscribe("iPhone");
  await subscribe("Mac");
  const info = await client.call("server.info", {});
  const cli = join(import.meta.dirname, "../../cli/src/main.ts");
  const env = { ...process.env, CASM_URL: server.url, CASM_TOKEN: token, CASM_HOST: "", CASM_SERVER_ID: info.id, CASM_SERVER_NAME: info.name, CASM_AGENT_ID: agent.id };
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { env });
  const { stdout } = await run("--json", "notify", "Build", "finished", "--device", "iPhone");
  const r = JSON.parse(stdout);
  assert.equal(r.notification.title, "worker · cli-proj");
  assert.equal(r.notification.body, "Build finished");
  assert.deepEqual(sent.map((s) => s.endpoint), [phone.endpoint]);
  const human = await run("notify", "hello");
  assert.match(human.stderr, /delivered to 2 of 2 devices/);
  await assert.rejects(run("notify", "x", "--device", "nope"), (e: { stderr: string }) => /no device "nope"/.test(e.stderr));
});
