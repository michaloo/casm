// File attachments: chunked uploads saved in the root of the agent's project
// folder, the line the message gains, name clashes, unsafe names, the size
// limit, queued messages, a peer, and the CLI's --file.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasmClient, CasmError } from "@casm/client";
import { ErrorCode, MAX_ATTACHMENT_BYTES, splitAttachments, type Item } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { CHUNK_BYTES, numberedName, safeName } from "../src/attachments.ts";
import type { Provider } from "../src/providers/types.ts";

// What each agent's provider received, and turns held open until released.
const received = new Map<string, string[]>();
let hold: Promise<void> | null = null;
const provider: Provider = {
  id: "claude",
  open(opts) {
    setImmediate(() => opts.emit({ type: "sessionId", id: `s-${opts.cwd}-${Math.random()}` }));
    return {
      send(text) {
        received.set(opts.cwd, [...(received.get(opts.cwd) ?? []), text]);
        const wait = hold ?? Promise.resolve();
        void wait.then(() => setTimeout(() => opts.emit({ type: "turnEnded", outcome: "completed" }), 5));
      },
      shell() {}, async interrupt() {}, async close() {},
    };
  },
  async history(): Promise<Item[]> { return []; },
  async catalog() { return { models: [], modes: [] }; },
  async usage() { return null; },
  async commands() { return []; },
};

type Host = { store: Store; server: RunningServer; client: CasmClient; token: string; url: string; home: string; project: string; projectId: string };

async function host(name: string): Promise<Host> {
  const home = mkdtempSync(join(tmpdir(), `casm-attach-${name}-`));
  const project = mkdtempSync(join(tmpdir(), `casm-attach-${name}-project-`));
  const store = new Store(join(home, "casm.db"));
  const token = store.createToken("test");
  const server = await startServer({ store, providers: [provider], host: "127.0.0.1", port: 0, version: "test", name, home });
  const url = `ws://127.0.0.1:${server.port}`;
  const client = await CasmClient.connect(url, token);
  const projectId = (await client.call("project.create", { path: project, name: `${name}-proj` })).id;
  return { store, server, client, token, url, home, project, projectId };
}

let alpha: Host;
let beta: Host;

before(async () => {
  alpha = await host("alpha");
  beta = await host("beta");
  alpha.store.setPeer({ name: "beta", url: beta.url, token: beta.token, serverId: beta.store.serverId() });
});

after(async () => {
  for (const h of [alpha, beta]) {
    h.client.close();
    await h.server.close();
    h.store.close();
    rmSync(h.home, { recursive: true, force: true });
    rmSync(h.project, { recursive: true, force: true });
  }
});

// Uploads `content` in chunks of `chunk` bytes, as clients do.
async function upload(c: CasmClient, name: string, content: Buffer, opts: { mediaType?: string; chunk?: number } = {}) {
  const { uploadId, chunkSize } = await c.call("upload.start", { name, size: content.length, mediaType: opts.mediaType });
  const step = opts.chunk ?? chunkSize;
  for (let offset = 0; offset < content.length; offset += step)
    await c.call("upload.chunk", { uploadId, offset, data: content.subarray(offset, offset + step).toString("base64") });
  return uploadId;
}

const agentIn = async (h: Host, cwd?: string) =>
  (await h.client.call("agent.create", { projectId: h.projectId, provider: "claude", ...(cwd ? { cwd } : {}) })).id;

async function lastText(h: Host, cwd: string) {
  return (received.get(cwd) ?? []).at(-1) ?? "";
}

test("names are made safe: no folders, no hidden files, no control characters", () => {
  assert.equal(safeName("report.pdf"), "report.pdf");
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("C:\\Users\\me\\data.csv"), "data.csv");
  assert.equal(safeName(".env"), "env");
  assert.equal(safeName("..."), "attachment");
  assert.equal(safeName("a/.."), "attachment");
  assert.equal(safeName("bad\nname\t.txt"), "badname.txt");
  assert.equal(safeName("  spaced.txt. "), "spaced.txt");
  const long = safeName(`${"x".repeat(300)}.xlsx`);
  assert.ok(Buffer.byteLength(long) <= 200);
  assert.ok(long.endsWith(".xlsx"));
  assert.ok(Buffer.byteLength(safeName("ż".repeat(150))) <= 200);
  assert.equal(numberedName("report.pdf", 0), "report.pdf");
  assert.equal(numberedName("report.pdf", 2), "report (2).pdf");
  assert.equal(numberedName("archive.tar.gz", 1), "archive.tar (1).gz");
  assert.equal(numberedName("Makefile", 1), "Makefile (1)");
});

test("an attached file is saved in the project root and the agent gets a line saying where", async () => {
  const sub = join(alpha.project, "sub");
  mkdirSync(sub);
  const id = await agentIn(alpha, "sub");
  const csv = Buffer.from("name,qty\napple,3\n");
  // Small chunks: the file is put together in order.
  const uploadId = await upload(alpha.client, "data.csv", csv, { chunk: 5 });
  await alpha.client.call("agent.send", { id, text: "Sum the qty column", attachments: [uploadId] });
  await alpha.client.call("agent.wait", { id });
  // The project root, not the agent's cwd.
  const saved = join(alpha.project, "data.csv");
  assert.deepEqual(readFileSync(saved), csv);
  assert.ok(!readdirSync(sub).length);
  const text = await lastText(alpha, sub);
  assert.equal(text, `Sum the qty column\n\nAttached file: data.csv (text/csv, 17 B) saved at ${saved}`);
  assert.deepEqual(splitAttachments(text), {
    text: "Sum the qty column",
    attachments: [{ name: "data.csv", mediaType: "text/csv", size: "17 B", path: saved }],
  });
  // The staging copy is gone.
  assert.deepEqual(readdirSync(join(alpha.home, "uploads")), []);
});

test("a taken name gets (1), (2)...; nothing is overwritten; unsafe names land in the root", async () => {
  const id = await agentIn(alpha);
  writeFileSync(join(alpha.project, "report.pdf"), "original");
  const a = await upload(alpha.client, "report.pdf", Buffer.from("%PDF-one"));
  const b = await upload(alpha.client, "report.pdf", Buffer.from("%PDF-two"));
  const evil = await upload(alpha.client, "../../.bashrc", Buffer.from("echo hi"));
  await alpha.client.call("agent.send", { id, text: "", attachments: [a, b, evil] });
  await alpha.client.call("agent.wait", { id });
  assert.equal(readFileSync(join(alpha.project, "report.pdf"), "utf8"), "original");
  assert.equal(readFileSync(join(alpha.project, "report (1).pdf"), "utf8"), "%PDF-one");
  assert.equal(readFileSync(join(alpha.project, "report (2).pdf"), "utf8"), "%PDF-two");
  assert.equal(readFileSync(join(alpha.project, "bashrc"), "utf8"), "echo hi");
  const { text, attachments } = splitAttachments(await lastText(alpha, alpha.project));
  assert.equal(text, "");
  assert.deepEqual(attachments.map((x) => [x.name, x.mediaType, x.path]), [
    ["report.pdf", "application/pdf", join(alpha.project, "report (1).pdf")],
    ["report.pdf", "application/pdf", join(alpha.project, "report (2).pdf")],
    ["bashrc", "application/octet-stream", join(alpha.project, "bashrc")],
  ]);
});

test("the same message sent again does not save its files twice", async () => {
  const id = await agentIn(alpha);
  const u = await upload(alpha.client, "once.log", Buffer.from("line\n"), { mediaType: "text/plain" });
  const messageId = crypto.randomUUID();
  await alpha.client.call("agent.send", { id, text: "look", messageId, attachments: [u] });
  await alpha.client.call("agent.send", { id, text: "look", messageId, attachments: [u] });
  await alpha.client.call("agent.wait", { id });
  assert.deepEqual(readdirSync(alpha.project).filter((n) => n.startsWith("once")), ["once.log"]);
  assert.equal(received.get(alpha.project)?.filter((t) => t.startsWith("look")).length, 1);
  // A finished upload can't take more data.
  await assert.rejects(alpha.client.call("upload.chunk", { uploadId: u, offset: 5, data: "eA==" }), (e: CasmError) => e.code === ErrorCode.Conflict);
});

test("a queued message saves its file when accepted and keeps the line until it is sent", async () => {
  const sub = join(alpha.project, "queued");
  mkdirSync(sub);
  const id = await agentIn(alpha, "queued");
  let release!: () => void;
  hold = new Promise((r) => (release = r));
  try {
    await alpha.client.call("agent.send", { id, text: "first" });
    const u = await upload(alpha.client, "later.zip", Buffer.from("PK\x03\x04"));
    const r = await alpha.client.call("agent.send", { id, text: "second", attachments: [u] });
    assert.equal(r.queued, true);
    // Saved already, while it waits.
    assert.equal(readFileSync(join(alpha.project, "later.zip"), "latin1"), "PK\x03\x04");
    const [pending] = (await alpha.client.call("agent.pending", { id })).messages;
    assert.match(pending.text, /^second\n\nAttached file: later\.zip \(application\/zip, 4 B\) saved at /);
  } finally {
    hold = null;
    release();
  }
  await alpha.client.call("agent.wait", { id });
  await alpha.client.call("agent.wait", { id });
  assert.match(await lastText(alpha, sub), /^second\n\nAttached file: later\.zip/);
});

test("refused: over 50 MB, unfinished, unknown, out of order, or to an archived agent", async () => {
  const id = await agentIn(alpha);
  await assert.rejects(
    alpha.client.call("upload.start", { name: "huge.bin", size: MAX_ATTACHMENT_BYTES + 1 }),
    (e: CasmError) => e.code === ErrorCode.InvalidParams && /huge\.bin is 50\.0 MB, over the 50 MB limit for a file attachment/.test(e.message),
  );
  const { uploadId } = await alpha.client.call("upload.start", { name: "half.txt", size: 10 });
  await alpha.client.call("upload.chunk", { uploadId, offset: 0, data: Buffer.from("12345").toString("base64") });
  // The same chunk again (a lost response) is fine; a gap is not.
  await alpha.client.call("upload.chunk", { uploadId, offset: 0, data: Buffer.from("12345").toString("base64") });
  await assert.rejects(alpha.client.call("upload.chunk", { uploadId, offset: 7, data: "eA==" }), (e: CasmError) => e.code === ErrorCode.Conflict);
  await assert.rejects(alpha.client.call("upload.chunk", { uploadId, offset: 5, data: Buffer.from("123456").toString("base64") }), /longer than the 10 bytes/);
  await assert.rejects(alpha.client.call("upload.chunk", { uploadId, offset: 5, data: Buffer.alloc(CHUNK_BYTES + 3).toString("base64") }), /at most/);
  await assert.rejects(alpha.client.call("agent.send", { id, text: "x", attachments: [uploadId] }), /not fully uploaded \(5 of 10 bytes\)/);
  await assert.rejects(alpha.client.call("agent.send", { id, text: "x", attachments: ["nope"] }), (e: CasmError) => e.code === ErrorCode.NotFound);
  // Nothing was sent or saved.
  assert.ok(!readdirSync(alpha.project).includes("half.txt"));
  // An agent.create with a broken upload creates no agent.
  const before = (await alpha.client.call("agent.list", {})).agents.length;
  await assert.rejects(alpha.client.call("agent.create", { projectId: alpha.projectId, provider: "claude", prompt: "x", attachments: [uploadId] }), /not fully uploaded/);
  assert.equal((await alpha.client.call("agent.list", {})).agents.length, before);
  const done = await upload(alpha.client, "kept.txt", Buffer.from("k"));
  await alpha.client.call("agent.update", { id, archived: true });
  await assert.rejects(alpha.client.call("agent.send", { id, text: "x", attachments: [done] }), /archived/);
  assert.ok(!readdirSync(alpha.project).includes("kept.txt"));
});

test("through a peer: the file travels to the peer and is saved in its project", async () => {
  const viaAlpha = await CasmClient.connect(alpha.url, alpha.token, { host: "beta" });
  try {
    const content = Buffer.from("%PDF-1.4 remote");
    const u = await upload(viaAlpha, "remote.pdf", content);
    const created = await viaAlpha.call("agent.create", { projectId: beta.projectId, provider: "claude", prompt: "Read it", attachments: [u] });
    await viaAlpha.call("agent.wait", { id: created.id });
    assert.deepEqual(readFileSync(join(beta.project, "remote.pdf")), content);
    assert.ok(!readdirSync(alpha.project).includes("remote.pdf"));
    assert.equal(await lastText(beta, beta.project), `Read it\n\nAttached file: remote.pdf (application/pdf, 15 B) saved at ${join(beta.project, "remote.pdf")}`);
  } finally {
    viaAlpha.close();
  }
});

const cliPath = join(import.meta.dirname, "../../cli/src/main.ts");
async function cli(...args: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [cliPath, ...args], {
      env: { ...process.env, CASM_URL: alpha.url, CASM_TOKEN: alpha.token, CASM_HOME: alpha.home, CASM_HOST: "", CASM_AGENT_ID: "", CASM_SERVER_ID: "" },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, stdout: x.stdout, stderr: x.stderr };
  }
}

test("CLI: send --file and run --file, locally and with -H through a peer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-attach-cli-"));
  try {
    const big = Buffer.alloc(CHUNK_BYTES + 1000, 7);
    writeFileSync(join(dir, "big.bin"), big);
    writeFileSync(join(dir, "notes.csv"), "a,b\n1,2\n");
    const id = await agentIn(alpha);
    const sent = await cli("send", id, "two files", "--file", join(dir, "big.bin"), "--file", join(dir, "notes.csv"), "--wait");
    assert.equal(sent.code, 0, sent.stderr);
    assert.deepEqual(readFileSync(join(alpha.project, "big.bin")), big);
    assert.equal(readFileSync(join(alpha.project, "notes.csv"), "utf8"), "a,b\n1,2\n");
    assert.deepEqual(splitAttachments(await lastText(alpha, alpha.project)).attachments.map((a) => a.name), ["big.bin", "notes.csv"]);

    // Files alone are a message.
    const run = await cli("-H", "beta", "run", "--project", "beta-proj", "--file", join(dir, "notes.csv"), "--wait");
    assert.equal(run.code, 0, run.stderr);
    assert.equal(readFileSync(join(beta.project, "notes.csv"), "utf8"), "a,b\n1,2\n");
    assert.equal(await lastText(beta, beta.project), `Attached file: notes.csv (text/csv, 8 B) saved at ${join(beta.project, "notes.csv")}`);

    const missing = await cli("send", id, "x", "--file", join(dir, "nope.pdf"));
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /--file .*nope\.pdf: no such file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
