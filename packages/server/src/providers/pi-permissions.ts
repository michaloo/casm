// casm's permission gate for pi, loaded into every casm pi session with
// `pi -e`. pi has no permission system of its own; this extension's tool_call
// hook is awaited and blocks a call that isn't allowed.
//
// Modes (CASM_PI_MODE at spawn, then /casm-mode <mode>): bypass allows every
// call; acceptEdits allows edit and write inside the project and gates the
// rest; default gates everything a rule doesn't allow. pi's read-only
// built-ins (read, grep, find, ls, tool_search) are always allowed.
//
// A gated call asks through ctx.ui.select with a MARKER title, which casm's pi
// adapter turns into its permission card. "Always" saves an allow rule in pi's
// own settings, under SETTINGS_KEY: in the project's .pi/settings.json when pi
// trusts the project and that file exists, else in the agent directory's
// settings.json under `projects["<project path>"]`. Creating .pi/settings.json
// would make pi treat the project as untrusted in RPC mode (no saved trust
// decision), so casm never creates it. Rules apply from the global `allow`,
// the project's entry, and a trusted project's file; files are re-read when
// they change. There are no deny rules: Deny refuses that one call.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type Mode = "default" | "acceptEdits" | "bypass";
export const MODES: Mode[] = ["default", "acceptEdits", "bypass"];
// `bash` rules hold a command pattern, `edit` rules (edit and write) a path
// glob relative to the project; any other tool name allows that tool.
export type Rule = { tool: string; command?: string; path?: string };
// What the card offers to save, as editable text: bash patterns one per line.
// `file` is the settings file it goes to; `project` the key under `projects` there.
export type Suggestion = { kind: "bash" | "edit" | "tool"; value: string; editable: boolean; file: string; project?: string };

export const SETTINGS_KEY = "casmPermissions";
export const MARKER = "casm-permission:";
export const MODE_ENV = "CASM_PI_MODE";
export const MODE_COMMAND = "casm-mode";
const READ_ONLY = new Set(["read", "grep", "find", "ls", "tool_search"]);
const EDITS = new Set(["edit", "write"]);
// Tools whose first argument names the action: `git status`, `npm test`.
const SUBCOMMANDS = new Set(["git", "npm", "pnpm", "yarn", "bun", "npx", "cargo", "go", "docker", "kubectl", "uv", "pip", "make", "gh", "node", "python", "python3"]);

// --- bash

// The simple commands of a shell line: split at ; & && || | and newlines,
// subshell parentheses removed, $(...), `...` and <(...) bodies included as
// commands of their own. Null when quotes or parentheses don't balance.
export function commandParts(line: string): string[] | null {
  const parts: string[] = [];
  let cur = "";
  let quote = "";
  const flush = () => {
    const part = cur.trim();
    cur = "";
    if (/^\(.*\)$/s.test(part)) {
      const inner = commandParts(part.slice(1, -1));
      if (!inner) return false;
      parts.push(...inner);
    } else if (part) parts.push(part.replace(/\s+/g, " "));
    return true;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'" || (quote === '"' && c !== "$" && c !== "`" && c !== "\\")) {
      if (c === quote) quote = "";
      cur += c;
    } else if (c === "\\") {
      cur += c + (line[i + 1] ?? "");
      i++;
    } else if (c === "'" || c === '"') {
      if (quote === c) quote = "";
      else if (!quote) quote = c;
      cur += c;
    } else if (c === "`" || ((c === "$" || c === "<" || c === ">") && line[i + 1] === "(")) {
      const open = c === "`" ? i : i + 1;
      const end = c === "`" ? line.indexOf("`", i + 1) : closing(line, open);
      if (end < 0) return null;
      const inner = commandParts(line.slice(open + 1, end));
      if (!inner) return null;
      parts.push(...inner);
      cur += line.slice(i, end + 1);
      i = end;
    } else if (quote) {
      cur += c;
    } else if (c === "(") {
      const end = closing(line, i);
      if (end < 0) return null;
      cur += line.slice(i, end + 1);
      i = end;
    } else if (c === ";" || c === "\n" || c === "|" || c === "&") {
      // `&>` and `>&` are redirections, not separators.
      if (c === "&" && (line[i + 1] === ">" || line[i - 1] === ">")) cur += c;
      else {
        if (!flush()) return null;
        if ((c === "|" || c === "&") && line[i + 1] === c) i++;
      }
    } else cur += c;
  }
  if (quote || !flush()) return null;
  return parts;
}

function closing(line: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"') i++;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "\\") i++;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

// `npm test *` matches `npm test` and `npm test -- --watch`; `*` elsewhere
// matches any text. Without a `*` the command must match exactly.
export function commandMatches(pattern: string, command: string): boolean {
  const p = pattern.trim().replace(/\s+/g, " ");
  if (!p) return false;
  const body = p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${p.endsWith(" *") ? `${body.slice(0, -3)}(?: .*)?` : body}$`, "s").test(command);
}

// Every part of a compound command must match a pattern.
export function bashAllowed(patterns: string[], line: string): boolean {
  const parts = commandParts(line);
  return !!parts?.length && parts.every((part) => patterns.some((p) => commandMatches(p, part)));
}

export function suggestPattern(part: string): string {
  const words = part.split(" ");
  const n = SUBCOMMANDS.has(words[0]) && words[1] && !words[1].startsWith("-") ? 2 : 1;
  return words.length > n ? `${words.slice(0, n).join(" ")} *` : part;
}

// --- paths

// A path inside the project, relative to it; null outside (or the root itself).
export function projectPath(cwd: string, path: string): string | null {
  const abs = resolve(cwd, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : null;
}

// `**` matches across directories, `*` and `?` within one.
export function globMatches(glob: string, rel: string): boolean {
  const g = glob.trim().replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    if (g.startsWith("**/", i)) (re += "(?:.*/)?"), (i += 2);
    else if (g.startsWith("**", i)) (re += ".*"), i++;
    else if (g[i] === "*") re += "[^/]*";
    else if (g[i] === "?") re += "[^/]";
    else re += g[i].replace(/[.+^${}()|[\]\\]/, "\\$&");
  }
  return !!g && new RegExp(`^${re}$`).test(rel);
}

// --- settings

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function agentDir(env = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR;
  return dir ? resolve(dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir) : join(homedir(), ".pi", "agent");
}

type Section = { allow?: unknown; projects?: Record<string, { allow?: unknown }> };
const valid = (allow: unknown): Rule[] => Array.isArray(allow) ? allow.filter((r): r is Rule => !!r && typeof r === "object" && typeof r.tool === "string") : [];

// The file's `allow` rules, plus those of `projects[project]`.
export function readRules(file: string, project?: string): Rule[] {
  try {
    const section = JSON.parse(readFileSync(file, "utf8"))?.[SETTINGS_KEY] as Section | undefined;
    return [...valid(section?.allow), ...(project ? valid(section?.projects?.[project]?.allow) : [])];
  } catch {
    return [];
  }
}

// Adds rules to a settings file, keeping everything else in it. Takes the
// `<file>.lock` directory lock pi itself uses for its settings.
export function addRules(file: string, rules: Rule[], project?: string) {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 50) throw e;
      const until = Date.now() + 20;
      while (Date.now() < until);
    }
  }
  try {
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const section = settings[SETTINGS_KEY] ?? {};
    const scope = project ? (section.projects?.[project] ?? {}) : section;
    const allow: Rule[] = Array.isArray(scope.allow) ? scope.allow : [];
    const key = (r: Rule) => JSON.stringify([r.tool, r.command ?? null, r.path ?? null]);
    const next = { ...scope, allow: [...allow, ...rules.filter((r) => !allow.some((a) => key(a) === key(r)))] };
    settings[SETTINGS_KEY] = project ? { ...section, projects: { ...section.projects, [project]: next } } : next;
    writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
  } finally {
    rmdirSync(lock);
  }
}

// --- decisions

type Call = { toolName: string; input: Record<string, unknown> };

export function allowed(mode: Mode, rules: Rule[], call: Call, cwd: string): boolean {
  if (mode === "bypass" || READ_ONLY.has(call.toolName)) return true;
  if (call.toolName === "bash") return bashAllowed(rules.flatMap((r) => (r.tool === "bash" && r.command ? [r.command] : [])), String(call.input.command ?? ""));
  if (EDITS.has(call.toolName)) {
    const rel = projectPath(cwd, String(call.input.path ?? ""));
    return !!rel && (mode === "acceptEdits" || rules.some((r) => r.tool === "edit" && !!r.path && globMatches(r.path, rel)));
  }
  return rules.some((r) => r.tool === call.toolName && !r.command && !r.path);
}

export function suggest(call: Call, cwd: string, where: { file: string; project?: string }, rules: Rule[] = []): Suggestion {
  if (call.toolName === "bash") {
    const known = rules.flatMap((r) => (r.tool === "bash" && r.command ? [r.command] : []));
    const parts = (commandParts(String(call.input.command ?? "")) ?? []).filter((p) => !known.some((k) => commandMatches(k, p)));
    return { kind: "bash", value: [...new Set(parts.map(suggestPattern))].join("\n"), editable: true, ...where };
  }
  if (EDITS.has(call.toolName)) {
    const rel = projectPath(cwd, String(call.input.path ?? ""));
    const dir = rel && dirname(rel);
    return { kind: "edit", value: !rel ? "" : dir === "." ? rel : `${dir}/**`, editable: !!rel, ...where };
  }
  return { kind: "tool", value: call.toolName, editable: false, ...where };
}

// The rules an "Always" answer saves; the edited value replaces the suggestion.
export function rulesFor(s: Suggestion, value: string): Rule[] {
  const v = s.editable ? value : s.value;
  if (s.kind === "bash") return v.split("\n").map((l) => l.trim()).filter(Boolean).map((command) => ({ tool: "bash", command }));
  if (s.kind === "edit") return v.trim() ? [{ tool: "edit", path: v.trim() }] : [];
  return [{ tool: s.value }];
}

// --- extension

type Ui = { select(title: string, options: string[]): Promise<string | undefined>; notify(message: string, type?: "info" | "warning" | "error"): void };
type Ctx = { cwd: string; hasUI: boolean; ui: Ui; isProjectTrusted?(): boolean };
type Pi = {
  on(event: "tool_call", handler: (event: Call, ctx: Ctx) => Promise<{ block: true; reason: string } | undefined>): void;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: Ctx): Promise<void> }): void;
};

const state = globalThis as { casmPiMode?: Mode };

export default function casmPermissions(pi: Pi) {
  const fromEnv = process.env[MODE_ENV] as Mode | undefined;
  state.casmPiMode ??= fromEnv && MODES.includes(fromEnv) ? fromEnv : "default";
  const cache = new Map<string, { mtime: number; rules: Rule[] }>();
  const rulesOf = (file: string, project?: string) => {
    const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    const key = `${file}\0${project ?? ""}`;
    const hit = cache.get(key);
    if (hit?.mtime === mtime) return hit.rules;
    const rules = mtime ? readRules(file, project) : [];
    cache.set(key, { mtime, rules });
    return rules;
  };

  pi.on("tool_call", async (call, ctx) => {
    const trusted = ctx.isProjectTrusted?.() ?? false;
    const project = join(ctx.cwd, ".pi", "settings.json");
    const global = join(agentDir(), "settings.json");
    const cwd = canonical(ctx.cwd);
    const own = trusted && existsSync(project);
    const rules = [...rulesOf(global, cwd), ...(own ? rulesOf(project) : [])];
    if (allowed(state.casmPiMode!, rules, call, ctx.cwd)) return undefined;
    if (!ctx.hasUI) return { block: true, reason: `casm: ${call.toolName} needs approval and nobody can answer here` };
    const suggestion = suggest(call, ctx.cwd, own ? { file: project } : { file: global, project: cwd }, rules);
    const answer = await ctx.ui.select(MARKER + JSON.stringify({ tool: call.toolName, input: call.input, rule: suggestion }), ["Approve", "Always", "Deny"]);
    const [choice = "", ...rest] = (answer ?? "").split("\n");
    if (choice === "Approve") return undefined;
    if (choice === "Always") {
      const save = rulesFor(suggestion, rest.length ? rest.join("\n") : suggestion.value);
      try {
        if (save.length) addRules(suggestion.file, save, suggestion.project);
      } catch (e) {
        ctx.ui.notify(`casm could not save the rule to ${suggestion.file}: ${e instanceof Error ? e.message : e}`, "warning");
      }
      return undefined;
    }
    const why = choice === "Deny" && rest.join("\n").trim();
    return { block: true, reason: choice === "Deny" ? `Denied by the user${why ? `: ${why}` : ""}` : "The permission request was dismissed" };
  });

  pi.registerCommand(MODE_COMMAND, {
    description: "casm: permission mode (default, acceptEdits, bypass)",
    async handler(args, ctx) {
      const mode = args.trim() as Mode;
      if (mode && !MODES.includes(mode)) return ctx.ui.notify(`${MODE_COMMAND}: unknown mode "${mode}" (${MODES.join(", ")})`, "error");
      if (mode) state.casmPiMode = mode;
      ctx.ui.notify(`${MODE_COMMAND}: ${state.casmPiMode}`, "info");
    },
  });
}
