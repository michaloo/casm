// Read-only file access: project scoping, listings, previews, signed download
// links and their streaming, locally and through a peer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient, CasmError } from "@casm/client";
import { ErrorCode } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { Files, MAX_READ_BYTES, contentDisposition } from "../src/files.ts";
import { PeerPool } from "../src/peers.ts";

type Host = { store: Store; server: RunningServer; client: CasmClient; token: string; url: string; http: string; home: string };

async function host(name: string): Promise<Host> {
  const home = mkdtempSync(join(tmpdir(), `casm-files-${name}-`));
  const store = new Store(join(home, "casm.db"));
  const token = store.createToken("test");
  const server = await startServer({ store, providers: [], host: "127.0.0.1", port: 0, version: "test", name, home });
  const url = `ws://127.0.0.1:${server.port}`;
  return { store, server, token, url, http: `http://127.0.0.1:${server.port}`, home, client: await CasmClient.connect(url, token) };
}

const root = mkdtempSync(join(tmpdir(), "casm-files-"));
const project = join(root, "project");
const outside = join(root, "outside");
const json = '{"merged":[1,2,3]}\n';
let alpha: Host;
let beta: Host;
let projectId: string;

before(async () => {
  mkdirSync(join(project, "sub", "deeper"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(project, "data.json"), json);
  writeFileSync(join(project, ".env"), "SECRET=1\n");
  writeFileSync(join(project, "b.md"), "# Notes\n");
  writeFileSync(join(project, "sub", "zażółć plik.txt"), "zażółć\n");
  writeFileSync(join(project, "pixel.png"), Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  writeFileSync(join(project, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(project, "big.txt"), "ą".repeat(MAX_READ_BYTES));
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
  symlinkSync(join(outside, "secret.txt"), join(project, "escape.txt"));
  symlinkSync(outside, join(project, "escape-dir"));
  symlinkSync(join(project, "data.json"), join(project, "alias.json"));
  alpha = await host("alpha");
  beta = await host("beta");
  projectId = (await alpha.client.call("project.create", { path: project, name: "proj" })).id;
  await beta.client.call("project.create", { path: project, name: "beta-proj" });
  alpha.store.setPeer({ name: "beta", url: beta.url, token: beta.token, serverId: beta.store.serverId() });
});

after(async () => {
  for (const h of [alpha, beta]) {
    h.client.close();
    await h.server.close();
    h.store.close();
  }
});

async function refused(p: Promise<unknown>, code: number, message: RegExp) {
  await assert.rejects(p, (e: CasmError) => {
    assert.equal(e.code, code);
    assert.match(e.message, message);
    return true;
  });
}

test("fs.list: directories first, hidden files marked, symlinks flagged", async () => {
  const r = await alpha.client.call("fs.list", { projectId });
  assert.equal(r.dir, project);
  assert.equal(r.root, project);
  assert.equal(r.projectId, projectId);
  const names = r.entries.map((e) => e.name);
  assert.deepEqual(names.slice(0, 2), ["escape-dir", "sub"]);
  assert.deepEqual(names.slice(2), [...names.slice(2)].sort((a, b) => a.localeCompare(b)));
  const env = r.entries.find((e) => e.name === ".env")!;
  assert.equal(env.hidden, true);
  assert.equal(env.type, "file");
  assert.equal(env.size, 9);
  assert.ok(Date.parse(env.mtime));
  assert.equal(r.entries.find((e) => e.name === "alias.json")!.symlink, true);
  assert.equal(r.entries.find((e) => e.name === "data.json")!.hidden, false);

  const sub = await alpha.client.call("fs.list", { projectId, dir: "sub" });
  assert.deepEqual(sub.entries.map((e) => [e.name, e.type]), [["deeper", "dir"], ["zażółć plik.txt", "file"]]);
  const abs = await alpha.client.call("fs.list", { path: join(project, "sub") });
  assert.deepEqual(abs.entries, sub.entries);
});

test("paths outside project folders are refused, including through .. and symlinks", async () => {
  await refused(alpha.client.call("fs.read", { path: "/etc/passwd" }), ErrorCode.InvalidParams, /not inside a project folder/);
  await refused(alpha.client.call("fs.read", { path: `${project}/../outside/secret.txt` }), ErrorCode.InvalidParams, /not inside a project folder/);
  await refused(alpha.client.call("fs.read", { path: "data.json" }), ErrorCode.InvalidParams, /must be absolute/);
  await refused(alpha.client.call("fs.read", { path: join(project, "escape.txt") }), ErrorCode.InvalidParams, /outside every project folder/);
  await refused(alpha.client.call("fs.list", { projectId, dir: "escape-dir" }), ErrorCode.InvalidParams, /outside every project folder/);
  await refused(alpha.client.call("fs.list", { projectId, dir: "../outside" }), ErrorCode.InvalidParams, /not inside a project folder/);
  await refused(alpha.client.call("fs.downloadLink", { path: join(project, "escape.txt") }), ErrorCode.InvalidParams, /outside/);
  await refused(alpha.client.call("fs.read", { path: join(project, "missing.txt") }), ErrorCode.NotFound, /no such file/);
  await refused(alpha.client.call("fs.list", { projectId: "nope" }), ErrorCode.NotFound, /project nope not found/);
  await refused(alpha.client.call("fs.list", { projectId, dir: "data.json" }), ErrorCode.InvalidParams, /not a directory/);
  // A symlink to a file inside the project is fine.
  assert.equal((await alpha.client.call("fs.read", { path: join(project, "alias.json") })).content, json);
});

test("fs.read: text, mime, truncation, binary and directories", async () => {
  const r = await alpha.client.call("fs.read", { path: join(project, "data.json") });
  assert.equal(r.content, json);
  assert.equal(r.mime, "application/json");
  assert.equal(r.binary, false);
  assert.equal(r.truncated, false);
  assert.equal(r.size, json.length);
  assert.equal(r.type, "file");

  const big = await alpha.client.call("fs.read", { path: join(project, "big.txt") });
  assert.equal(big.truncated, true);
  assert.equal(big.size, MAX_READ_BYTES * 2);
  // Cut inside a two-byte character: the half is dropped, not reported as binary.
  const odd = await alpha.client.call("fs.read", { path: join(project, "big.txt"), maxBytes: 5 });
  assert.deepEqual([odd.content, odd.truncated, odd.binary], ["ąą", true, false]);
  const capped = await alpha.client.call("fs.read", { path: join(project, "big.txt"), maxBytes: 10 * MAX_READ_BYTES });
  assert.equal(capped.content!.length, MAX_READ_BYTES / 2);

  const bin = await alpha.client.call("fs.read", { path: join(project, "blob.bin") });
  assert.deepEqual([bin.binary, bin.content, bin.mime], [true, null, "application/octet-stream"]);
  const png = await alpha.client.call("fs.read", { path: join(project, "pixel.png") });
  assert.deepEqual([png.binary, png.content, png.mime], [true, null, "image/png"]);
  const dir = await alpha.client.call("fs.read", { path: join(project, "sub") });
  assert.deepEqual([dir.type, dir.content, dir.binary], ["dir", null, false]);
});

test("download links stream the file as an attachment with safe headers", async () => {
  const link = await alpha.client.call("fs.downloadLink", { path: join(project, "sub", "zażółć plik.txt") });
  assert.match(link.url, /^\/dl\/[\w-]+\.[\w-]+$/);
  assert.equal(link.name, "zażółć plik.txt");
  assert.ok(Date.parse(link.expiresAt) > Date.now() + 4 * 60_000);
  assert.ok(!link.url.includes(alpha.token));
  const res = await fetch(alpha.http + link.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("content-disposition"), contentDisposition("attachment", "zażółć plik.txt"));
  assert.match(res.headers.get("content-disposition")!, /^attachment; filename="za____ plik.txt"; filename\*=UTF-8''za%C5%BC%C3%B3%C5%82%C4%87%20plik.txt$/);
  assert.equal(res.headers.get("content-length"), String(statSync(join(project, "sub", "zażółć plik.txt")).size));
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy")!, /sandbox/);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(await res.text(), "zażółć\n");

  const head = await fetch(alpha.http + link.url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(alpha.http + link.url, { method: "POST" })).status, 405);
});

test("inline links show images only; other files stay attachments", async () => {
  const png = await alpha.client.call("fs.downloadLink", { path: join(project, "pixel.png"), inline: true });
  const res = await fetch(alpha.http + png.url);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.match(res.headers.get("content-disposition")!, /^inline; /);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(join(project, "pixel.png")));
  const md = await alpha.client.call("fs.downloadLink", { path: join(project, "b.md"), inline: true });
  assert.match((await fetch(alpha.http + md.url)).headers.get("content-disposition")!, /^attachment; /);
  await refused(alpha.client.call("fs.downloadLink", { path: join(project, "sub") }), ErrorCode.InvalidParams, /not a file/);
});

test("tampered and foreign links are refused", async () => {
  const link = await alpha.client.call("fs.downloadLink", { path: join(project, "data.json") });
  const [body, mac] = link.url.slice(4).split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  const forged = Buffer.from(JSON.stringify({ ...payload, p: join(outside, "secret.txt") })).toString("base64url");
  for (const url of [`/dl/${forged}.${mac}`, `/dl/${body}.${mac.slice(0, -2)}AA`, `/dl/${body}`, "/dl/", `/dl/${body}.${mac}.x`]) {
    const res = await fetch(alpha.http + url);
    assert.equal(res.status, 403, url);
    assert.match(await res.text(), /invalid download link/);
  }
  // Another server's links mean nothing here (each has its own secret).
  const theirs = await beta.client.call("fs.downloadLink", { path: join(project, "data.json") });
  assert.equal((await fetch(alpha.http + theirs.url)).status, 403);
  // The secret persists in the state directory, private to this user.
  assert.equal(statSync(join(alpha.home, "download-secret")).mode & 0o777, 0o600);
});

test("links expire, and stop working when the file leaves every project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-files-expiry-"));
  const store = new Store(join(dir, "casm.db"));
  const p = store.createProject({ name: "p", path: project });
  let now = 1_000_000;
  const files = new Files({ store, peers: new PeerPool(store), ttlMs: 5 * 60_000, now: () => now });
  const http = createServer((req, res) => void files.serve(req, res, () => {}));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  try {
    const link = await files.link({ path: join(project, "data.json") });
    assert.equal(link.expiresAt, new Date(now + 5 * 60_000).toISOString());
    assert.equal((await fetch(base + link.url)).status, 200);
    now += 5 * 60_000 + 1;
    const late = await fetch(base + link.url);
    assert.equal(late.status, 403);
    assert.match(await late.text(), /expired/);
    now -= 5 * 60_000;
    store.deleteProject(p.id);
    const gone = await fetch(base + link.url);
    assert.equal(gone.status, 403);
    assert.match(await gone.text(), /not inside a project folder/);
  } finally {
    http.close();
    store.close();
  }
});

test("a peer's files: list and read forward, downloads stream through this server", async () => {
  const listed = await alpha.client.call("fs.list", { path: project, dir: undefined });
  const viaPeer = await CasmClient.connect(alpha.url, alpha.token, { host: "beta" });
  try {
    const r = await viaPeer.call("fs.list", { path: project });
    assert.deepEqual(r.entries.map((e) => e.name), listed.entries.map((e) => e.name));
    assert.notEqual(r.projectId, projectId);
    assert.equal((await viaPeer.call("fs.read", { path: join(project, "data.json") })).content, json);
    await refused(viaPeer.call("fs.read", { path: "/etc/passwd" }), ErrorCode.InvalidParams, /not inside a project folder/);

    const link = await viaPeer.call("fs.downloadLink", { path: join(project, "pixel.png"), inline: true });
    assert.equal(link.name, "pixel.png");
    const payload = JSON.parse(Buffer.from(link.url.slice(4).split(".")[0], "base64url").toString());
    assert.equal(payload.h, "beta");
    // Served by alpha, the server the client is connected to.
    const res = await fetch(alpha.http + link.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("content-disposition")!, /^inline; filename="pixel.png"/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(join(project, "pixel.png")));
    // Beta itself would not take alpha's wrapper.
    assert.equal((await fetch(beta.http + link.url)).status, 403);
    await refused(viaPeer.call("fs.downloadLink", { path: join(project, "escape.txt") }), ErrorCode.InvalidParams, /outside/);
  } finally {
    viaPeer.close();
  }
  const unknown = await CasmClient.connect(alpha.url, alpha.token, { host: "gamma" });
  try {
    await refused(unknown.call("fs.downloadLink", { path: join(project, "data.json") }), ErrorCode.NotFound, /unknown host "gamma"/);
  } finally {
    unknown.close();
  }
});

test("a peer link whose peer is gone answers 502", async () => {
  const viaPeer = await CasmClient.connect(alpha.url, alpha.token, { host: "beta" });
  const link = await viaPeer.call("fs.downloadLink", { path: join(project, "data.json") });
  viaPeer.close();
  alpha.store.setPeer({ name: "beta", url: "ws://127.0.0.1:1", token: beta.token, serverId: beta.store.serverId() });
  try {
    const res = await fetch(alpha.http + link.url);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /host "beta" is unreachable/);
  } finally {
    alpha.store.setPeer({ name: "beta", url: beta.url, token: beta.token, serverId: beta.store.serverId() });
  }
});

test("/f/ preview routes serve the web client", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-files-web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>casm</title>");
  const store = new Store(join(dir, "casm.db"));
  const server = await startServer({ store, providers: [], host: "127.0.0.1", port: 0, version: "test", webRoot: dir });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/f${project}/data.json`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>casm/);
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/missing.js`)).status, 426);
  } finally {
    await server.close();
    store.close();
  }
});
