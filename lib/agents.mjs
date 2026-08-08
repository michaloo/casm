// agent providers: claude code / opencode / pi.
// Uniform session shape: { agent, id, cwd, mtime(Date), preview, file? }
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, cyan, magenta, yellow, dim, die, shq, shq0, readLines, headEntries, extractText, normalizeIdPrefix, loadBookmarks } from "./util.mjs";
import { exec, copyTo, copyFrom } from "./nodes.mjs";

// What push/pull print for you to paste, and what `resume` echoes before it
// hands over. Kept separate from resumeArgv so the argv stays a real array -
// re-splitting a command string on spaces is what used to break any argument
// containing one.
export const displayCmd = (argv, cwd) => `cd ${shq(cwd)} && ${argv.join(" ")}`;

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
export const CC_PROJECTS = path.join(CLAUDE_DIR, "projects");
export const CC_LIVE = path.join(CLAUDE_DIR, "sessions"); // <pid>.json, written by claude itself
export const PI_SESSIONS = path.join(HOME, ".pi", "agent", "sessions");
export const OC_DB = path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "opencode", "opencode.db");

export const ccSlug = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
export const piSlug = (p) => "--" + p.replace(/^\//, "").replace(/[^A-Za-z0-9]/g, "-") + "--";

// `opencode db`, `pi install` and friends are the same binary doing something
// that is not a session; without this they show up in `active` as agents with
// nothing attached. bare `opencode`, `opencode <project>` and `opencode run …`
// are sessions, so this is a denylist: an unknown subcommand still gets listed.
const NOT_A_SESSION = {
  opencode: new Set(["db", "serve", "web", "acp", "mcp", "models", "stats", "upgrade", "uninstall",
    "export", "import", "github", "pr", "plugin", "completion", "debug", "providers", "auth", "agent", "session"]),
  pi: new Set(["install", "remove", "uninstall", "update", "list", "config"]),
  claude: new Set(["mcp", "config", "doctor", "update", "install", "migrate-installer", "setup-token", "plugin"]),
};

export function sq(sql) {
  const out = execFileSync("sqlite3", ["-json", "-readonly", OC_DB, sql], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
  return out ? JSON.parse(out) : [];
}

export const AGENTS = {
  claude: {
    tag: () => cyan("cc"),
    available: () => fs.existsSync(CC_PROJECTS),
    sessions() {
      const out = [];
      for (const dir of fs.readdirSync(CC_PROJECTS)) {
        const full = path.join(CC_PROJECTS, dir);
        let entries; try { entries = fs.readdirSync(full); } catch { continue; }
        for (const f of entries) {
          if (!f.endsWith(".jsonl")) continue;
          const file = path.join(full, f);
          out.push({ agent: "claude", id: f.slice(0, -6), file, mtime: fs.statSync(file).mtime, cwd: null, preview: null });
        }
      }
      return out;
    },
    enrich(s) {
      for (const o of headEntries(s.file)) {
        if (o.cwd && !s.cwd) s.cwd = o.cwd;
        if (o.type === "user" && o.message && s.preview === null)
          s.preview = extractText(o.message.content).replace(/\s+/g, " ").trim();
        if (s.cwd && s.preview !== null) break;
      }
      s.preview ??= "";
      return s;
    },
    searchEntry: (o) => (o.type === "user" || o.type === "assistant") ? extractText(o.message?.content ?? "") : null,
    turns(s) {
      const turns = [];
      readLines(s.file, (o) => {
        if ((o.type !== "user" && o.type !== "assistant") || o.isSidechain) return;
        const text = extractText(o.message?.content ?? "").replace(/\s+/g, " ").trim();
        if (text) turns.push({ role: o.type, text, ts: o.timestamp });
      });
      return turns;
    },
    resumeArgv: (s) => ["claude", "--resume", s.id],
    newArgv: () => ["claude"],
    procMatch: (comm, argv0, args) => (comm === "claude" || new RegExp("(^|\\/)claude$").test(argv0)) && !NOT_A_SESSION.claude.has(args[0]),
    // context = the input side of the newest assistant turn: what filled the
    // window last time the model ran. tail-read so long transcripts stay cheap.
    contextUsage(s) {
      let found = null;
      readLines(s.file, (o) => {
        if (o.type === "assistant" && o.message?.usage) found = o.message;
      }, 256 * 1024);
      if (!found) return null;
      const u = found.usage;
      return { model: found.model, ctx: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) };
    },
    // r: the remote session as reported by `casm list --json` there
    async pull(r, node, localPath, force) {
      const dir = path.join(CC_PROJECTS, ccSlug(localPath));
      if (!force && fs.existsSync(path.join(dir, `${r.id}.jsonl`))) die("session already exists locally - use --force");
      fs.mkdirSync(dir, { recursive: true });
      copyFrom(node, r.file, dir + "/");
      const companion = r.file.slice(0, -6); // <uuid>/ sits next to <uuid>.jsonl
      if (exec(node, `test -d ${shq(companion)} && echo yes || echo no`) === "yes") {
        fs.mkdirSync(path.join(dir, r.id), { recursive: true });
        copyFrom(node, companion + "/", path.join(dir, r.id) + "/");
      }
      return dir;
    },
    async push(s, node, targetPath, force) {
      // ~ is expanded by the far shell, so resolve it before it reaches a
      // transport that does not run one (docker cp takes a literal path).
      const dest = `${exec(node, 'printf %s "$HOME"')}/.claude/projects/${ccSlug(targetPath)}`;
      if (!force && exec(node, `test -f ${shq(dest)}/${s.id}.jsonl && echo yes || echo no`) === "yes")
        die("session already exists on remote - use --force");
      exec(node, `mkdir -p ${shq(dest)} ${shq(targetPath)}`);
      copyTo(node, s.file, dest + "/");
      const companion = s.file.slice(0, -6);
      if (fs.existsSync(companion)) {
        exec(node, `mkdir -p ${shq(dest)}/${shq(s.id)}`);
        copyTo(node, companion + "/", `${dest}/${s.id}/`);
      }
    },
  },

  pi: {
    tag: () => yellow("pi"),
    available: () => fs.existsSync(PI_SESSIONS),
    sessions() {
      const out = [];
      for (const dir of fs.readdirSync(PI_SESSIONS)) {
        const full = path.join(PI_SESSIONS, dir);
        let entries; try { entries = fs.readdirSync(full); } catch { continue; }
        for (const f of entries) {
          if (!f.endsWith(".jsonl")) continue;
          const file = path.join(full, f);
          const id = f.replace(/\.jsonl$/, "").split("_").pop();
          out.push({ agent: "pi", id, file, mtime: fs.statSync(file).mtime, cwd: null, preview: null });
        }
      }
      return out;
    },
    enrich(s) {
      for (const o of headEntries(s.file, 30)) {
        if (o.type === "session" && o.cwd) s.cwd = o.cwd;
        if (o.type === "message" && o.message?.role === "user" && s.preview === null)
          s.preview = extractText(o.message.content).replace(/\s+/g, " ").trim();
        if (s.cwd && s.preview !== null) break;
      }
      s.preview ??= "";
      return s;
    },
    searchEntry: (o) => o.type === "message" ? extractText(o.message?.content ?? "") : null,
    turns(s) {
      const turns = [];
      readLines(s.file, (o) => {
        if (o.type !== "message") return;
        const role = o.message?.role;
        if (role !== "user" && role !== "assistant") return;
        const text = extractText(o.message?.content ?? "").replace(/\s+/g, " ").trim();
        if (text) turns.push({ role, text, ts: o.timestamp });
      });
      return turns;
    },
    resumeArgv: (s) => ["pi", "--session", s.id],
    newArgv: () => ["pi"],
    procMatch: (comm, argv0, args) => (comm === "pi" || new RegExp("(^|\\/)pi$").test(argv0)) && !NOT_A_SESSION.pi.has(args[0]),
    contextUsage(s) {
      let found = null;
      readLines(s.file, (o) => {
        if (o.type === "message" && o.message?.role === "assistant" && o.message.usage) found = o.message;
      }, 256 * 1024);
      if (!found) return null;
      const u = found.usage;
      return { model: found.model, ctx: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) };
    },
    async pull(r, node, localPath, force) {
      const dir = path.join(PI_SESSIONS, piSlug(localPath));
      const fname = path.basename(r.file); // <ts>_<uuid>.jsonl - keep the remote name
      if (!force && fs.existsSync(path.join(dir, fname))) die("session already exists locally - use --force");
      fs.mkdirSync(dir, { recursive: true });
      copyFrom(node, r.file, dir + "/");
      return dir;
    },
    async push(s, node, targetPath, force) {
      const dest = `${exec(node, 'printf %s "$HOME"')}/.pi/agent/sessions/${piSlug(targetPath)}`;
      const fname = path.basename(s.file);
      if (!force && exec(node, `test -f ${shq(dest)}/${shq(fname)} && echo yes || echo no`) === "yes")
        die("session already exists on remote - use --force");
      exec(node, `mkdir -p ${shq(dest)} ${shq(targetPath)}`);
      copyTo(node, s.file, dest + "/");
    },
  },

  opencode: {
    tag: () => magenta("oc"),
    available: () => {
      if (!fs.existsSync(OC_DB)) return false;
      try { execFileSync("sqlite3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
    },
    sessions() {
      return sq("select id, directory, title, time_updated from session order by time_updated desc limit 500")
        .map((r) => ({ agent: "opencode", id: r.id, file: null, cwd: r.directory, preview: r.title ?? "", mtime: new Date(r.time_updated) }));
    },
    enrich: (s) => s,
    turns(s) {
      const rows = sq(`select m.data as m, p.data as p from part p join message m on p.message_id = m.id where p.session_id = ${shq0(s.id)} order by p.time_created`);
      const turns = [];
      for (const r of rows) {
        let mo, po;
        try { mo = JSON.parse(r.m); po = JSON.parse(r.p); } catch { continue; }
        if (po.type !== "text" || !po.text) continue;
        const role = mo.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = po.text.replace(/\s+/g, " ").trim();
        if (!text) continue;
        const last = turns[turns.length - 1];
        if (last && last.role === role && last._mid === r.m) last.text += " " + text;
        else turns.push({ role, text, ts: new Date(mo.time?.created ?? 0).toISOString(), _mid: r.m });
      }
      return turns;
    },
    search(needle, limit) {
      const esc = needle.replace(/'/g, "''").replace(/[%_]/g, (c) => "\\" + c);
      const rows = sq(`select p.session_id as sid, s.directory as dir, s.time_updated as tu, p.data as data from part p join session s on s.id = p.session_id where p.data like '%${esc}%' escape '\\' order by s.time_updated desc limit ${limit * 4}`);
      const seen = new Set(); const out = [];
      for (const r of rows) {
        if (seen.has(r.sid) || out.length >= limit) continue;
        let text; try { text = JSON.parse(r.data).text ?? ""; } catch { continue; }
        const idx = text.toLowerCase().indexOf(needle.toLowerCase());
        if (idx === -1) continue;
        seen.add(r.sid);
        out.push({ id: r.sid, cwd: r.dir, mtime: new Date(r.tu), text, idx });
      }
      return out;
    },
    // --dir is not optional: opencode ignores the spawn cwd and walks up to the
    // nearest project root, which in a container means writing outside the
    // directory that was mounted for it.
    resumeArgv: (s, cwd) => ["opencode", "--dir", cwd, "-s", s.id],
    newArgv: (cwd) => ["opencode", "--dir", cwd],
    procMatch: (comm, argv0, args) => (comm === "opencode" || new RegExp("(^|\\/)opencode$").test(argv0)) && !NOT_A_SESSION.opencode.has(args[0]),
    contextUsage(s) {
      const rows = sq(`select data from message where session_id = ${shq0(s.id)} order by time_created desc, id desc limit 20`);
      for (const r of rows) {
        let m; try { m = JSON.parse(r.data); } catch { continue; }
        if (m.role !== "assistant" || !m.tokens) continue;
        return { model: m.modelID ?? "", ctx: (m.tokens.input ?? 0) + (m.tokens.cache?.read ?? 0) + (m.tokens.cache?.write ?? 0) };
      }
      return null;
    },
    // push in reverse: export on the remote, rewrite directory, import here
    async pull(r, node, localPath, force) {
      if (!AGENTS.opencode.available())
        die("opencode is not set up on this machine (needs the opencode db and the sqlite3 cli)");
      // available() only proves the db is readable; import needs the binary too
      try { execFileSync("opencode", ["--version"], { stdio: "ignore" }); }
      catch { die("the opencode binary is not on PATH here - install opencode to import the session"); }
      if (!force && sq(`select id from session where id = ${shq0(r.id)}`).length)
        die("session already exists locally - use --force");
      const tmpRemote = `/tmp/casm-oc-${r.id}.json`;
      const tmpLocal = path.join(os.tmpdir(), `casm-oc-${r.id}.json`);
      exec(node, `opencode export ${shq(r.id)} > ${shq(tmpRemote)}`);
      copyFrom(node, tmpRemote, tmpLocal);
      exec(node, `rm -f ${shq(tmpRemote)}`);

      let raw = fs.readFileSync(tmpLocal, "utf8");
      raw = raw.slice(raw.indexOf("{"));
      const obj = JSON.parse(raw);
      if (obj.info) {
        obj.info.directory = localPath;
        if ("path" in obj.info) obj.info.path = localPath.replace(/^\//, "");
      }
      fs.writeFileSync(tmpLocal, JSON.stringify(obj));
      fs.mkdirSync(localPath, { recursive: true }); // import records the session against it
      const out = execFileSync("opencode", ["import", tmpLocal], { cwd: localPath, encoding: "utf8" }).trim();
      if (out) console.log(dim(out));
      fs.unlinkSync(tmpLocal);
      return localPath;
    },
    async push(s, node, targetPath) {
      // sanctioned path: opencode export → rewrite directory → opencode import on remote.
      // export must go via file redirect: piped stdout truncates (bun stdout flush bug)
      const tmpLocal = path.join(os.tmpdir(), `casm-oc-${s.id}.json`);
      execFileSync("sh", ["-c", `opencode export ${shq(s.id)} > ${shq(tmpLocal)}`], { stdio: ["ignore", "ignore", "inherit"] });
      let raw = fs.readFileSync(tmpLocal, "utf8");
      raw = raw.slice(raw.indexOf("{"));
      const obj = JSON.parse(raw);
      if (obj.info) {
        obj.info.directory = targetPath;
        if ("path" in obj.info) obj.info.path = targetPath.replace(/^\//, "");
      }
      fs.writeFileSync(tmpLocal, JSON.stringify(obj));
      const tmpRemote = `/tmp/casm-oc-${s.id}.json`;
      copyTo(node, tmpLocal, tmpRemote);
      fs.unlinkSync(tmpLocal);
      exec(node, `mkdir -p ${shq(targetPath)}`);
      const out = exec(node, `cd ${shq(targetPath)} && opencode import ${tmpRemote}; rm -f ${tmpRemote}`);
      if (out) console.log(dim(out));
    },
  },
};

// claude (>= ~2.1) records each running session at ~/.claude/sessions/<pid>.json:
// { pid, sessionId, cwd, status, name, updatedAt, ... }. that is authoritative -
// it names the exact session, where older casm had to guess "newest transcript
// in this cwd", which picks the wrong one when two sessions share a directory.
export function claudeLive(pid) {
  try { return JSON.parse(fs.readFileSync(path.join(CC_LIVE, `${pid}.json`), "utf8")); }
  catch { return null; }
}

export function activeAgents(agentFilter) {
  const names = agentFilter ? [agentFilter] : Object.keys(AGENTS);
  if (agentFilter && !AGENTS[agentFilter]) die(`unknown agent '${agentFilter}' (claude|opencode|pi)`);
  return names.filter((n) => AGENTS[n].available());
}

export function allSessions(agentFilter) {
  const out = [];
  for (const name of activeAgents(agentFilter)) out.push(...AGENTS[name].sessions());
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export function findSession(rawPrefix, { soft = false } = {}) {
  const idPrefix = normalizeIdPrefix(rawPrefix);
  // an exact bookmark alias wins over prefix search, so aliases work wherever
  // an id does (resume/show/push/bookmark rm)
  const marks = loadBookmarks();
  const aliasedId = Object.keys(marks).find((id) => marks[id] && marks[id] === idPrefix);
  const matches = allSessions(null).filter((s) => (aliasedId ? s.id === aliasedId : s.id.startsWith(idPrefix)));
  if (matches.length === 0) {
    if (aliasedId) die(`bookmark '${idPrefix}' points at ${aliasedId.slice(0, 10)}, which no longer exists here`);
    if (soft) return null;
    die(`no session matching '${idPrefix}'`);
  }
  if (matches.length > 1) die(`ambiguous id '${idPrefix}' (${matches.length} matches) - use more characters`);
  return AGENTS[matches[0].agent].enrich(matches[0]);
}
