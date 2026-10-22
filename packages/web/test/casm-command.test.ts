import test from "node:test";
import assert from "node:assert/strict";
import { casmCalls, casmToolCalls, createdAgent, shellCommand, tokenize } from "../src/casm-command.ts";

const one = (command: string) => {
  const calls = casmCalls(command);
  assert.ok(calls, command);
  assert.equal(calls.length, 1, command);
  return calls[0];
};

test("send reads the target and the message through shell quoting", () => {
  const send = one(`casm send 370bc4a8 "Main agent: it's \\"done\\" \\$5 \`ok\`"`.replace("`ok`", "ok"));
  assert.equal(send.label, "Send");
  assert.equal(send.agent, "370bc4a8");
  assert.equal(send.text, `Main agent: it's "done" $5 ok`);
  assert.equal(one(`casm send worker 'single "quoted"' `).text, `single "quoted"`);
  assert.equal(one(`casm send worker $'line one\\nline two'`).text, "line one\nline two");
  assert.equal(one(`casm send worker "multi\nline"`).text, "multi\nline");
  assert.equal(one(`casm send worker unquoted words here`).text, "unquoted words here");
  assert.equal(one(`casm send worker "a"'b'c`).text, "abc");
});

test("--steer, -H and other flags around the positionals", () => {
  const steer = one(`casm -H buildbox send --steer abc "stop that"`);
  assert.equal(steer.label, "Steer");
  assert.equal(steer.peer, "buildbox");
  assert.equal(steer.agent, "abc");
  assert.equal(steer.text, "stop that");
  assert.equal(one(`casm send abc "x" --steer --wait`).label, "Steer");
  assert.equal(one(`casm --host=mac agents`).peer, "mac");
  assert.equal(one(`casm -Hmac agents`).peer, "mac");
  const run = one(`casm run --project code --cwd .worktrees/x --provider codex --name "web: rows" "Do the thing"`);
  assert.equal(run.label, "Run");
  assert.equal(run.text, "Do the thing");
  assert.equal(run.agent, "web: rows");
  assert.equal(run.flags.provider, "codex");
  const history = one(`casm history abc -n 20`);
  assert.equal(history.agent, "abc");
  assert.equal(history.flags.n, "20");
});

test("verb table: refs, schedule groups, deny reasons, unknown verbs", () => {
  const add = one(`casm schedule add --every 30m --agent worker "check CI"`);
  assert.equal(add.label, "Schedule add");
  assert.equal(add.agent, "worker");
  assert.equal(add.text, "check CI");
  assert.equal(add.flags.every, "30m");
  const edit = one(`casm schedule edit 1a2b --at 18:30 "new prompt"`);
  assert.equal(edit.ref, "1a2b");
  assert.equal(edit.text, "new prompt");
  const deny = one(`casm deny worker req-1 --message "not that file"`);
  assert.deepEqual([deny.label, deny.agent, deny.ref, deny.text], ["Deny", "worker", "req-1", "not that file"]);
  assert.deepEqual([one("casm approve w r --always").label, one("casm send-now w m").label], ["Approve", "Send now"]);
  const unknown = one(`casm frobnicate --x 1 thing`);
  assert.equal(unknown.known, false);
  assert.equal(unknown.verb, "frobnicate");
  assert.equal(one("casm agents --all").agent, undefined);
});

test("chained calls, cd and env prefixes, pipes and redirections", () => {
  const calls = casmCalls(`cd /tmp && casm send w "hi" && casm wait w`)!;
  assert.deepEqual(calls.map((c) => c.verb), ["send", "wait"]);
  assert.deepEqual(casmCalls(`casm send w "a"; casm send v "b"`)!.map((c) => c.agent), ["w", "v"]);
  assert.equal(one(`CASM_HOST=buildbox env -u NODE_ENV casm agents`).verb, "agents");
  assert.equal(one(`/usr/local/bin/casm agents`).verb, "agents");
  assert.equal(one(`casm history w 2>&1 | tail -40`).agent, "w");
  assert.equal(one(`casm wait w > /tmp/out.txt 2>/dev/null`).agent, "w");
  assert.equal(one(`sleep 30; casm wait w # then read it`).verb, "wait");
  assert.equal(one(`casm send w "$(cat <<'EOF'\nLine *one*\n\n- two \`code\` $HOME\nEOF\n)"`).text, "Line *one*\n\n- two `code` $HOME");
});

test("Codex bash -lc wrapping and command arrays", () => {
  assert.equal(one(`/bin/bash -lc "casm send w 'wrapped msg'"`).text, "wrapped msg");
  assert.equal(one(`bash -lc 'cd /x && casm agents'`).verb, "agents");
  assert.equal(shellCommand("exec_command", { command: ["/bin/bash", "-lc", "casm agents"] }), "casm agents");
  assert.equal(casmToolCalls("exec_command", { cmd: "casm wait w" })?.[0].verb, "wait");
  assert.equal(casmToolCalls("Bash", { command: "casm agents", description: "List agents" })?.[0].verb, "agents");
  assert.equal(casmToolCalls("shell", { command: "casm agents", cwd: "/x" })?.[0].verb, "agents");
  assert.equal(casmToolCalls("bash", { command: "casm agents" })?.[0].verb, "agents");
});

test("falls back to the generic row when unsure", () => {
  for (const command of [
    "ls -la",
    "git status && casm agents",
    "casm send w \"$(date)\"",
    "casm send w `whoami`",
    "casm send w \"unterminated",
    "(cd x && casm agents)",
    "casm send w <<EOF\nhi\nEOF",
    "echo hi | casm send w -",
    "casm -H",
    "casm",
    "casmx agents",
    "casm --weird agents",
  ])
    assert.equal(casmCalls(command), null, command);
  assert.equal(casmToolCalls("Read", { command: "casm agents" }), null);
  assert.equal(casmToolCalls("Bash", { command: 42 }), null);
  assert.equal(tokenize("a 'b"), null);
});

test("finds the new agent id in run output", () => {
  assert.equal(createdAgent("ab12cd34-0000-4000-8000-123456789abc\n"), "ab12cd34-0000-4000-8000-123456789abc");
  assert.equal(createdAgent("queued"), undefined);
});

test("notify carries only a message", () => {
  const notify = one(`casm notify "Build is **green**" --title CI`);
  assert.deepEqual([notify.label, notify.agent, notify.text, notify.flags.title], ["Notify", undefined, "Build is **green**", "CI"]);
});
