// End-to-end check of the extension in Playwright's Chromium: a throwaway
// casm server (in this process, its own temp state), the unpacked extension
// paired with it in two browser profiles, local test pages shared by hand
// (as the popup does), and the real `casm browser` CLI against them.
//
//   npm run e2e -w @casm/chrome-extension            (headless)
//   xvfb-run -a npm run e2e -w @casm/chrome-extension -- --headed
//
// Playwright's Chromium paints background tabs (it runs with anti-throttling
// flags), so the hidden-tab check is exercised through Chrome's own notion of
// the front tab, not through painting.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Dialog } from "playwright";
import { Store } from "../../server/src/db.ts";
import { startServer } from "../../server/src/server.ts";
import { startFixtures } from "./fixtures.ts";

const headed = process.argv.includes("--headed");
const extension = join(import.meta.dirname, "../extension");
const cliPath = join(import.meta.dirname, "../../cli/src/main.ts");
const dir = mkdtempSync(join(tmpdir(), "casm-ext-e2e-"));

const web = await startFixtures(0);
const site = `http://127.0.0.1:${(web.address() as { port: number }).port}`;

const store = new Store(join(dir, "casm.db"));
const token = store.createToken("chrome-e2e");
const server = await startServer({ store, providers: [], host: "127.0.0.1", port: 0, version: "e2e", name: "e2e" });

async function casm(...args: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [cliPath, ...args], { env: { ...process.env, CASM_URL: server.url, CASM_TOKEN: token, CASM_HOST: "" } });
    return { code: 0, out: stdout.trim(), err: stderr.trim() };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, out: err.stdout.trim(), err: err.stderr.trim() };
  }
}
const show = (args: string[], r: { out: string; err: string }) => console.log(`$ casm ${args.join(" ")}\n${[r.out, r.err].filter(Boolean).join("\n")}\n`);
const ok = async (...args: string[]) => {
  const r = await casm(...args);
  assert.equal(r.code, 0, `casm ${args.join(" ")}: ${r.err}`);
  show(args, r);
  return r;
};
const refused = async (pattern: RegExp, ...args: string[]) => {
  const r = await casm(...args);
  assert.equal(r.code, 1, `casm ${args.join(" ")} should fail: ${r.out}`);
  assert.match(r.err, pattern);
  show(args, r);
};
const ref = (snapshot: string, pattern: RegExp) => {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  const m = line?.match(/\[(e\d+)\]/);
  assert.ok(m, `no ref for ${pattern} in\n${snapshot}`);
  return m[1];
};
const IDLE_MS = 1500;
const idle = () => new Promise((r) => setTimeout(r, IDLE_MS + 1000));
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 50 && !(await check()); i++) await new Promise((r) => setTimeout(r, 100));
};

// `viaPopup`: set up through the popup's form, as a person does (name left empty).
async function browser(name: string, { viaPopup = false } = {}) {
  const context = await chromium.launchPersistentContext(join(dir, name), {
    channel: "chromium",
    headless: !headed,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  // Playwright dismisses dialogs nobody listens for; the extension must see
  // them open. Kept, to play the user answering one.
  const dialogs: Dialog[] = [];
  context.on("page", (p) => p.on("dialog", (d) => dialogs.push(d)));
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const sw = <T>(fn: string) => worker.evaluate(fn) as Promise<T>;
  // Saved as the popup does it, minus the permission prompt (no one to click it here).
  if (viaPopup) {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await popup.locator("form[data-filled]").waitFor({ state: "attached" });
    await popup.evaluate(() => ((document.getElementById("settingsBox") as HTMLDetailsElement).open = true));
    assert.equal(await popup.locator("input[name=label]").getAttribute("placeholder"), "chromium", "the name field suggests the browser's kind");
    await popup.fill("input[name=url]", server.url);
    await popup.fill("input[name=token]", token);
    // Saving also asks for host access; nobody answers that prompt here, and the settings must not wait for it.
    await popup.click("button[type=submit]");
    await until(() => sw<string>("casm.state().then((s) => s.status)").then((s) => s === "connected"));
    assert.equal(await sw<string>("casm.state().then((s) => s.settings.label)"), "chromium", "an empty name is the suggested one");
    await popup.close();
  } else await sw(`casm.saveSettings({ url: ${JSON.stringify(server.url)}, token: ${JSON.stringify(token)}, label: "" })`);
  // The debugger lets go after 30 s without commands; here after IDLE_MS.
  await sw(`casm.setIdleDetachMs(${IDLE_MS})`);
  const share = async (url: string) => {
    const page = await context.newPage();
    await page.goto(url);
    const tabId = await sw<number>(`chrome.tabs.query({ url: ${JSON.stringify(url)} }).then((t) => t[0].id)`);
    await sw(`casm.share(${tabId})`);
    return { page, tabId };
  };
  const attached = () => sw<number[]>("casm.attached()");
  return { context, sw, share, attached, dialogs, extensionId: new URL(worker.url()).host };
}

const contexts: BrowserContext[] = [];
try {
  const one = await browser("profile-one");
  contexts.push(one.context);
  await until(async () => (await casm("browser", "tabs")).err.includes("no tab is shared"));
  // The extension names itself after the browser: Playwright's is Chromium.
  assert.match((await casm("browser", "tabs")).err, /no tab is shared in chromium/);
  await refused(/no tab is shared/, "browser", "snapshot");

  // The user shares a tab (the popup's button calls the same function).
  const { tabId, page: firstPage } = await one.share(`${site}/`);
  const group = await one.sw<{ title: string }>(`chrome.tabs.get(${tabId}).then((t) => chrome.tabGroups.get(t.groupId))`);
  assert.equal(group.title, "casm");
  assert.match((await ok("browser", "tabs")).out, /Test login/);
  // Sharing alone doesn't attach the debugger (no "debugging" bar yet).
  assert.deepEqual(await one.attached(), []);

  const snap = (await ok("browser", "snapshot")).out;
  assert.match(snap, /heading "Sign in"/);
  assert.deepEqual(await one.attached(), [tabId], "attached while the agent works");
  await idle();
  assert.deepEqual(await one.attached(), [], "detached once it stops");
  // Refs outlive the detach: the next command attaches again and uses them.
  await ok("browser", "type", ref(snap, /textbox "Email"/), "ada@example.com");
  await ok("browser", "click", ref(snap, /button "Continue"/));
  assert.equal((await ok("browser", "eval", "document.getElementById('out').textContent")).out, "Hello ada@example.com");
  await ok("browser", "press", "Tab");

  const shot = (await ok("browser", "screenshot", "-o", join(dir, "shot.png"))).out;
  assert.equal(readFileSync(shot).subarray(1, 4).toString(), "PNG");

  assert.match((await ok("browser", "open", `${site}/next`)).out, /Next/);
  // Refs don't outlive a navigation.
  await refused(/unknown ref e\d+: take a new snapshot/, "browser", "click", ref(snap, /button "Continue"/));

  // iframes: same-origin and cross-origin content, with refs that work.
  await ok("browser", "open", `${site}/frames`);
  let frames = (await ok("browser", "snapshot")).out;
  assert.match(frames, /Iframe "same"[^\n]*\n\s+- button "Same button"/);
  assert.match(frames, /Iframe "cross"[^\n]*\n\s+- button "Cross button"/);
  // A cross-origin frame's refs too, though its session is new after re-attaching.
  await idle();
  await ok("browser", "click", ref(frames, /button "Cross button"/));
  await ok("browser", "click", ref(frames, /button "Same button"/));
  await ok("browser", "type", ref(frames.slice(frames.indexOf('Iframe "cross"')), /textbox "Field"/), "typed across origins");
  frames = (await ok("browser", "snapshot")).out;
  assert.match(frames, /button "Cross button clicked"/);
  assert.match(frames, /button "Same button clicked"/);
  assert.match(frames, /textbox "Field" value="typed across origins"/);

  // Dialogs: reported, block other commands, answered only by the agent.
  await ok("browser", "open", `${site}/tools`);
  let tools = (await ok("browser", "snapshot")).out;
  const asked = await ok("browser", "click", ref(tools, /button "Ask"/));
  assert.match(asked.err, /a confirm dialog is open: "Leave\?"/);
  await refused(/a confirm dialog is open: "Leave\?". Answer it first/, "browser", "snapshot");
  // A dialog waiting for the agent keeps the debugger attached.
  await idle();
  assert.deepEqual(await one.attached(), [tabId]);
  assert.match((await ok("browser", "dialog")).out, /^confirm: Leave\?$/);
  await ok("browser", "dialog", "dismiss");
  assert.equal((await ok("browser", "eval", "document.getElementById('said').textContent")).out, "no");
  await ok("browser", "click", ref(tools, /button "Name"/));
  assert.match((await ok("browser", "dialog")).out, /prompt: Name\?  \(default: anon\)/);
  await ok("browser", "dialog", "accept", "Ada Lovelace");
  assert.equal((await ok("browser", "eval", "document.getElementById('said').textContent")).out, "Ada Lovelace");
  await refused(/no dialog is open/, "browser", "dialog", "accept");
  // A dialog that opens while no agent works is the user's: commands say so at once.
  await ok("browser", "eval", "setTimeout(() => alert('while idle'), 2000); 1");
  await idle();
  await until(async () => one.dialogs.some((d) => d.message() === "while idle"));
  await refused(/a dialog is probably open .* ask the user to answer it/, "browser", "snapshot");
  await one.dialogs.find((d) => d.message() === "while idle")!.accept();
  assert.match((await ok("browser", "snapshot")).out, /button "Ask"/);

  // Uploads: a file from this machine set on the page's file input.
  const upload = join(dir, "notes.txt");
  writeFileSync(upload, "from the agent's machine");
  tools = (await ok("browser", "snapshot")).out;
  await ok("browser", "upload", ref(tools, /button "Attachment"/), upload);
  assert.equal((await ok("browser", "eval", "document.getElementById('got').textContent")).out, "notes.txt: from the agent's machine");

  // Downloads: reported, and fetched back.
  await ok("browser", "click", ref(tools, /link "Get the report"/));
  await until(async () => (await casm("browser", "downloads")).out.includes("report.txt"));
  const downloads = (await ok("browser", "downloads")).out;
  const downloadId = downloads.split(/\s+/)[0];
  assert.match(downloads, /report\.txt/);
  const fetched = (await ok("browser", "download", downloadId, "-o", join(dir, "report.txt"))).out;
  assert.equal(readFileSync(fetched, "utf8"), "quarterly numbers");

  // A popup the shared tab opens is shared too, and reported.
  const popped = await ok("browser", "click", ref(tools, /button "Sign in with popup"/));
  assert.match(popped.err, /opened tab (\d+) .*\/next.*opened by \d+/);
  const popupId = popped.err.match(/opened tab (\d+)/)![1];
  assert.match((await ok("browser", "snapshot", "--tab", popupId)).out, /heading "Next page"/);

  // Every way a shared tab opens another puts it in the same casm group, and agents can steer it.
  // (Each new tab becomes the default target, the most recently shared, so the opener is named.)
  const toolsId = (await ok("browser", "tabs")).out.split("\n").find((l) => l.includes("/tools"))!.split(/\s+/)[0];
  const inGroup = () => one.sw<number>(`chrome.tabs.get(${tabId}).then((t) => chrome.tabs.query({ groupId: t.groupId })).then((ts) => ts.length)`);
  let grouped = await inGroup();
  const blank = await ok("browser", "click", ref(tools, /link "Blank link"/), "--tab", toolsId);
  assert.match(blank.err, new RegExp(`opened tab \\d+ .*/next\\?blank.*opened by ${toolsId}`));
  assert.equal(await inGroup(), ++grouped, "target=_blank joined the group");
  // The _blank tab came to the front: clicks and keys no longer reach /tools, and casm says so at once.
  await refused(/the tab is not visible \(another tab is in front in its window\): Chrome doesn't deliver clicks to a background tab.*ask the user to show it/, "browser", "click", ref(tools, /link "Plain link"/), "--tab", toolsId);
  await refused(/doesn't deliver key presses/, "browser", "press", "Tab", "--tab", toolsId);
  // Typing does reach a background tab.
  await ok("browser", "eval", "document.body.insertAdjacentHTML('beforeend', '<input aria-label=Later>'); 1", "--tab", toolsId);
  const later = ref((await ok("browser", "snapshot", "--tab", toolsId)).out, /textbox "Later"/);
  await ok("browser", "type", later, "typed in the background", "--tab", toolsId);
  assert.equal((await ok("browser", "eval", "document.querySelector('[aria-label=Later]').value", "--tab", toolsId)).out, "typed in the background");
  await refused(/doesn't deliver key presses \(--submit presses Enter\)/, "browser", "type", later, "x", "--submit", "--tab", toolsId);
  // The user brings it back.
  await firstPage.bringToFront();
  const newTab = await ok("browser", "click", ref(tools, /link "Plain link"/), "--new-tab", "--tab", toolsId);
  assert.match(newTab.err, new RegExp(`opened tab \\d+ .*/next\\?plain.*opened by ${toolsId}`));
  assert.match(newTab.out + (await ok("browser", "tabs")).out, new RegExp(`^${toolsId} +Tools`, "m"), "the clicking tab stayed where it was");
  assert.equal(await inGroup(), ++grouped, "click --new-tab joined the group");
  // The user's (or the page's) own Control-click and middle-click.
  await firstPage.click("#plain", { modifiers: ["Control"] });
  await until(async () => (await inGroup()) === grouped + 1);
  assert.equal(await inGroup(), ++grouped, "Control-click joined the group");
  await firstPage.click("#plain", { button: "middle" });
  await until(async () => (await inGroup()) === grouped + 1);
  assert.equal(await inGroup(), ++grouped, "middle-click joined the group");
  // open --new goes next to the target tab, in its group.
  const near = (await ok("browser", "open", "--new", "--tab", toolsId, `${site}/next?near`)).out;
  assert.match(near, /\/next\?near/);
  assert.equal(await inGroup(), ++grouped, "open --new joined the target tab's group");
  // All of them are listed, opener included, and every command works on each.
  const listed = (await ok("browser", "tabs")).out.split("\n");
  for (const kind of ["blank", "plain", "near"]) assert.ok(listed.some((l) => l.includes(`/next?${kind}`) && l.includes(`opened by ${toolsId}`)), `${kind} listed with its opener`);
  for (const line of listed) {
    const id = line.split(/\s+/)[0];
    if (line.includes("/next")) assert.match((await ok("browser", "snapshot", "--tab", id)).out, /heading "Next page"/);
  }
  const plainId = listed.filter((l) => l.includes("/next?plain"))[0].split(/\s+/)[0];
  assert.equal((await ok("browser", "eval", "location.search", "--tab", plainId)).out, "?plain");
  await ok("browser", "open", `${site}/`, "--tab", plainId);
  await ok("browser", "type", ref((await ok("browser", "snapshot", "--tab", plainId)).out, /textbox "Email"/), "in a new tab", "--tab", plainId);

  // A new tab opens in the background, and casm won't bring it to the front for a screenshot.
  const opened = (await ok("browser", "open", "--new", `${site}/`)).out;
  const newId = opened.split(/\s+/)[0];
  assert.match((await ok("browser", "tabs")).out, new RegExp(`^${newId} +Test login`, "m"));
  await refused(/the tab is not visible \(another tab is in front in its window\).*ask the user to show it/, "browser", "screenshot", "--tab", newId);

  // A second browser: targets must be named.
  const two = await browser("profile-two", { viaPopup: true });
  contexts.push(two.context);
  await until(async () => (await casm("browser", "list")).out.includes("chromium-2"));
  await two.share(`${site}/next`);
  const list = (await ok("browser", "list")).out;
  assert.match(list, /^chromium  \d+ shared tabs/m);
  assert.match(list, /^chromium-2  1 shared tab/m);
  await refused(/2 browsers are connected \(chromium, chromium-2\): name one with --browser, or a tab with --tab/, "browser", "snapshot");
  assert.match((await ok("browser", "snapshot", "--browser", "chromium-2")).out, /heading "Next page"/);
  assert.match((await ok("browser", "snapshot", "--tab", newId)).out, /heading "Sign in"/);
  await two.context.close();
  await until(async () => !(await casm("browser", "list")).out.includes("chromium-2"));

  // Taking a tab out of the group unshares it at once.
  const firstId = (await ok("browser", "tabs")).out.split("\n")[0].split(/\s+/)[0];
  await one.sw(`chrome.tabs.ungroup(${tabId})`);
  await new Promise((r) => setTimeout(r, 300));
  await refused(/not shared anymore/, "browser", "snapshot", "--tab", firstId);
  // The extension checks for itself: a command naming the unshared tab's Chrome id is refused.
  const forged = await one.sw<string>(`casm.command({ action: "eval", tabId: ${tabId}, expression: "1" }).then(() => "ran", (e) => e.message)`);
  assert.equal(forged, "that tab is not shared anymore");

  // Server access for local network rules: the manifest's ws:// patterns are valid, and the popup says it's missing.
  assert.equal(await one.sw<boolean>(`chrome.permissions.contains({ origins: ["ws://127.0.0.1/*", "http://127.0.0.1/*"] })`), false);
  const popup = await one.context.newPage();
  await popup.goto(`chrome-extension://${one.extensionId}/popup.html`);
  await popup.locator("#perm:not([hidden])").waitFor();
  assert.match(await popup.locator("#perm").innerText(), /no access to 127\.0\.0\.1/);
  await popup.close();

  // Closing the browser: calls fail at once.
  await one.context.close();
  await new Promise((r) => setTimeout(r, 300));
  await refused(/no browser is connected/, "browser", "snapshot");
  console.log("e2e: all checks passed");
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await server.close();
  store.close();
  web.close();
  rmSync(dir, { recursive: true, force: true });
}
