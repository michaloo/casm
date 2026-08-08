// A node is anywhere casm can run something: this machine, an ssh target, or a
// container. Everything remote casm does goes through the handful of functions
// below, so adding a transport means adding a branch here and nowhere else.
//
// ssh targets stay plain strings (a ~/.ssh/config name or user@host) exactly as
// before; containers are registered in config.json and addressed by their casm
// name, which is why resolveNode consults containers first - a container named
// `rig` should not silently mean the ssh host `rig`.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { die, shq, loadConfig } from "./util.mjs";

export const LOCAL = { kind: "local", target: null, name: "local" };
export const isRemote = (node) => node.kind !== "local";

// containers: { "<casm name>": { container, dir, image, agents } } in config.json
export function loadContainers() {
  const c = loadConfig().containers;
  if (!c || typeof c !== "object" || Array.isArray(c)) return {};
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v)));
}

export const containerName = (name) => `casm-${name}`;

// A bare name resolves to a container if one is registered, otherwise it is
// taken as an ssh target - unregistered ssh targets keep working, which is what
// `--host user@box` has always done.
export function resolveNode(name) {
  if (!name || name === "local") return LOCAL;
  const cfg = loadContainers()[name];
  if (cfg) return { kind: "docker", target: cfg.container ?? containerName(name), name, cfg };
  return { kind: "ssh", target: name, name };
}

export const nodeLabel = (node) => (node.kind === "docker" ? `container ${node.name}` : node.kind === "ssh" ? node.name : "local");

// ---------- running a command, throwing on failure ----------

const BIG = { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 };

export function exec(node, cmd) {
  if (node.kind === "local") return execFileSync("bash", ["-lc", cmd], BIG).trim();
  if (node.kind === "ssh") return execFileSync("ssh", [node.target, cmd], BIG).trim();
  return execFileSync("docker", ["exec", node.target, "bash", "-lc", cmd], BIG).trim();
}

// ---------- probing: never prompts, never hangs, never throws ----------

const run = (bin, args, opts = {}) =>
  new Promise((res) => {
    execFile(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      res({ ok: !err, out: (stdout ?? "").trimEnd(), err: (stderr ?? "").trimEnd() }));
  });

export function tryExec(node, cmd, connectTimeout = 6) {
  if (node.kind === "local") return run("bash", ["-lc", cmd], { timeout: connectTimeout * 1000 });
  if (node.kind === "ssh")
    return run("ssh", ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`, node.target, cmd]);
  return run("docker", ["exec", node.target, "bash", "-lc", cmd], { timeout: connectTimeout * 1000 });
}

// Run casm on another node and capture its output. `bash -lc` so the login PATH
// (where npm puts global bins) is available.
export function casmOn(node, args, connectTimeout = 10) {
  const inner = ["casm", ...args].map(shq).join(" ");
  if (node.kind === "local") return run("bash", ["-lc", inner]);
  if (node.kind === "ssh")
    return run("ssh", ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`, node.target, `bash -lc ${shq(inner)}`]);
  return run("docker", ["exec", node.target, "bash", "-lc", inner]);
}

// ---------- file transfer ----------
// A trailing slash on a source means "the contents of this directory", matching
// rsync. docker cp spells that `dir/.`, so normalise rather than expose the
// difference to callers.
const cpSrc = (p) => (p.endsWith("/") ? p + "." : p);

export function copyTo(node, src, dest) {
  if (node.kind === "local") {
    execFileSync("bash", ["-lc", `mkdir -p ${shq(dest.replace(/\/[^/]*$/, "") || "/")} && cp -a ${shq(cpSrc(src))} ${shq(dest)}`], BIG);
    return;
  }
  if (node.kind === "ssh") {
    execFileSync("rsync", ["-a", src, `${node.target}:${dest}`], { stdio: "inherit" });
    return;
  }
  execFileSync("docker", ["cp", cpSrc(src), `${node.target}:${dest}`], { stdio: "inherit" });
}

export function copyFrom(node, src, dest) {
  if (node.kind === "local") {
    execFileSync("bash", ["-lc", `cp -a ${shq(cpSrc(src))} ${shq(dest)}`], BIG);
    return;
  }
  if (node.kind === "ssh") {
    execFileSync("rsync", ["-a", `${node.target}:${src}`, dest], { stdio: "inherit" });
    return;
  }
  execFileSync("docker", ["cp", `${node.target}:${cpSrc(src)}`, dest], { stdio: "inherit" });
}

// ---------- handing over the terminal ----------
// The whole point of `-t` / `-it`: without a tty the agents' TUIs do not render,
// colours vanish and ctrl-c goes to the wrong process. argv is passed as an
// array locally and for docker; ssh only takes a command string, so it is
// quoted there and nowhere else.
export function interactive(node, argv, cwd) {
  if (node.kind === "local") {
    const r = spawnSync(argv[0], argv.slice(1), { cwd, stdio: "inherit" });
    return r.status ?? 0;
  }
  if (node.kind === "ssh") {
    const remote = `cd ${shq(cwd)} && ${argv.map(shq).join(" ")}`;
    const r = spawnSync("ssh", ["-t", node.target, remote], { stdio: "inherit" });
    return r.status ?? 0;
  }
  const r = spawnSync("docker", ["exec", "-it", "-w", cwd, node.target, ...argv], { stdio: "inherit" });
  return r.status ?? 0;
}

// ---------- docker helpers ----------

// `docker info` with no --format: podman's docker shim implements the command
// but not docker's template fields, so `--format {{.ServerVersion}}` fails there
// even though the daemon is perfectly reachable.
export function dockerAvailable() {
  try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10000 }); return true; }
  catch { return false; }
}

// casm's own containers, by casm name. Returns [] when the daemon is down, so a
// stopped Docker never makes the rest of casm look broken.
export function runningContainers() {
  try {
    const out = execFileSync("docker", ["ps", "--filter", "label=casm=1", "--format", "{{.Label \"casm.name\"}}"],
      { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out ? out.split("\n").filter(Boolean) : [];
  } catch { return []; }
}

export function containerState(target) {
  try {
    return execFileSync("docker", ["inspect", "--format", "{{.State.Status}}", target],
      { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

export function requireDocker() {
  if (!dockerAvailable()) die("docker is not reachable - is the daemon running?");
}
