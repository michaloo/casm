// The browser.* namespace: agent calls routed to a browser extension client,
// here a fake one on a plain WebSocket, through the CLI and through a peer.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { CasmClient, CasmError } from "@casm/client";
import { ErrorCode, type BrowserCommand, type SharedTab } from "@casm/protocol";
import { Store } from "../src/db.ts";
import { startServer, type RunningServer } from "../src/server.ts";

type Host = { dir: string; store: Store; server: RunningServer; token: string; url: string; client: CasmClient };

async function host(name: string): Promise<Host> {
  const dir = mkdtempSync(join(tmpdir(), `casm-browser-${name}-`));
  const store = new Store(join(dir, "casm.db"));
  const token = store.createToken("test");
  const server = await startServer({ store, providers: [], host: "127.0.0.1", port: 0, version: "test", name, browserTimeoutMs: 1500 });
  const url = `ws://127.0.0.1:${server.port}`;
  return { dir, store, server, token, url, client: await CasmClient.connect(url, token) };
}

// What the extension does: connect, share tabs, answer browser.command.
// `answer` decides each command's result; returning undefined leaves it unanswered.
class FakeExtension {
  commands: BrowserCommand[] = [];
  answer: (cmd: BrowserCommand) => unknown = () => ({});
  private ws: WebSocket;
  private nextId = 1;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method !== "browser.command") return;
      this.commands.push(msg.params);
      let result: unknown;
      try {
        result = this.answer(msg.params);
      } catch (e) {
        return ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: ErrorCode.NotFound, message: (e as Error).message } }));
      }
      if (result !== undefined) ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  }
  // Like a browser: no header, `auth` first.
  static async connect(url: string, token: string) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
    const ext = new FakeExtension(ws);
    await ext.call("auth", { token });
    return ext;
  }
  call(method: string, params: unknown) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onMessage = (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.id !== id) return;
        this.ws.off("message", onMessage);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      };
      this.ws.on("message", onMessage);
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  share(tabs: SharedTab[]) {
    return this.call("browser.share", { browserId: "install-1", label: "chrome-test", tabs });
  }
  close() {
    this.ws.close();
  }
}

const tab = (tabId: number, sharedAt: string, url = `https://example.com/${tabId}`): SharedTab => ({ tabId, title: `Tab ${tabId}`, url, sharedAt });

const cliPath = join(import.meta.dirname, "../../cli/src/main.ts");
async function cli(h: Host, ...args: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [cliPath, ...args], { env: { ...process.env, CASM_URL: h.url, CASM_TOKEN: h.token, CASM_HOST: "" } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

const rejects = (p: Promise<unknown>, code: number, message: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof CasmError && e.code === code && message.test(e.message));

let alpha: Host;
let beta: Host;

before(async () => {
  alpha = await host("alpha");
  beta = await host("beta");
  alpha.store.setPeer({ name: "beta", url: beta.url, token: beta.store.createToken("alpha"), serverId: null });
});

after(async () => {
  for (const h of [alpha, beta]) {
    h.client.close();
    await h.server.close();
    h.store.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("without a connected browser, calls fail at once", async () => {
  assert.deepEqual(await alpha.client.call("browser.tabs", {}), { tabs: [], browsers: [] });
  await rejects(alpha.client.call("browser.snapshot", {}), ErrorCode.Unreachable, /no browser is connected/);
  const r = await cli(alpha, "browser", "snapshot");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no browser is connected/);
});

test("calls go to the shared tab named, else the last shared; unsharing stops them", async () => {
  const ext = await FakeExtension.connect(alpha.url, alpha.token);
  try {
    await ext.share([]);
    await rejects(alpha.client.call("browser.snapshot", {}), ErrorCode.NotFound, /no tab is shared/);

    await ext.share([tab(101, "2026-11-10T10:00:00Z"), tab(102, "2026-11-10T10:05:00Z")]);
    const { tabs, browsers } = await alpha.client.call("browser.tabs", {});
    assert.deepEqual(browsers.map((b) => b.name), ["chrome-test"]);
    assert.deepEqual(tabs.map((t) => t.url), ["https://example.com/101", "https://example.com/102"]);
    const [first, second] = tabs;

    ext.answer = (cmd) => (cmd.action === "snapshot" ? { text: `- button "Go" [e1] in ${cmd.tabId}`, title: "Now", url: "https://example.com/now" } : {});
    const snap = await cli(alpha, "browser", "snapshot");
    assert.equal(snap.code, 0, snap.stderr);
    assert.match(snap.stdout, /^tab 2 +Now  https:\/\/example.com\/now\n- button "Go" \[e1\] in 102\n$/);

    assert.equal((await cli(alpha, "browser", "click", "e1", "--tab", first.id)).code, 0);
    assert.equal((await cli(alpha, "browser", "type", "e2", "hello", "world", "--submit")).code, 0);
    assert.equal((await cli(alpha, "browser", "press", "Control+a")).code, 0);
    assert.deepEqual(ext.commands.slice(1), [
      { action: "click", tabId: 101, ref: "e1" },
      { action: "type", tabId: 102, ref: "e2", text: "hello world", submit: true },
      { action: "press", tabId: 102, key: "Control+a" },
    ]);

    ext.answer = (cmd) => (cmd.action === "eval" ? { value: { n: 2 } } : cmd.action === "screenshot" ? { data: Buffer.from("png!").toString("base64") } : {});
    assert.deepEqual((await alpha.client.call("browser.eval", { expression: "1+1" })).value, { n: 2 });
    const out = join(alpha.dir, "shot.png");
    const shot = await cli(alpha, "browser", "screenshot", "-o", out);
    assert.equal(shot.stdout.trim(), out);
    assert.equal(readFileSync(out, "utf8"), "png!");

    // The extension's own error reaches the agent.
    ext.answer = () => {
      throw new Error("ref e9 is unknown: take a new snapshot");
    };
    await rejects(alpha.client.call("browser.click", { ref: "e9" }), ErrorCode.NotFound, /browser: ref e9 is unknown/);

    // Unsharing the last tab: the earlier one is the default again, the unshared one fails by id.
    await ext.share([tab(101, "2026-11-10T10:00:00Z")]);
    const before = ext.commands.length;
    await rejects(alpha.client.call("browser.click", { tab: second.id, ref: "e1" }), ErrorCode.NotFound, /tab 2 is not shared anymore/);
    assert.equal(ext.commands.length, before, "nothing reached the browser");
    await rejects(alpha.client.call("browser.click", { tab: "77", ref: "e1" }), ErrorCode.NotFound, /tab 77 is not shared/);
  } finally {
    ext.close();
  }
});

test("open navigates the shared tab, or opens a new one when none is shared", async () => {
  const ext = await FakeExtension.connect(alpha.url, alpha.token);
  try {
    await ext.share([]);
    ext.answer = (cmd) => {
      if (cmd.action !== "open") return {};
      const tabId = cmd.tabId ?? 300;
      // Like the extension: the new tab is shared before the answer.
      void ext.share([tab(tabId, "2026-11-10T11:00:00Z", cmd.url)]);
      return { tabId, url: cmd.url, title: "" };
    };
    const opened = await alpha.client.call("browser.open", { url: "https://example.org/login" });
    assert.equal(opened.tab.url, "https://example.org/login");
    assert.deepEqual(ext.commands.at(-1), { action: "open", url: "https://example.org/login" });
    await alpha.client.call("browser.open", { url: "http://example.org/next" });
    assert.deepEqual(ext.commands.at(-1), { action: "open", url: "http://example.org/next", tabId: 300 });
    await rejects(alpha.client.call("browser.open", { url: "javascript:alert(1)" }), ErrorCode.InvalidParams, /only http and https/);
    await rejects(alpha.client.call("browser.open", { url: "file:///etc/passwd" }), ErrorCode.InvalidParams, /only http and https/);
  } finally {
    ext.close();
  }
});

test("a browser that disconnects or stays silent fails the waiting call", async () => {
  const ext = await FakeExtension.connect(alpha.url, alpha.token);
  await ext.share([tab(5, "2026-11-10T12:00:00Z")]);
  ext.answer = () => undefined;
  const started = Date.now();
  await rejects(alpha.client.call("browser.snapshot", {}), ErrorCode.Unreachable, /did not answer snapshot/);
  assert.ok(Date.now() - started < 3000);

  const waiting = alpha.client.call("browser.snapshot", {});
  await new Promise((r) => setTimeout(r, 50));
  ext.close();
  await rejects(waiting, ErrorCode.Unreachable, /the browser disconnected/);
  await rejects(alpha.client.call("browser.snapshot", {}), ErrorCode.Unreachable, /no browser is connected/);
});

test("-H reaches a browser connected to a peer; a browser can't share through one", async () => {
  const ext = await FakeExtension.connect(beta.url, beta.token);
  try {
    await ext.share([tab(9, "2026-11-10T13:00:00Z")]);
    ext.answer = (cmd) => (cmd.action === "snapshot" ? { text: "- heading \"Beta\" [e1]" } : {});
    const tabs = await cli(alpha, "-H", "beta", "browser", "tabs");
    assert.equal(tabs.code, 0, tabs.stderr);
    assert.match(tabs.stdout, /Tab 9  https:\/\/example.com\/9/);
    const snap = await cli(alpha, "-H", "beta", "browser", "snapshot");
    assert.match(snap.stdout, /heading "Beta" \[e1\]/);
    assert.deepEqual((await alpha.client.call("browser.tabs", {})).tabs, [], "alpha itself has no browser");

    const viaPeer = await FakeExtension.connect(alpha.url, alpha.token);
    try {
      const msg = await new Promise<{ error?: { message: string } }>((resolve) => {
        (viaPeer as unknown as { ws: WebSocket }).ws.on("message", (d) => resolve(JSON.parse(d.toString())));
        (viaPeer as unknown as { ws: WebSocket }).ws.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "browser.share", host: "beta", params: { browserId: "x", tabs: [] } }));
      });
      assert.match(msg.error?.message ?? "", /not through a peer/);
    } finally {
      viaPeer.close();
    }
  } finally {
    ext.close();
  }
});
