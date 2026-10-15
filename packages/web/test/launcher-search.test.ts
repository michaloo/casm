import test from "node:test";
import assert from "node:assert/strict";
import { agentRecentKey, fuzzy, rankEntries, readRecent, rememberAgent, type SearchEntry } from "../src/launcher-search.ts";

test("launcher fuzzy matches subsequences and separate words, with safe original character positions", () => {
  assert.deepEqual(fuzzy("Alpha Beta", "abt")?.positions, [0, 6, 8]);
  assert.deepEqual(fuzzy("Alpha Beta", "beta ALP")?.positions, [0, 1, 2, 6, 7, 8, 9]);
  assert.equal(fuzzy("Alpha Beta", "zzz"), null);
  assert.equal(fuzzy("Alpha Beta", "alp missing"), null);
  assert.equal(fuzzy("Alpha Beta", " ")?.score, 0);
  assert.ok(fuzzy("Beta worker", "beta")!.score > fuzzy("A Beta worker", "beta")!.score);
  assert.ok(fuzzy("A Beta worker", "beta")!.score > fuzzy("Alphabetaxy", "beta")!.score);
  assert.ok(fuzzy("alpha", "alp")!.score > fuzzy("a long path", "alp")!.score);
  assert.deepEqual(fuzzy("<script>", "script")?.positions, [1, 2, 3, 4, 5, 6]);
});
const entry = (id: string, more: Partial<SearchEntry> = {}): SearchEntry => ({ id, title: "Same name", subtitle: "Project · peer host · Claude", group: "Agents", ...more });
test("empty query prioritizes attention, running, persisted recency, then last activity", () => {
  const entries = [entry("idle", { activity: 4 }), entry("recent"), entry("running", { running: true }), entry("waiting", { attention: true }), entry("failed", { attention: true, activity: 2 }), entry("held", { attention: true, activity: 3 }), entry("older", { activity: 1 }), entry("action", { group: "Actions" })];
  assert.deepEqual(rankEntries(entries, "", { recent: 100, idle: 50 }).map(result => result.entry.id), ["held", "failed", "waiting", "running", "recent", "idle", "older", "action"]);
});
test("query score wins over attention and uses MRU to break ties across host/project/provider metadata", () => {
  const entries = [entry("attention", { title: "Faraway work", attention: true }), entry("old", { title: "Beta task" }), entry("recent", { title: "Beta task" })];
  assert.deepEqual(rankEntries(entries, "beta", { recent: 2 }).map(result => result.entry.id), ["recent", "old"]);
  assert.equal(rankEntries(entries, "peer Claude", {}).length, 3);
  assert.equal(rankEntries(entries, "Project", {}).length, 3);
});
test("recent agent visits are host-specific, bounded, tolerate unavailable or corrupt storage", () => {
  let value: string | null = "broken";
  const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
  assert.deepEqual(readRecent(storage), {});
  rememberAgent(storage, "local", "same", 1); rememberAgent(storage, "peer", "same", 2);
  assert.equal(Object.keys(readRecent(storage)).length, 2);
  assert.equal(readRecent(storage)[agentRecentKey("peer", "same")], 2);
  for (let i = 0; i < 210; i++) rememberAgent(storage, "local", String(i), i + 3);
  assert.equal(Object.keys(readRecent(storage)).length, 200);
  assert.equal(readRecent(storage)[agentRecentKey("local", "same")], undefined);
  assert.doesNotThrow(() => rememberAgent({ getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("quota"); } }, "host", "agent"));
});
test("500+ agents remain searchable without limiting results", () => {
  const entries = Array.from({ length: 750 }, (_, i) => entry(String(i), { title: `Worker ${i}`, subtitle: `Project ${i % 9} · host ${i % 3}` }));
  assert.equal(rankEntries(entries, "worker", {}).length, 750);
  assert.equal(rankEntries(entries, "Worker 749", {})[0].entry.id, "749");
});
