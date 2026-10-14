import { test } from "node:test";
import assert from "node:assert/strict";
import { projectKey, projectExpanded, readCollapsed, writeCollapsed } from "../src/project-collapse.ts";

test("collapse keys distinguish hosts and ambiguous concatenations", () => {
  assert.notEqual(projectKey("a", "b:c"), projectKey("a:b", "c"));
  assert.notEqual(projectKey("one", "shared"), projectKey("two", "shared"));
});
test("route selection reveals its agent without changing saved preference", () => {
  const saved = { [projectKey("host", "project")]: true as const };
  assert.equal(projectExpanded(saved, "host", "project"), false);
  assert.equal(projectExpanded(saved, "host", "project", { host: "host", project: "project", id: "agent" }), true);
  assert.equal(projectExpanded(saved, "host", "project", { host: "other", project: "project", id: "agent" }), false);
  assert.equal(saved[projectKey("host", "project")], true);
});
test("preferences round trip and corrupt/unavailable storage is harmless", () => {
  let value = "";
  const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
  const saved = { [projectKey("h", "p")]: true as const };
  writeCollapsed(storage, saved);
  assert.deepEqual(readCollapsed(storage), saved);
  value = "invalid";
  assert.deepEqual(readCollapsed(storage), {});
  assert.doesNotThrow(() => writeCollapsed({ setItem() { throw Error("quota"); } }, saved));
});
