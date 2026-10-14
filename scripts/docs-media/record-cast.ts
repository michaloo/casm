// Records real CLI sessions against the lab (scripts/docs-media/lab.sh) as
// asciicast v2 files and renders them to animated SVG with svg-term-cli:
//
//   node scripts/docs-media/record-cast.ts [scene...]
//
// Each scene starts a fresh lab, runs its hidden setup, then "types" each
// command and records its real output with real timings; gaps longer than a
// step's `maxGap` (seconds) are shortened, like asciinema's idle time limit.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const out = join(repo, "docs/media");
const lab = process.env.LAB ?? "/var/tmp/casm-lab";
const width = 100;
mkdirSync(out, { recursive: true });

type Step =
  | { cmd: string; maxGap?: number; capture?: [name: string, pattern: RegExp] }
  | { comment: string }
  | { hidden: string; capture?: [name: string, pattern: RegExp] };
type Scene = { height: number; steps: Step[] };

const poem = "Run sleep 15 with the Bash tool in the foreground, then write a four-line poem about a lighthouse keeper.";
const scenes: Record<string, Scene> = {
  "cli-quickstart": {
    height: 24,
    steps: [
      { comment: "# register a folder, then start an agent in it" },
      { cmd: "casm project create /tmp/code/acme-api --name acme-api" },
      { cmd: 'casm run --project acme-api --provider claude --model haiku --name reviewer "Read src/orders.js and summarize it in two sentences."' },
      { cmd: "casm agents" },
      { cmd: "casm wait reviewer", maxGap: 1.5 },
      { cmd: "casm history reviewer" },
    ],
  },
  "cli-queue-steer": {
    height: 26,
    steps: [
      { hidden: "casm project create /tmp/code/acme-api --name acme-api && casm run --project acme-api --provider claude --model haiku --mode bypassPermissions --name writer --wait 'Reply with just: ready'" },
      { comment: "# while a turn runs, sends queue up in order" },
      { cmd: `casm send writer "${poem}"` },
      { cmd: 'casm send writer "Then give it a title."' },
      { cmd: 'casm send writer "Then translate it to French."' },
      { cmd: "casm pending", capture: ["french", /^(\w{8}) .*French/m] },
      { comment: "# --steer goes into the running turn instead; cancel drops a queued one" },
      { cmd: 'casm send writer "Make the keeper a retired sailor." --steer' },
      { cmd: "casm cancel writer {french}" },
      { hidden: "casm wait writer; sleep 3; casm wait writer" },
      { cmd: "casm history writer -n 8 | grep -v thinking" },
    ],
  },
  "cli-peers": {
    height: 26,
    steps: [
      { hidden: "true" },
      { comment: "# a peer is another casm server; -H runs any command there" },
      { cmd: "casm peers --probe" },
      { cmd: 'casm -H worker run --project acme-api --provider claude --model haiku --name tests --wait "Run npm test and report the result in one line."', maxGap: 1.5 },
      { cmd: "casm -H worker permissions tests", capture: ["req", /^(\S+)/m] },
      { cmd: "casm -H worker approve tests {req}" },
      { cmd: "casm -H worker wait tests", maxGap: 1.5 },
      { cmd: "casm -H worker agents" },
    ],
  },
  "cli-schedules": {
    height: 20,
    steps: [
      { hidden: "casm project create /tmp/code/acme-api --name acme-api && casm run --project acme-api --provider claude --model haiku --name reviewer --wait 'Reply with just: ready'" },
      { cmd: 'casm schedule add --every 30m --agent reviewer --skip-if-busy "Run npm test; report failures only."' },
      { cmd: 'casm schedule add --cron "0 9 * * 1-5" --project acme-api --provider claude --model haiku --name triage "Summarize yesterday\'s commits."' },
      { cmd: "casm schedules" },
      { cmd: "casm limits" },
      { cmd: "casm usage reviewer" },
    ],
  },
  "cli-orchestration": {
    height: 26,
    steps: [
      { hidden: "casm project create /tmp/code/acme-api --name acme-api" },
      { comment: "# --casm-tools gives an agent casm's MCP tools: it can run agents itself" },
      { cmd: 'casm run --project acme-api --provider claude --model haiku --casm-tools --mode bypassPermissions --name lead --wait "With your casm tools, start a claude haiku agent named helper on host worker in project acme-api with the prompt \'Say hello from worker in five words.\', wait for it and quote its reply in one line."', maxGap: 1.5 },
      { cmd: "casm -H worker agents" },
      { cmd: "casm -H worker history helper" },
    ],
  },
};

// Deterministic typing rhythm.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

async function record(name: string, scene: Scene) {
  const r = spawnSync(join(repo, "scripts/docs-media/lab.sh"), ["up"], { encoding: "utf8", env: { ...process.env, LAB: lab } });
  if (r.status !== 0) throw new Error(`lab up failed: ${r.stderr}`);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${lab}/bin:${process.env.PATH}`, COLUMNS: String(width) };
  for (const k of Object.keys(env)) if (k.startsWith("CASM_")) delete env[k];
  // The lab is fresh; drop its own setup output.
  const vars: Record<string, string> = {};
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

  const events: [number, "o", string][] = [];
  let t = 0;
  const emit = (data: string, dt = 0) => {
    t += dt;
    events.push([Number(t.toFixed(3)), "o", data.replace(/\r?\n/g, "\r\n")]);
  };
  const prompt = () => emit("\x1b[1;35m$\x1b[0m ", 0.4);

  for (const step of scene.steps) {
    if ("hidden" in step) {
      const h = spawnSync("bash", ["-c", step.hidden], { cwd: "/tmp/code/acme-api", env, encoding: "utf8" });
      if (h.status !== 0) throw new Error(`setup failed: ${step.hidden}\n${h.stderr}`);
      if (step.capture) vars[step.capture[0]] = h.stdout.match(step.capture[1])?.[1] ?? "";
      continue;
    }
    prompt();
    const text = "comment" in step ? step.comment : fill(step.cmd);
    if ("comment" in step) {
      for (const ch of text) emit(`\x1b[2m${ch}\x1b[0m`, 0.012 + rand() * 0.02);
      emit("\n", 0.5);
      continue;
    }
    for (const ch of text) emit(ch, 0.025 + rand() * 0.045);
    emit("\n", 0.35);
    const maxGap = step.maxGap ?? 1;
    let last = Date.now();
    let output = "";
    await new Promise<void>((done) => {
      const child = spawn("bash", ["-c", text], { cwd: "/tmp/code/acme-api", env });
      const onData = (d: Buffer) => {
        const now = Date.now();
        emit(d.toString(), Math.min((now - last) / 1000, maxGap));
        last = now;
        output += d.toString();
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("close", () => done());
    });
    if (step.capture) vars[step.capture[0]] = output.match(step.capture[1])?.[1] ?? "";
    t += Math.min((Date.now() - last) / 1000, maxGap);
  }
  prompt();
  emit("", 2.5);

  const lines = [JSON.stringify({ version: 2, width, height: scene.height, env: { SHELL: "/bin/bash", TERM: "xterm-256color" } }), ...events.map((e) => JSON.stringify(e))];
  const cast = join(out, `${name}.cast`);
  writeFileSync(cast, lines.join("\n") + "\n");
  const svg = join(out, `${name}.svg`);
  const s = spawnSync("npx", ["-y", "svg-term-cli", "--in", cast, "--out", svg, "--window", "--no-cursor", "--width", String(width), "--height", String(scene.height), "--padding", "14"], { encoding: "utf8" });
  if (s.status !== 0) throw new Error(`svg-term: ${s.stderr}`);
  console.log(`${name}: ${t.toFixed(1)} s, cast ${(statSync(cast).size / 1024).toFixed(0)} KB, svg ${(statSync(svg).size / 1024).toFixed(0)} KB`);
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenes);
try {
  for (const name of wanted) {
    if (!scenes[name]) throw new Error(`unknown scene ${name}; scenes: ${Object.keys(scenes).join(", ")}`);
    await record(name, scenes[name]);
  }
} finally {
  spawnSync(join(repo, "scripts/docs-media/lab.sh"), ["down"], { env: { ...process.env, LAB: lab } });
}
