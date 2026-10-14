// Screenshots and GIFs of the web client for docs/media, taken against the
// showcase server (fake providers, demo projects; never real data):
//
//   npm run build
//   node scripts/docs-media/capture-web.ts [scene...]
//
// Needs Playwright's Chromium and ffmpeg on PATH (GIFs only). SHOWCASE_PORT
// (default 7497) and SHOWCASE_HOME (default /tmp/demo) pick the server's
// port and state; each scene starts a fresh server.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

const repo = resolve(import.meta.dirname, "../..");
const out = join(repo, "docs/media");
const port = Number(process.env.SHOWCASE_PORT ?? 7497);
const home = process.env.SHOWCASE_HOME ?? "/tmp/demo";
const base = `http://127.0.0.1:${port}`;
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
  const ctx = await browser.newContext({
    viewport: { width, height: mobile ? 812 : height },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: dark ? "dark" : "light",
  });
  // A visible pointer for the GIFs: Playwright's mouse isn't drawn.
  await ctx.addInitScript(() => {
    addEventListener("DOMContentLoaded", () => {
      const dot = document.createElement("div");
      dot.id = "docs-pointer";
      Object.assign(dot.style, { position: "fixed", zIndex: "2147483647", width: "18px", height: "18px", marginLeft: "-9px", marginTop: "-9px", borderRadius: "50%", background: "rgba(121,82,181,.35)", border: "2px solid rgba(121,82,181,.9)", pointerEvents: "none", display: "none", transition: "transform .12s" });
      document.body.append(dot);
      addEventListener("mousemove", (e) => Object.assign(dot.style, { display: "block", left: `${e.clientX}px`, top: `${e.clientY}px` }), true);
      addEventListener("mousedown", () => (dot.style.transform = "scale(.7)"), true);
      addEventListener("mouseup", () => (dot.style.transform = ""), true);
    });
  });
  return ctx;
}

async function login(ctx: BrowserContext, path = "/") {
  const page = await ctx.newPage();
  await page.goto(base + "/");
  await page.getByLabel("Server token").fill(readFileSync(`${home}/web-token`, "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText(/^Connected$/).waitFor({ state: "attached" });
  if (path !== "/") await page.goto(base + path);
  return page;
}

const agentIds = () => JSON.parse(readFileSync(`${home}/agents.json`, "utf8")) as Record<string, string>;
const agentPath = (name: string) => `/h/studio/a/${agentIds()[name]}`;

async function settle(page: Page, ms = 700) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.getElementById("docs-pointer")?.style.setProperty("display", "none"));
  await settle(page);
  await page.screenshot({ path: join(out, `${name}.png`) });
  // Lossless squeeze; screenshots of flat UI compress well at 256 colours.
  spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", join(out, `${name}.png`), "-vf", "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none", join(out, `${name}.tmp.png`)]);
  spawnSync("mv", [join(out, `${name}.tmp.png`), join(out, `${name}.png`)]);
  console.log(`${name}.png  ${(statSync(join(out, `${name}.png`)).size / 1024).toFixed(0)} KB`);
}

// Moves the visible pointer to the element, then clicks it.
async function click(page: Page, target: Locator, opts: { dbl?: boolean } = {}) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await page.waitForTimeout(150);
  if (opts.dbl) await target.dblclick();
  else await target.click();
}

async function type(page: Page, target: Locator, text: string) {
  await click(page, target);
  await target.pressSequentially(text, { delay: 35 });
}

// Records a GIF: screenshots in a loop while `act` runs, then ffmpeg with a
// shared palette. `scale` resizes frames; frames repeat for their real duration.
async function gif(page: Page, name: string, act: () => Promise<void>, { scale = 0.6, tail = 1500 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "casm-gif-"));
  const frames: { file: string; t: number }[] = [];
  let recording = true;
  const loop = (async () => {
    while (recording) {
      const file = join(dir, `${String(frames.length).padStart(5, "0")}.png`);
      const t = Date.now();
      await page.screenshot({ path: file, animations: "allow", caret: "initial" });
      frames.push({ file, t });
    }
  })();
  try {
    await settle(page, 500);
    await act();
    await page.waitForTimeout(tail);
  } catch (e) {
    await page.screenshot({ path: join(tmpdir(), `${name}-error.png`) });
    console.error(`failed; last frame in ${join(tmpdir(), `${name}-error.png`)}`);
    throw e;
  } finally {
    recording = false;
    await loop;
  }
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.t ?? f.t + 100) - f.t) / 1000).toFixed(3)}`).join("\n");
  writeFileSync(join(dir, "list.txt"), `${list}\nfile '${frames.at(-1)!.file}'\n`);
  const file = join(out, `${name}.gif`);
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"),
    "-vf", `fps=10,scale=iw*${scale}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, file]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  rmSync(dir, { recursive: true, force: true });
  console.log(`${name}.gif  ${frames.length} frames  ${(statSync(file).size / 1024).toFixed(0)} KB`);
}

// ---------------------------------------------------------------- scenes
const scenes: Record<string, (b: Browser) => Promise<void>> = {
  async screenshots(b) {
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
    const ctx = await context(b);
    const page = await login(ctx);
    const hostMenu = async (item: string) => {
      await page.getByTitle("Host options").first().click();
      await page.getByRole("menuitem", { name: new RegExp(`^${item}`) }).click();
    };
    await page.getByTitle("Host options").first().click();
    await shot(page, "web-host-menu");
    await page.keyboard.press("Escape");
    await hostMenu("Usage");
    await shot(page, "web-usage");
    await page.keyboard.press("Escape");
    await hostMenu("Schedules");
    await shot(page, "web-schedules");
    await page.keyboard.press("Escape");
    await hostMenu("Settings");
    await shot(page, "web-host-settings");
    await page.keyboard.press("Escape");
    await hostMenu("New project");
    await shot(page, "web-new-project");
    await page.keyboard.press("Escape");
    await page.goto(base + agentPath("fix order totals"));
    await page.getByRole("link", { name: /rounding\.md/ }).click();
    await shot(page, "web-file-preview");
    await ctx.close();
  },

  async "gif-steer"(b) {
    const ctx = await context(b, { width: 1280, height: 800 });
    const page = await login(ctx, agentPath("fix order totals"));
    await page.getByText("2 passed").waitFor();
    const box = page.getByLabel("Message");
    await gif(page, "web-send-steer", async () => {
      await type(page, box, "Add input validation to POST /orders.");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1800);
      await type(page, box, "Also reject negative quantities.");
      await click(page, page.getByRole("button", { name: "Steer", exact: true }));
            await page.getByText("as you asked mid-turn").waitFor({ timeout: 20_000 });
    });
    await ctx.close();
  },

  async "gif-queue"(b) {
    const ctx = await context(b, { width: 1280, height: 800 });
    const page = await login(ctx, agentPath("fix order totals"));
    await page.getByText("2 passed").waitFor();
    const box = page.getByLabel("Message");
    await gif(page, "web-queue", async () => {
      await type(page, box, "Add input validation to POST /orders.");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);
      await type(page, box, "Then update the CHANGELOG.");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      await type(page, box, "Then run the tests once more.");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2500);
      await page.getByText("All 3 tests pass.").waitFor({ timeout: 40_000 });
    });
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
