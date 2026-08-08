#!/usr/bin/env node
// casm - multi-node coding-agent session manager for Claude Code, opencode, and pi.
import os from "node:os";
import { dim, cyan, green, magenta, yellow, die, listHosts, strFlag } from "../lib/util.mjs";
import { casmOn, resolveNode, runningContainers } from "../lib/nodes.mjs";
import { cmdList, cmdSearch, cmdShow, cmdResume, cmdContinue, cmdActive, cmdPush, cmdPull, cmdHost, cmdBookmark, cmdNew, cmdContainer } from "../lib/commands.mjs";

// multi-machine fan-out: casm must be installed on every managed host.
// remotes run concurrently and their output is buffered, so the per-host
// blocks stay grouped and one slow/unreachable host doesn't serialize the rest.
//
// Scope is pinned on every remote invocation, or two machines listing each
// other would never terminate. An ssh host is asked for itself plus its own
// containers; a container is a leaf and is asked for itself alone. Both flags
// go to an ssh host on purpose: a pre-0.8 casm there does not know
// `--local-containers`, and would fan out to its own hosts if it saw only that.
async function runRemote(node, cmd, args) {
  const scope = node.kind === "docker" ? ["--local"] : ["--local", "--local-containers"];
  const r = await casmOn(node, [cmd, ...args, ...scope]);
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
  const withContainers = args.includes("--local-containers");
  const localArgs = args.filter((a, i) =>
    !["--all", "--local", "--local-containers", "--host"].includes(a) && args[i - 1] !== "--host");

  // --local-containers is tested first so it wins when both are present, which
  // is exactly how runRemote addresses an ssh host.
  if (!withContainers && args.includes("--local")) return fn(localArgs);

  // running containers join the survey, but only the running ones: a stopped
  // container has nothing to report, and a stopped docker daemon returns none
  // at all rather than making every casm invocation look broken.
  const nodes = hostArg ? [resolveNode(hostArg)]
    : (withContainers ? runningContainers() : [...listHosts(), ...runningContainers()]).map(resolveNode);
  if (!nodes.length) {
    if (explicitAll || hostArg) die("no hosts configured - add one with: casm host add <ssh-target>");
    return fn(localArgs); // nothing to fan out to: just this machine
  }
  const all = explicitAll || !hostArg;
  const remotes = nodes.map((n) => runRemote(n, cmd, localArgs)); // start before the local pass
  if (all) {
    console.log(`\n${green("● local")} ${dim(os.hostname())}`);
    await fn(localArgs);
  }
  for (const [i, n] of nodes.entries()) {
    console.log(`\n${green("● " + n.name)}`);
    console.log(await remotes[i]);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const FANOUT_CMDS = new Set(["list", "search", "active"]); // all-hosts by default, --local/--host to scope
const commands = { list: cmdList, search: cmdSearch, show: cmdShow, resume: cmdResume, continue: cmdContinue, push: cmdPush, pull: cmdPull, active: cmdActive, host: cmdHost, bookmark: cmdBookmark, bm: cmdBookmark, new: cmdNew, container: cmdContainer };

if (!cmd || !commands[cmd]) {
  console.log(`casm - multi-node coding-agent session manager (claude code ${cyan("cc")} / opencode ${magenta("oc")} / pi ${yellow("pi")})

usage:
  casm continue [-n 10] [--agent X] [--host H]   pick a recent session and resume it
  casm new    [--agent X] [--host H] [--dir P]   start a NEW session
  casm active                                    running sessions + inferred status
  casm list   [-n 20] [--agent X] [--project P]  newest sessions across agents
  casm search <term> [-n 25] [--agent X]         full-text search of transcripts
  casm show   <id-prefix> [-n 30]                preview a conversation, local or remote
  casm resume <id-prefix> [--host H]             resume with its own agent, in its cwd
  casm push   <id-prefix> <host> [--to <path>] [--dry-run] [--force]
  casm pull   <host> [id-prefix] [-n 20] [--force]   fetch a session from a host
  casm host   list | add <ssh-target> | rm <ssh-target>
  casm container list | create <name> --dir <path> | auth <name> | rm <name> | build
  casm bookmark [<id-prefix> [alias]] | rm <alias>   pin sessions in continue;
                                                 an alias works wherever an id does

sessions are agent-scoped: push moves a session to the SAME agent on the
other machine (claude→claude, opencode→opencode, pi→pi). the agent is
detected from the session id - no flag needed.

a host is anywhere casm can run: an ssh target (a ~/.ssh/config name or
user@host - put ports and identities in ~/.ssh/config) or a container created
with 'casm container create', reached over docker exec instead of ssh. casm
must be installed and on PATH on every one of them (npm i -g casm-cli); the
container image ships with it.

a container is a machine like any other: its sessions live inside it, so
'casm container rm' destroys them - 'casm pull <name> <id>' first.

active/list/search cover this machine, every configured host and every running
container by default. scope them with --local (this machine alone),
--local-containers (this machine and its containers) or --host <name> (one).
a remote host is asked for itself and its own containers, never for its hosts.`);
  process.exit(cmd ? 1 : 0);
}
const runner = FANOUT_CMDS.has(cmd) ? fanOut(cmd, commands[cmd], rest) : commands[cmd](rest);
Promise.resolve(runner).catch((e) => die(e.message));
