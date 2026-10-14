// Screenshots and GIFs of the web client for docs/media, taken against the
// showcase server (fake providers, demo projects; never real data):
//
//   npm run build
//   node scripts/docs-media/capture-web.ts [scene...]
//
// Needs Playwright's Chromium and ffmpeg on PATH. SHOWCASE_PORT (default 7497)
// and SHOWCASE_HOME (default /tmp/demo) pick the server's port and state; each
// scene starts a fresh server. Stills are 2x; GIFs come from a CDP screencast.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

const repo = resolve(import.meta.dirname, "../..");
const out = join(repo, "docs/media");
const port = Number(process.env.SHOWCASE_PORT ?? 7497);
const home = process.env.SHOWCASE_HOME ?? "/tmp/demo";
const base = `http://127.0.0.1:${port}`;
const scale = 2;
mkdirSync(out, { recursive: true });

let server: ChildProcess | undefined;
process.on("exit", () => server?.kill("SIGKILL"));
async function startShowcase() {
  await stopShowcase();
  const env: NodeJS.ProcessEnv = { ...process.env, SHOWCASE_PORT: String(port), SHOWCASE_HOME: home };
  for (const k of Object.keys(env)) if (k.startsWith("CASM_")) delete env[k];
  server = spawn(process.execPath, [join(repo, "scripts/docs-media/showcase-server.ts")], { cwd: repo, env, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((ok, fail) => {
    server!.stdout!.on("data", (d) => String(d).includes("showcase:") && ok());
    server!.once("exit", (code) => fail(new Error(`showcase server exited with ${code}`)));
  });
}
async function stopShowcase() {
  if (!server || server.exitCode !== null) return;
  const s = server;
  await new Promise((ok) => (s.once("exit", ok), s.kill("SIGTERM")));
}

type Opts = { width?: number; height?: number; dark?: boolean };
async function context(browser: Browser, { width = 1440, height = 900, dark = false }: Opts = {}) {
  const mobile = width < 600;
  return browser.newContext({
    viewport: { width, height: mobile ? 812 : height },
    deviceScaleFactor: scale,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: dark ? "dark" : "light",
    acceptDownloads: true,
  });
}

async function login(ctx: BrowserContext, path = "/") {
  const page = await ctx.newPage();
  await page.goto(base + "/");
  await page.getByLabel("Server token").fill(readFileSync(`${home}.state/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText(/^Connected$/).waitFor({ state: "attached" });
  if (path !== "/") await page.goto(base + path);
  // Hide the caret and any scrollbars; they add noise to stills and GIFs.
  await page.addStyleTag({ content: "*{caret-color:transparent!important;scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important}" });
  return page;
}

const agentIds = () => JSON.parse(readFileSync(`${home}.state/agents.json`, "utf8")) as Record<string, string>;
const agentPath = (name: string) => `/h/studio/a/${agentIds()[name]}`;

async function settle(page: Page, ms = 700) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

type Box = { x: number; y: number; width: number; height: number };
// A box around one or more elements, padded and kept inside the viewport.
async function around(page: Page, targets: Locator[], pad = 24): Promise<Box> {
  const boxes = (await Promise.all(targets.map((t) => t.boundingBox()))).filter((b): b is Box => !!b);
  const vp = page.viewportSize()!;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(vp.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x, y, width: right - x, height: bottom - y };
}

function optimizePng(file: string) {
  // Flat UI compresses well at 256 colours; keep the original if it isn't smaller.
  const tmp = `${file}.tmp.png`;
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", file, "-vf", "split[a][b];[a]palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=none", tmp]);
  if (r.status === 0 && statSync(tmp).size < statSync(file).size) renameSync(tmp, file);
  else rmSync(tmp, { force: true });
}

async function shot(page: Page, name: string, clip?: Box) {
  await settle(page);
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file, clip });
  optimizePng(file);
  console.log(`${name}.png  ${(statSync(file).size / 1024).toFixed(0)} KB`);
}

async function type(target: Locator, text: string) {
  await target.click();
  await target.pressSequentially(text, { delay: 45 });
}

// Records a GIF from a CDP screencast while `act` runs: frames arrive only when
// something paints, each with its timestamp, so durations are exact. `clip` is
// in CSS pixels; `width` is the GIF's width in pixels.
async function gif(page: Page, name: string, act: () => Promise<void>, { clip, width = 960, fps = 12, hold = 1800 }: { clip?: Box; width?: number; fps?: number; hold?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "casm-gif-"));
  const frames: { file: string; t: number }[] = [];
  const cdp = await page.context().newCDPSession(page);
  const vp = page.viewportSize()!;
  cdp.on("Page.screencastFrame", (f) => {
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.png`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await settle(page, 400);
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: vp.width * scale, maxHeight: vp.height * scale, everyNthFrame: 1 });
  // Force a first frame even if nothing moves yet.
  await page.evaluate(() => document.body.animate([{ opacity: 1 }, { opacity: 0.999 }], 50));
  try {
    await page.waitForTimeout(600);
    await act();
    await page.waitForTimeout(hold);
  } catch (e) {
    await page.screenshot({ path: join(tmpdir(), `${name}-error.png`) });
    console.error(`failed; last frame in ${join(tmpdir(), `${name}-error.png`)}`);
    throw e;
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => {});
  }
  const end = frames.at(-1)!.t + hold / 1000;
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? end) - f.t).toFixed(3)}`).join("\n");
  writeFileSync(join(dir, "list.txt"), `${list}\nfile '${frames.at(-1)!.file}'\n`);
  // Frame pixels per CSS pixel, from the PNG header's width.
  const ratio = readFileSync(frames[0].file).readUInt32BE(16) / vp.width;
  const crop = clip ? `crop=${Math.round(clip.width * ratio)}:${Math.round(clip.height * ratio)}:${Math.round(clip.x * ratio)}:${Math.round(clip.y * ratio)},` : "";
  const file = join(out, `${name}.gif`);
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"),
    "-vf", `${crop}fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop", "0", file]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  rmSync(dir, { recursive: true, force: true });
  const seconds = end - frames[0].t;
  console.log(`${name}.gif  ${frames.length} frames  ${seconds.toFixed(1)} s  ${(statSync(file).size / 1024).toFixed(0)} KB`);
}

// ⋯ on a host row opens the host window; its tabs are Usage, Schedules and Instructions.
const hostTab = async (page: Page, tab: string) => {
  await page.getByTitle("Host options").first().click();
  await page.getByRole("dialog").getByRole("navigation").getByRole("button", { name: tab, exact: true }).click();
};
// The chat column: transcript and composer, without the sidebar.
const chatColumn = async (page: Page): Promise<Box> => {
  const vp = page.viewportSize()!;
  const side = (await page.locator("aside, nav").first().boundingBox())?.width ?? 280;
  return { x: side, y: 0, width: vp.width - side, height: vp.height };
};

// ---------------------------------------------------------------- scenes
const scenes: Record<string, (b: Browser) => Promise<void>> = {
  async stills(b) {
    for (const dark of [false, true]) {
      const suffix = dark ? "dark" : "light";
      let ctx = await context(b, { dark });
      let page = await login(ctx, agentPath("fix order totals"));
      await page.getByText("2 passed").waitFor();
      await shot(page, `web-agent-${suffix}`);
      await ctx.close();

      ctx = await context(b, { width: 375, dark });
      page = await login(ctx, agentPath("fix order totals"));
      await page.getByText("2 passed").waitFor();
      await shot(page, `web-mobile-agent-${suffix}`);
      await page.getByRole("button", { name: "Agents" }).click();
      await shot(page, `web-mobile-sidebar-${suffix}`);
      await ctx.close();
    }
  },

  async panels(b) {
    // Tall enough for the whole conversation, so nothing is cut off.
    let ctx = await context(b, { height: 960 });
    let page = await login(ctx, agentPath("release lead"));
    await page.getByText("Ready to tag").waitFor();
    await shot(page, "web-orchestration", await chatColumn(page));
    await ctx.close();

    ctx = await context(b, { height: 1000 });
    page = await login(ctx);
    for (const [tab, name] of [["Usage", "web-usage"], ["Schedules", "web-schedules"], ["Instructions", "web-host-settings"]] as const) {
      await hostTab(page, tab);
      const dialog = page.getByRole("dialog").last();
      await dialog.waitFor();
      if (tab === "Instructions") await dialog.getByText("Agent prompt").last().scrollIntoViewIfNeeded();
      await shot(page, name, await around(page, [dialog], 0));
      await page.keyboard.press("Escape");
    }
    await ctx.close();
  },

  async "gif-steer"(b) {
    const ctx = await context(b, { width: 1280, height: 800 });
    const page = await login(ctx, agentPath("fix order totals"));
    await page.getByText("2 passed").waitFor();
    const box = page.getByLabel("Message");
    await gif(page, "web-send-steer", async () => {
      await type(box, "Add input validation to POST /orders.");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1800);
      await type(box, "Also reject negative quantities.");
      await page.getByRole("button", { name: "Steer", exact: true }).click();
      await page.getByText("as you asked mid-turn").waitFor({ timeout: 20_000 });
      await page.getByText("with a test.").waitFor({ timeout: 10_000 });
    }, { clip: await chatColumn(page), width: 900 });
    await ctx.close();
  },

  async "gif-queue"(b) {
    const ctx = await context(b, { width: 1280, height: 800 });
    const page = await login(ctx, agentPath("fix order totals"));
    await page.getByText("2 passed").waitFor();
    const box = page.getByLabel("Message");
    await gif(page, "web-queue", async () => {
      await type(box, "Add input validation to POST /orders.");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      await type(box, "Then update the CHANGELOG.");
      await page.keyboard.press("Enter");
      await type(box, "Then run the tests once more.");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(700);
      await page.locator(".queue-toggle").click();
      await page.waitForTimeout(2200);
      await page.locator(".queue-toggle").click();
      await page.getByText("All 3 tests pass.").waitFor({ timeout: 40_000 });
    }, { clip: await chatColumn(page), width: 900 });
    await ctx.close();
  },

  async "gif-schedule"(b) {
    const ctx = await context(b, { width: 1280, height: 860 });
    const page = await login(ctx);
    await hostTab(page, "Schedules");
    const panel = page.getByRole("dialog").last();
    await panel.waitFor();
    await page.waitForTimeout(300);
    await gif(page, "web-schedule-create", async () => {
      await page.getByRole("button", { name: "New schedule" }).click();
      await page.waitForTimeout(400);
      await type(page.getByRole("textbox", { name: "Prompt", exact: true }), "Check open PRs and summarize what needs review.");
      await page.waitForTimeout(300);
      await page.getByLabel("Agent", { exact: true }).selectOption({ label: "api review" });
      await page.waitForTimeout(400);
      await page.getByRole("radio", { name: "Calendar" }).click();
      await page.waitForTimeout(500);
      await page.getByRole("group", { name: "Common times" }).getByRole("button").first().click();
      await page.waitForTimeout(500);
      await type(page.getByLabel("Name", { exact: true }), "PR digest");
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: "Create schedule" }).click();
      await page.getByText("PR digest").waitFor();
    }, { clip: await around(page, [panel], 0), width: 760 });
    await ctx.close();
  },

  async "gif-file"(b) {
    const ctx = await context(b, { width: 1280, height: 800 });
    const page = await login(ctx, agentPath("fix order totals"));
    await page.getByText("2 passed").waitFor();
    await gif(page, "web-file-preview", async () => {
      await page.getByRole("link", { name: /rounding\.md/ }).click();
      await page.waitForTimeout(2200);
      await page.getByRole("button", { name: "Close file preview" }).click();
      await page.waitForTimeout(500);
      await page.getByRole("link", { name: /orders\.js$/ }).first().click();
      await page.waitForTimeout(2500);
      await page.getByRole("button", { name: "Close file preview" }).click();
    }, { width: 900 });
    await ctx.close();
  },

  async "gif-new-project"(b) {
    const ctx = await context(b, { width: 1280, height: 800 });
    const page = await login(ctx);
    await gif(page, "web-new-project", async () => {
      await page.getByTitle("New project").first().click();
      await page.waitForTimeout(500);
      const folder = page.getByLabel("Folder", { exact: true });
      await folder.fill("");
      await type(folder, "/tmp/demo/do");
      await page.waitForTimeout(700);
      await page.getByRole("option", { name: /\/tmp\/demo\/docs-site$/ }).click();
      await page.waitForTimeout(500);
      await type(page.getByLabel("Name", { exact: true }), "docs-site");
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: "Create project" }).click();
      await page.getByText("docs-site").first().waitFor();
    }, { width: 900 });
    await ctx.close();
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenes);
const browser = await chromium.launch();
try {
  for (const name of wanted) {
    if (!scenes[name]) throw new Error(`unknown scene ${name}; scenes: ${Object.keys(scenes).join(", ")}`);
    await startShowcase();
    console.log(`# ${name}`);
    await scenes[name](browser);
  }
} finally {
  await browser.close();
  await stopShowcase();
}
