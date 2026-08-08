// Container lifecycle. A casm container is a long-lived machine, not the
// ephemeral `--rm` box a benchmark harness wants: the sessions live inside it,
// so it has to survive between invocations. Removing one destroys its sessions,
// which is why cmdContainer makes you confirm.
//
// Mount policy, in one place because it is the part that is easy to get subtly
// wrong. Config is mounted read-only so the container tracks the host with no
// re-seeding and the agent cannot edit it; but only at file granularity, never
// whole agent home directories - all three agents write state (transcripts,
// caches, lock files) directly alongside their config, so a read-only ~/.claude
// breaks claude outright.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOME, die, shq } from "./util.mjs";
import { containerName } from "./nodes.mjs";

export const DEFAULT_IMAGE = "casm/agents";
export const AGENT_NAMES = ["claude", "opencode", "pi"];

// Read-only config parity mounts: [hostPath, containerRelPath]. Deliberately
// files and leaf directories.
//
// NOT here, and each for a reason:
//   ~/.config/opencode/node_modules  - 49M of host-platform native binaries
//                                      (darwin .node files cannot load in linux)
//   ~/.claude/projects, sessions, …  - state the agent must write; also where
//                                      the container's own sessions live
//   ~/.pi/agent/{auth.json,sessions} - secrets and state, seeded/owned separately
//   ~/.ssh/*                         - read-only stops tampering, not reading,
//                                      and an agent here can read and exfiltrate.
//                                      The container gets its own casm key at
//                                      the default path instead, which needs no
//                                      config; git on a mounted project is
//                                      normally done from the host anyway.
const RO_MOUNTS = [
  [".claude/settings.json", ".claude/settings.json"],
  [".claude/plugins", ".claude/plugins"],
  [".claude/skills", ".claude/skills"],
  [".config/opencode/opencode.jsonc", ".config/opencode/opencode.jsonc"],
  [".config/opencode/opencode.json", ".config/opencode/opencode.json"],
  [".config/opencode/skills", ".config/opencode/skills"],
  [".pi/agent/settings.json", ".pi/agent/settings.json"],
  [".pi/agent/models.json", ".pi/agent/models.json"],
  [".gitconfig", ".gitconfig"],
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

const AUTH_SEED = {
  claude: [".claude/.credentials.json"], // absent on macOS - see keychainCredentials
  opencode: [".local/share/opencode/auth.json"],
  pi: [".pi/agent/auth.json"],
};

// gitconfig keys that are meaningless or actively broken inside a linux
// container, so `create` can warn instead of letting git fail confusingly later
const GIT_INCOMPATIBLE = /^(credential\.helper=osxkeychain|gpg\.|commit\.gpgsign|tag\.gpgsign|includeif\.)/i;


const DEFAULT_LIMITS = { memory: "4g", pids: "256", cpus: "2" };

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
function dockerTry(args) {
  try { return { ok: true, out: docker(args) }; }
  catch (e) { return { ok: false, out: "", err: (e.stderr || e.message || "").toString().trim() }; }
}

export function imageExists(image) {
  return dockerTry(["image", "inspect", "--format", "{{.Id}}", image]).ok;
}

// ---------- create ----------

export function buildRunArgs({ name, image, dir, uid, gid, limits = {} }) {
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
  for (const [rel] of RO_MOUNTS) {
    const host = path.join(HOME, rel);
    if (fs.existsSync(host)) args.push("-v", `${host}:${path.posix.join("/casmhome", rel)}:ro`);
  }
  args.push("-e", "HOME=/casmhome", "-e", "OPENCODE_DISABLE_PROJECT_CONFIG=1");
  args.push(image, "sleep", "infinity");
  return args;
}

// opencode's own default is permissive enough for `run`, but the interactive
// TUI gates tools, and the mounted host opencode.jsonc could grow a permission
// block at any time and would then apply inside containers too. So say it
// outright in opencode's managed config, which on linux is /etc/opencode.
//
// This is the default, not an enforcement: OPENCODE_PERMISSION and a user
// config both outrank it, so anyone who sets one deliberately gets what they
// asked for. Every documented surface is listed rather than relying on the "*"
// catch-all, since a per-tool object in a merged config survives a catch-all.
const OPENCODE_MANAGED = JSON.stringify({
  permission: Object.fromEntries(
    ["*", "read", "edit", "glob", "grep", "list", "bash", "task", "external_directory",
     "todowrite", "question", "webfetch", "websearch", "lsp", "doom_loop", "skill"]
      .map((k) => [k, "allow"])),
}, null, 2);

// claude refuses to start with permissions off when it is root, and its rules
// merge across scopes with deny winning - so a mounted host settings.json could
// quietly narrow a container that exists to be permissive. Managed settings are
// the highest-precedence source and cannot be overridden by any other scope,
// including CLI flags, so one file solves both.
const MANAGED_SETTINGS = JSON.stringify({
  permissions: { allowManagedPermissionRulesOnly: true, defaultMode: "bypassPermissions" },
}, null, 2);

export function createContainer({ name, dir, image = DEFAULT_IMAGE, agents = ["claude"], keyPath, keychain = true, withRefresh = false }) {
  if (!imageExists(image))
    die(`docker image "${image}" not found - build it with: casm container build${image === DEFAULT_IMAGE ? "" : ` --image ${image}`}`);
  if (dockerTry(["inspect", containerName(name)]).ok)
    die(`container '${name}' already exists - remove it with: casm container rm ${name}`);

  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const r = dockerTry(buildRunArgs({ name, image, dir, uid, gid }));
  if (!r.ok) die(`docker run failed: ${r.err}`);
  const target = containerName(name);

  // Both policies are root-owned so the agents, which run as the host uid,
  // cannot edit their own policy.
  writePolicy(target, "/etc/claude-code/managed-settings.json", MANAGED_SETTINGS);
  writePolicy(target, "/etc/opencode/opencode.json", OPENCODE_MANAGED);

  // Ordering matters twice over. Before seeding, because docker created the
  // mount parents as root and nothing can be written into HOME until that is
  // undone. After seeding, because `docker cp` lands files owned by root.
  claimHome(target, uid, gid);
  const auth = seedAuth(target, agents, { keychain, withRefresh });
  installKey(target, keyPath);
  claimHome(target, uid, gid);
  return { name, target, dir, image, agents, auth };
}

// Docker creates the parent directory of every bind mount itself, owned by
// root. Since the container runs as the host uid, that leaves ~/.claude and
// friends unwritable, and claude cannot create ~/.claude/projects - which is
// where the container's own sessions have to land for casm to see them at all.
// So hand the home directory back after the mounts exist.
//
// -xdev keeps this off the read-only mounts, each of which is its own device;
// the `|| true` is belt and braces for a runtime that reports them differently.
function claimHome(target, uid, gid) {
  const dirs = STATE_DIRS.map((d) => shq(path.posix.join("/casmhome", d))).join(" ");
  // The host uid does not exist in the image's /etc/passwd, and anything that
  // resolves the current user falls over without an entry - ssh refuses
  // outright with "No user exists for uid", which would break git over ssh.
  docker(["exec", "-u", "0", target, "sh", "-c",
    `grep -q "^[^:]*:x:${uid}:" /etc/passwd || echo "casm:x:${uid}:${gid}:casm:/casmhome:/bin/bash" >> /etc/passwd; ` +
    `grep -q "^[^:]*:x:${gid}:" /etc/group || echo "casm:x:${gid}:" >> /etc/group`]);
  docker(["exec", "-u", "0", target, "sh", "-c",
    `find /casmhome -xdev -exec chown ${uid}:${gid} {} + 2>/dev/null || true`]);
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
function writePolicy(target, containerPath, contents) {
  const dir = path.posix.dirname(containerPath);
  execFileSync("docker", ["exec", "-i", "-u", "0", target, "sh", "-c",
    `mkdir -p ${shq(dir)} && cat > ${shq(containerPath)} && chmod 0644 ${shq(containerPath)}`],
    { input: contents + "\n", stdio: ["pipe", "ignore", "pipe"], timeout: 30000 });
}

function seedAuth(target, agents, { keychain = true, withRefresh = false } = {}) {
  const seeded = [];
  const missing = [];
  for (const a of agents) {
    for (const rel of AUTH_SEED[a] ?? []) {
      const host = path.join(HOME, rel);
      if (!fs.existsSync(host)) { missing.push({ agent: a, rel }); continue; }
      docker(["exec", target, "mkdir", "-p", path.posix.join("/casmhome", path.dirname(rel))]);
      docker(["cp", host, `${target}:${path.posix.join("/casmhome", rel)}`]);
      seeded.push(rel);
    }
  }

  if (agents.includes("claude")) seedClaudeState(target);

  // macOS keeps claude's credentials in the Keychain, so there is no file to
  // copy and the seed above finds nothing. The Keychain item holds the same
  // document claude reads from ~/.claude/.credentials.json on linux, so pull it
  // out and write it in directly.
  let fromKeychain = false;
  let expiresAt = null;
  if (keychain && agents.includes("claude") && missing.some((m) => m.agent === "claude")) {
    const creds = keychainCredentials({ withRefresh });
    if (creds) {
      writeSecret(target, "/casmhome/.claude/.credentials.json", creds.json);
      fromKeychain = true;
      expiresAt = creds.expiresAt;
      missing.splice(missing.findIndex((m) => m.agent === "claude"), 1);
    }
  }
  return { seeded, missing, fromKeychain, expiresAt, withRefresh };
}

// Re-seed a container that is already running, for when its access token has
// expired. Same path as create, plus the ownership fix that `docker cp` needs.
export function reseedAuth({ target, agents, keychain = true, withRefresh = false }) {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const auth = seedAuth(target, agents, { keychain, withRefresh });
  claimHome(target, uid, gid);
  return auth;
}

function seedClaudeState(target) {
  const host = path.join(HOME, CLAUDE_STATE);
  if (!fs.existsSync(host)) return false;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(host, "utf8")); } catch { return false; }
  const trimmed = Object.fromEntries(Object.entries(doc)
    .filter(([k]) => !CLAUDE_STATE_DROP.has(k) && !k.startsWith("cached")));
  writeSecret(target, `/casmhome/${CLAUDE_STATE}`, JSON.stringify(trimmed));
  return true;
}

// The Keychain item claude writes on macOS. Returns { json, expiresAt }, never
// logged, or null when it is absent or the read is refused.
//
// The refresh token is stripped by default. Host and container would otherwise
// hold the same one, and whichever refreshed first could invalidate the other -
// the container silently taking out your host login. Without it claude runs
// happily until the access token expires and then stops, which is a failure you
// can see and fix with `casm container auth`. Pass withRefresh to opt back in.
export function keychainCredentials({ withRefresh = false } = {}) {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("security", ["find-generic-password", "-l", "Claude Code-credentials", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim();
    if (!out) return null;
    const doc = JSON.parse(out); // a truncated or unexpected value is worse than none
    const o = doc.claudeAiOauth;
    if (!o?.accessToken) return null;
    if (!withRefresh) { delete o.refreshToken; delete o.refreshTokenExpiresAt; }
    return { json: JSON.stringify(doc), expiresAt: o.expiresAt ?? null, withRefresh };
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
  docker(["exec", target, "mkdir", "-p", "/casmhome/.ssh"]);
  docker(["cp", keyPath, `${target}:/casmhome/.ssh/id_ed25519`]);
  docker(["cp", keyPath + ".pub", `${target}:/casmhome/.ssh/id_ed25519.pub`]);
  docker(["exec", target, "chmod", "600", "/casmhome/.ssh/id_ed25519"]);
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

export function removeContainer(name) {
  const r = dockerTry(["rm", "-f", containerName(name)]);
  if (!r.ok) die(`could not remove container '${name}': ${r.err}`);
}

// ---------- host-side preflight ----------

export function checkGitConfig() {
  let listed = "";
  try { listed = execFileSync("git", ["config", "--global", "--list"], { encoding: "utf8" }); } catch { return []; }
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

export { seedAuth, RO_MOUNTS, AUTH_SEED };
