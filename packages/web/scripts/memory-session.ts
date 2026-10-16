// Scripted long session against the heavy memory workspace, measuring what
// the web app holds: JS heap, DOM nodes, listeners (Chromium, over CDP) and the
// browser's process memory (both engines). Build the web app first.
//   node packages/web/scripts/memory-session.ts [chromium|webkit] [out.json]
// CASM_WEB_TEST_PORT / CASM_WEB_TEST_HOME pick the disposable server.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { chromium, webkit, type Page, type CDPSession } from "@playwright/test";

const engine = process.argv[2] === "webkit" ? "webkit" : "chromium";
const out = process.argv[3] ?? `/tmp/casm-memory-${engine}.json`;
const port = Number(process.env.CASM_WEB_TEST_PORT ?? 7810);
const home = process.env.CASM_WEB_TEST_HOME ?? "/tmp/casm-web-mem";
const url = `http://127.0.0.1:${port}`;
const repo = resolve(import.meta.dirname, "../../..");

const server = spawn("node", [resolve(repo, "packages/web/test/server.ts")], {
  cwd: repo,
  env: { ...process.env, CASM_WEB_TEST_PORT: String(port), CASM_WEB_TEST_HOME: home, CASM_WEB_TEST_SCENARIO: "memory" },
  stdio: ["ignore", "inherit", "inherit"],
});
process.on("exit", () => server.kill("SIGTERM"));
for (let i = 0; ; i++) {
  try { if ((await fetch(`${url}/health`)).ok) break; } catch {}
  if (i > 600) throw new Error("server did not start");
  await new Promise((r) => setTimeout(r, 100));
}

// Resident memory of the browser and all its children (renderers, GPU, network).
function tree(root: number) {
  const children = new Map<number, number[]>();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const ppid = Number(readFileSync(`/proc/${d}/stat`, "utf8").split(") ")[1].split(" ")[1]);
      children.set(ppid, [...(children.get(ppid) ?? []), Number(d)]);
    } catch {}
  }
  const all: number[] = [];
  const walk = (p: number) => { all.push(p); for (const c of children.get(p) ?? []) walk(c); };
  walk(root);
  return all;
}
function pss(pid: number) {
  try { return Number(/Pss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))![1]) * 1024; } catch { return 0; }
}
function cmd(pid: number) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; }
}

const launcher = engine === "webkit" ? webkit : chromium;
const browserServer = await launcher.launchServer({ headless: true });
const browserPid = browserServer.process().pid!;
const browser = await launcher.connect(browserServer.wsEndpoint());
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// CASM_CHAT_MEMORY picks the "Keep chats in memory" setting (5, 20 or all).
if (process.env.CASM_CHAT_MEMORY)
  await context.addInitScript((v) => localStorage.setItem("casm.chat-memory", v), process.env.CASM_CHAT_MEMORY);
const page = await context.newPage();
const cdp: CDPSession | undefined = engine === "chromium" ? await context.newCDPSession(page) : undefined;
if (cdp) await cdp.send("Performance.enable");

const samples: Record<string, unknown>[] = [];
const mb = (n: number) => Math.round(n / 1048576 * 10) / 10;
async function measure(label: string) {
  if (cdp) await cdp.send("HeapProfiler.collectGarbage");
  await page.waitForTimeout(500);
  const sample: Record<string, unknown> = { label, at: Math.round(performance.now() / 1000) };
  if (cdp) {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const dom = await cdp.send("Memory.getDOMCounters");
    Object.assign(sample, { heapMB: mb(m.JSHeapUsedSize), heapTotalMB: mb(m.JSHeapTotalSize), nodes: dom.nodes, listeners: dom.jsEventListeners, documents: dom.documents });
  }
  sample.domElements = await page.evaluate(() => document.getElementsByTagName("*").length);
  sample.imgs = await page.evaluate(() => document.images.length);
  const pids = tree(browserPid);
  const content = pids.filter((p) => /--type=renderer|WebKitWebProcess|WebContent/.test(cmd(p)));
  sample.contentPssMB = mb(content.reduce((s, p) => s + pss(p), 0));
  sample.largestPssMB = mb(Math.max(...pids.map(pss)));
  sample.totalPssMB = mb(pids.reduce((s, p) => s + pss(p), 0));
  samples.push(sample);
  console.log(JSON.stringify(sample));
}
async function snapshot(file: string) {
  if (!cdp) return;
  await cdp.send("HeapProfiler.collectGarbage");
  const stream = createWriteStream(file);
  const chunk = (e: { chunk: string }) => stream.write(e.chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", chunk);
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  cdp.off("HeapProfiler.addHeapSnapshotChunk", chunk);
  await new Promise((r) => stream.end(r));
}

async function open(page: Page, name: string) {
  await page.getByRole("button", { name: new RegExp(`${name}\\b`) }).first().click();
  await page.locator("main header strong", { hasText: name }).waitFor();
  await page.locator(".item").first().waitFor();
  await page.waitForTimeout(400);
}
// Reads back through `pages` older pages (100 items each), then returns to the end.
async function scrollChat(page: Page, pages: number) {
  const scroller = page.locator("[data-virtuoso-scroller]");
  for (let i = 0; i < pages; i++) {
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(350);
  }
  for (let i = 0; i < 6; i++) {
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
    await page.waitForTimeout(80);
  }
  const latest = page.getByRole("button", { name: "Latest ↓" });
  if (await latest.count()) await latest.click();
  await page.waitForTimeout(300);
}
async function send(page: Page, text: string) {
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Message").press("Enter");
}

await page.goto(url);
await page.getByLabel("Server token").fill(readFileSync(`${home}/web-token`, "utf8"));
await page.getByRole("button", { name: "Connect", exact: true }).click();
await page.getByRole("button", { name: /Mem 00/ }).waitFor();
await measure("connected");

const names = Array.from({ length: 40 }, (_, i) => `Mem ${String(i).padStart(2, "0")}`);
const visit = names.slice(0, 30);
const streaming = new Set(["Mem 01", "Mem 11", "Mem 21", "Mem 31"]);
for (const [i, name] of visit.entries()) {
  await open(page, name);
  const long = Number(name.slice(4)) % 5 === 0;
  await scrollChat(page, long ? 8 : 2);
  if (streaming.has(name)) { await send(page, "churn"); await page.waitForTimeout(1500); }
  if (i === 0) await measure("1 chat");
  if ((i + 1) % 10 === 0) await measure(`${i + 1} chats`);
}
await snapshot(`${out}.30.heapsnapshot`);
// The server drops every socket: the app reconnects and reloads the open chat.
process.kill(Number(readFileSync(`${home}/web-pid`, "utf8")), "SIGUSR2");
await page.locator("aside footer", { hasText: "Connected" }).waitFor({ timeout: 30_000 });
await page.waitForTimeout(3000);
await measure("reconnected");
for (const name of [...names.slice(30), ...visit.slice(0, 5)]) {
  await open(page, name);
  await scrollChat(page, 1);
}
await measure("40 chats + 5 revisits");
// Left open with four agents streaming.
await page.waitForTimeout(60_000);
await measure("idle 60s, streaming");
await snapshot(`${out}.end.heapsnapshot`);
writeFileSync(out, JSON.stringify(samples, null, 2));
await browser.close();
await browserServer.close();
server.kill("SIGTERM");

