// Shell tool calls that run the casm CLI, read back into what they did: the
// verb, its target agent and its message. A small shell-style tokenizer and a
// verb table, not a CLI parser: anything it is unsure about returns null, and
// the transcript keeps the generic tool row.

export type CasmCall = {
  /** The subcommand as typed: "send", "schedule add". */
  verb: string;
  /** Readable: "Send", "Steer", "Schedule add". */
  label: string;
  known: boolean;
  /** -H <peer>. */
  peer?: string;
  /** The agent the call is about, as typed (id, id prefix or name). */
  agent?: string;
  /** A schedule or request id the call is about. */
  ref?: string;
  /** Message text, prompt or reason: prose, not flags. */
  text?: string;
  /** A shell command (casm shell). */
  code?: string;
  flags: Record<string, string | true>;
  args: string[];
};

const SHELL_TOOLS = /^(bash|shell|exec_command|local_shell|run_shell_command|terminal)$/i;

/** The command line of a shell tool call, or null for other tools. */
export function shellCommand(name: string, input: unknown): string | null {
  if (!SHELL_TOOLS.test(name) || !input || typeof input !== "object") return null;
  const fields = input as Record<string, unknown>;
  const command = fields.command ?? fields.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((c) => typeof c === "string")) {
    const shell = shellScript(command as string[]);
    return shell ?? (command as string[]).map(quote).join(" ");
  }
  return null;
}

const quote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

// bash -lc "<script>", as Codex wraps every command.
function shellScript(words: string[]): string | null {
  const [shell, flag, script, ...rest] = words;
  if (!shell || !/^(\/usr)?(\/bin\/)?(ba|z|da)?sh$/.test(shell) || !/^-l?c$|^-cl$/.test(flag ?? "") || script === undefined || rest.length) return null;
  return script;
}

type Token = { word: string } | { op: string };

/** Shell-style words and operators; null for what this does not model ($(...), `...`, subshells). */
export function tokenize(line: string): Token[] | null {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  let redirect = false;
  const end = () => {
    if (!inWord) return;
    if (redirect) redirect = false;
    else tokens.push({ word });
    word = "";
    inWord = false;
    quoted = false;
  };
  // "$(cat <<'EOF'\n…\nEOF\n)": the one command substitution agents write, for long messages.
  const heredoc = (at: number): [string, number] | null => {
    const m = /^\$\(\s*cat\s+<<-?\s*(['"]?)([A-Za-z_]\w*)\1[ \t]*\n/.exec(line.slice(at));
    if (!m) return null;
    const start = at + m[0].length;
    const close = new RegExp(`^[ \\t]*${m[2]}[ \\t]*$`, "m");
    const rest = line.slice(start);
    const found = close.exec(rest);
    if (!found) return null;
    const body = rest.slice(0, found.index).replace(/\n+$/, "");
    let i = start + found.index + found[0].length;
    while (/\s/.test(line[i] ?? "")) i++;
    if (line[i] !== ")") return null;
    return [body, i + 1];
  };
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (c === "\\") {
      if (line[i + 1] === "\n") {
        i += 2;
        continue;
      }
      word += line[i + 1] ?? "";
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) return null;
      word += line.slice(i + 1, close);
      inWord = quoted = true;
      i = close + 1;
      continue;
    }
    if (c === "$" && line[i + 1] === "'") {
      let j = i + 2;
      for (; j < line.length && line[j] !== "'"; j++) {
        if (line[j] === "\\") {
          const e = line[++j];
          word += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else word += line[j];
      }
      if (j >= line.length) return null;
      inWord = quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        const d = line[j];
        if (d === "\\" && /[$`"\\\n]/.test(line[j + 1] ?? "")) {
          if (line[j + 1] !== "\n") word += line[j + 1];
          j++;
        } else if (d === "`") return null;
        else if (d === "$" && line[j + 1] === "(") {
          const sub = heredoc(j);
          if (!sub) return null;
          word += sub[0];
          j = sub[1] - 1;
        } else word += d;
      }
      if (j >= line.length) return null;
      inWord = quoted = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      const sub = heredoc(i);
      if (!sub) return null;
      word += sub[0];
      inWord = quoted = true;
      i = sub[1];
      continue;
    }
    if (c === "`" || c === "(" || c === ")" || c === "{" || c === "}") {
      // A brace inside a word ("a{b}") is literal; at a word start it groups.
      if ((c === "{" || c === "}") && inWord) {
        word += c;
        i++;
        continue;
      }
      return null;
    }
    if (c === "#" && !inWord) {
      while (i < line.length && line[i] !== "\n") i++;
      continue;
    }
    if (c === " " || c === "\t") {
      end();
      i++;
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && line[i + 1] === ">")) {
      if (line.startsWith("<<", i)) return null;
      // "2>&1": the fd is part of the operator.
      if (inWord && !quoted && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else end();
      const op = /^(&>>?|>>?|<)(&(\d+|-))?/.exec(line.slice(i))!;
      i += op[0].length;
      if (!op[2]) redirect = true;
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || c === "&") {
      end();
      const two = line.slice(i, i + 2);
      const op = two === "&&" || two === "||" ? two : c;
      tokens.push({ op });
      i += op.length;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  end();
  if (redirect) return null;
  return tokens;
}

// Commands that may run around casm calls without changing what they mean.
const HARMLESS = new Set(["cd", "sleep", "true", "export"]);

/** The casm calls a shell command line makes, or null unless it is only casm calls. */
export function casmCalls(command: string, depth = 0): CasmCall[] | null {
  const tokens = tokenize(command);
  if (!tokens || depth > 2) return null;
  const calls: CasmCall[] = [];
  let words: string[] = [];
  let piped = false;
  const flush = () => {
    const command = words;
    words = [];
    if (piped) return true;
    let i = 0;
    while (i < command.length && /^[A-Za-z_]\w*=/.test(command[i])) i++;
    if (command[i] === "env") {
      i++;
      while (i < command.length && (/^[A-Za-z_]\w*=/.test(command[i]) || command[i].startsWith("-")))
        i += command[i] === "-u" ? 2 : 1;
    }
    const rest = command.slice(i);
    if (!rest.length || HARMLESS.has(rest[0])) return true;
    if (/(^|\/)casm$/.test(rest[0])) {
      const call = parseCall(rest.slice(1));
      if (!call) return false;
      calls.push(call);
      return true;
    }
    const script = shellScript(rest);
    if (script === null) return false;
    const inner = casmCalls(script, depth + 1);
    if (!inner) return false;
    calls.push(...inner);
    return true;
  };
  for (const t of tokens) {
    if ("word" in t) {
      words.push(t.word);
      continue;
    }
    if (t.op === "|") {
      // The output went through a filter; the call itself is still this one.
      if (!piped && !flush()) return null;
      piped = true;
      continue;
    }
    if (!flush()) return null;
    piped = false;
  }
  if (!flush()) return null;
  return calls.length ? calls : null;
}

/** casmCalls for a tool item, or null when it is not a shell call of casm. */
export function casmToolCalls(name: string, input: unknown): CasmCall[] | null {
  const command = shellCommand(name, input);
  return command === null ? null : casmCalls(command);
}

// Flags that take no value; every other --flag takes the next word.
const BOOLEAN = new Set(["steer", "wait", "fail-if-limited", "all", "json", "skip-if-busy", "always", "dismiss", "force", "refresh", "probe", "usage", "default", "edit", "reset", "enable", "disable", "reconnect"]);
const GROUPS = new Set(["schedule", "token", "peer", "host", "project"]);

type Spec = {
  /** What the first positional names. */
  first?: "agent" | "ref";
  /** Where the prose is: the positionals after `first`, or a flag. */
  text?: "rest" | `--${string}`;
  /** The second positional is a request or message id. */
  second?: "ref";
  code?: true;
};
const VERBS: Record<string, Spec> = {
  send: { first: "agent", text: "rest" },
  notify: { text: "rest" },
  run: { text: "rest" },
  wait: { first: "agent" },
  history: { first: "agent" },
  watch: { first: "agent" },
  usage: { first: "agent" },
  permissions: { first: "agent" },
  questions: { first: "agent" },
  interrupt: { first: "agent" },
  reload: { first: "agent" },
  restart: { first: "agent" },
  archive: { first: "agent" },
  rm: { first: "agent" },
  pending: { first: "agent" },
  subagents: { first: "agent" },
  mcp: { first: "agent" },
  "agent-prompt": { first: "agent" },
  cancel: { first: "agent", second: "ref" },
  retry: { first: "agent", second: "ref" },
  "send-now": { first: "agent", second: "ref" },
  approve: { first: "agent", second: "ref" },
  deny: { first: "agent", second: "ref", text: "--message" },
  answer: { first: "agent", second: "ref" },
  shell: { first: "agent", code: true },
  agents: {},
  projects: {},
  peers: {},
  limits: {},
  models: {},
  schedules: {},
  "schedule add": { text: "rest" },
  "schedule edit": { first: "ref", text: "rest" },
  "schedule run": { first: "ref" },
  "schedule enable": { first: "ref" },
  "schedule disable": { first: "ref" },
  "schedule rm": { first: "ref" },
};

function parseCall(words: string[]): CasmCall | null {
  let peer: string | undefined;
  const flags: Record<string, string | true> = {};
  let i = 0;
  for (; i < words.length && words[i].startsWith("-"); i++) {
    const w = words[i];
    if (w === "-H" || w === "--host") peer = words[++i];
    else if (w.startsWith("--host=")) peer = w.slice(7);
    else if (/^-H./.test(w)) peer = w.slice(2);
    else if (w === "--json") flags.json = true;
    else return null;
  }
  if (i > words.length || (peer !== undefined && !peer)) return null;
  let verb = words[i++];
  if (!verb) return null;
  if (GROUPS.has(verb) && words[i] && !words[i].startsWith("-")) verb += ` ${words[i++]}`;
  const args: string[] = [];
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      args.push(...words.slice(i + 1));
      break;
    }
    const long = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(w);
    if (long) {
      const [, key, value] = long;
      if (value !== undefined) flags[key] = value;
      else if (BOOLEAN.has(key) || i + 1 >= words.length) flags[key] = true;
      else flags[key] = words[++i];
      continue;
    }
    if (w === "-H") {
      peer = words[++i];
      continue;
    }
    if (/^-[a-zA-Z]$/.test(w) && i + 1 < words.length) {
      flags[w.slice(1)] = words[++i];
      continue;
    }
    args.push(w);
  }
  const spec = VERBS[verb];
  const label = verb === "send" && flags.steer ? "Steer" : verb[0].toUpperCase() + verb.slice(1).replace(/-/g, " ");
  const call: CasmCall = { verb, label, known: !!spec, flags, args, ...(peer ? { peer } : {}) };
  if (!spec) return call;
  let rest = args;
  if (spec.first && rest.length) {
    call[spec.first] = rest[0];
    rest = rest.slice(1);
  }
  if (spec.second && rest.length) {
    call.ref = rest[0];
    rest = rest.slice(1);
  }
  if (verb === "schedule add" && typeof flags.agent === "string") call.agent = flags.agent;
  if (verb === "run" && typeof flags.name === "string") call.agent = flags.name;
  if (spec.code && rest.length) call.code = rest.join(" ");
  if (spec.text === "rest" && rest.length) call.text = rest.join(" ");
  else if (spec.text?.startsWith("--")) {
    const value = flags[spec.text.slice(2)];
    if (typeof value === "string") call.text = value;
  }
  return call;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** The new agent's id in `casm run` output. */
export const createdAgent = (output: string) => UUID.exec(output)?.[0];

/** The agent a casm agent reference names, the way the CLI resolves it: id, exact name, then a unique id prefix. */
export function findAgent<A extends { id: string; name: string; archivedAt?: string | null }>(agents: A[], ref: string): A | undefined {
  const live = agents.filter((a) => !a.archivedAt);
  const byId = agents.find((a) => a.id === ref);
  if (byId) return byId;
  const named = live.filter((a) => a.name === ref);
  if (named.length === 1) return named[0];
  const prefixed = agents.filter((a) => a.id.startsWith(ref));
  return ref.length >= 4 && prefixed.length === 1 ? prefixed[0] : undefined;
}
