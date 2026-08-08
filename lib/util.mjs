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
export const pad = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
export const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export const fmtAge = (s) =>
  s < 60 ? `${Math.round(s)}s`
  : s < 3600 ? `${Math.round(s / 60)}m`
  : s < 172800 ? `${(s / 3600).toFixed(1)}h`
  : `${(s / 86400).toFixed(1)}d`;
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const shq0 = (s) => `'${String(s).replace(/'/g, "''")}'`; // sql-quote

export function die(msg) { console.error(`casm: ${msg}`); process.exit(1); }

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
export function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((b) => (typeof b === "string" ? b : b.text ?? "")).join(" ");
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
export const shortProject = (cwdOrDir) => {
  const p = (cwdOrDir ?? "").split("/").filter(Boolean);
  return p.slice(-2).join("/") || cwdOrDir || "?";
};
export const snippet = (text, idx, len) => {
  const start = Math.max(0, idx - 40);
  return text.slice(start, idx) + yellow(text.slice(idx, idx + len)) + text.slice(idx + len, idx + len + 40);
};
export const absolutize = (p, home) => (p.startsWith("/") ? p : `${home}/${p}`.replace(/\/+/g, "/"));
