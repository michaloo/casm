// command implementations
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import {
  HOME, CONFIG_PATH, dim, cyan, green, yellow, pad, truncate, fmtAge, shq, shq0, die,
  ask, readLines, intFlag, strFlag, positionals, normalizeIdPrefix,
  listHosts, normalizeHosts, loadBookmarks, loadConfigForWrite, saveConfig,
  shortProject, snippet, absolutize, ensureStore, STORE_ROOT, loadContainerized,
} from "./util.mjs";
import { AGENTS, CC_PROJECTS, PI_SESSIONS, claudeLive, ccSlug, piSlug, sq, activeAgents, allSessions, findSession, displayCmd, stores, storePaths } from "./agents.mjs";
import {
  LOCAL, resolveNode, nodeLabel, isRemote, exec, tryExec, casmOn, interactive, copyTo,
  loadContainers, containerName, containerState, ensureRunning, requireDocker,
} from "./nodes.mjs";
import {
  createContainer, imageExists, reseedAuth,
  ensureCasmKey, checkGitConfig, claudeAuthPlan, allocatePorts, PORT_BLOCK,
  DEFAULT_IMAGE, CONTAINER_BRIEF,
} from "./docker.mjs";

// Every command that runs something in a container comes through here first, so
// a container stopped by a reboot is started rather than reported as an error.
async function live(node) {
  const why = await ensureRunning(node);
  if (why) die(why);
  return node;
}
const targetNode = (args) => live(resolveNode(strFlag(args, "--host", null)));

// The only thing in a listing that says a session runs in a container. It sits
// in front of the project, because that is what it qualifies - where this
// session lives. Two columns wide either way, so rows stay aligned.
//
// The container's name is deliberately absent: casm generates it, you never type
// it, and printing it would invite treating it as something to address.
const boxMark = (s) => (s.store?.name ? dim("▣ ") : "  ");
// Printed under a listing only when something in it was marked, so the glyph is
// never unexplained and never in the way.
const boxLegend = (rows) =>
  rows.some((s) => s.store?.name) && console.log(dim("\n▣ runs in its own container"));

export async function cmdList(args) {
  const n = intFlag(args, "-n", 20);
  const agent = strFlag(args, "--agent", null);
  const project = strFlag(args, "--project", null);
  const idPrefix = normalizeIdPrefix(strFlag(args, "--id", null));
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
      return { agent: s.agent, id: s.id, cwd: s.cwd, file: s.file, mtime: s.mtime.toISOString(), preview: s.preview ?? "", ctx: ctxOf(s.agent, s) };
    });
    console.log(JSON.stringify(rows));
    return;
  }
  for (const s of sessions.slice(0, n)) {
    AGENTS[s.agent].enrich(s);
    const when = s.mtime.toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `${dim(when)}  ${AGENTS[s.agent].tag()}  ${cyan(pad(s.id, 11))}  ${boxMark(s)}${green(pad(shortProject(s.cwd), 26))}  ${ctxCol(ctxOf(s.agent, s))}  ${truncate(s.preview || dim("(untitled)"), 56)}`
    );
  }
  if (!sessions.length) console.log("no sessions found");
  else boxLegend(sessions.slice(0, n));
}

export async function cmdSearch(args) {
  const agentFlagVal = strFlag(args, "--agent", null);
  const [term] = positionals(args, ["-n", "--agent"]);
  if (!term) die("usage: casm search <term> [--agent claude|codex|opencode|pi] [-n N]");
  const n = intFlag(args, "-n", 25);
  const needle = term.toLowerCase();
  let hits = 0;
  const shown = [];

  // every store on this machine: your own home, then one per containerized session
  for (const store of stores()) {
  if (hits >= n) break;
  for (const name of activeAgents(agentFlagVal, store)) {
    if (hits >= n) break;
    const A = AGENTS[name];
    if (A.search) {
      for (const h of A.search(term, n - hits, store)) {
        hits++; shown.push(h);
        console.log(`${dim(h.mtime.toISOString().slice(0, 10))}  ${A.tag()}  ${cyan(pad(h.id, 11))}  ${boxMark(h)}${green(pad(shortProject(h.cwd), 24))}  …${snippet(h.text, h.idx, term.length)}…`);
      }
      continue;
    }
    for (const s of A.sessions(store).sort((a, b) => b.mtime - a.mtime)) {
      if (hits >= n) break;
      let found = null;
      readLines(s.file, (o) => {
        const raw = A.searchEntry(o);
        if (!raw) return;
        // matched on the same string the snippet is cut from: the offset used
        // to come from the unflattened text, so collapsing whitespace shifted
        // the highlight off the term by however many runs preceded it
        const text = raw.replace(/\s+/g, " ");
        const idx = text.toLowerCase().indexOf(needle);
        if (idx === -1) return;
        found = snippet(text, idx, term.length);
        return false;
      });
      if (found) {
        hits++; shown.push(s);
        A.enrich(s);
        console.log(`${dim(s.mtime.toISOString().slice(0, 10))}  ${A.tag()}  ${cyan(pad(s.id, 11))}  ${boxMark(s)}${green(pad(shortProject(s.cwd), 24))}  …${found}…`);
      }
    }
  }
  }
  if (!hits) console.log("no matches");
  else boxLegend(shown);
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
  const r = await casmOn(resolveNode(host), ["list", "--json", "--local", "--id", idPrefix, "-n", String(n)], timeout);
  if (!r.ok) return [];
  try { return JSON.parse(r.out); } catch { return []; }
}

async function showRemote(hosts, idPrefix, n, explicit) {
  const results = hosts.map((h) => casmOn(resolveNode(h), ["show", idPrefix, "-n", String(n), "--local"]));
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
  const [idPrefix] = positionals(args, ["--host"]);
  if (!idPrefix) die("usage: casm resume <session-id-prefix> [--host <ssh-target|container>]");
  const node = await targetNode(args);
  if (!isRemote(node)) return launch(findSession(idPrefix), node);

  // the session lives over there, so ask that machine's own casm about it
  const matches = await remoteSessions(node, ["--id", normalizeIdPrefix(idPrefix), "-n", "5"]);
  if (!matches.length) die(`no session matching '${idPrefix}' on ${nodeLabel(node)}`);
  if (matches.length > 1) die(`ambiguous id '${idPrefix}' (${matches.length} matches on ${nodeLabel(node)}) - use more characters`);
  if (!AGENTS[matches[0].agent]) die(`${nodeLabel(node)} reports agent '${matches[0].agent}', which this casm does not know`);
  launch(matches[0], node);
}

// hand the terminal to the agent, in the session's own directory. resuming by
// id (not `--continue`) so you land in the session you picked, not whatever
// happens to be newest in that directory.
//
// Only the local branch second-guesses the cwd: a remote session's cwd came
// from that machine's own casm, and stat-ing it here would test the wrong
// filesystem.
function launch(s, node = LOCAL) {
  // A containerized session runs where it lives. The store it was found in
  // names its container, so nothing has to be looked up and there is no way to
  // resume it on the host by accident - which would silently take a session
  // that ran with prompts off and resume it with prompts on.
  if (!isRemote(node) && s.store?.name) return launchContainerized(s);

  let cwd = s.cwd;
  if (!isRemote(node)) {
    cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : process.cwd();
    if (!s.cwd || !fs.existsSync(s.cwd))
      console.error(dim(`warning: original cwd ${s.cwd ?? "?"} missing, resuming from ${cwd}`));
  } else if (!cwd) {
    die(`could not determine the session's directory on ${nodeLabel(node)}`);
  }
  const argv = AGENTS[s.agent].resumeArgv(s, cwd);
  handOver(node, argv, cwd);
}

// What each agent needs on the argv to work unattended in a container.
//
// The brief: claude and pi take it with --append-system-prompt, where the agent
// cannot edit it away. opencode and codex have no such flag and read a file
// instead - /etc/opencode/casm-brief.md and $CODEX_HOME/AGENTS.md, both written
// at create time.
//
// Permissions: claude and opencode are handled by the root-owned managed policy
// files, and pi has no permission system. codex has neither, so it is the one
// agent that needs the flag - without it a containerized codex session still
// stops to ask for approval, which is the whole thing a container is for.
const boxArgv = (agent) =>
  agent === "claude" || agent === "pi" ? ["--append-system-prompt", CONTAINER_BRIEF]
  : agent === "codex" ? ["--dangerously-bypass-approvals-and-sandbox"]
  : [];

async function launchContainerized(s) {
  const name = s.store.name;
  let rec = loadContainers()[name];
  if (!rec) die(`session ${s.id.slice(0, 10)} belongs to container '${name}', which is not registered`);

  const target = rec.container ?? containerName(name);
  // The store outlives the container, so a container that has been removed - by
  // a prune, or by hand - costs nothing but the time to build it again. The
  // record holds everything needed, which is the whole reason it exists.
  if (containerState(target) === null) {
    requireDocker();
    console.error(dim(`container ${name} is gone - rebuilding it from its record`));
    await provision({ name, dir: rec.dir, agent: s.agent, image: rec.image ?? DEFAULT_IMAGE, root: rec.root, args: [], keepPorts: rec.ports ?? null });
    rec = loadContainers()[name];
    runSetup(rec);
  }

  const node = { kind: "docker", name, target: rec.container ?? target, cfg: rec };
  const why = await ensureRunning(node);
  if (why) die(why);
  refreshAuth(rec, s.agent);
  handOver(node, [...AGENTS[s.agent].resumeArgv(s, s.cwd), ...boxArgv(s.agent)], s.cwd);
}

// The credential casm seeds carries no refresh token - deliberately, so a
// container can use your login but never rotate the one your host depends on.
// The cost is that it expires, and there is no command to top it up by hand any
// more. So top it up on the way in, every time: the host's
// credential is the freshest thing available, and copying it costs a fraction
// of the time the agent takes to start.
//
// Never fatal. A container that has been running for a week on an expired token
// should still open, and say why it will ask you to log in.
function refreshAuth(rec, agent) {
  try {
    reseedAuth({ target: rec.container, agents: [agent], dir: rec.dir, store: rec.root });
  } catch (e) {
    console.error(yellow(`could not refresh credentials in ${rec.container}: ${e.message}`));
  }
}

// What the agent recorded about the environment it built. Re-run only on a
// rebuild, never on an ordinary start: a stopped container still has everything
// it installed, and re-running installs on every resume would turn a
// sub-second start into minutes.
function runSetup(rec) {
  const script = path.join(rec.root, ".casm", "setup.sh");
  if (!fs.existsSync(script) || !fs.readFileSync(script, "utf8").trim()) {
    console.error(dim("  no setup.sh recorded - the container starts from the bare image"));
    return;
  }
  console.error(dim(`  running setup.sh to rebuild the environment`));
  const r = spawnSync("docker", ["exec", "-w", rec.dir, rec.container, "bash", script], { stdio: "inherit" });
  if (r.status !== 0) console.error(yellow(`  setup.sh exited ${r.status} - the environment may be incomplete`));
}

// Every launch path ends here. The tty check is not cosmetic: `ssh -t` and
// `docker exec -it` both fail with their own opaque message when stdin is not a
// terminal, and this is a command you might reasonably try from a script.
function handOver(node, argv, cwd) {
  console.error(dim(`$ ${isRemote(node) ? `[${nodeLabel(node)}] ` : ""}${displayCmd(argv, cwd)}`));
  if (isRemote(node) && !process.stdin.isTTY)
    die(`not a terminal - starting a session on ${nodeLabel(node)} needs one`);
  process.exit(interactive(node, argv, cwd));
}

// start a session rather than resume one. the agent's own defaults apply: a
// container has already been made permissive at create time, and anywhere else
// tightening or loosening permissions is not casm's business.
export async function cmdNew(args) {
  if (args.includes("--containerized")) return newContainerized(args);
  const node = await targetNode(args);
  const agentName = strFlag(args, "--agent", "claude");
  if (!AGENTS[agentName]) die(`unknown agent '${agentName}' (claude|codex|opencode|pi)`);

  let dir = strFlag(args, "--dir", null);
  if (!dir && node.kind === "docker") dir = node.cfg?.dir; // the mounted project is the only interesting place
  if (!dir) dir = isRemote(node) ? exec(node, 'printf %s "$PWD"') : process.cwd();
  if (!isRemote(node)) dir = path.resolve(dir);

  const argv = AGENTS[agentName].newArgv(dir);
  handOver(node, argv, dir);
}

// The picker covers this machine and its containers, and resumes the pick
// wherever it actually lives. Deliberately not the configured ssh hosts, unlike
// list/active/search: continue ends by handing your terminal to an agent, and a
// numbered list that can silently drop you onto another machine is a mis-key
// waiting to happen. A container is a different matter - it shares this
// machine's filesystem and its project is mounted at the same path, so a
// session there is one of yours in a way a remote host's is not. Reach a host
// explicitly with --host.
//
// It does not go through fanOut() either: that prints one block per node, and
// the point here is a single list ordered by recency.
export async function cmdContinue(args) {
  const n = intFlag(args, "-n", 10);
  const hostArg = strFlag(args, "--host", null);
  const agentFilter = strFlag(args, "--agent", null);
  const agentArgs = agentFilter ? ["--agent", agentFilter] : [];

  // Containers are not nodes: a containerized session's transcripts are in a
  // store on this machine, so allSessions() already has them. Asking the
  // container as well would offer every one of them twice.
  const nodes = hostArg ? [await targetNode(args)] : [LOCAL];
  // bookmarks are per-machine, so they only mean anything in a survey that
  // includes this machine
  const marks = nodes.includes(LOCAL) ? loadBookmarks() : {};

  // remotes start first and answer concurrently, so the survey costs about one
  // round trip rather than one per node
  const remotes = nodes.filter(isRemote).map(async (node) => {
    const why = await ensureRunning(node);
    if (why) { console.error(dim(why)); return []; }
    const rows = await remoteSessions(node, [...agentArgs, "-n", String(n)], { soft: true });
    return rows.filter((s) => AGENTS[s.agent]).map((s) => ({ ...s, mtime: new Date(s.mtime), node }));
  });
  // not sliced to n: a bookmark is pinned out of this list further down, and
  // slicing first would drop the cold ones that pinning exists to rescue
  const localRows = nodes.includes(LOCAL)
    ? allSessions(agentFilter).map((s) => ({ ...s, node: LOCAL })) : [];
  const all = [...localRows, ...(await Promise.all(remotes)).flat()].sort((a, b) => b.mtime - a.mtime);

  // Bookmarks stay pinned above the rest rather than sorted in with it: a pin is
  // there precisely because it is worth reaching after it has gone cold. The
  // section headers exist so that reads as deliberate and not as a sort bug.
  const pinned = all.filter((s) => s.id in marks && !isRemote(s.node));
  const sessions = [...pinned, ...all.filter((s) => !pinned.includes(s))].slice(0, n);
  if (!sessions.length) { console.log(`no sessions found${hostArg ? ` on ${nodeLabel(nodes[0])}` : ""}`); return; }

  const multi = new Set(sessions.map((s) => s.node.name)).size > 1;
  sessions.forEach((s, i) => {
    if (i === 0 && pinned.length) console.log(dim("  bookmarks"));
    if (i === pinned.length && pinned.length) console.log(dim("\n  recent"));
    if (!isRemote(s.node)) AGENTS[s.agent].enrich(s);
    const mark = s.id in marks ? yellow(` ★${marks[s.id] ? " " + marks[s.id] : ""}`) : "";
    const where = multi ? " " + dim(pad(truncate(s.node.name, 14), 14)) : "";
    console.log(
      `${cyan(pad(`${i + 1})`, 4))} ${dim(pad(fmtAge((Date.now() - s.mtime) / 1000) + " ago", 9))} ${AGENTS[s.agent].tag()}${where}  ${boxMark(s)}${green(pad(shortProject(s.cwd), 26))}  ${ctxCol(isRemote(s.node) ? s.ctx ?? null : ctxOf(s.agent, s))}  ${truncate(s.preview || dim("(untitled)"), multi ? 34 : 48)}${mark}`
    );
  });

  boxLegend(sessions);
  if (!process.stdin.isTTY) die("not a terminal - use: casm resume <id-prefix>");
  const answer = await ask(`\ncontinue [1-${sessions.length}, enter=1, q to abort]: `);
  if (answer === null || answer === "q") { console.log("aborted"); return; }
  const idx = answer === "" ? 1 : parseInt(answer, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > sessions.length) die(`invalid choice '${answer}'`);
  launch(sessions[idx - 1], sessions[idx - 1].node);
}

// ---------- context column ----------

const fmtTokens = (t) => (t >= 1000 ? `${Math.round(t / 1000)}k` : String(t));

// context of a session: the input side of its newest assistant turn - prompt,
// history and tool results that filled the model's window last time it ran.
// shown as a column in every listing; blank when a session has no turns yet.
function ctxOf(agentName, sLike) {
  try { return AGENTS[agentName].contextUsage?.(sLike)?.ctx ?? null; } catch { return null; }
}
const ctxCol = (ctx) => (ctx != null ? cyan(pad(fmtTokens(ctx), 5)) : dim(pad("", 5)));

// ---------- active ----------

// On Linux a container's processes are visible in the host's own process table,
// so an agent running in a casm container gets counted twice: once by the casm
// on the host and again by the casm inside the container. The host's view is the
// worse of the two, since it resolves the session against whatever transcript
// happens to be newest in that directory - which after a `casm pull` is a stale
// copy, reported with the wrong age.
//
// /proc/<pid>/cgroup names the runtime when a process belongs to a container:
// `libpod-<id>.scope/container` for podman, `/docker/<id>` or `docker-<id>.scope`
// for docker. macOS has no /proc and keeps containers in a VM, so there is
// nothing to filter and this always returns false there.
function inContainer(pid) {
  try {
    return /libpod-|\/docker[-/]|crio-|\.scope\/container/
      .test(fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"));
  } catch { return false; }
}

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
  return procs.filter((p) => !pids.has(p.ppid) && !inContainer(p.pid));
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

// `kids` overrides the process-table lookup. A containerized agent's children
// are in the container's pid namespace, so the caller answers that from the ps
// it already ran in there; only the host case falls back to hasChildren().
function claudeStatus(file, pid, kids = null) {
  const ageSec = (Date.now() - fs.statSync(file).mtimeMs) / 1000;
  if (ageSec < 10) return { status: "generating", ageSec };
  const entries = [];
  readLines(file, (o) => { entries.push(o); }, 128 * 1024);
  const lastMsg = [...entries].reverse().find((o) => o.type === "user" || o.type === "assistant");
  if (!lastMsg) return { status: "idle", ageSec };
  if (lastMsg.type === "assistant") {
    const hasToolUse = Array.isArray(lastMsg.message?.content) && lastMsg.message.content.some((b) => b.type === "tool_use");
    if (hasToolUse) return (kids ?? hasChildren(pid)) ? { status: "running tool", ageSec } : { status: "waiting approval?", ageSec };
    return { status: "idle", ageSec };
  }
  return { status: ageSec < 300 ? "working" : "stalled?", ageSec };
}

// Agents running inside containerized sessions. Their processes are in the
// container's pid namespace: on linux the host `ps` sees them but agentProcs
// filters them out (they would resolve against the wrong store), and on macOS
// they are in a VM and invisible entirely. So ask each container that is up.
//
// One `ps` per running container, which also answers the children question that
// separates `running tool` from `waiting approval?` - the host's process table
// cannot, since those children are not in it either.
function containerProcs() {
  const out = [];
  for (const rec of loadContainerized()) {
    const target = rec.container ?? containerName(rec.name);
    if (containerState(target) !== "running") continue;
    let ps;
    try {
      ps = execFileSync("docker", ["exec", target, "ps", "-eo", "pid=,ppid=,comm=,args="],
        { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    } catch { continue; }

    const store = { name: rec.name, ...storePaths(rec.root) };
    const seen = [];
    for (const line of ps.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const [, pid, ppid, comm, cmdline] = m;
      const [argv0, ...cmdArgs] = cmdline.split(/\s+/);
      if (/(^|\/)casm(\.mjs)?$/.test(argv0)) continue;
      for (const [name, A] of Object.entries(AGENTS))
        if (A.procMatch(path.basename(comm), argv0, cmdArgs)) { seen.push({ pid: +pid, ppid: +ppid, agent: name }); break; }
    }
    const pids = new Set(seen.map((p) => p.pid));
    const ppids = new Set(ps.split("\n").map((l) => +(l.match(/^\s*\d+\s+(\d+)/)?.[1] ?? -1)));
    for (const p of seen.filter((p) => !pids.has(p.ppid)))
      out.push({ ...p, rec, store, hasKids: ppids.has(p.pid) });
  }
  return out;
}

export async function cmdActive() {
  const procs = agentProcs();
  const boxed = containerProcs();
  if (!procs.length && !boxed.length) { console.log(dim("none")); return; }
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
      printActive(label, live.sessionId, live.cwd, st, live.name, ctxOf("claude", { file }));
      continue;
    }

    const cwd = procCwd(p.pid);
    if (!cwd) { console.log(`${label} ${yellow("unknown cwd")}`); continue; }

    let sess = null, st = null, sessFile = null;
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
        sessFile = newest.full;
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
    const ctx = p.agent === "opencode" ? ctxOf("opencode", { id: sess }) : ctxOf(p.agent, { file: sessFile });
    printActive(label, sess, cwd, st, undefined, ctx);
  }

  for (const p of boxed) {
    const A = AGENTS[p.agent];
    const label = `${dim("pid " + String(p.pid).padEnd(7))} ${A.tag()} `;
    const store = p.store;
    let sess = null, sessFile = null, st = null, cwd = p.rec.dir;

    if (p.agent === "claude") {
      // claude writes its live file into the store, which is on the host, so
      // this names the exact session without entering the container
      const live = claudeLive(p.pid, store);
      if (live?.sessionId && live?.cwd) {
        cwd = live.cwd;
        sess = live.sessionId;
        sessFile = path.join(store.ccProjects, ccSlug(live.cwd), `${live.sessionId}.jsonl`);
      }
    }
    if (!sess && (p.agent === "claude" || p.agent === "pi")) {
      const dir = p.agent === "claude" ? path.join(store.ccProjects, ccSlug(cwd)) : path.join(store.piSessions, piSlug(cwd));
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
        sessFile = newest.full;
      }
    } else if (p.agent === "opencode" && A.available(store)) {
      const rows = sq(`select id, time_updated from session where directory = ${shq0(cwd)} order by time_updated desc limit 1`, store.ocDb);
      if (rows.length) {
        sess = rows[0].id;
        const ageSec = (Date.now() - rows[0].time_updated) / 1000;
        st = { status: ageSec < 10 ? "generating" : "idle", ageSec };
      }
    }

    if (!sess) { console.log(`${label} ${boxMark({ store })}${green(pad(shortProject(cwd), 26))}  ${yellow("no session found")}`); continue; }
    if (!st && sessFile) {
      st = p.agent === "claude"
        ? claudeStatus(sessFile, p.pid, p.hasKids)
        : { status: (Date.now() - fs.statSync(sessFile).mtimeMs) / 1000 < 10 ? "generating" : "idle",
            ageSec: (Date.now() - fs.statSync(sessFile).mtimeMs) / 1000 };
    }
    const ctx = p.agent === "opencode" ? ctxOf("opencode", { id: sess, store }) : ctxOf(p.agent, { file: sessFile });
    printActive(label, sess, cwd, st, undefined, ctx, { store });
  }
  boxLegend([...boxed.map((p) => ({ store: p.store }))]);
}

function printActive(label, sess, cwd, st, name, ctx, s = {}) {
  const statusCol =
    st.status === "generating" || st.status === "working" ? green(pad(st.status, 17))
    : st.status.startsWith("waiting") ? yellow(pad(st.status, 17))
    : st.status === "running tool" ? cyan(pad(st.status, 17))
    : dim(pad(st.status, 17));
  console.log(
    `${label} ${cyan(pad(sess, 11))}  ${boxMark(s)}${green(pad(shortProject(cwd), 26))}  ${ctxCol(ctx)}  ${statusCol} ${dim("last activity " + fmtAge(st.ageSec) + " ago")}${name ? dim("  " + name) : ""}`
  );
}

// ---------- bookmarks ----------

const BOOKMARK_USAGE = `usage: casm bookmark                       list bookmarks
       casm bookmark <id-prefix> [alias]   bookmark a session (★ in continue; alias works wherever an id does)
       casm bookmark rm <alias|id-prefix>  remove a bookmark (the session stays)`;

// aliases share the namespace with id-prefixes, so keep them un-id-like and
// clear of the subcommand words
const validAlias = (a) => /^[A-Za-z][A-Za-z0-9._-]*$/.test(a) && !["rm", "remove", "del", "delete", "list"].includes(a);

export async function cmdBookmark(args) {
  const [a, b] = positionals(args);
  if (!a || a === "list") return bookmarkList();
  if (["rm", "remove", "del", "delete"].includes(a)) return bookmarkRemove(b);
  return bookmarkAdd(a, b);
}

function bookmarkAdd(idPrefix, alias) {
  if (alias !== undefined && !validAlias(alias))
    die(`invalid alias '${alias}' - start with a letter; letters, digits, dot, dash, underscore\n${BOOKMARK_USAGE}`);
  const s = findSession(idPrefix); // resolves prefixes and existing aliases, dies if ambiguous
  const cfg = loadConfigForWrite();
  const marks = loadBookmarks();
  if (alias) {
    const clash = Object.keys(marks).find((id) => marks[id] === alias && id !== s.id);
    if (clash) die(`alias '${alias}' already points at ${clash.slice(0, 10)} - casm bookmark rm ${alias} first`);
  }
  const existed = s.id in marks;
  marks[s.id] = alias ?? marks[s.id] ?? ""; // re-bookmarking without an alias keeps an existing one
  cfg.bookmarks = marks;
  saveConfig(cfg);
  console.log(`${existed ? "updated" : "bookmarked"} ${yellow("★")} ${cyan(pad(s.id, 11))}${marks[s.id] ? ` as ${yellow(marks[s.id])}` : ""}  ${green(shortProject(s.cwd))}`);
  if (marks[s.id]) console.log(dim(`resume with: casm resume ${marks[s.id]}`));
}

function bookmarkList() {
  const marks = loadBookmarks();
  const ids = Object.keys(marks);
  if (!ids.length) { console.log(`no bookmarks ${dim("- add one with: casm bookmark <id-prefix> [alias]")}`); return; }
  const byId = new Map(allSessions(null).map((s) => [s.id, s]));
  for (const id of ids) {
    const s = byId.get(id);
    const alias = yellow(pad(marks[id] || "", 14));
    if (!s) { console.log(`${yellow("★")} ${alias} ${cyan(pad(id, 11))}  ${dim("(session no longer exists here)")}`); continue; }
    AGENTS[s.agent].enrich(s);
    console.log(`${yellow("★")} ${alias} ${AGENTS[s.agent].tag()}  ${cyan(pad(id, 11))}  ${green(pad(shortProject(s.cwd), 26))}  ${ctxCol(ctxOf(s.agent, s))}  ${dim(fmtAge((Date.now() - s.mtime) / 1000) + " ago")}  ${truncate(s.preview || dim("(untitled)"), 36)}`);
  }
}

function bookmarkRemove(nameOrPrefix) {
  if (!nameOrPrefix) die(BOOKMARK_USAGE);
  const needle = normalizeIdPrefix(nameOrPrefix);
  const marks = loadBookmarks();
  const hits = Object.keys(marks).filter((id) => marks[id] === needle || id.startsWith(needle));
  if (!hits.length) die(`no bookmark matching '${needle}'`);
  if (hits.length > 1) die(`ambiguous '${needle}' (${hits.length} bookmarks) - use the alias or more characters`);
  const cfg = loadConfigForWrite();
  delete marks[hits[0]];
  cfg.bookmarks = marks;
  saveConfig(cfg);
  console.log(`removed bookmark ${cyan(hits[0].slice(0, 10))}${marks[hits[0]] ? "" : ""} ${dim("(the session itself is untouched)")}`);
}

// ---------- containers ----------


// A bare name means a container here and nothing else, so a name that is
// neither a local container nor a plausible ssh target is worth naming as such -
// otherwise it reaches ssh and fails with "Could not resolve hostname".
export function explainUnknownTarget(name) {
  if (!name || name.includes("/") || name.includes("@") || name.includes(".")) return null;
  if (loadContainers()[name] || listHosts().includes(name)) return null;
  return `no container '${name}' here, and no host by that name\n` +
         `a bare name is always a local container; a container elsewhere is <host>/${name}`;
}

// ---------- containerize ----------

// A derived name, never chosen: the project's own directory name, with a
// counter when that project already has one. This is what the containers in the
// wild were called by hand, so casm may as well generate it.
function containerNameFor(dir) {
  const base = path.basename(dir).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+/, "") || "session";
  const taken = new Set(Object.keys(loadContainers()));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

// Move a session into a container of its own. One-way: the transcript leaves
// the host store, so there is no second copy to drift, and no path back that
// would silently resume a prompts-off session with prompts on.
export async function cmdContainerize(args) {
  const [idPrefix] = positionals(args, ["--image", "--agent", "--ports", "--base"]);
  if (!idPrefix) die("usage: casm containerize <session-id-prefix> [--image X] [--ports N] [--no-ports]");
  requireDocker();

  const s = findSession(idPrefix);
  if (s.store?.name) die(`session ${s.id.slice(0, 10)} is already in container '${s.store.name}'`);
  if (!s.cwd) die("could not determine the session's directory");
  if (!fs.existsSync(s.cwd)) die(`${s.cwd} no longer exists - the container needs a directory to mount`);

  const name = containerNameFor(s.cwd);
  const image = strFlag(args, "--image", DEFAULT_IMAGE);
  const root = ensureStore(path.join(STORE_ROOT, name));

  console.log(`session   ${AGENTS[s.agent].tag()} ${cyan(pad(s.id, 11))}  ${dim(truncate(s.preview ?? "", 50))}`);
  console.log(`project   ${s.cwd} ${dim("(mounted read-write at the same path)")}`);
  console.log(`container ${cyan(name)}\n`);
  console.log(yellow("this is one-way: the transcript moves into the container's store, and"));
  console.log(yellow("the session is resumed there from now on. reading it stays unchanged."));
  if (process.stdin.isTTY) {
    const ok = await ask("\ncontainerize? [y/N]: ");
    if (ok === null || !/^y(es)?$/i.test(ok)) { console.log("aborted"); return; }
  }

  const { c, ports } = await provision({ name, dir: s.cwd, agent: s.agent, image, root, args });

  // Only after the container exists, so a failed create leaves the session
  // exactly where it was.
  AGENTS[s.agent].moveTo(s, { name, ...storePaths(root) });

  console.log(`\n${green("containerized")} ${cyan(s.id.slice(0, 10))} ${dim("→")} ${cyan(name)}`);
  if (ports) console.log(`  ports     ${ports[0]}-${ports[1]}`);
  reportAuth(c.auth, [s.agent], name);
  console.log(`\nresume it with: ${cyan(`casm resume ${s.id.slice(0, 10)}`)}`);
}

// Start a session that is containerized from the outset. Nothing has to be
// moved, and the record is keyed by container rather than by session id - which
// is why the session's own id never has to be known in advance. It appears in
// listings as soon as the agent writes its first transcript, because the store
// is already being scanned.
async function newContainerized(args) {
  requireDocker();
  const agent = strFlag(args, "--agent", "claude");
  if (!AGENTS[agent]) die(`unknown agent '${agent}' (claude|codex|opencode|pi)`);
  const dir = path.resolve(strFlag(args, "--dir", null) ?? process.cwd());
  if (!fs.existsSync(dir)) die(`${dir} does not exist - create it first`);

  const name = containerNameFor(dir);
  const image = strFlag(args, "--image", DEFAULT_IMAGE);
  const root = ensureStore(path.join(STORE_ROOT, name));

  console.log(`project   ${dir} ${dim("(mounted read-write at the same path)")}`);
  console.log(`container ${cyan(name)}  ${dim(AGENTS[agent].tag ? "" : "")}`);
  const { c, ports } = await provision({ name, dir, agent, image, root, args });
  if (ports) console.log(`ports     ${ports[0]}-${ports[1]}`);
  reportAuth(c.auth, [agent], name);

  const node = { kind: "docker", name, target: c.target, cfg: loadContainers()[name] };
  handOver(node, [...AGENTS[agent].newArgv(dir), ...boxArgv(agent)], dir);
}

// Build the image, allocate ports, create the container and record it. Shared
// by `containerize` and `new --containerized`, and by the rebuild that happens
// when a container has been removed out from under a session that still exists.
async function provision({ name, dir, agent, image, root, args, keepPorts = null, quiet = false }) {
  buildImage(image, null, { quiet: quiet || imageExists(image) });
  const { key, created } = ensureCasmKey();

  // Both of these are only worth saying once, when the container is first built
  // for a session: a gitconfig that cannot work in a linux container, and a
  // brand new key that has to be added to a forge before the agent can push.
  const badGit = checkGitConfig();
  if (badGit.length) {
    console.log(yellow(`git       ~/.gitconfig is mounted, but these keys do not work in a linux container:`));
    for (const l of badGit) console.log(dim(`          ${l}`));
  }
  if (created) {
    console.log(`ssh key   ${dim(key)} ${green("(new)")}`);
    try {
      console.log(dim(`          ${fs.readFileSync(key + ".pub", "utf8").trim()}`));
      console.log(dim("          add that key to your git forge if the agent needs to push"));
    } catch {}
  }

  // A rebuild keeps the block it already published, or the agent's dev server
  // would come back on a different port than the one you had open. Allocating
  // afresh would also skip this container's own block, since it is still in the
  // record it is being rebuilt from.
  let ports = keepPorts;
  if (!ports && !args.includes("--no-ports")) {
    const size = Math.max(1, intFlag(args, "--ports", PORT_BLOCK));
    const taken = Object.entries(loadContainers()).filter(([n]) => n !== name).map(([, c]) => c.ports).filter(Boolean);
    ports = await allocatePorts(taken, size);
    if (!ports) console.log(yellow(`could not find ${size} free ports - creating without any`));
  }

  // codex has no --append-system-prompt and reads its instructions from
  // CODEX_HOME, which is inside the store - so casm writes the brief there
  // directly, on the host, rather than into the container.
  if (agent === "codex") {
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "AGENTS.md"), CONTAINER_BRIEF + "\n");
  }
  const c = createContainer({ name, dir, image, agents: [agent], keyPath: key, ports, store: root });

  const cfg = loadConfigForWrite();
  cfg.containers = { ...loadContainers(), [name]: { container: c.target, root, dir, image, agents: [agent], ...(ports ? { ports } : {}) } };
  saveConfig(cfg);
  return { c, ports };
}

// Auth is copied in rather than mounted, because the agents rewrite these files
// when they refresh a token.
function reportAuth(auth, agents, name) {
  const { seeded, missing, claude } = auth;
  if (seeded.length) console.log(`  auth      ${seeded.map((s) => "~/" + s).join(", ")}`);
  if (claude) {
    console.log(`  claude    ${green("seeded")} ${dim(`from ${claude.source}`)}`);
    if (claude.withRefresh) {
      console.log(yellow(`            with its refresh token: this container can rotate it, and`));
      console.log(yellow(`            a refresh here will invalidate your host login`));
    } else if (claude.expiresAt) {
      // The credential carries no refresh token on purpose, so an already-expired
      // access token cannot heal itself - the container would be dead on arrival.
      const left = claude.expiresAt - Date.now();
      if (left <= 0) {
        console.log(yellow(`            but that token EXPIRED ${fmtAge(-left / 1000)} ago, so it will not work.`));
        console.log(dim(`            run any claude command on this host to refresh it - casm`));
        console.log(dim(`            re-seeds the container the next time you resume.`));
      } else {
        console.log(dim(`            access token only, so it cannot rotate your host login.`));
        console.log(dim(`            expires in ${fmtAge(left / 1000)}; casm refreshes it on the next resume`));
      }
    }
    return;
  }
  if (!agents.includes("claude") || !missing.some((m) => m.agent === "claude")) return;
  const plan = claudeAuthPlan();
  if (plan.kind === "env") {
    console.log(yellow(`  claude    no credentials on disk; pass ${plan.name} through instead:`));
    console.log(dim(`            export ${plan.name} before casm new --host ${name}`));
  } else {
    console.log(yellow(`  claude    no credentials found to seed`));
    console.log(dim(`            log in on this host first, or: claude setup-token then`));
    console.log(dim(`            export CLAUDE_CODE_OAUTH_TOKEN=<token>`));
  }
}

// `create` calls this every time, so a new machine needs one command rather
// than two and an existing one cannot drift behind the Dockerfile.
function buildImage(image, base, { quiet = false, noCache = false } = {}) {
  // fileURLToPath, not URL.pathname: the latter percent-encodes, so a home
  // directory with a space in it resolves to a path that does not exist.
  const dockerfile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docker", "Dockerfile");
  if (!fs.existsSync(dockerfile)) die(`Dockerfile not found at ${dockerfile}`);
  const buildArgs = ["build", "-t", image, "-f", dockerfile];
  // layer caching pins the agent CLIs to whenever the layer was built, so
  // refreshing them needs the cache busting rather than just a rebuild
  if (noCache) buildArgs.push("--no-cache");
  if (base) buildArgs.push("--build-arg", `BASE=${base}`);
  buildArgs.push(path.dirname(dockerfile));
  if (quiet) {
    const r = spawnSync("docker", buildArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) {
      console.log(r.stdout ?? "");
      console.error(r.stderr ?? "");
      die("image build failed");
    }
    return;
  }
  console.log(`${yellow("building " + image)} ${dim("- first time on this machine, takes a few minutes")}`);
  console.log(dim(`$ docker ${buildArgs.join(" ")}`));
  const r = spawnSync("docker", buildArgs, { stdio: "inherit" });
  if (r.status !== 0) die("image build failed");
  console.log(green(`\nbuilt ${image}`));
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
const probeHost = (target) => tryExec(resolveNode(target), "command -v casm >/dev/null 2>&1 && echo CASM || echo NOCASM");
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
  if (!idPrefix || !host) die("usage: casm push <session-id-prefix> <ssh-target|container> [--to <remote-project-path>] [--dry-run] [--force]");
  const why = explainUnknownTarget(host); if (why) die(why);
  const node = await live(resolveNode(host));
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  // `casm push <container> <id>` is an easy slip, and "no session matching
  // <container>" is a baffling way to report it.
  if (!findSession(idPrefix, { soft: true }) && (loadContainers()[idPrefix] || listHosts().includes(idPrefix)))
    die(`'${idPrefix}' is a ${loadContainers()[idPrefix] ? "container" : "host"}, not a session` +
        `\ndid you mean: casm push ${host} ${idPrefix}`);

  const s = findSession(idPrefix);
  if (!s.cwd) die("could not determine session cwd");
  const base = path.basename(s.cwd);
  const rel = s.cwd.startsWith(HOME) ? s.cwd.slice(HOME.length) : null;

  console.log(`session   ${AGENTS[s.agent].tag()} ${cyan(pad(s.id, 11))}  ${dim(truncate(s.preview ?? "", 55))}`);
  console.log(`project   ${s.cwd}\n`);

  if (toFlagVal) {
    // relative --to needs the real remote home: a literal "$HOME" would be shq-quoted, never expanded
    const home = toFlagVal.startsWith("/") ? null : exec(node, 'printf %s "$HOME"');
    return doPush(node, s, absolutize(toFlagVal, home), { force, dryRun });
  }

  // A container mounts its project at the host's own path, so the session's cwd
  // is already the right answer over there. The home-relative remap below is for
  // ssh hosts, where homes differ; applied to a container it looks under
  // /casmhome, finds nothing, and offers to copy the whole project in beside
  // the copy that is already mounted.
  if (node.kind === "docker" && node.cfg?.dir) {
    const mounted = node.cfg.dir;
    if (s.cwd === mounted || s.cwd.startsWith(mounted + "/")) {
      console.log(`on ${green(nodeLabel(node))}: ${dim("mounted at the same path")} ${s.cwd}\n`);
      return doPush(node, s, s.cwd, { force, dryRun });
    }
    console.log(yellow(`${s.cwd} is outside this container's mounted directory (${mounted}).`));
    console.log(dim(`pass --to <path> if you want it somewhere else inside.\n`));
  }

  const probe = exec(node, [
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

  console.log(`on ${green(nodeLabel(node))} ${dim(`(home ${remoteHome})`)}:`);
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
  await doPush(node, s, target, { force, copyProject: chosen.copyProject });
}

async function doPush(node, s, remotePath, { force = false, dryRun = false, copyProject = false } = {}) {
  console.log(`\nagent      ${s.agent}`);
  console.log(`target     ${nodeLabel(node)}:${remotePath}`);
  if (copyProject) console.log(`project    → full rsync of ${s.cwd}`);
  if (dryRun) { console.log(dim("(dry run - nothing copied)")); return; }

  // --force silently replaces a copy that may have been worked on over there
  if (force) {
    const [existing] = await remoteRows(node.name, s.id, 1);
    if (existing)
      console.log(yellow(`\nreplacing the copy already on ${nodeLabel(node)}, last activity ${fmtAge((Date.now() - new Date(existing.mtime)) / 1000)} ago`));
  }

  if (copyProject && s.cwd) {
    exec(node, `mkdir -p ${shq(remotePath)}`);
    copyTo(node, s.cwd + "/", remotePath + "/");
  }
  await AGENTS[s.agent].push(s, node, remotePath, force);
  console.log(green(`\npushed. resume it with:`));
  console.log(`  casm resume ${s.id.slice(0, 10)} --host ${node.name}`);
  console.log(dim(`  or, over there: ${displayCmd(AGENTS[s.agent].resumeArgv(s, remotePath), remotePath)}`));
}

// the remote's own casm reports its sessions; --local so it answers for itself
// and doesn't fan out to its hosts in turn
// `soft` is for the fleet-wide survey in `continue`, where one unreachable node
// must cost that node's rows and nothing more - dying would take the whole
// picker down with it.
async function remoteSessions(nodeOrName, extraArgs, { soft = false } = {}) {
  if (typeof nodeOrName === "string") { const why = explainUnknownTarget(nodeOrName); if (why) die(why); }
  const node = typeof nodeOrName === "string" ? resolveNode(nodeOrName) : nodeOrName;
  const r = await casmOn(node, ["list", "--json", "--local", ...extraArgs]);
  const fail = (msg) => {
    if (!soft) die(`${nodeLabel(node)}: ${msg}`);
    console.error(dim(`${node.name}: ${msg}`));
    return [];
  };
  if (!r.ok) return fail(r.err || "no answer - check that casm is installed there (npm i -g casm-cli)");
  try { return JSON.parse(r.out); } catch { return fail("unexpected reply from remote casm (is it older than 0.6?)"); }
}

export async function cmdPull(args) {
  const [host, rawPrefix] = positionals(args, ["-n"]);
  if (!host) die("usage: casm pull <ssh-target|container|host/container> [session-id-prefix] [-n 20] [--force]");
  const whyPull = explainUnknownTarget(host); if (whyPull) die(whyPull);
  const node = await live(resolveNode(host));
  const idPrefix = normalizeIdPrefix(rawPrefix);
  if (idPrefix && !/^[A-Za-z0-9_-]+$/.test(idPrefix)) die(`invalid session id prefix '${idPrefix}'`);
  const force = args.includes("--force");

  if (!idPrefix) {
    const rows = await remoteSessions(host, ["-n", String(intFlag(args, "-n", 20))]);
    if (!rows.length) { console.log(`no sessions found on ${host}`); return; }
    console.log(`newest sessions on ${green(host)}:\n`);
    for (const r of rows) {
      const tag = AGENTS[r.agent]?.tag() ?? yellow(pad(r.agent ?? "?", 2)); // a newer remote may know agents we don't
      console.log(`${dim(r.mtime.slice(0, 16).replace("T", " "))}  ${tag}  ${cyan(pad(r.id, 11))}  ${green(pad(shortProject(r.cwd), 26))}  ${ctxCol(r.ctx ?? null)}  ${truncate(r.preview || dim("(untitled)"), 46)}`);
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
  const remoteHome = exec(node, 'printf %s "$HOME"');
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

  await AGENTS[r.agent].pull(r, node, localPath, force);
  console.log(green(`\npulled. resume it with:`));
  console.log(`  casm resume ${r.id}`);
}
