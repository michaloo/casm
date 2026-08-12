#!/usr/bin/env node
// casm - multi-node coding-agent session manager for Claude Code, opencode, and pi.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dim, cyan, green, magenta, yellow, blue, die, listHosts, strFlag } from "../lib/util.mjs";
import { casmOn, resolveNode } from "../lib/nodes.mjs";
import { cmdList, cmdSearch, cmdShow, cmdResume, cmdContinue, cmdActive, cmdPush, cmdPull, cmdHost, cmdBookmark, cmdNew, cmdContainerize, cmdAuth } from "../lib/commands.mjs";

// multi-machine fan-out: casm must be installed on every managed host.
// remotes run concurrently and their output is buffered, so the per-host
// blocks stay grouped and one slow/unreachable host doesn't serialize the rest.
//
// Scope is pinned on every remote invocation, or two machines listing each
// other would never terminate. Containers are not nodes: a containerized
// session's transcripts live on the machine that owns the container, so that
// machine reports them in its own pass and reaching into the container would
// list every one of them twice.
async function runRemote(node, cmd, args) {
  const r = await casmOn(node, [cmd, ...args, "--local", `--as=${node.name}`]);
  const parts = [r.out, r.err].filter(Boolean);
  if (!r.ok) parts.push(dim(`(${node.name}: no answer - check that casm is installed there: npm i -g casm-cli)`));
  return parts.join("\n") || dim("none");
}

async function fanOut(cmd, fn, args) {
  // --json is machine-readable output for a single node (it's how casm nodes
  // talk to each other); fanning it out would interleave headers with JSON
  if (args.includes("--json")) return fn(args);
  const explicitAll = args.includes("--all");
  const hostArg = strFlag(args, "--host", null);
  // set when another casm is asking: it has already printed a header for us, so
  // ours would be a duplicate, and our containers belong in its namespace
  const asName = (args.find((a) => a.startsWith("--as=")) ?? "").slice(5) || null;
  const localArgs = args.filter((a, i) =>
    !["--all", "--local", "--local-containers", "--host"].includes(a) &&
    !a.startsWith("--as=") && args[i - 1] !== "--host");

  if (args.includes("--local")) return fn(localArgs);

  const nodes = hostArg ? [resolveNode(hostArg)] : listHosts().map(resolveNode);
  if (!nodes.length) {
    if (explicitAll || hostArg) die("no hosts configured - add one with: casm host add <ssh-target>");
    return fn(localArgs); // nothing to fan out to: just this machine
  }
  const all = explicitAll || !hostArg;
  const remotes = nodes.map((n) => runRemote(n, cmd, localArgs)); // start before the local pass
  if (all) {
    if (!asName) console.log(`\n${green("● local")} ${dim(os.hostname())}`);
    await fn(localArgs);
  }
  for (const [i, n] of nodes.entries()) {
    console.log(`\n${green("● " + (asName ? `${asName}/${n.name}` : n.name))}`);
    console.log(await remotes[i]);
  }
}

// Every option each command accepts. Anything else that looks like a flag is a
// mistake and is refused, rather than silently ignored: a misspelled
// `--containerized` used to start an ordinary session while you believed you
// were in a container, which is the kind of typo that has to fail loudly.
const FLAGS = {
  list:         ["-n", "--agent", "--project", "--id", "--json", "--local", "--host", "--all", "--as"],
  search:       ["-n", "--agent", "--local", "--host", "--all", "--as"],
  active:       ["--local", "--host", "--all", "--as"],
  show:         ["-n", "--host", "--local"],
  resume:       ["--host"],
  continue:     ["-n", "--agent", "--host", "--local"],
  new:          ["--agent", "--host", "--dir", "--containerized", "--image", "--ports", "--no-ports"],
  containerize: ["--image", "--ports", "--no-ports"],
  auth:         [],
  push:         ["--to", "--dry-run", "--force"],
  pull:         ["-n", "--force"],
  host:         [],
  bookmark:     [],
  bm:           [],
};

const VALUE_FLAGS = new Set([
  "-n", "--agent", "--project", "--id", "--host", "--as", "--dir",
  "--image", "--ports", "--to",
]);

function checkFlags(cmd, args) {
  const known = FLAGS[cmd];
  if (!known) return;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--" || !a.startsWith("-") || a === "-") continue;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (known.includes(name)) {
      if (eq !== -1 && !VALUE_FLAGS.has(name))
        die(`option '${name}' for 'casm ${cmd}' does not take a value`);
      if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? args[i + 1] : a.slice(eq + 1);
        if (!value || (eq === -1 && value.startsWith("-")))
          die(`option '${name}' for 'casm ${cmd}' needs a value`);
        if (eq === -1) i++;
      }
      continue;
    }
    const near = known.find((k) => k.replace(/[^a-z]/g, "").startsWith(name.replace(/[^a-z]/g, "").slice(0, 6)));
    die(`unknown option '${name}' for 'casm ${cmd}'` +
        (near ? ` - did you mean ${near}?` : ` - try: casm help`));
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const FANOUT_CMDS = new Set(["list", "search", "active"]); // all-hosts by default, --local/--host to scope
const commands = { list: cmdList, search: cmdSearch, show: cmdShow, resume: cmdResume, continue: cmdContinue, push: cmdPush, pull: cmdPull, active: cmdActive, host: cmdHost, bookmark: cmdBookmark, bm: cmdBookmark, new: cmdNew, containerize: cmdContainerize, auth: cmdAuth };

// fileURLToPath, not new URL().pathname: a checkout under a path with a space
// comes back percent-encoded from the latter and the read fails.
const version = () =>
  JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

// The three things people install casm for. Kept to a headline, one sentence and
// something you can paste - the command table above is the reference, this is
// the part that answers "what is this for".
const USE_CASES = [
  ["continue from anywhere",
   "your most recent sessions across every agent, newest first. pick one and\ncasm changes into its directory and resumes it with its own agent.",
   "casm continue"],
  ["search and resume",
   "full-text over every transcript, on this machine and every host, with the match\nshown in context. resume the hit wherever it turns out to live.",
   `casm search "rate limiting"`],
  ["new session in a dedicated container",
   "permission prompts off inside, where the only thing the agent can reach is the\nproject you point it at. `casm containerize <id>` moves an existing one in.",
   "casm new --containerized"],
];

function help() {
  console.log(`casm ${dim(version())} - multi-node coding-agent session manager
${dim("  agents:")} claude code ${cyan("cc")} · codex ${blue("cx")} · opencode ${magenta("oc")} · pi ${yellow("pi")}

usage:
  casm continue [-n 10] [--agent X] [--host H]   pick a recent session and resume it
  casm new    [--agent X] [--host H] [--dir P]   start a NEW session
              [--containerized]                  ...in a container of its own
  casm containerize <id-prefix>                  move a session into a container of
                                                 its own (one-way)
  casm auth [<id-prefix>]                        re-seed credentials into containerized
                                                 sessions, without resuming them
  casm active                                    running sessions + inferred status
  casm list   [-n 20] [--agent X] [--project P]  newest sessions across agents
  casm search <term> [-n 25] [--agent X]         full-text search of transcripts
  casm show   <id-prefix> [-n 30]                preview a conversation, local or remote
  casm resume <id-prefix> [--host H]             resume with its own agent, in its cwd
  casm push   <id-prefix> <host> [--to <path>] [--dry-run] [--force]
  casm pull   <host> [id-prefix] [-n 20] [--force]   fetch a session from a host
  casm host   list | add <ssh-target> | rm <ssh-target>
  casm bookmark [<id-prefix> [alias]] | rm <alias>   pin sessions in continue;
                                                 an alias works wherever an id does
  casm help | casm version                       this screen; the installed version`);

  for (const [title, desc, example] of USE_CASES) {
    console.log(`\n${green(title)}`);
    for (const line of desc.split("\n")) console.log(dim("  " + line));
    console.log(`  ${cyan("$ " + example)}`);
  }
}

if (cmd === "help" || cmd === "--help" || cmd === "-h") { help(); process.exit(0); }
if (cmd === "version" || cmd === "--version" || cmd === "-v") { console.log(version()); process.exit(0); }

if (!cmd) {
  help();
  process.exit(0);
} else if (!commands[cmd]) {
  die(`unknown command '${cmd}' - try: casm help`);
} else {
  checkFlags(cmd, rest);
  const runner = FANOUT_CMDS.has(cmd) ? fanOut(cmd, commands[cmd], rest) : commands[cmd](rest);
  Promise.resolve(runner).catch((e) => die(e.message));
}
