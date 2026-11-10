// End-to-end check of the extension in Playwright's Chromium: a throwaway
// casm server (in this process, its own temp state), the unpacked extension
// paired with it, a local test page shared by hand (as the popup does), and
// the real `casm browser` CLI against it.
//
//   npm run e2e -w @casm/chrome-extension            (headless)
//   xvfb-run -a npm run e2e -w @casm/chrome-extension -- --headed
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { Store } from "../../server/src/db.ts";
import { startServer } from "../../server/src/server.ts";

const headed = process.argv.includes("--headed");
const extension = join(import.meta.dirname, "../extension");
const cliPath = join(import.meta.dirname, "../../cli/src/main.ts");
const dir = mkdtempSync(join(tmpdir(), "casm-ext-e2e-"));

const page = `<!doctype html><title>Test login</title>
<h1>Sign in</h1>
<label>Email <input id="email" name="email"></label>
<button onclick="document.getElementById('out').textContent = 'Hello ' + document.getElementById('email').value">Continue</button>
<p id="out">waiting</p>`;
const web = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(req.url === "/next" ? "<title>Next</title><h1>Next page</h1>" : page));
await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
const site = `http://127.0.0.1:${(web.address() as { port: number }).port}`;

const store = new Store(join(dir, "casm.db"));
const token = store.createToken("chrome-e2e");
const server = await startServer({ store, providers: [], host: "127.0.0.1", port: 0, version: "e2e", name: "e2e" });

async function casm(...args: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [cliPath, ...args], { env: { ...process.env, CASM_URL: server.url, CASM_TOKEN: token, CASM_HOST: "" } });
    return { code: 0, out: (stdout + stderr).trim() };
  } catch (e) {
    const err = e as { code: number; stderr: string };
    return { code: err.code, out: err.stderr.trim() };
  }
}
const ok = async (...args: string[]) => {
  const r = await casm(...args);
  assert.equal(r.code, 0, `casm ${args.join(" ")}: ${r.out}`);
  console.log(`$ casm ${args.join(" ")}\n${r.out}\n`);
  return r.out;
};
const ref = (snapshot: string, pattern: RegExp) => {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  const m = line?.match(/\[(e\d+)\]/);
  assert.ok(m, `no ref for ${pattern} in\n${snapshot}`);
  return m[1];
};

const context = await chromium.launchPersistentContext(join(dir, "profile"), {
  channel: "chromium",
  headless: !headed,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const sw = <T>(fn: string) => worker.evaluate(fn) as Promise<T>;
  await sw(`casm.saveSettings({ url: ${JSON.stringify(server.url)}, token: ${JSON.stringify(token)}, label: "e2e-chromium" })`);

  const tab = await context.newPage();
  await tab.goto(site);
  // Nothing shared yet: agents see a browser and no tabs.
  for (let i = 0; i < 50 && !(await casm("browser", "tabs")).out.includes("no tab is shared"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match((await casm("browser", "tabs")).out, /no tab is shared in e2e-chromium/);
  assert.match((await casm("browser", "snapshot")).out, /no tab is shared/);

  // The user shares the tab (the popup's button calls the same function).
  const tabId = await sw<number>(`chrome.tabs.query({ url: "${site}/*" }).then((t) => t[0].id)`);
  await sw(`casm.share(${tabId})`);
  const group = await sw<{ title: string }>(`chrome.tabs.get(${tabId}).then((t) => chrome.tabGroups.get(t.groupId))`);
  assert.equal(group.title, "casm");
  assert.match(await ok("browser", "tabs"), /Test login/);

  const snap = await ok("browser", "snapshot");
  assert.match(snap, /heading "Sign in"/);
  await ok("browser", "type", ref(snap, /textbox "Email"/), "ada@example.com");
  await ok("browser", "click", ref(snap, /button "Continue"/));
  assert.equal(await ok("browser", "eval", "document.getElementById('out').textContent"), "Hello ada@example.com");
  await ok("browser", "press", "Tab");

  const shot = await ok("browser", "screenshot", "-o", join(dir, "shot.png"));
  assert.equal(readFileSync(shot).subarray(1, 4).toString(), "PNG");

  assert.match(await ok("browser", "open", `${site}/next`), /Next/);
  // Refs don't outlive a navigation.
  assert.match((await casm("browser", "click", ref(snap, /button "Continue"/))).out, /unknown ref e\d+: take a new snapshot/);
  assert.match(await ok("browser", "snapshot"), /heading "Next page"/);

  // A new tab joins the casm group.
  const opened = await ok("browser", "open", "--new", `${site}/`);
  const newId = opened.split(/\s+/)[0];
  assert.match(await ok("browser", "tabs"), new RegExp(`^${newId} +Test login`, "m"));
  // It opened in the background; it still has to answer.
  await ok("browser", "screenshot", "--tab", newId, "-o", join(dir, "background.png"));

  // Taking a tab out of the group unshares it at once.
  const firstId = (await ok("browser", "tabs")).split("\n")[0].split(/\s+/)[0];
  await sw(`chrome.tabs.ungroup(${tabId})`);
  await new Promise((r) => setTimeout(r, 300));
  const refused = await casm("browser", "snapshot", "--tab", firstId);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /not shared anymore/);
  console.log(`$ casm browser snapshot --tab ${firstId}\n${refused.out}\n`);
  // The extension checks for itself: a command naming the unshared tab's Chrome id is refused.
  const forged = await sw<string>(`casm.command({ action: "eval", tabId: ${tabId}, expression: "1" }).then(() => "ran", (e) => e.message)`);
  assert.equal(forged, "that tab is not shared anymore");

  // Closing the browser: calls fail at once.
  await context.close();
  await new Promise((r) => setTimeout(r, 300));
  assert.match((await casm("browser", "snapshot")).out, /no browser is connected/);
  console.log("e2e: all checks passed");
} finally {
  await context.close().catch(() => {});
  await server.close();
  store.close();
  web.close();
  rmSync(dir, { recursive: true, force: true });
}
