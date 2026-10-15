// Read-only file access: project scoping, previews, signed download
// links and their streaming, locally and through a peer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(project, "b.md"), "# Notes\n");
  writeFileSync(join(project, "sub", "zażółć plik.txt"), "zażółć\n");
  writeFileSync(join(project, "pixel.png"), Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  writeFileSync(join(project, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(project, "big.txt"), "ą".repeat(MAX_READ_BYTES));
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
  symlinkSync(join(outside, "secret.txt"), join(project, "escape.txt"));
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

test("paths outside project folders are refused, including through .. and symlinks", async () => {
  await refused(alpha.client.call("fs.read", { path: "/etc/passwd" }), ErrorCode.InvalidParams, /not inside a project folder/);
  await refused(alpha.client.call("fs.read", { path: `${project}/../outside/secret.txt` }), ErrorCode.InvalidParams, /not inside a project folder/);
  await refused(alpha.client.call("fs.read", { path: "data.json" }), ErrorCode.InvalidParams, /must be absolute/);
  await refused(alpha.client.call("fs.read", { path: join(project, "escape.txt") }), ErrorCode.InvalidParams, /outside every project folder/);
  await refused(alpha.client.call("fs.downloadLink", { path: join(project, "escape.txt") }), ErrorCode.InvalidParams, /outside/);
  await refused(alpha.client.call("fs.read", { path: join(project, "missing.txt") }), ErrorCode.NotFound, /no such file/);
  // A symlink to a file inside the project is fine.
  assert.equal((await alpha.client.call("fs.read", { path: join(project, "alias.json") })).content, json);
});

test("the server's state directory is refused even inside a project", async () => {
  const p = await alpha.client.call("project.create", { path: alpha.home, name: "state" });
  try {
    for (const name of ["casm.db", "download-secret"]) {
      await refused(alpha.client.call("fs.read", { path: join(alpha.home, name) }), ErrorCode.InvalidParams, /casm's state directory/);
      await refused(alpha.client.call("fs.downloadLink", { path: join(alpha.home, name) }), ErrorCode.InvalidParams, /casm's state directory/);
    }
  } finally {
    await alpha.client.call("project.delete", { id: p.id });
  }
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
  assert.match(link.url, /^\/dl\/[\w-]+\.[\w-]+\/za%C5%BC%C3%B3%C5%82%C4%87%20plik\.txt$/);
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
  const [token, nameSegment] = link.url.slice(4).split("/");
  const [body, mac] = token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  const forged = Buffer.from(JSON.stringify({ ...payload, p: join(outside, "secret.txt") })).toString("base64url");
  // The name in the path must be the signed one; the bare token still works.
  assert.equal((await fetch(`${alpha.http}/dl/${body}.${mac}`)).status, 200);
  assert.equal((await fetch(`${alpha.http}/dl/${body}.${mac}/${nameSegment}`)).status, 200);
  for (const name of ["other.json", "data.jso", "%E0%A4%A", "data.json/x"]) {
    const res = await fetch(`${alpha.http}/dl/${body}.${mac}/${name}`);
    assert.equal(res.status, 403, name);
  }
  for (const url of [`/dl/${forged}.${mac}`, `/dl/${body}.${mac.slice(0, -2)}AA`, `/dl/${body}`, "/dl/", `/dl/${body}.${mac}.x/${nameSegment}`]) {
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

test("a peer's files: reads forward, downloads stream through this server", async () => {
  const viaPeer = await CasmClient.connect(alpha.url, alpha.token, { host: "beta" });
  try {
    const read = await viaPeer.call("fs.read", { path: join(project, "data.json") });
    assert.equal(read.content, json);
    assert.notEqual(read.projectId, projectId);
    await refused(viaPeer.call("fs.read", { path: "/etc/passwd" }), ErrorCode.InvalidParams, /not inside a project folder/);

    const link = await viaPeer.call("fs.downloadLink", { path: join(project, "pixel.png"), inline: true });
    assert.equal(link.name, "pixel.png");
    const payload = JSON.parse(Buffer.from(link.url.slice(4).split(".")[0], "base64url").toString());
    assert.equal(payload.h, "beta");
    assert.ok(link.url.endsWith("/pixel.png"));
    // Served by alpha, the server the client is connected to.
    const res = await fetch(alpha.http + link.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("content-disposition")!, /^inline; filename="pixel.png"/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(join(project, "pixel.png")));
    // An attachment keeps its name through the relay, in the header and in the path.
    const dl = await viaPeer.call("fs.downloadLink", { path: join(project, "data.json") });
    assert.ok(dl.url.endsWith("/data.json"));
    const attached = await fetch(alpha.http + dl.url);
    assert.equal(attached.headers.get("content-disposition"), contentDisposition("attachment", "data.json"));
    assert.equal(await attached.text(), json);
    assert.equal((await fetch(alpha.http + dl.url.replace(/[^/]*$/, "evil.json"))).status, 403);
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

test("casm cat and casm get, here and on a peer", async () => {
  const cli = join(import.meta.dirname, "../../cli/src/main.ts");
  const cwd = mkdtempSync(join(tmpdir(), "casm-files-cli-"));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CASM_")));
  const casm = (...args: string[]) =>
    promisify(execFile)(process.execPath, [cli, ...args], { cwd, encoding: "buffer", maxBuffer: 8 * MAX_READ_BYTES,
      env: { ...clean, CASM_HOME: cwd, CASM_URL: alpha.url, CASM_TOKEN: alpha.token } });
  assert.equal(String((await casm("cat", join(project, "data.json"))).stdout), json);
  // Past the preview cap, cat streams the whole file.
  assert.equal((await casm("cat", join(project, "big.txt"))).stdout.length, 2 * MAX_READ_BYTES);
  await assert.rejects(casm("cat", join(project, "blob.bin")), /binary file \(application\/octet-stream, 4 bytes\); "casm get"/);
  assert.deepEqual((await casm("cat", "--force", join(project, "blob.bin"))).stdout, Buffer.from([1, 2, 0, 3]));
  await assert.rejects(casm("cat", join(project, "escape.txt")), /outside every project folder/);

  const saved = await casm("get", join(project, "sub", "zażółć plik.txt"));
  assert.match(String(saved.stderr), /saved .*zażółć plik.txt \(11 bytes\)/);
  assert.equal(readFileSync(join(cwd, "zażółć plik.txt"), "utf8"), "zażółć\n");
  await assert.rejects(casm("get", join(project, "sub", "zażółć plik.txt")), /exists; choose another -o or add --force/);
  await casm("-H", "beta", "get", join(project, "pixel.png"), "-o", "peer.png");
  assert.deepEqual(readFileSync(join(cwd, "peer.png")), readFileSync(join(project, "pixel.png")));
  assert.deepEqual((await casm("get", join(project, "blob.bin"), "-o", "-")).stdout, Buffer.from([1, 2, 0, 3]));
  assert.ok(!readdirSync(cwd).some((f) => f.endsWith(".part")));
  assert.ok(!existsSync(join(cwd, "blob.bin")));
});
