// Container lifecycle. A casm container belongs to one session and is
// disposable: its transcripts live in a store on the host, so removing it frees
// disk and loses no conversation, and the next resume builds a fresh one from
// the standard image.
//
// Nothing is replayed into a rebuilt container. The agent is told it is in a
// container that can be reset, and decides for itself what to reinstall.
import { execFileSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { HOME, die, shq } from "./util.mjs";
import { containerName } from "./nodes.mjs";

export const DEFAULT_IMAGE = "casm/agents";

// The container's HOME is the host's own home path, not a stand-in like
// /casmhome. Combined with the project being mounted at its own path, that makes
// every path mean the same thing on both sides: `~` resolves the same, and a
// transcript written inside is readable outside without translation. The
// directory is container-local and mostly empty - only the config mounts and
// whatever the agents write land in it.
const CHOME = HOME;
export const AGENT_NAMES = ["claude", "codex", "opencode", "pi"];

// Agent config, copied in at create time rather than mounted. [path relative to
// home, follows the store].
//
// Copies, not read-only mounts, because every one of these agents writes next to
// its own config - codex persists your model choice into config.toml, and a
// read-only mount makes that fail loudly on every start. A container has a store
// of its own, so a copy it can scribble on costs nothing: the blast radius is
// one container, and a rebuild takes a fresh copy from the host.
//
// The trade is that host changes do not reach a container that already exists.
// That is the right way round - a long-lived session keeps the setup it started
// with, and rebuilding is how you take an updated one.
//
// NOT here, and each for a reason:
//   ~/.config/opencode/node_modules  - 49M of host-platform native binaries
//                                      (darwin .node files cannot load in linux)
//   ~/.claude/projects, sessions, …  - state, and where the session itself lives
//   ~/.pi/agent/auth.json            - a secret, seeded separately
//   ~/.ssh/*                         - an agent in here can read and exfiltrate.
//                                      The container gets its own casm key at the
//                                      default path instead.
const SEED_CONFIG = [
  [".claude/settings.json", true],
  [".claude/plugins", true],
  [".claude/skills", true],
  [".codex/config.toml", true],
  [".codex/skills", true],
  [".config/opencode/opencode.jsonc", false],
  [".config/opencode/opencode.json", false],
  [".config/opencode/skills", false],
  [".pi/agent/settings.json", false],
  [".pi/agent/models.json", false],
  [".gitconfig", false],
];

// Auth files copied in at create time rather than mounted: the agents refresh
// tokens by rewriting them, which a read-only mount would break, and a
// read-write mount of host credentials is not something to hand an agent.
// ~/.claude.json is account and onboarding state, not a credential, but claude
// asks you to log in again without it even when the credential is present.
// `projects` is 185kB of path history on this machine and has no business in a
// container; the cache blobs are large and host-specific; mcpServers points at
// binaries that do not exist inside.
const CLAUDE_STATE = ".claude.json";
const CLAUDE_STATE_DROP = new Set(["projects", "githubRepoPaths", "mcpServers"]);

// [relative path, follows the store]. A store relocates CLAUDE_CONFIG_DIR and
// XDG_DATA_HOME, so claude's and opencode's credentials have to land inside it
// or the agent looks straight past them. pi's does not: only its *sessions* are
// redirected (PI_CODING_AGENT_SESSION_DIR), and its config dir stays in HOME.
const AUTH_SEED = {
  claude: [], // handled by claudeCredential(): a file on linux, the Keychain on macOS
  codex: [[".codex/auth.json", true]],
  opencode: [[".local/share/opencode/auth.json", true]],
  pi: [[".pi/agent/auth.json", false]],
};

// gitconfig keys that are meaningless or actively broken inside a linux
// container, so `create` can warn instead of letting git fail confusingly later
const GIT_INCOMPATIBLE = /^(credential\.helper=osxkeychain|gpg\.|commit\.gpgsign|tag\.gpgsign|includeif\.)/i;


// pids is a fork-bomb backstop, not a workload budget: a real dev session runs
// npm, esbuild, a database and a test runner at once, and 256 is inside that.
const DEFAULT_LIMITS = { memory: "4g", pids: "1024", cpus: "2" };

// Each container gets a small block of ports so an agent can actually show you
// what it built - a web UI, an API, a couple of spares. Published identically
// (20000 inside is 20000 outside), matching how paths are mapped, so a URL the
// agent prints is a URL you can click.
//
// High base to stay clear of the ports you are likely using yourself, and well
// above the 1024 floor that rootless podman cannot bind. Ports are fixed at
// `docker run`, so the block is decided at create time and recorded in the
// container's config; changing it means recreating.
export const PORT_BASE = 20000;
export const PORT_BLOCK = 5;

const portFree = (port) => new Promise((res) => {
  const srv = net.createServer();
  srv.once("error", () => res(false));
  srv.once("listening", () => srv.close(() => res(true)));
  srv.listen(port, "127.0.0.1");
});

// The lowest block that no other casm container has claimed and that nothing
// else is listening on. Checking both matters: config knows about containers
// that are stopped, and a bind test catches everything else on the machine.
export async function allocatePorts(taken, size = PORT_BLOCK) {
  const claimed = new Set();
  for (const [from, to] of taken) for (let p = from; p <= to; p++) claimed.add(p);
  for (let base = PORT_BASE; base < PORT_BASE + 500; base += size) {
    const block = Array.from({ length: size }, (_, i) => base + i);
    if (block.some((p) => claimed.has(p))) continue;
    const free = await Promise.all(block.map(portFree));
    if (free.every(Boolean)) return [base, base + size - 1];
  }
  return null;
}

// Rootless podman maps the host user to container root, so a plain
// `--user <hostuid>` lands on a subuid that owns none of the bind-mounted
// files - the project tree then appears root-owned and read-only from inside,
// which is exactly the symptom it produces. --userns=keep-id maps the host uid
// to the same uid in the container, so the mounts are writable and the user is
// still not root. Docker needs neither and does not accept it.
let podman;
export function isPodman() {
  if (podman !== undefined) return podman;
  try {
    podman = /podman/i.test(execFileSync("docker", ["-v"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }));
  } catch { podman = false; }
  return podman;
}

function docker(args, opts = {}) {
  // stdio pipe on all three: execFileSync forwards the child's stderr to ours
  // by default, which would splatter docker daemon errors over casm output.
  const r = execFileSync("docker", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
  return typeof r === "string" ? r.trim() : "";
}
function dockerTry(args, opts = {}) {
  try { return { ok: true, out: docker(args, opts) }; }
  catch (e) { return { ok: false, out: "", err: (e.stderr || e.message || "").toString().trim() }; }
}

export function imageExists(image) {
  return dockerTry(["image", "inspect", "--format", "{{.Id}}", image]).ok;
}

// ---------- create ----------

// `store` is the session's state root on the host. It is mounted at its own path
// like the project, and the three agents are pointed into it, so their
// transcripts land on the host rather than inside the container. That is what
// lets casm list and search a containerized session without entering it, and
// what makes the container disposable without losing the conversation.
export function buildRunArgs({ name, image, dir, uid, gid, limits = {}, ports = null, store = null }) {
  const l = { ...DEFAULT_LIMITS, ...limits };
  const args = [
    "run", "-d",
    "--name", containerName(name),
    "--label", "casm=1",
    "--label", `casm.name=${name}`,
    "--label", `casm.dir=${dir}`,
    // SELinux hosts (fedora) refuse every bind mount without this unless the
    // mounts are relabelled, and relabelling would rewrite the context of the
    // user's own files. Namespaces remain the boundary; inert without SELinux.
    "--security-opt", "label=disable",
    // So a reboot does not leave every container down with its sessions
    // stranded inside. `unless-stopped` and not `always`, so one you stop by
    // hand stays stopped. Docker honours this on daemon start; rootless podman
    // needs `systemctl --user enable podman-restart.service` as well, which is
    // why casm also starts a stopped container on demand rather than relying
    // on this alone.
    "--restart", "unless-stopped",
    // Without an init, PID 1 is `sleep infinity`, which never calls wait(). Every
    // orphan inside the container reparents to it and stays a zombie forever,
    // each holding a slot against --pids-limit until fork() starts failing and
    // *every* command dies, `echo` included. --init makes PID 1 a real init
    // (tini on docker, catatonit on podman) that reaps them.
    "--init",
    "--memory", l.memory,
    "--pids-limit", l.pids,
    "--cpus", String(l.cpus),
    // Non-root, at the host uid: bypassPermissions refuses to run as root, and
    // files written into the mounted project must belong to you on the host.
    ...(isPodman() ? ["--userns=keep-id"] : ["--user", `${uid}:${gid}`]),
    // The project is mounted at its own host path, so every path recorded in a
    // transcript is valid on both sides and push/pull need no translation.
    "-v", `${dir}:${dir}`,
    "-w", dir,
  ];
  if (ports) {
    for (let p = ports[0]; p <= ports[1]; p++) args.push("-p", `${p}:${p}`);
    args.push("--label", `casm.ports=${ports[0]}-${ports[1]}`);
  }
  // HOME stays the host's own home path so `~` and the project path mean the
  // same thing on both sides. Only agent *state* moves, via the three variables
  // below - each verified to relocate its agent's store.
  args.push("-e", `HOME=${CHOME}`, "-e", "OPENCODE_DISABLE_PROJECT_CONFIG=1");
  if (store) {
    args.push("-v", `${store}:${store}`);
    args.push(
      "-e", `CLAUDE_CONFIG_DIR=${path.posix.join(store, ".claude")}`,
      "-e", `PI_CODING_AGENT_SESSION_DIR=${path.posix.join(store, ".pi", "agent", "sessions")}`,
      "-e", `XDG_DATA_HOME=${path.posix.join(store, ".local", "share")}`,
      "-e", `CODEX_HOME=${path.posix.join(store, ".codex")}`,
      // where the agent records what it installs, so a reset can rebuild it
      "-e", `CASM_SETUP=${path.posix.join(store, ".casm", "setup.sh")}`,
    );
  }
  // so an agent can discover what it is allowed to bind without being told
  if (ports) args.push("-e", `CASM_PORTS=${ports[0]}-${ports[1]}`, "-e", `PORT=${ports[0]}`);
  args.push(image, "sleep", "infinity");
  return args;
}

// What a containerized agent is told about where it is. Injected on the argv
// for claude and pi (`--append-system-prompt`), which cannot be edited away, and
// written as AGENTS.md for opencode, which has no equivalent flag.
//
// The text is constant: it becomes part of the system prompt, so varying it per
// session would re-cache the prompt prefix on every resume for no benefit. It
// also says what NOT to do - an agent that helpfully commits a Dockerfile to a
// mounted repo has done damage that outlives its container.
export const CONTAINER_BRIEF = [
  "You are running inside a container managed by casm.",
  "",
  "- The project directory is mounted from the host and persists. Everything else in this container is disposable and can be reset at any time.",
  "- Anything you install (apt packages, global npm packages, language runtimes, services) is lost when it is reset. A reset gives you the stock image back, nothing more - casm does not replay anything for you.",
  "- $CASM_SETUP is yours to use as a record of the OS-level setup this work needs. Keep it idempotent, append to it as you install things, and if you find the environment bare, read it and decide for yourself what is worth reinstalling.",
  "- Do not add setup instructions, Dockerfiles or environment notes to the project's own files unless they belong there for the project's own sake.",
  "- Permission prompts are off in here. The container is the boundary, so work without asking for approval to run commands.",
].join("\n");

// opencode's own default is permissive enough for `run`, but the interactive
// TUI gates tools, and the mounted host opencode.jsonc could grow a permission
// block at any time and would then apply inside containers too. So say it
// outright in opencode's managed config, which on linux is /etc/opencode.
//
// This is the default, not an enforcement: OPENCODE_PERMISSION and a user
// config both outrank it, so anyone who sets one deliberately gets what they
// asked for. Every documented surface is listed rather than relying on the "*"
// catch-all, since a per-tool object in a merged config survives a catch-all.
const OPENCODE_BRIEF_FILE = "/etc/opencode/casm-brief.md";
const OPENCODE_MANAGED = JSON.stringify({
  permission: Object.fromEntries(
    ["*", "read", "edit", "glob", "grep", "list", "bash", "task", "external_directory",
     "todowrite", "question", "webfetch", "websearch", "lsp", "doom_loop", "skill"]
      .map((k) => [k, "allow"])),
  // opencode has no --append-system-prompt, so its copy of the brief is a file
  // referenced from the managed config. Both are root-owned, which gets it the
  // same tamper-resistance the argv gives claude and pi. "AGENTS.md" is
  // opencode's own default and is repeated here because setting the key at all
  // replaces it, and a project's AGENTS.md should still be read.
  instructions: ["AGENTS.md", OPENCODE_BRIEF_FILE],
}, null, 2);

// claude refuses to start with permissions off when it is root, and its rules
// merge across scopes with deny winning - so a mounted host settings.json could
// quietly narrow a container that exists to be permissive. Managed settings are
// the highest-precedence source and cannot be overridden by any other scope,
// including CLI flags, so one file solves both.
const MANAGED_SETTINGS = JSON.stringify({
  permissions: { allowManagedPermissionRulesOnly: true, defaultMode: "bypassPermissions" },
}, null, 2);

export function createContainer({ name, dir, image = DEFAULT_IMAGE, agents = ["claude"], keyPath, keychain = true, withRefresh = false, sudo = true, ports = null, store = null, onStep = () => {} }) {
  if (!imageExists(image))
    die(`docker image "${image}" not found - rebuild it by retrying the containerized session command`);
  if (dockerTry(["inspect", containerName(name)]).ok)
    die(`container '${name}' already exists - remove it with: docker rm -f ${containerName(name)}`);

  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  onStep("starting the container");
  const r = dockerTry(buildRunArgs({ name, image, dir, uid, gid, ports, store }));
  if (!r.ok) die(`docker run failed: ${r.err}`);
  const target = containerName(name);

  // Both policies are root-owned so the agents, which run as the host uid,
  // cannot edit their own policy.
  onStep("turning off permission prompts");
  writePolicy(target, "/etc/claude-code/managed-settings.json", MANAGED_SETTINGS);
  writePolicy(target, "/etc/opencode/opencode.json", OPENCODE_MANAGED);
  if (store) writePolicy(target, OPENCODE_BRIEF_FILE, CONTAINER_BRIEF);

  // Ordering matters twice over. Before seeding, because docker created the
  // mount parents as root and nothing can be written into HOME until that is
  // undone. After seeding, because `docker cp` lands files owned by root.
  onStep("claiming the home directory");
  claimHome(target, uid, gid, sudo);
  onStep("copying your agent settings in");
  seedConfig(target, store);
  onStep("seeding credentials");
  const auth = seedAuth(target, agents, { keychain, withRefresh, dir, store });
  onStep("installing the container's ssh key");
  installKey(target, keyPath);
  claimHome(target, uid, gid, sudo);
  return { name, target, dir, image, agents, auth, ports };
}

// Docker creates the parent directory of every bind mount itself, owned by
// root. Since the container runs as the host uid, that leaves ~/.claude and
// friends unwritable, and claude cannot create ~/.claude/projects - which is
// where the container's own sessions have to land for casm to see them at all.
// So hand the home directory back after the mounts exist.
//
// -xdev keeps this off the read-only mounts, each of which is its own device;
// the `|| true` is belt and braces for a runtime that reports them differently.
function claimHome(target, uid, gid, sudo = true) {
  const dirs = STATE_DIRS.map((d) => shq(path.posix.join(CHOME, d))).join(" ");
  // The host uid does not exist in the image's /etc/passwd, and anything that
  // resolves the current user falls over without an entry - ssh refuses
  // outright with "No user exists for uid", which would break git over ssh.
  docker(["exec", "-u", "0", target, "sh", "-c",
    `grep -q "^[^:]*:x:${uid}:" /etc/passwd || echo "casm:x:${uid}:${gid}:casm:${CHOME}:/bin/bash" >> /etc/passwd; ` +
    `grep -q "^[^:]*:x:${gid}:" /etc/group || echo "casm:x:${gid}:" >> /etc/group; ` +
    // sudo authenticates through PAM, whose account stack rejects a user with no
    // shadow entry ("account validation failure, is your account locked?"), so
    // the passwd line alone is not enough. `*` means no password rather than
    // locked, which is what `!` would mean.
    `U=$(getent passwd ${uid} | cut -d: -f1); ` +
    `[ -n "$U" ] && { grep -q "^$U:" /etc/shadow || echo "$U:*:20000:0:99999:7:::" >> /etc/shadow; }`]);
  // Passwordless sudo, so the agent can install what it needs. The container is
  // the boundary and root inside does not cross it. The one thing this gives up
  // is that the agent could now rewrite its own policy files, which costs
  // nothing while those policies say "allow everything".
  if (sudo) {
    docker(["exec", "-u", "0", target, "sh", "-c",
      `printf '#%s\\n' "casm: passwordless sudo for a dedicated session container" > /etc/sudoers.d/casm; ` +
      `printf '%s ALL=(ALL) NOPASSWD:ALL\\n' "#${uid}" >> /etc/sudoers.d/casm; ` +
      `chmod 0440 /etc/sudoers.d/casm`]);
  }
  docker(["exec", "-u", "0", target, "sh", "-c",
    `mkdir -p ${shq(CHOME)}; find ${shq(CHOME)} -xdev -exec chown ${uid}:${gid} {} + 2>/dev/null || true`]);
  // Pre-create the directories the agents write into, so the first run does not
  // have to, and so their ownership is right from the start.
  docker(["exec", target, "sh", "-c", `mkdir -p ${dirs}`]);
}

// Where each agent keeps the state casm reads back: transcripts and, for
// opencode, the database. Never mounted - this is the container's own.
const STATE_DIRS = [
  ".claude/projects", ".claude/sessions",
  ".pi/agent/sessions",
  ".local/share/opencode",
];

// Written over stdin as root, so nothing lands on the host and the agent, which
// is not root, cannot rewrite the rules it runs under.
// Everything written here is root-owned on purpose: the agents run as your uid,
// so they can read these but not rewrite the rules they are governed by.
function writePolicy(target, containerPath, contents) {
  const dir = path.posix.dirname(containerPath);
  execFileSync("docker", ["exec", "-i", "-u", "0", target, "sh", "-c",
    `mkdir -p ${shq(dir)} && cat > ${shq(containerPath)} && chmod 0644 ${shq(containerPath)}`],
    { input: contents + "\n", stdio: ["pipe", "ignore", "pipe"], timeout: 30000 });
}

// Your agent config, as a writable copy inside the container. Missing files are
// skipped silently - not everyone has plugins, skills or a gitconfig.
function seedConfig(target, store = null) {
  for (const [rel, inStore] of SEED_CONFIG) {
    const host = path.join(HOME, rel);
    if (!fs.existsSync(host)) continue;
    const dest = path.posix.join(inStore && store ? store : CHOME, rel);
    try { copyInto(target, host, dest); } catch (e) {
      console.error(`could not copy ~/${rel} into the container: ${(e.stderr || e.message || "").toString().trim()}`);
    }
  }
  // only when there is a registry to repoint - most people have no plugins
  if (store && fs.existsSync(path.join(HOME, ".claude", "plugins"))) repointPlugins(target, store);
}

// `docker cp` refuses any symlink that points outside the tree it is copying,
// and every agent's skills directory is commonly a farm of links into a shared
// ~/.agents/skills. `docker cp -L` does not help: it fails identically and
// leaves a partial copy behind. Streaming a dereferenced tar copies what the
// links point at, so the container gets real files and nothing dangles.
function copyInto(target, host, dest) {
  const parent = path.posix.dirname(dest);
  docker(["exec", target, "mkdir", "-p", parent]);
  // -h dereferences the symlinks; the xattr flags keep macOS out of the stream,
  // where com.apple.provenance and AppleDouble files make the extract fail with
  // "lsetxattr … operation not supported" on a linux container.
  const flags = ["-ch", "--no-xattrs"];
  if (process.platform === "darwin") flags.push("--no-mac-metadata");
  const tar = execFileSync("tar", [...flags, "-C", path.dirname(host), path.basename(host)],
    { maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("docker", ["cp", "-", `${target}:${parent}`],
    { input: tar, maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "ignore", "pipe"] });
}

// claude's plugin registry stores absolute paths to each plugin's files, all
// under $HOME/.claude/plugins. A store moves the whole directory somewhere else,
// so every one of those paths points at nothing inside the container and no
// plugin loads - the files are all present, and claude cannot find any of them.
//
// Rewriting the registry is the narrow fix: the directory is copied, so the same
// relative layout exists under the new root and only the prefix is wrong.
function repointPlugins(target, store) {
  const to = path.posix.join(store, ".claude", "plugins");
  // Any `…/.claude/plugins` prefix, not just this machine's home: the registry
  // carries whatever path the host recorded, which is not always the home casm
  // is running under.
  const script = `
    const fs = require("fs"), path = require("path"), dir = ${JSON.stringify(to)};
    if (!fs.existsSync(dir)) process.exit(0);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(dir, f);
      let t; try { t = fs.readFileSync(p, "utf8"); } catch { continue; }
      const n = t.replace(/"[^"]*\\/\\.claude\\/plugins/g, '"' + dir);
      if (n !== t) fs.writeFileSync(p, n);
    }`;
  try {
    execFileSync("docker", ["exec", "-i", "-u", "0", target, "node"],
      { input: script, stdio: ["pipe", "ignore", "pipe"], timeout: 30000 });
  } catch (e) {
    console.error(`could not repoint the plugin registry: ${(e.stderr || e.message || "").toString().trim()}`);
  }
}


function seedAuth(target, agents, { keychain = true, withRefresh = false, dir = null, store = null } = {}) {
  const seeded = [];
  const missing = [];
  const base = (inStore) => (inStore && store ? store : CHOME);
  for (const a of agents) {
    for (const [rel, inStore] of AUTH_SEED[a] ?? []) {
      const host = path.join(HOME, rel);
      if (!fs.existsSync(host)) { missing.push({ agent: a, rel }); continue; }
      docker(["exec", target, "mkdir", "-p", path.posix.join(base(inStore), path.dirname(rel))]);
      docker(["cp", host, `${target}:${path.posix.join(base(inStore), rel)}`]);
      seeded.push(rel);
    }
  }

  let claude = null;
  if (keychain && agents.includes("claude")) {
    claude = claudeCredential({ withRefresh });
    if (claude) {
      seedClaudeState(target, dir, store);
      writeSecret(target, path.posix.join(base(true), ".claude/.credentials.json"), claude.json);
    } else {
      missing.push({ agent: "claude", rel: ".claude/.credentials.json" });
    }
  }
  return { seeded, missing, claude };
}

// Re-seed a container that is already running, for when its access token has
// expired. Same path as create, plus the ownership fix that `docker cp` needs.
export function reseedAuth({ target, agents, keychain = true, withRefresh = false, dir = null, store = null }) {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const auth = seedAuth(target, agents, { keychain, withRefresh, dir, store });
  claimHome(target, uid, gid);
  return auth;
}

// CLAUDE_CONFIG_DIR relocates this file too: with a store in play claude reads
// <store>/.claude/.claude.json and ignores $HOME/.claude.json entirely. Seeding
// the old location left every containerized session running claude's first-run
// onboarding - theme picker and all - on top of the conversation it had just
// resumed.
function seedClaudeState(target, dir, store = null) {
  const host = path.join(HOME, CLAUDE_STATE);
  if (!fs.existsSync(host)) return false;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(host, "utf8")); } catch { return false; }
  const trimmed = Object.fromEntries(Object.entries(doc)
    .filter(([k]) => !CLAUDE_STATE_DROP.has(k) && !k.startsWith("cached")));
  // Trust the mounted directory. `projects` is dropped above because it is host
  // path history, but choosing `--dir` is the act of trusting it, so making the
  // container ask again on first launch is a prompt with no decision in it.
  if (dir) {
    trimmed.projects = { [dir]: {
      allowedTools: [], hasTrustDialogAccepted: true,
      mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
    } };
  }
  // Deliberately NOT seeding bypassPermissionsModeAccepted. claude's bypass-mode
  // warning is worth seeing: it is the confirmation that prompts really are off
  // in here, which is the whole reason the container exists. casm always hands
  // over a terminal, so there is someone present to accept it.
  const dest = store ? path.posix.join(store, ".claude", CLAUDE_STATE) : `${CHOME}/${CLAUDE_STATE}`;
  writeSecret(target, dest, JSON.stringify(trimmed));
  return true;
}

// Claude's credential from wherever this OS keeps it: ~/.claude/.credentials.json
// on linux, the Keychain on macOS. Returns { json, expiresAt, source }, never
// logged, or null when absent or unreadable.
//
// **The refresh token is stripped**, on both platforms. Host and container would
// otherwise hold the same one, and whichever refreshes first invalidates the
// other - a container quietly taking out your host login, which is not a
// theoretical risk: it happened on a Fedora host during testing, and copying the
// file wholesale was the cause. Without it claude runs until the access token
// expires and then stops, which is visible and fixed by `casm auth`.
// Pass withRefresh to opt back in.
export function claudeCredential({ withRefresh = false } = {}) {
  const file = path.join(HOME, ".claude", ".credentials.json");
  let raw = null, source = null;
  if (fs.existsSync(file)) {
    try { raw = fs.readFileSync(file, "utf8"); source = "~/.claude/.credentials.json"; } catch {}
  }
  if (raw === null && process.platform === "darwin") {
    raw = keychainRead();
    source = "macOS Keychain";
  }
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw); // a truncated or unexpected value is worse than none
    const o = doc.claudeAiOauth;
    if (!o?.accessToken) return null;
    if (!withRefresh) { delete o.refreshToken; delete o.refreshTokenExpiresAt; }
    return { json: JSON.stringify(doc), expiresAt: o.expiresAt ?? null, source, withRefresh };
  } catch { return null; }
}

function keychainRead() {
  try {
    const out = execFileSync("security", ["find-generic-password", "-l", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim();
    return out || null;
  } catch { return null; }
}

// Secrets go in over stdin rather than through a temp file, so they never touch
// the host disk, and never through argv, where `ps` would show them.
function writeSecret(target, containerPath, contents) {
  const dir = path.posix.dirname(containerPath);
  execFileSync("docker", ["exec", "-i", target, "sh", "-c",
    `umask 077 && mkdir -p ${shq(dir)} && cat > ${shq(containerPath)}`],
    { input: contents, stdio: ["pipe", "ignore", "pipe"], timeout: 30000 });
}

function installKey(target, keyPath) {
  if (!keyPath || !fs.existsSync(keyPath)) return;
  docker(["exec", target, "mkdir", "-p", `${CHOME}/.ssh`]);
  docker(["cp", keyPath, `${target}:${CHOME}/.ssh/id_ed25519`]);
  docker(["cp", keyPath + ".pub", `${target}:${CHOME}/.ssh/id_ed25519.pub`]);
  docker(["exec", target, "chmod", "600", `${CHOME}/.ssh/id_ed25519`]);
}

// ---------- inspect / remove ----------

export function containerRows() {
  const r = dockerTry(["ps", "-a", "--filter", "label=casm=1", "--format",
    '{{.Label "casm.name"}}\t{{.State}}\t{{.Image}}\t{{.Label "casm.dir"}}']);
  if (!r.ok || !r.out) return [];
  return r.out.split("\n").filter(Boolean).map((line) => {
    const [name, state, image, dir] = line.split("\t");
    return { name, state, image, dir };
  });
}

// podman waits for a graceful stop before killing, and a container with a live
// exec session in it (an interactive agent, say) can sit in `Stopping` for the
// whole timeout or longer. `-t 0` goes straight to SIGKILL; docker's rm has no
// such flag and kills immediately anyway. The hard timeout is the backstop:
// without one, execFileSync waits forever and casm hangs with no explanation.
export function removeContainer(name) {
  const target = containerName(name);
  const args = ["rm", "-f", ...(isPodman() ? ["-t", "0"] : []), target];
  const r = dockerTry(args, { timeout: 60000 });
  if (!r.ok) {
    die(`could not remove container '${name}': ${r.err || "timed out"}\n` +
        `remove it by hand with: docker rm -f ${isPodman() ? "-t 0 " : ""}${target}`);
  }
}

// ---------- host-side preflight ----------

export function checkGitConfig() {
  let listed = "";
  // stderr ignored: with no ~/.gitconfig git writes "fatal: unable to read
  // config file" to it, which is not an error here - it just means there is
  // nothing to warn about - and it would land in the middle of casm's output.
  try { listed = execFileSync("git", ["config", "--global", "--list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return []; }
  return listed.split("\n").filter((l) => GIT_INCOMPATIBLE.test(l.trim()));
}

// One dedicated key, shared across containers: it is revocable without touching
// your real identity, and it is one thing to add to a forge rather than one per
// container. Never a mount of ~/.ssh.
export function ensureCasmKey() {
  const dir = path.join(HOME, ".config", "casm", "ssh");
  const key = path.join(dir, "id_ed25519");
  if (fs.existsSync(key)) return { key, created: false };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "casm", "-f", key], { stdio: "ignore" });
  return { key, created: true };
}

// On macOS claude keeps credentials in the Keychain, so there is no
// .credentials.json to seed and a file copy would silently produce a container
// that cannot authenticate.
export function claudeAuthPlan() {
  if (fs.existsSync(path.join(HOME, ".claude", ".credentials.json"))) return { kind: "file" };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { kind: "env", name: "CLAUDE_CODE_OAUTH_TOKEN" };
  if (process.env.ANTHROPIC_API_KEY) return { kind: "env", name: "ANTHROPIC_API_KEY" };
  return { kind: "none" };
}

export { seedAuth, SEED_CONFIG, AUTH_SEED };
