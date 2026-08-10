// A node is anywhere casm can run something: this machine, an ssh target, or a
// container. Everything remote casm does goes through the handful of functions
// below, so adding a transport means adding a branch here and nowhere else.
//
// ssh targets stay plain strings (a ~/.ssh/config name or user@host) exactly as
// before; containers are registered in config.json and addressed by their casm
// name, which is why resolveNode consults containers first - a container named
// `rig` should not silently mean the ssh host `rig`.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { die, dim, shq, loadConfig } from "./util.mjs";

export const LOCAL = { kind: "local", target: null, name: "local" };
export const isRemote = (node) => node.kind !== "local";

// containers: { "<casm name>": { container, dir, image, agents } } in config.json
export function loadContainers() {
  const c = loadConfig().containers;
  if (!c || typeof c !== "object" || Array.isArray(c)) return {};
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v)));
}

export const containerName = (name) => `casm-${name}`;

// Addressing, in one place:
//
//   local                     this machine
//   <name>                    a container here, and only ever that
//   <ssh-target>              a machine, e.g. rig or user@box
//   <ssh-target>/<name>       a container on that machine
//
// A bare name is never a remote container. Container names are only unique
// within a machine, so letting a bare name mean "a container somewhere" made a
// local one silently shadow a remote one of the same name, and pointed pushes at
// the wrong machine. The slash is what makes the intent explicit.
export function resolveNode(name) {
  if (!name || name === "local") return LOCAL;

  const slash = name.indexOf("/");
  if (slash > 0) {
    const host = name.slice(0, slash);
    const container = name.slice(slash + 1);
    if (!container || container.includes("/")) die(`bad target '${name}' - use <host>/<container>`);
    return { kind: "ssh-docker", host, container, target: containerName(container), name };
  }

  const cfg = loadContainers()[name];
  if (cfg) return { kind: "docker", target: cfg.container ?? containerName(name), name, cfg };
  return { kind: "ssh", target: name, name };
}

// A container on another machine: ssh there, then docker exec. The inner command
// is quoted once for the remote shell and once more for `bash -lc` inside the
// container, which is why every branch below builds the string in two steps
// rather than interpolating directly.
const viaSsh = (node, inner) => `docker exec ${shq(node.target)} bash -lc ${shq(inner)}`;

// podman's docker shim prints "Emulate Docker CLI using podman..." on the
// stderr of every invocation until /etc/containers/nodocker exists. It is not
// an error, so it must not surface as one when a node's output is relayed.
export const stripShimNoise = (text) =>
  (text ?? "").replace(/^Emulate Docker CLI using podman\..*\n?/gm, "").trimEnd();

export const nodeLabel = (node) =>
  node.kind === "docker" ? `container ${node.name}`
  : node.kind === "ssh-docker" ? `container ${node.container} on ${node.host}`
  : node.kind === "ssh" ? node.name
  : "local";

// ---------- running a command, throwing on failure ----------

const BIG = { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 };

// stderr is captured rather than inherited so podman's shim banner does not
// interleave with casm's own output; a real failure still throws, carrying the
// stderr it captured.
export function exec(node, cmd) {
  const [bin, args] =
    node.kind === "local" ? ["bash", ["-lc", cmd]]
    : node.kind === "ssh" ? ["ssh", [node.target, cmd]]
    : node.kind === "ssh-docker" ? ["ssh", [node.host, viaSsh(node, cmd)]]
    : ["docker", ["exec", node.target, "bash", "-lc", cmd]];
  try {
    return execFileSync(bin, args, { ...BIG, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = stripShimNoise((e.stderr ?? "").toString()) || e.message;
    throw new Error(`${nodeLabel(node)}: ${err}`);
  }
}

// ---------- probing: never prompts, never hangs, never throws ----------

const run = (bin, args, opts = {}) =>
  new Promise((res) => {
    execFile(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      res({ ok: !err, out: stripShimNoise(stdout), err: stripShimNoise(stderr) }));
  });

export function tryExec(node, cmd, connectTimeout = 6) {
  if (node.kind === "local") return run("bash", ["-lc", cmd], { timeout: connectTimeout * 1000 });
  if (node.kind === "ssh")
    return run("ssh", ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`, node.target, cmd]);
  if (node.kind === "ssh-docker")
    return run("ssh", ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`, node.host, viaSsh(node, cmd)]);
  return run("docker", ["exec", node.target, "bash", "-lc", cmd], { timeout: connectTimeout * 1000 });
}

// Run casm on another node and capture its output. `bash -lc` so the login PATH
// (where npm puts global bins) is available.
export function casmOn(node, args, connectTimeout = 10) {
  const inner = ["casm", ...args].map(shq).join(" ");
  if (node.kind === "local") return run("bash", ["-lc", inner]);
  if (node.kind === "ssh")
    return run("ssh", ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`, node.target, `bash -lc ${shq(inner)}`]);
  if (node.kind === "ssh-docker")
    return run("ssh", ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`, node.host, viaSsh(node, inner)]);
  return run("docker", ["exec", node.target, "bash", "-lc", inner]);
}

// ---------- file transfer ----------
// A trailing slash on a source means "the contents of this directory", matching
// rsync. docker cp spells that `dir/.`, so normalise rather than expose the
// difference to callers.
const cpSrc = (p) => (p.endsWith("/") ? p + "." : p);

// A remote container is two hops, so files stage through a temp path on the
// machine in between and are cleaned up whether or not the docker cp succeeds.
const xferTmp = () => `/tmp/casm-xfer-${process.pid}-${Date.now()}`;

// Control calls for the staging dance. stderr is captured rather than inherited:
// podman's shim greets every invocation on stderr, and that banner would
// otherwise land in the middle of a transfer. A real failure still throws, with
// the captured stderr attached.
function sshQuiet(host, cmd) {
  try {
    return execFileSync("ssh", [host, cmd], { ...BIG, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = stripShimNoise((e.stderr ?? "").toString()) || e.message;
    throw new Error(`${host}: ${err}`);
  }
}

function sshDockerCopyTo(node, src, dest) {
  const tmp = xferTmp();
  const dir = src.endsWith("/");
  sshQuiet(node.host, `mkdir -p ${shq(dir ? tmp : tmp + ".d")}`);
  execFileSync("rsync", ["-a", src, `${node.host}:${dir ? tmp + "/" : tmp}`], { stdio: "inherit" });
  sshQuiet(node.host,
    `docker cp ${shq(dir ? tmp + "/." : tmp)} ${shq(node.target)}:${shq(dest)}; rc=$?; rm -rf ${shq(tmp)} ${shq(tmp + ".d")}; exit $rc`);
}

function sshDockerCopyFrom(node, src, dest) {
  const tmp = xferTmp();
  sshQuiet(node.host, `mkdir -p ${shq(tmp)} && docker cp ${shq(node.target)}:${shq(cpSrc(src))} ${shq(tmp + "/")}`);
  try {
    execFileSync("rsync", ["-a", `${node.host}:${tmp}/`, dest], { stdio: "inherit" });
  } finally {
    sshQuiet(node.host, `rm -rf ${shq(tmp)}`);
  }
}

export function copyTo(node, src, dest) {
  if (node.kind === "ssh-docker") return sshDockerCopyTo(node, src, dest);
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
  if (node.kind === "ssh-docker") return sshDockerCopyFrom(node, src, dest);
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
// An agent TUI that dies without unwinding - killed, or cut off with the ssh
// connection - leaves its last attributes set and its cursor hidden on *your*
// terminal, and the shell prompt inherits them. ssh -t and docker exec -it
// restore the line discipline they changed, but nothing restores what the
// program drew. casm handed the terminal over, so casm hands it back.
//
// Deliberately only the two that are always safe to re-assert. Leaving the
// alternate screen is not: a TUI that exited cleanly has already done it, and
// doing it again would restore a saved cursor position over the output you
// wanted to keep.
function restoreTerminal() {
  if (process.stdout.isTTY) process.stdout.write("\x1b[0m\x1b[?25h");
}

export function interactive(node, argv, cwd) {
  try {
    if (node.kind === "local") {
      const r = spawnSync(argv[0], argv.slice(1), { cwd, stdio: "inherit" });
      return r.status ?? 0;
    }
    if (node.kind === "ssh") {
      const remote = `cd ${shq(cwd)} && ${argv.map(shq).join(" ")}`;
      const r = spawnSync("ssh", ["-t", node.target, remote], { stdio: "inherit" });
      return r.status ?? 0;
    }
    if (node.kind === "ssh-docker") {
      const remote = `docker exec -it -w ${shq(cwd)} ${shq(node.target)} ${argv.map(shq).join(" ")}`;
      const r = spawnSync("ssh", ["-t", node.host, remote], { stdio: "inherit" });
      return r.status ?? 0;
    }
    const r = spawnSync("docker", ["exec", "-it", "-w", cwd, node.target, ...argv], { stdio: "inherit" });
    return r.status ?? 0;
  } finally {
    restoreTerminal();
  }
}

// ---------- docker helpers ----------

// `docker info` with no --format: podman's docker shim implements the command
// but not docker's template fields, so `--format {{.ServerVersion}}` fails there
// even though the daemon is perfectly reachable.
export function dockerAvailable() {
  try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10000 }); return true; }
  catch { return false; }
}

// casm's own containers here, by casm name, running or not. `docker ps` without
// -a hides the stopped ones, and after a reboot that is every one of them - but
// their sessions are untouched and still worth listing, so the state travels
// with the name and callers decide. Returns [] when the daemon is down, so a
// stopped Docker never makes the rest of casm look broken.
export function localContainers() {
  try {
    const out = execFileSync("docker",
      ["ps", "-a", "--filter", "label=casm=1", "--format", '{{.Label "casm.name"}}\t{{.State}}'],
      { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!out) return [];
    return out.split("\n").filter(Boolean).map((line) => {
      const [name, state] = line.split("\t");
      return { name, state };
    });
  } catch { return []; }
}
export const containerNames = () => localContainers().map((c) => c.name);

export function containerState(target) {
  try {
    return execFileSync("docker", ["inspect", "--format", "{{.State.Status}}", target],
      { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

// ---------- container lifecycle ----------

// Lifecycle is the one thing that cannot go through exec(), which needs the
// container up already. So docker is addressed on whichever machine hosts the
// container: here for a `docker` node, over ssh for a `ssh-docker` one.
function dockerHost(node, argv, timeout = 60000) {
  if (node.kind === "ssh-docker")
    return run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", node.host,
      ["docker", ...argv].map(shq).join(" ")], { timeout });
  return run("docker", argv, { timeout });
}

// A stopped container is not a broken one. A reboot stops every one of them and
// leaves the sessions inside completely intact, so the useful thing to do is
// start it, not report docker's "can only create exec sessions on running
// containers". A `sleep infinity` container starts in well under a second,
// which is what makes this safe to do from a plain listing.
//
// Returns null when the node is usable, or a reason when it is not.
export async function ensureRunning(node) {
  if (node.kind !== "docker" && node.kind !== "ssh-docker") return null;

  const probe = await dockerHost(node, ["inspect", "--format", "{{.State.Status}}", node.target], 15000);
  if (!probe.ok)
    return `no container '${node.container ?? node.name}'${node.kind === "ssh-docker" ? ` on ${node.host}` : ""}` +
           ` - create it with: casm container create ${node.container ?? node.name} --dir <path>`;
  const state = probe.out.trim();
  if (state === "running") return null;

  const r = await dockerHost(node, ["start", node.target]);
  if (!r.ok) return `could not start container '${node.name}' (${state}): ${r.err || "docker start failed"}`;
  console.error(dim(`started container ${node.name} (was ${state})`));
  return null;
}

export function requireDocker() {
  if (!dockerAvailable()) die("docker is not reachable - is the daemon running?");
}
