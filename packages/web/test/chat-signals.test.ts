import { test } from "node:test";
import assert from "node:assert/strict";
import { observeSignal, liveSignal, sampleSignal, tailSignature, readSignals, saveSignals } from "../src/chat-signals.ts";
const agent = { status: "idle" as const, updatedAt: "2026-11-01T00:00:00Z" };
const reply = (id: string, text = "Done") => ({ kind: "assistant" as const, id, text, at: "2026-11-02T00:00:00Z" });
test("first snapshots and history establish a baseline without marking old messages unread", () => {
  const initial = observeSignal(undefined, agent, false, 1000);
  assert.equal(initial.unread, false);
  const sampled = sampleSignal(initial, agent, reply("a"), false);
  assert.equal(sampled.unread, false);
  assert.equal(sampled.activity, Date.parse("2026-11-02T00:00:00Z"));
  assert.equal(observeSignal(sampled, agent, false), sampled);
});
test("status, configuration, own messages and tool events never create an unread message", () => {
  let state = observeSignal(undefined, agent, false);
  for (const status of ["running", "waiting", "failed", "idle"] as const) {
    state = observeSignal(state, { ...agent, status }, false, Date.parse("2026-11-03"));
    assert.equal(state.unread, false);
  }
  state = observeSignal(state, { ...agent, updatedAt: "2026-11-04" }, false);
  assert.equal(state.unread, false);
  for (const item of [{ kind: "user" as const, id: "own", text: "My prompt" }, { kind: "notice" as const, id: "n", text: "Automatic approval" }, { kind: "tool" as const, id: "t", name: "Read", input: {}, status: "done" as const }]) {
    assert.equal(liveSignal(state, agent, false, Date.now(), item).unread, false);
    assert.equal(sampleSignal(state, agent, item, false).unread, false);
  }
});
test("only a new assistant message marks unread, persists through reload, and clears when read", () => {
  let state = sampleSignal(undefined, agent, reply("a"), true);
  state = liveSignal(state, agent, false, Date.now(), reply("b"));
  assert.equal(state.unread, true);
  assert.equal(observeSignal(state, { ...agent, status: "running" }, false).unread, true);
  let serialized = "";
  saveSignals({ setItem: (_, value) => { serialized = value; } }, { '["host","a"]': state });
  const restored = readSignals({ getItem: () => serialized })['["host","a"]'];
  assert.equal(restored.unread, true);
  const seen = observeSignal(restored, agent, true);
  assert.equal(seen.unread, false);
  assert.equal(liveSignal(seen, agent, false, Date.now(), reply("b")).unread, false);
});
test("offline reply comparisons detect a message while technical items keep the last reply fingerprint", () => {
  const before = sampleSignal(undefined, agent, reply("a"), true);
  const after = sampleSignal(before, agent, reply("b"), false, Date.parse("2026-11-04"));
  assert.equal(after.unread, true);
  assert.equal(after.activity, Date.parse("2026-11-04"));
  assert.equal(sampleSignal(after, agent, { kind: "notice", id: "log", text: "Finished tool" }, false).tail, after.tail);
  assert.equal(sampleSignal(after, agent, reply("b"), true).unread, false);
  assert.equal(liveSignal(after, agent, false).tail, after.tail);
});
test("migration preserves recency while discarding old generic activity markers", () => {
  const legacy = JSON.stringify({ '["host","a"]': { activity: 123, unread: true, status: "idle", updatedAt: agent.updatedAt, tail: "tool:fingerprint" } });
  const state = readSignals({ getItem: key => key === "casm.chat-signals" ? legacy : null })['["host","a"]'];
  assert.equal(state.activity, 123);
  assert.equal(state.unread, false);
  assert.equal(state.tail, undefined);
});
test("fingerprints contain no message content and corrupt or blocked storage is harmless", () => {
  assert.notEqual(tailSignature(reply("a", "one")), tailSignature(reply("a", "two")));
  assert.ok(!tailSignature(reply("a", "private content")).includes("private content"));
  assert.deepEqual(readSignals({ getItem: () => '{"bad":true}' }), {});
  assert.deepEqual(readSignals({ getItem: () => 'invalid' }), {});
  assert.deepEqual(readSignals({ getItem() { throw Error(); } }), {});
  assert.doesNotThrow(() => saveSignals({ setItem() { throw Error(); } }, {}));
});
