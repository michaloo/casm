// shared helpers: terminal colors, config, file readers.
// Running things on other machines lives in nodes.mjs, which owns every
// transport (local, ssh, docker exec) behind one interface.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const HOME = os.homedir();
export const CONFIG_PATH = path.join(HOME, ".config", "casm", "config.json");

export const dim = (s) => `\x1b[2m${s}\x1b[0m`;
export const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
export const green = (s) => `\x1b[32m${s}\x1b[0m`;
export const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
export const magenta = (s) => `\x1b[35m${s}\x1b[0m`;
export const blue = (s) => `\x1b[34m${s}\x1b[0m`;
// Anything that came out of a transcript is untrusted terminal input, not text.
// Agent sessions are full of pasted build logs, git output and screen captures,
// so escape sequences reach casm routinely - and one printed verbatim drives
// *your* terminal: ESC[8m conceals everything typed afterwards, ESC[?1049h
// switches to the alt screen, a lone CR overwrites the line. Strip the lot at
// the point the text enters casm and every column, snippet and preview below is
// plain text by construction.
//
// Order matters. The string-introducers go first, since their payload can
// contain anything including CSI-looking bytes; then CSI, terminated or not,
// because an unterminated one is exactly what a truncate leaves behind; then
// whatever single-character escape is left - ESC c alone resets the whole
// terminal, and its final byte is outside the usual two-character range. Tab
// and CR become spaces because callers collapse whitespace anyway.
export const plain = (s) =>
  String(s ?? "")
    .replace(/\x1b[\]P^_X][\s\S]*?(?:\x07|\x1b\\|$)/g, "")  // OSC/DCS/PM/APC/SOS, to BEL or ST
    .replace(/\x1b\[[0-9;?<>=!]*[\x20-\x2f]*[@-~]?/g, "")   // CSI, terminated or not
    .replace(/\x1b[\x20-\x7e]?/g, "")                       // any other escape, and a lone ESC
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")  // remaining C0/C1
    .replace(/[\t\r]/g, " ");

// Cutting a coloured string mid-sequence is how a terminal ends up waiting for
// a final byte that never comes, swallowing the newline and the front of your
// shell prompt with it. Callers should be handing these plain text, but they
// also pass casm's own colours through, so refuse to leave a chopped escape
// behind rather than trusting every call site to have got it right.
const cut = (s, n) => {
  const out = s.slice(0, n);
  const open = out.search(/\x1b(\[[0-9;?<>=!]*[\x20-\x2f]*)?$/);
  return (open === -1 ? out : out.slice(0, open)) + "…";
};
export const pad = (s, n) => (s.length > n ? cut(s, n - 1) : s.padEnd(n));
export const truncate = (s, n) => (s.length > n ? cut(s, n - 1) : s);
export const fmtAge = (s) =>
  s < 60 ? `${Math.round(s)}s`
  : s < 3600 ? `${Math.round(s / 60)}m`
  : s < 172800 ? `${(s / 3600).toFixed(1)}h`
  : `${(s / 86400).toFixed(1)}d`;
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const shq0 = (s) => `'${String(s).replace(/'/g, "''")}'`; // sql-quote

// Failure messages routinely carry text casm did not write: a remote shell's
// stderr, a docker error, whatever the user typed as a target. None of it is
// coloured, so the whole message is stripped rather than trusting each caller.
export function die(msg) { console.error(`casm: ${plain(msg)}`); process.exit(1); }

// listings show ids truncated with a "…"; tolerate it being pasted straight back
export const normalizeIdPrefix = (p) => (p ? p.replace(/[….]+$/, "") : p);

export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}
// like loadConfig, but refuses to continue on a malformed file - callers that
// write it back would otherwise silently discard whatever is in there
export function loadConfigForWrite() {
  let raw;
  try { raw = fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return {}; }
  try {
    const cfg = JSON.parse(raw);
    if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("not an object");
    if (cfg.hosts !== undefined && (cfg.hosts === null || typeof cfg.hosts !== "object"))
      die(`${CONFIG_PATH}: "hosts" is not a list - fix it by hand first`);
    return cfg;
  } catch { die(`${CONFIG_PATH} is not valid JSON - fix or remove it first`); }
}
export function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, CONFIG_PATH);
}
// hosts is a list of ssh targets - a ~/.ssh/config name, or user@host.
// anything fancier (port, identity, proxy) belongs in ~/.ssh/config, not here.
export function normalizeHosts(cfg) {
  const h = cfg.hosts;
  if (Array.isArray(h)) return h.filter((x) => typeof x === "string" && x);
  // pre-0.6 alias map: { "rig": "user@rig.local", "fedora": { ssh, home } }
  if (h && typeof h === "object")
    return Object.values(h).map((v) => (typeof v === "string" ? v : v?.ssh)).filter(Boolean);
  return [];
}
export const listHosts = () => normalizeHosts(loadConfig());

// bookmarks: { "<full-session-id>": "<alias or empty string>" } in config.json.
// an alias resolves wherever an id-prefix is accepted; "" is a bare bookmark.
export function loadBookmarks() {
  const b = loadConfig().bookmarks;
  if (!b || typeof b !== "object" || Array.isArray(b)) return {};
  return Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === "string"));
}

// Containerized sessions: one record each under `containers` in config.json,
// holding everything needed to rebuild the container if it is removed. `root`
// is where that session's transcripts live on this machine, so the record is
// also what makes them findable without entering the container.
//
//   { "<name>": { root, container, dir, image, agents, ports } }
//
// A record with no `root` is a 0.8-style container, which kept its sessions
// inside itself. That absence is what migration keys off, so the two can share
// one config key without a version field.
export const STORE_ROOT = path.join(
  process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "casm", "containers");

// rename() is atomic but only within one filesystem, and a store can sit on a
// different one from ~/.claude. Fall back to copy-then-remove, which is not
// atomic but is the only thing available across a boundary.
export function moveInto(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
  return dest;
}

// The directories the agents expect to find under a store root. Created on the
// host before the container starts, so the mount has real directories to expose
// and nothing inside has to create them as the wrong user.
export const STORE_SKELETON = [
  ".claude/projects", ".claude/sessions",
  ".pi/agent/sessions",
  ".codex/sessions",
  ".local/share/opencode",
  ".casm",
];
export function ensureStore(root) {
  for (const d of STORE_SKELETON) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

export function loadContainerized() {
  const c = loadConfig().containers;
  if (!c || typeof c !== "object" || Array.isArray(c)) return [];
  return Object.entries(c)
    .filter(([, v]) => v && typeof v === "object" && !Array.isArray(v) && typeof v.root === "string")
    .map(([name, v]) => ({ name, ...v }));
}

// resolves null if the input ends without an answer (ctrl-D), so callers can
// treat that as an abort instead of hanging or exiting silently
export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    let answered = false;
    rl.on("close", () => { if (!answered) res(null); });
    rl.question(question, (a) => { answered = true; rl.close(); res(a.trim()); });
  });
}
export function readLines(file, cb, maxBytesTail = null) {
  let text;
  if (maxBytesTail) {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytesTail);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } else {
    text = fs.readFileSync(file, "utf8");
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (cb(obj) === false) return;
  }
}
export function headEntries(file, maxLines = 60) {
  const out = [];
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(64 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  for (const line of buf.toString("utf8", 0, n).split("\n").slice(0, maxLines)) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}
// The one door transcript text comes through for claude and pi - preview,
// search and show all land here - so this is where it stops being terminal
// input and starts being text.
export function extractText(content) {
  if (typeof content === "string") return plain(content);
  if (Array.isArray(content))
    return plain(content.map((b) => (typeof b === "string" ? b : b.text ?? "")).join(" "));
  return "";
}

export const intFlag = (args, name, dflt) => { const i = args.indexOf(name); return i >= 0 ? parseInt(args[i + 1], 10) : dflt; };
export const strFlag = (args, name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
export const positionals = (args, valueFlags = []) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-")) { if (valueFlags.includes(args[i])) i++; continue; }
    out.push(args[i]);
  }
  return out;
};
// the cwd is read out of a transcript like everything else, so it is no more
// trustworthy than the preview beside it
export const shortProject = (cwdOrDir) => {
  const p = plain(cwdOrDir ?? "").split("/").filter(Boolean);
  return p.slice(-2).join("/") || plain(cwdOrDir ?? "") || "?";
};
// The window is cut at arbitrary offsets either side of the match, so on raw
// text it would happily emit an opener without its closer, or start halfway
// through a sequence. plain() here means the slices are always plain text and
// the only escapes in the result are the ones this line adds.
export const snippet = (text, idx, len) => {
  const t = plain(text);
  const start = Math.max(0, idx - 40);
  return t.slice(start, idx) + yellow(t.slice(idx, idx + len)) + t.slice(idx + len, idx + len + 40);
};
export const absolutize = (p, home) => (p.startsWith("/") ? p : `${home}/${p}`.replace(/\/+/g, "/"));
