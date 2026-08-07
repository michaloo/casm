#!/usr/bin/env node
// casm - multi-node coding-agent session manager for Claude Code, opencode, and pi.
import os from "node:os";
import { dim, cyan, green, magenta, yellow, die, listHosts, strFlag, casmRemote } from "../lib/util.mjs";
import { cmdList, cmdSearch, cmdShow, cmdResume, cmdContinue, cmdActive, cmdPush, cmdPull, cmdHost, cmdBookmark } from "../lib/commands.mjs";

// multi-machine fan-out: casm must be installed on every managed host.
// remotes run concurrently and their output is buffered, so the per-host
// blocks stay grouped and one slow/unreachable host doesn't serialize the rest.
// `--local` is forced on the remote: without it the remote would fan out to
// its own hosts, and two machines listing each other would never terminate.
async function runRemote(host, cmd, args) {
  const r = await casmRemote(host, [cmd, ...args, "--local"]);
  const parts = [r.out, r.err].filter(Boolean);
  if (!r.ok) parts.push(dim(`(${host}: no answer - check ssh, and that casm is installed there: npm i -g casm-cli)`));
  return parts.join("\n") || dim("none");
}

async function fanOut(cmd, fn, args) {
  // --json is machine-readable output for a single node (it's how casm nodes
  // talk to each other); fanning it out would interleave headers with JSON
  if (args.includes("--json")) return fn(args);
  const explicitAll = args.includes("--all");
  const hostArg = strFlag(args, "--host", null);
  // listing commands survey every configured host by default; --local opts out
  const all = explicitAll || (!hostArg && !args.includes("--local"));
  if (!all && !hostArg) return fn(args);
  const localArgs = args.filter((a, i) => !["--all", "--local", "--host"].includes(a) && args[i - 1] !== "--host");
  const hosts = hostArg ? [hostArg] : listHosts();
  if (!hosts.length) {
    if (explicitAll || hostArg) die("no hosts configured - add one with: casm host add <ssh-target>");
    return fn(localArgs); // implicit fan-out with nothing configured: just this machine
  }
  const remotes = hosts.map((h) => runRemote(h, cmd, localArgs)); // start before the local pass
  if (all) {
    console.log(`\n${green("● local")} ${dim(os.hostname())}`);
    await fn(localArgs);
  }
  for (const [i, h] of hosts.entries()) {
    console.log(`\n${green("● " + h)}`);
    console.log(await remotes[i]);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const FANOUT_CMDS = new Set(["list", "search", "active"]); // all-hosts by default, --local/--host to scope
const commands = { list: cmdList, search: cmdSearch, show: cmdShow, resume: cmdResume, continue: cmdContinue, push: cmdPush, pull: cmdPull, active: cmdActive, host: cmdHost, bookmark: cmdBookmark, bm: cmdBookmark };

if (!cmd || !commands[cmd]) {
  console.log(`casm - multi-node coding-agent session manager (claude code ${cyan("cc")} / opencode ${magenta("oc")} / pi ${yellow("pi")})

usage:
  casm continue [-n 10] [--agent X]              pick a recent local session and resume it
  casm active                                    running sessions + inferred status
  casm list   [-n 20] [--agent X] [--project P]  newest sessions across agents
  casm search <term> [-n 25] [--agent X]         full-text search of transcripts
  casm show   <id-prefix> [-n 30]                preview a conversation, local or remote
  casm resume <id-prefix>                        resume with its own agent, in its cwd
  casm push   <id-prefix> <host> [--to <path>] [--dry-run] [--force]
  casm pull   <host> [id-prefix] [-n 20] [--force]   fetch a session from a host
  casm host   list | add <ssh-target> | rm <ssh-target>
  casm bookmark [<id-prefix> [alias]] | rm <alias>   pin sessions in continue;
                                                 an alias works wherever an id does

sessions are agent-scoped: push moves a session to the SAME agent on the
other machine (claude→claude, opencode→opencode, pi→pi). the agent is
detected from the session id - no flag needed.

casm must be installed and on PATH on every machine you manage
(npm i -g casm-cli). hosts are plain ssh targets - a ~/.ssh/config name or
user@host; put ports, identities and usernames in ~/.ssh/config.

active/list/search cover this machine and every configured host by default.
scope them with --local (this machine) or --host <ssh-target> (just one).`);
  process.exit(cmd ? 1 : 0);
}
const runner = FANOUT_CMDS.has(cmd) ? fanOut(cmd, commands[cmd], rest) : commands[cmd](rest);
Promise.resolve(runner).catch((e) => die(e.message));
