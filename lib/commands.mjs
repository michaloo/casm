// command implementations
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  HOME, CONFIG_PATH, dim, cyan, green, yellow, pad, truncate, fmtAge, shq, shq0, die,
  ask, ssh, sshTry, casmRemote, readLines, intFlag, strFlag, positionals, normalizeIdPrefix,
  listHosts, normalizeHosts, loadConfigForWrite, saveConfig,
  shortProject, snippet, absolutize,
} from "./util.mjs";
import { AGENTS, CC_PROJECTS, PI_SESSIONS, claudeLive, ccSlug, piSlug, sq, activeAgents, allSessions, findSession } from "./agents.mjs";

export async function cmdList(args) {
  const n = intFlag(args, "-n", 20);
  const agent = strFlag(args, "--agent", null);
  const project = strFlag(args, "--project", null);
  const idPrefix = strFlag(args, "--id", null);
  let sessions = allSessions(agent);
  if (idPrefix) sessions = sessions.filter((s) => s.id.startsWith(idPrefix));
  if (project) {
    const abs = path.resolve(project);
    sessions = sessions.filter((s) => {
      const c = AGENTS[s.agent].enrich(s).cwd ?? "";
      return c === abs || c.startsWith(abs + "/");
    });
  }
  // --json is how one casm node reads another's sessions (see pull)
  if (args.includes("--json")) {
    const rows = sessions.slice(0, n).map((s) => {
      AGENTS[s.agent].enrich(s);
      return { agent: s.agent, id: s.id, cwd: s.cwd, file: s.file, mtime: s.mtime.toISOString(), preview: s.preview ?? "" };
    });
    console.log(JSON.stringify(rows));
    return;
  }
  for (const s of sessions.slice(0, n)) {
    AGENTS[s.agent].enrich(s);
    const when = s.mtime.toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `${dim(when)}  ${AGENTS[s.agent].tag()}  ${cyan(pad(s.id, 11))}  ${green(pad(shortProject(s.cwd), 26))}  ${truncate(s.preview || dim("(untitled)"), 62)}`
    );
  }
  if (!sessions.length) console.log("no sessions found");
}

export async function cmdSearch(args) {
  const agentFlagVal = strFlag(args, "--agent", null);
  const [term] = positionals(args, ["-n", "--agent"]);
  if (!term) die("usage: casm search <term> [--agent claude|opencode|pi] [-n N]");
  const n = intFlag(args, "-n", 25);
  const needle = term.toLowerCase();
  let hits = 0;

  for (const name of activeAgents(agentFlagVal)) {
    if (hits >= n) break;
    const A = AGENTS[name];
    if (A.search) {
      for (const h of A.search(term, n - hits)) {
        hits++;
        console.log(`${dim(h.mtime.toISOString().slice(0, 10))}  ${A.tag()}  ${cyan(pad(h.id, 11))}  ${green(pad(shortProject(h.cwd), 24))}  …${snippet(h.text.replace(/\s+/g, " "), h.idx, term.length)}…`);
      }
      continue;
    }
    for (const s of A.sessions().sort((a, b) => b.mtime - a.mtime)) {
      if (hits >= n) break;
      let found = null;
      readLines(s.file, (o) => {
        const text = A.searchEntry(o);
        if (!text) return;
        const idx = text.toLowerCase().indexOf(needle);
        if (idx === -1) return;
        found = snippet(text.replace(/\s+/g, " "), idx, term.length);
        return false;
      });
      if (found) {
        hits++;
        A.enrich(s);
        console.log(`${dim(s.mtime.toISOString().slice(0, 10))}  ${A.tag()}  ${cyan(pad(s.id, 11))}  ${green(pad(shortProject(s.cwd), 24))}  …${found}…`);
      }
    }
  }
  if (!hits) console.log("no matches");
}

export async function cmdShow(args) {
  const [idPrefix] = positionals(args, ["-n", "--host"]);
  if (!idPrefix) die("usage: casm show <session-id-prefix> [-n turns] [--host <ssh-target>]");
  const n = intFlag(args, "-n", 30);
  const hostArg = strFlag(args, "--host", null);

  // an id that isn't here is looked for on every configured host, so you can
  // `casm list` the fleet and then show anything you saw, wherever it lives
  if (hostArg) return showRemote([hostArg], idPrefix, n, true);
  const s = findSession(idPrefix, { soft: true });
  if (!s) {
    const hosts = listHosts();
    if (!hosts.length) die(`no session matching '${idPrefix}'`);
    return showRemote(hosts, idPrefix, n, false);
  }
  const turns = AGENTS[s.agent].turns(s);
  for (const t of turns.slice(-n)) {
    const tag = t.role === "user" ? cyan("user     ") : green("assistant");
    console.log(`${tag} ${dim(t.ts?.slice(11, 16) ?? "")} ${truncate(t.text, 400)}\n`);
  }
  console.log(dim(`[${s.agent}] session ${s.id} - ${turns.length} text turns, last activity ${fmtAge((Date.now() - s.mtime) / 1000)} ago`));

  // push/pull keep the id, so the same session can sit on several machines and
  // drift apart. say so, with each copy's age, rather than pretending it's one.
  // (--local skips the check; it's what a remote show is invoked with, so the
  // far end doesn't start probing its own hosts on our behalf.)
  if (args.includes("--local")) return;
  const elsewhere = await findCopies(s.id, listHosts());
  for (const c of elsewhere)
    console.log(yellow(`also on ${c.host}`) + dim(` - last activity ${fmtAge((Date.now() - new Date(c.mtime)) / 1000)} ago (separate copy, diverges independently)`));
}

// ask each host whether it holds this id. advisory only: a host that is down or
// running an older casm is skipped rather than failing the command.
async function findCopies(id, hosts) {
  // short timeout: this is a footnote on a command that already has its answer,
  // so a host that is down must not hold `show` open for the usual 10s
  const probes = hosts.map((h) => remoteRows(h, id, 2, 4).then((rows) => rows.map((r) => ({ ...r, host: h }))));
  return (await Promise.all(probes)).flat();
}
async function remoteRows(host, idPrefix, n = 2, timeout = 10) {
  const r = await casmRemote(host, ["list", "--json", "--local", "--id", idPrefix, "-n", String(n)], timeout);
  if (!r.ok) return [];
  try { return JSON.parse(r.out); } catch { return []; }
}

async function showRemote(hosts, idPrefix, n, explicit) {
  const results = hosts.map((h) => casmRemote(h, ["show", idPrefix, "-n", String(n), "--local"]));
  let found = false;
  for (const [i, h] of hosts.entries()) {
    const r = await results[i];
    if (!r.ok) {
      if (explicit) die(`${h}: ${r.err || "no answer - check ssh, and that casm is installed there"}`);
      continue;
    }
    found = true;
    console.log(`${green("● " + h)}\n`);
    console.log(r.out);
  }
  if (!found) die(`no session matching '${idPrefix}' on this machine or any configured host`);
}

export async function cmdResume(args) {
  const [idPrefix] = positionals(args);
  if (!idPrefix) die("usage: casm resume <session-id-prefix>");
  launch(findSession(idPrefix));
}

// hand the terminal to the agent, in the session's own directory. resuming by
// id (not `--continue`) so you land in the session you picked, not whatever
// happens to be newest in that directory.
function launch(s) {
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : process.cwd();
  if (!s.cwd || !fs.existsSync(s.cwd))
    console.error(dim(`warning: original cwd ${s.cwd ?? "?"} missing, resuming from ${cwd}`));
  const cmd = AGENTS[s.agent].resumeCmd(s, cwd);
  console.error(dim(`$ ${cmd}`));
  const [bin, ...binArgs] = cmd.split(" && ")[1].split(" ");
  const r = spawnSync(bin, binArgs, { cwd, stdio: "inherit" });
  process.exit(r.status ?? 0);
}

export async function cmdContinue(args) {
  const n = intFlag(args, "-n", 10);
  const sessions = allSessions(strFlag(args, "--agent", null)).slice(0, n);
  if (!sessions.length) { console.log("no sessions found"); return; }

  sessions.forEach((s, i) => {
    AGENTS[s.agent].enrich(s);
    console.log(
      `${cyan(pad(`${i + 1})`, 4))} ${dim(pad(fmtAge((Date.now() - s.mtime) / 1000) + " ago", 9))} ${AGENTS[s.agent].tag()}  ${green(pad(shortProject(s.cwd), 26))}  ${truncate(s.preview || dim("(untitled)"), 54)}`
    );
  });

  if (!process.stdin.isTTY) die("not a terminal - use: casm resume <id-prefix>");
  const answer = await ask(`\ncontinue [1-${sessions.length}, enter=1, q to abort]: `);
  if (answer === null || answer === "q") { console.log("aborted"); return; }
  const idx = answer === "" ? 1 : parseInt(answer, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > sessions.length) die(`invalid choice '${answer}'`);
  launch(sessions[idx - 1]);
}

// ---------- active ----------

function agentProcs() {
  let out;
  try {
    out = execFileSync("ps", ["-axo", "pid=,ppid=,comm=,args="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch { return []; }
  const procs = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, comm, cmdline] = m;
    const [argv0, ...cmdArgs] = cmdline.split(/\s+/);
    // skip casm itself, but only casm itself: matching "casm" anywhere in the
    // command line would hide `opencode ~/src/casm`, which is a real session
    if (/(^|\/)casm(\.mjs)?$/.test(argv0) || cmdArgs.some((a) => /(^|\/)casm\.mjs$/.test(a))) continue;
    for (const [name, A] of Object.entries(AGENTS)) {
      if (A.procMatch(path.basename(comm), argv0, cmdArgs)) { procs.push({ pid: +pid, ppid: +ppid, agent: name }); break; }
    }
  }
  const pids = new Set(procs.map((p) => p.pid));
  return procs.filter((p) => !pids.has(p.ppid));
}

function procCwd(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
    const m = out.match(/^n(.+)$/m);
    return m ? m[1] : null;
  } catch { return null; }
}
const hasChildren = (pid) => {
  try { return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().length > 0; }
  catch { return false; }
};

function claudeStatus(file, pid) {
  const ageSec = (Date.now() - fs.statSync(file).mtimeMs) / 1000;
  if (ageSec < 10) return { status: "generating", ageSec };
  const entries = [];
  readLines(file, (o) => { entries.push(o); }, 128 * 1024);
  const lastMsg = [...entries].reverse().find((o) => o.type === "user" || o.type === "assistant");
  if (!lastMsg) return { status: "idle", ageSec };
  if (lastMsg.type === "assistant") {
    const hasToolUse = Array.isArray(lastMsg.message?.content) && lastMsg.message.content.some((b) => b.type === "tool_use");
    if (hasToolUse) return hasChildren(pid) ? { status: "running tool", ageSec } : { status: "waiting approval?", ageSec };
    return { status: "idle", ageSec };
  }
  return { status: ageSec < 300 ? "working" : "stalled?", ageSec };
}

export async function cmdActive() {
  const procs = agentProcs();
  if (!procs.length) { console.log(dim("none")); return; }
  for (const p of procs) {
    const A = AGENTS[p.agent];
    const label = `${dim("pid " + String(p.pid).padEnd(7))} ${A.tag()} `;

    // claude names the exact session this pid is running, which no amount of
    // transcript-sniffing can do. its `status` is not used: a single `busy`
    // covers generating / running tool / long turn, all of which the transcript
    // tells apart, so the status still comes from the transcript - just from
    // the right one.
    const live = p.agent === "claude" ? claudeLive(p.pid) : null;
    if (live?.sessionId && live?.cwd) {
      const file = path.join(CC_PROJECTS, ccSlug(live.cwd), `${live.sessionId}.jsonl`);
      let st;
      try { st = claudeStatus(file, p.pid); }
      // no transcript yet (session registered, nothing said to it): claude's own
      // word is all there is, and only until the first message lands
      catch { st = { status: live.status === "busy" ? "working" : live.status || "idle",
                     ageSec: (Date.now() - (live.statusUpdatedAt ?? live.updatedAt ?? Date.now())) / 1000 }; }
      printActive(label, live.sessionId, live.cwd, st, live.name);
      continue;
    }

    const cwd = procCwd(p.pid);
    if (!cwd) { console.log(`${label} ${yellow("unknown cwd")}`); continue; }

    let sess = null, st = null;
    if (p.agent === "claude" || p.agent === "pi") {
      const dir = p.agent === "claude" ? path.join(CC_PROJECTS, ccSlug(cwd)) : path.join(PI_SESSIONS, piSlug(cwd));
      let newest = null;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith(".jsonl")) continue;
          const full = path.join(dir, f);
          const mt = fs.statSync(full).mtimeMs;
          if (!newest || mt > newest.mt) newest = { full, mt, f };
        }
      } catch {}
      if (newest) {
        sess = p.agent === "claude" ? newest.f.slice(0, -6) : newest.f.replace(/\.jsonl$/, "").split("_").pop();
        st = p.agent === "claude"
          ? claudeStatus(newest.full, p.pid)
          : { status: (Date.now() - newest.mt) / 1000 < 10 ? "generating" : "idle", ageSec: (Date.now() - newest.mt) / 1000 };
      }
    } else if (p.agent === "opencode" && A.available()) {
      const rows = sq(`select id, time_updated from session where directory = ${shq0(cwd)} order by time_updated desc limit 1`);
      if (rows.length) {
        sess = rows[0].id;
        const ageSec = (Date.now() - rows[0].time_updated) / 1000;
        st = { status: ageSec < 10 ? "generating" : "idle", ageSec };
      }
    }

    if (!sess) { console.log(`${label} ${green(pad(shortProject(cwd), 26))}  ${yellow("no session found")}`); continue; }
    printActive(label, sess, cwd, st);
  }
}

function printActive(label, sess, cwd, st, name) {
  const statusCol =
    st.status === "generating" || st.status === "working" ? green(pad(st.status, 17))
    : st.status.startsWith("waiting") ? yellow(pad(st.status, 17))
    : st.status === "running tool" ? cyan(pad(st.status, 17))
    : dim(pad(st.status, 17));
  console.log(
    `${label} ${cyan(pad(sess, 11))}  ${green(pad(shortProject(cwd), 26))}  ${statusCol} ${dim("last activity " + fmtAge(st.ageSec) + " ago")}${name ? dim("  " + name) : ""}`
  );
}

// ---------- host config ----------

const HOST_USAGE = `usage: casm host list
       casm host add <ssh-target>     a ~/.ssh/config name, or user@host
       casm host rm  <ssh-target>`;

// targets end up inside `ssh <target>`; anything exotic goes in ~/.ssh/config
const validTarget = (t) => /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(t);

export async function cmdHost(args) {
  const [sub = "list", ...rest] = positionals(args);
  if (["list", "ls"].includes(sub)) return hostList();
  if (sub === "add") return hostAdd(rest);
  if (["rm", "remove", "del", "delete"].includes(sub)) return hostRemove(rest);
  die(`unknown subcommand '${sub}'\n${HOST_USAGE}`);
}

async function hostList() {
  const hosts = listHosts();
  if (!hosts.length) {
    console.log(`no hosts configured ${dim(`(${CONFIG_PATH})`)}`);
    console.log(dim("add one with: casm host add <ssh-target>"));
    return;
  }
  const probes = hosts.map(probeHost); // all at once; each capped by ConnectTimeout
  for (const [i, h] of hosts.entries())
    console.log(`${green(pad(h, 28))}  ${fmtProbe(await probes[i])}`);
  console.log(dim(`\n${CONFIG_PATH}`));
}

// always exits 0 so a missing casm stays distinguishable from a failed connection
const probeHost = (target) => sshTry(target, "bash -lc 'command -v casm >/dev/null 2>&1 && echo CASM || echo NOCASM'");
const fmtProbe = (r) => {
  if (!r.ok) return yellow(pad("unreachable", 13)) + dim(truncate(r.err, 50));
  return r.out.split("\n").pop() === "CASM"
    ? green(pad("ready", 13))
    : yellow(pad("no casm", 13)) + dim("ssh works, but casm is not on PATH there");
};

async function hostAdd(rest) {
  const [target] = rest;
  if (!target) die(HOST_USAGE);
  if (!validTarget(target))
    die(`invalid ssh target '${target}' - use a ~/.ssh/config name or user@host\n${HOST_USAGE}`);
  const cfg = loadConfigForWrite();
  const hosts = normalizeHosts(cfg);
  const known = hosts.includes(target);
  if (!known) hosts.push(target);
  cfg.hosts = hosts; // also rewrites a pre-0.6 alias map as a plain list
  saveConfig(cfg);
  console.log(`${known ? "already configured" : "added"} ${green(target)}`);

  const r = await probeHost(target);
  console.log(`probe:  ${fmtProbe(r)}`);
  if (!r.ok) console.log(dim(`fix with: make \`ssh ${target}\` work (key auth, ~/.ssh/config), then re-run`));
  else if (r.out.split("\n").pop() !== "CASM") console.log(dim(`fix with: ssh ${target} 'npm i -g casm-cli'`));
}

function hostRemove(rest) {
  const [target] = rest;
  if (!target) die(HOST_USAGE);
  const cfg = loadConfigForWrite();
  const hosts = normalizeHosts(cfg);
  if (!hosts.includes(target))
    die(`no host '${target}' configured${hosts.length ? ` - have: ${hosts.join(", ")}` : ""}`);
  cfg.hosts = hosts.filter((h) => h !== target);
  saveConfig(cfg);
  console.log(`removed ${green(target)}`);
}

// ---------- push / pull ----------

export async function cmdPush(args) {
  const toFlagVal = strFlag(args, "--to", null);
  const [idPrefix, host] = positionals(args, ["--to"]);
  if (!idPrefix || !host) die("usage: casm push <session-id-prefix> <ssh-host> [--to <remote-project-path>] [--dry-run] [--force]");
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  const s = findSession(idPrefix);
  if (!s.cwd) die("could not determine session cwd");
  const base = path.basename(s.cwd);
  const rel = s.cwd.startsWith(HOME) ? s.cwd.slice(HOME.length) : null;

  console.log(`session   ${AGENTS[s.agent].tag()} ${cyan(pad(s.id, 11))}  ${dim(truncate(s.preview ?? "", 55))}`);
  console.log(`project   ${s.cwd}\n`);

  if (toFlagVal) {
    // relative --to needs the real remote home: a literal "$HOME" would be shq-quoted, never expanded
    const home = toFlagVal.startsWith("/") ? null : ssh(host, 'printf %s "$HOME"');
    return doPush(host, s, absolutize(toFlagVal, home), { force, dryRun });
  }

  const probe = ssh(host, [
    `H="$HOME"`,
    `printf 'HOME=%s\\n' "$H"`,
    rel !== null ? `C="$H"${shq(rel)}` : `C=${shq(s.cwd)}`,
    `printf 'CANDIDATE=%s\\n' "$C"`,
    `[ -d "$C" ] && echo EXACT=yes || echo EXACT=no`,
    `find "$H" -maxdepth 4 -type d -name ${shq(base)} -not -path '*/.*' 2>/dev/null | head -8`,
  ].join("; "));
  const lines = probe.split("\n");
  const remoteHome = lines.find((l) => l.startsWith("HOME="))?.slice(5);
  const candidate = lines.find((l) => l.startsWith("CANDIDATE="))?.slice(10);
  const exactExists = lines.includes("EXACT=yes");
  const sameName = lines.filter((l) => l.startsWith("/") && l !== candidate);

  console.log(`on ${green(host)} ${dim(`(home ${remoteHome})`)}:`);
  console.log(`  exact path ${candidate} - ${exactExists ? green("found") : yellow("not found")}`);
  if (sameName.length) {
    console.log(`  same-name dirs elsewhere:`);
    for (const d of sameName) console.log(`    ${d}`);
  } else console.log(`  same-name dirs elsewhere: ${dim("none")}`);

  const options = [];
  if (exactExists) options.push({ label: `push into ${candidate}`, path: candidate });
  for (const d of sameName) options.push({ label: `push into ${d}`, path: d });
  let localSize = "?";
  try { localSize = execFileSync("du", ["-sh", s.cwd], { encoding: "utf8" }).split("\t")[0]; } catch {}
  options.push({ label: `copy entire local project dir (${localSize}) to ${candidate}, then push`, path: candidate, copyProject: true });
  options.push({ label: `custom remote path (created if missing)`, custom: true });

  console.log(`\noptions:`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
  console.log(`  q) abort`);

  if (dryRun) { console.log(dim("\n(dry run - stopping before the prompt)")); return; }
  if (!process.stdin.isTTY) die("not a terminal - use --to <path> for non-interactive push");

  const answer = await ask(`choose [1-${options.length}/q]: `);
  if (!answer || answer === "q") { console.log("aborted"); return; }
  const chosen = options[parseInt(answer, 10) - 1];
  if (!chosen) die(`invalid choice '${answer}'`);

  let target = chosen.path;
  if (chosen.custom) {
    const p = await ask(`remote path (absolute, or relative to ${remoteHome}): `);
    if (!p) die("no path given");
    target = absolutize(p, remoteHome);
  }
  await doPush(host, s, target, { force, copyProject: chosen.copyProject });
}

async function doPush(host, s, remotePath, { force = false, dryRun = false, copyProject = false } = {}) {
  console.log(`\nagent      ${s.agent}`);
  console.log(`target     ${host}:${remotePath}`);
  if (copyProject) console.log(`project    → full rsync of ${s.cwd}`);
  if (dryRun) { console.log(dim("(dry run - nothing copied)")); return; }

  // --force silently replaces a copy that may have been worked on over there
  if (force) {
    const [existing] = await remoteRows(host, s.id, 1);
    if (existing)
      console.log(yellow(`\nreplacing the copy already on ${host}, last activity ${fmtAge((Date.now() - new Date(existing.mtime)) / 1000)} ago`));
  }

  if (copyProject && s.cwd) {
    ssh(host, `mkdir -p ${shq(remotePath)}`);
    execFileSync("rsync", ["-a", "--info=progress2", s.cwd + "/", `${host}:${remotePath}/`], { stdio: "inherit" });
  }
  await AGENTS[s.agent].push(s, host, remotePath, force);
  console.log(green(`\npushed. resume on ${host} (e.g. in your tmux pane there):`));
  console.log(`  ${AGENTS[s.agent].resumeCmd(s, remotePath)}`);
}

// the remote's own casm reports its sessions; --local so it answers for itself
// and doesn't fan out to its hosts in turn
async function remoteSessions(host, extraArgs) {
  const r = await casmRemote(host, ["list", "--json", "--local", ...extraArgs]);
  if (!r.ok) die(`${host}: ${r.err || "no answer - check ssh, and that casm is installed there (npm i -g casm-cli)"}`);
  try { return JSON.parse(r.out); } catch { die(`${host}: unexpected reply from remote casm (is it older than 0.6?)`); }
}

export async function cmdPull(args) {
  const [host, rawPrefix] = positionals(args, ["-n"]);
  if (!host) die("usage: casm pull <ssh-host> [session-id-prefix] [-n 20] [--force]");
  const idPrefix = normalizeIdPrefix(rawPrefix);
  if (idPrefix && !/^[A-Za-z0-9_-]+$/.test(idPrefix)) die(`invalid session id prefix '${idPrefix}'`);
  const force = args.includes("--force");

  if (!idPrefix) {
    const rows = await remoteSessions(host, ["-n", String(intFlag(args, "-n", 20))]);
    if (!rows.length) { console.log(`no sessions found on ${host}`); return; }
    console.log(`newest sessions on ${green(host)}:\n`);
    for (const r of rows) {
      const tag = AGENTS[r.agent]?.tag() ?? yellow(pad(r.agent ?? "?", 2)); // a newer remote may know agents we don't
      console.log(`${dim(r.mtime.slice(0, 16).replace("T", " "))}  ${tag}  ${cyan(pad(r.id, 11))}  ${green(pad(shortProject(r.cwd), 26))}  ${truncate(r.preview || dim("(untitled)"), 50)}`);
    }
    console.log(dim(`\npull one with: casm pull ${host} <id-prefix>`));
    return;
  }

  const matches = await remoteSessions(host, ["--id", idPrefix, "-n", "5"]);
  if (!matches.length) die(`no session matching '${idPrefix}' on ${host}`);
  if (matches.length > 1) die(`ambiguous id '${idPrefix}' (${matches.length} matches on ${host}) - use more characters`);
  const r = matches[0];
  if (!AGENTS[r.agent]) die(`${host} reports agent '${r.agent}', which this casm does not know - upgrade it here (npm i -g casm-cli)`);
  if (!r.cwd) die("could not determine the session's directory on the remote");

  // map the remote project path into this machine's home
  const remoteHome = ssh(host, 'printf %s "$HOME"');
  const localPath = r.cwd.startsWith(remoteHome) ? HOME + r.cwd.slice(remoteHome.length) : r.cwd;

  console.log(`session   ${AGENTS[r.agent].tag()} ${cyan(r.id)}  ${dim(truncate(r.preview ?? "", 50))}`);
  console.log(`from      ${host}:${r.cwd}`);
  console.log(`into      ${localPath}${fs.existsSync(localPath) ? "" : yellow("  (does not exist here yet)")}`);

  // the id survives the transfer, so you may already hold a copy that has since
  // moved on. never overwrite one silently.
  const mine = findSession(r.id, { soft: true });
  if (mine) {
    const age = fmtAge((Date.now() - mine.mtime) / 1000);
    if (!force) die(`you already have ${r.id.slice(0, 10)} here (last activity ${age} ago) - pass --force to replace it with ${host}'s copy`);
    console.log(yellow(`\nreplacing your local copy, last activity ${age} ago`));
  }
  console.log("");

  await AGENTS[r.agent].pull(r, host, localPath, force);
  console.log(green(`\npulled. resume it with:`));
  console.log(`  casm resume ${r.id}`);
}
