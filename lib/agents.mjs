// agent providers: claude code / opencode / pi.
// Uniform session shape: { agent, id, cwd, mtime(Date), preview, file? }
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, cyan, magenta, yellow, blue, dim, die, shq, shq0, readLines, headEntries, extractText, plain, normalizeIdPrefix, loadBookmarks, loadContainerized, moveInto } from "./util.mjs";
import { exec, copyTo, copyFrom } from "./nodes.mjs";

// What push/pull print for you to paste, and what `resume` echoes before it
// hands over. Kept separate from resumeArgv so the argv stays a real array -
// re-splitting a command string on spaces is what used to break any argument
// containing one.
// Long arguments are elided rather than echoed. The only one that gets near the
// limit is the containerized brief, several hundred characters of system prompt
// that would bury the command it belongs to. Everything push and pull print is
// short, so their paste-able line is unaffected.
export const displayCmd = (argv, cwd) =>
  `cd ${shq(cwd)} && ${argv.map((a) => (a.length > 60 ? `<${a.length} chars>` : a)).join(" ")}`;

// A store is a home-shaped directory holding agent state: `.claude/`, `.pi/`
// and `.local/share/opencode/` under one root. Your own home is one store; a
// containerized session gets another, also on this machine, which the agents
// inside its container are pointed at with CLAUDE_CONFIG_DIR,
// PI_CODING_AGENT_SESSION_DIR and XDG_DATA_HOME.
//
// The layout under a root belongs to the agents, not to casm, so the same
// reading code serves both and casm never has to enter a container to see what
// happened in it.
export function storePaths(root, { hostEnv = false } = {}) {
  // Only the host store honours the agents' own redirection variables. A
  // container's store is derived purely from its root, or a CLAUDE_CONFIG_DIR
  // set in your shell would silently capture every container's transcripts too.
  const claudeDir = (hostEnv && process.env.CLAUDE_CONFIG_DIR) || path.join(root, ".claude");
  const xdgData = (hostEnv && process.env.XDG_DATA_HOME) || path.join(root, ".local", "share");
  return {
    root,
    claudeDir,
    ccProjects: path.join(claudeDir, "projects"),
    ccLive: path.join(claudeDir, "sessions"), // <pid>.json, written by claude itself
    piSessions: path.join(root, ".pi", "agent", "sessions"),
    codexHome: path.join(root, ".codex"),
    codexSessions: path.join(root, ".codex", "sessions"),
    ocDb: path.join(xdgData, "opencode", "opencode.db"),
  };
}

// `name` is null for the host store and the container's name otherwise, which
// is what listings show and what resume uses to find the container.
export const HOST_STORE = { name: null, ...storePaths(HOME, { hostEnv: true }) };

export const CLAUDE_DIR = HOST_STORE.claudeDir;
export const CC_PROJECTS = HOST_STORE.ccProjects;
export const CC_LIVE = HOST_STORE.ccLive;
export const PI_SESSIONS = HOST_STORE.piSessions;
export const CODEX_SESSIONS = HOST_STORE.codexSessions;
export const OC_DB = HOST_STORE.ocDb;

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
  // `resume` and `fork` do start a session; everything else here does not
  codex: new Set(["exec", "review", "login", "logout", "mcp", "plugin", "mcp-server",
    "app-server", "remote-control", "app", "completion", "update", "doctor", "sandbox",
    "debug", "apply", "archive", "delete", "unarchive", "cloud", "exec-server", "features", "help"]),
  claude: new Set(["mcp", "config", "doctor", "update", "install", "migrate-installer", "setup-token", "plugin"]),
};

// opencode keeps everything in one sqlite file per store, so every query needs
// to know which store it is asking about.
export function sq(sql, db = OC_DB) {
  const out = execFileSync("sqlite3", ["-json", "-readonly", db, sql], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
  return out ? JSON.parse(out) : [];
}
// A session read back from another machine arrives as plain JSON with no store
// attached, and those are always answered against this machine's own.
const ocDbOf = (s) => s.store?.ocDb ?? OC_DB;
// codex sends its own context to the model as `user` messages - the environment
// block, and any AGENTS.md it picked up. Nothing there was typed by you, so it
// is skipped for previews, turns and search, where it would otherwise be the
// first thing shown for every session and would match half of them.
const CODEX_INJECTED = /^\s*(<environment_context|<user_instructions|<INSTRUCTIONS|#\s*AGENTS\.md instructions)/;
// codex message content is a list of typed blocks; only the text ones matter.
const codexText = (content) =>
  plain(Array.isArray(content) ? content.map((b) => b?.text ?? "").join(" ") : (content ?? ""));

export const AGENTS = {
  claude: {
    tag: () => cyan("cc"),
    available: (store = HOST_STORE) => fs.existsSync(store.ccProjects),
    sessions(store = HOST_STORE) {
      const out = [];
      for (const dir of fs.readdirSync(store.ccProjects)) {
        const full = path.join(store.ccProjects, dir);
        let entries; try { entries = fs.readdirSync(full); } catch { continue; }
        for (const f of entries) {
          if (!f.endsWith(".jsonl")) continue;
          const file = path.join(full, f);
          out.push({ agent: "claude", id: f.slice(0, -6), file, mtime: fs.statSync(file).mtime, cwd: null, preview: null, store });
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
    // Move this session out of its current store and into another one on this
    // machine. `containerize` is one-way, so this moves rather than copies:
    // leaving a copy behind is what produced the diverging duplicates that the
    // container-as-host model suffered from.
    moveTo(s, store) {
      const slug = path.basename(path.dirname(s.file)); // keep the project's own slug
      const dest = moveInto(s.file, path.join(store.ccProjects, slug));
      const companion = s.file.slice(0, -6); // <uuid>/ sits beside <uuid>.jsonl
      if (fs.existsSync(companion)) moveInto(companion, path.join(store.ccProjects, slug));
      return dest;
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

  // codex stores one rollout file per session under sessions/YYYY/MM/DD/, named
  // rollout-<timestamp>-<uuid>.jsonl. The uuid is the session id `codex resume`
  // takes, and it is the last 36 characters of the name - parsed that way rather
  // than by splitting on "-", which the timestamp is full of.
  codex: {
    tag: () => blue("cx"),
    available: (store = HOST_STORE) => fs.existsSync(store.codexSessions),
    sessions(store = HOST_STORE) {
      const out = [];
      const walk = (dir, depth) => {
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory() && depth < 3) walk(full, depth + 1);
          else if (e.isFile() && e.name.endsWith(".jsonl") && e.name.startsWith("rollout-"))
            out.push({ agent: "codex", id: e.name.replace(/\.jsonl$/, "").slice(-36), file: full,
                       mtime: fs.statSync(full).mtime, cwd: null, preview: null, store });
        }
      };
      walk(store.codexSessions, 0);
      return out;
    },
    enrich(s) {
      for (const o of headEntries(s.file)) {
        if (o.type === "session_meta" && o.payload?.cwd && !s.cwd) s.cwd = o.payload.cwd;
        // the opening `developer` messages are codex's own instructions, not
        // anything you typed, so the preview comes from the first user turn
        if (s.preview === null && o.type === "response_item" && o.payload?.role === "user") {
          const t = codexText(o.payload.content);
          if (!CODEX_INJECTED.test(t)) s.preview = t.replace(/\s+/g, " ").trim();
        }
        if (s.cwd && s.preview !== null) break;
      }
      s.preview ??= "";
      return s;
    },
    searchEntry(o) {
      if (o.type !== "response_item" || o.payload?.type !== "message" || o.payload.role === "developer") return null;
      const t = codexText(o.payload.content);
      return CODEX_INJECTED.test(t) ? null : t;
    },
    turns(s) {
      const turns = [];
      readLines(s.file, (o) => {
        if (o.type !== "response_item" || o.payload?.type !== "message") return;
        const role = o.payload.role;
        if (role !== "user" && role !== "assistant") return;
        const raw = codexText(o.payload.content);
        if (CODEX_INJECTED.test(raw)) return;
        const text = raw.replace(/\s+/g, " ").trim();
        if (text) turns.push({ role, text, ts: o.timestamp });
      });
      return turns;
    },
    resumeArgv: (s) => ["codex", "resume", s.id],
    newArgv: () => ["codex"],
    procMatch: (comm, argv0, args) => (comm === "codex" || new RegExp("(^|\\/)codex$").test(argv0)) && !NOT_A_SESSION.codex.has(args[0]),
    contextUsage(s) {
      let found = null;
      readLines(s.file, (o) => {
        if (o.payload?.type === "token_count" && o.payload.info) found = o.payload.info;
      }, 256 * 1024);
      const u = found?.last_token_usage;
      if (!u) return null;
      return { model: "", ctx: (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0) + (u.cache_write_input_tokens ?? 0) };
    },
    moveTo(s, store) {
      // keep the YYYY/MM/DD path: codex groups by date and the picker reads it
      const rel = path.relative(s.store?.codexSessions ?? CODEX_SESSIONS, path.dirname(s.file));
      return moveInto(s.file, path.join(store.codexSessions, rel));
    },
    async pull(r, node, localPath, force) {
      const dir = path.join(CODEX_SESSIONS, ...(r.file.split("/sessions/")[1] ?? "").split("/").slice(0, 3));
      const fname = path.basename(r.file);
      if (!force && fs.existsSync(path.join(dir, fname))) die("session already exists locally - use --force");
      fs.mkdirSync(dir, { recursive: true });
      copyFrom(node, r.file, dir + "/");
      return dir;
    },
    async push(s, node, targetPath, force) {
      const datePath = (s.file.split("/sessions/")[1] ?? "").split("/").slice(0, 3).join("/");
      const dest = `${exec(node, 'printf %s "$HOME"')}/.codex/sessions/${datePath}`;
      const fname = path.basename(s.file);
      if (!force && exec(node, `test -f ${shq(dest)}/${shq(fname)} && echo yes || echo no`) === "yes")
        die("session already exists on remote - use --force");
      exec(node, `mkdir -p ${shq(dest)} ${shq(targetPath)}`);
      copyTo(node, s.file, dest + "/");
    },
  },

  pi: {
    tag: () => yellow("pi"),
    available: (store = HOST_STORE) => fs.existsSync(store.piSessions),
    sessions(store = HOST_STORE) {
      const out = [];
      for (const dir of fs.readdirSync(store.piSessions)) {
        const full = path.join(store.piSessions, dir);
        let entries; try { entries = fs.readdirSync(full); } catch { continue; }
        for (const f of entries) {
          if (!f.endsWith(".jsonl")) continue;
          const file = path.join(full, f);
          const id = f.replace(/\.jsonl$/, "").split("_").pop();
          out.push({ agent: "pi", id, file, mtime: fs.statSync(file).mtime, cwd: null, preview: null, store });
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
    moveTo(s, store) {
      const slug = path.basename(path.dirname(s.file));
      return moveInto(s.file, path.join(store.piSessions, slug));
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
    available: (store = HOST_STORE) => {
      if (!fs.existsSync(store.ocDb)) return false;
      try { execFileSync("sqlite3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
    },
    sessions(store = HOST_STORE) {
      return sq("select id, directory, title, time_updated from session order by time_updated desc limit 500", store.ocDb)
        // opencode's text comes from its sqlite store rather than through
        // extractText, so it is stripped here instead - a title is whatever the
        // model summarised the first prompt into, escapes included
        .map((r) => ({ agent: "opencode", id: r.id, file: null, cwd: r.directory, preview: plain(r.title ?? ""), mtime: new Date(r.time_updated), store }));
    },
    enrich: (s) => s,
    turns(s) {
      const rows = sq(`select m.data as m, p.data as p from part p join message m on p.message_id = m.id where p.session_id = ${shq0(s.id)} order by p.time_created`, ocDbOf(s));
      const turns = [];
      for (const r of rows) {
        let mo, po;
        try { mo = JSON.parse(r.m); po = JSON.parse(r.p); } catch { continue; }
        if (po.type !== "text" || !po.text) continue;
        const role = mo.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = plain(po.text).replace(/\s+/g, " ").trim();
        if (!text) continue;
        const last = turns[turns.length - 1];
        if (last && last.role === role && last._mid === r.m) last.text += " " + text;
        else turns.push({ role, text, ts: new Date(mo.time?.created ?? 0).toISOString(), _mid: r.m });
      }
      return turns;
    },
    search(needle, limit, store = HOST_STORE) {
      const esc = needle.replace(/'/g, "''").replace(/[%_]/g, (c) => "\\" + c);
      const rows = sq(`select p.session_id as sid, s.directory as dir, s.time_updated as tu, p.data as data from part p join session s on s.id = p.session_id where p.data like '%${esc}%' escape '\\' order by s.time_updated desc limit ${limit * 4}`, store.ocDb);
      const seen = new Set(); const out = [];
      for (const r of rows) {
        if (seen.has(r.sid) || out.length >= limit) continue;
        // flattened here, not at the call site: the offset has to index the
        // same string the snippet is cut from
        let text; try { text = plain(JSON.parse(r.data).text ?? "").replace(/\s+/g, " "); } catch { continue; }
        const idx = text.toLowerCase().indexOf(needle.toLowerCase());
        if (idx === -1) continue;
        seen.add(r.sid);
        out.push({ id: r.sid, cwd: r.dir, mtime: new Date(r.tu), text, idx, store });
      }
      return out;
    },
    // Naming the directory is not optional: opencode otherwise ignores the
    // spawn cwd and walks up to the nearest project root, which in a container
    // means working outside the directory that was mounted for it. It takes
    // that as a positional - `opencode [project]` - and not as --dir, which
    // opencode 1.18 does not accept at all: it exits 1 and prints its command
    // list, which looks like casm launched nothing.
    resumeArgv: (s, cwd) => ["opencode", cwd, "-s", s.id],
    newArgv: (cwd) => ["opencode", cwd],
    procMatch: (comm, argv0, args) => (comm === "opencode" || new RegExp("(^|\\/)opencode$").test(argv0)) && !NOT_A_SESSION.opencode.has(args[0]),
    contextUsage(s) {
      const rows = sq(`select data from message where session_id = ${shq0(s.id)} order by time_created desc, id desc limit 20`, ocDbOf(s));
      for (const r of rows) {
        let m; try { m = JSON.parse(r.data); } catch { continue; }
        if (m.role !== "assistant" || !m.tokens) continue;
        return { model: m.modelID ?? "", ctx: (m.tokens.input ?? 0) + (m.tokens.cache?.read ?? 0) + (m.tokens.cache?.write ?? 0) };
      }
      return null;
    },
    // opencode has no file to move - one sqlite database holds every session -
    // so the move is export, import into the target store, delete from the
    // source. XDG_DATA_HOME is what selects the database, verified by pointing
    // it at an empty directory and watching opencode build a fresh store there.
    moveTo(s, store) {
      const src = s.store?.ocDb ?? OC_DB;
      const tmp = path.join(os.tmpdir(), `casm-oc-${s.id}.json`);
      execFileSync("sh", ["-c", `opencode export ${shq(s.id)} > ${shq(tmp)}`], { stdio: ["ignore", "ignore", "inherit"] });
      const env = { ...process.env, XDG_DATA_HOME: path.join(store.root, ".local", "share") };
      execFileSync("opencode", ["import", tmp], { cwd: s.cwd || process.cwd(), env, encoding: "utf8" });
      fs.unlinkSync(tmp);
      // only once the copy is safely in the new store
      if (src === OC_DB) execFileSync("opencode", ["session", "delete", s.id], { stdio: "ignore" });
      return store.ocDb;
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
// A containerized session writes this into its own store, which is on the host,
// so casm reads a container's live sessions without entering it. The pid inside
// is the container's, and only means anything against that container.
export function claudeLive(pid, store = HOST_STORE) {
  try { return JSON.parse(fs.readFileSync(path.join(store.ccLive, `${pid}.json`), "utf8")); }
  catch { return null; }
}

export function activeAgents(agentFilter, store = HOST_STORE) {
  const names = agentFilter ? [agentFilter] : Object.keys(AGENTS);
  if (agentFilter && !AGENTS[agentFilter]) die(`unknown agent '${agentFilter}' (claude|codex|opencode|pi)`);
  return names.filter((n) => AGENTS[n].available(store));
}

// Every store on this machine: your own home, plus one per containerized
// session. A containerized session's transcript lives here rather than inside
// its container, so a listing never has to enter one - and removing a container
// never loses a conversation.
export function stores() {
  return [HOST_STORE, ...loadContainerized().map((r) => ({ name: r.name, ...storePaths(r.root) }))];
}

export function allSessions(agentFilter) {
  const out = [];
  for (const store of stores())
    for (const name of activeAgents(agentFilter, store)) out.push(...AGENTS[name].sessions(store));
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
