import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "@casm/protocol";
import { transcriptRows, rowAt, anchorRows, readWorkView, writeWorkView } from "../src/work-details.ts";
const message = (id: string): Item => ({ kind: "assistant", id, text: id });
const tool = (id: string): Item => ({ kind: "tool", id, name: "Bash", input: {}, status: "done" });

test("groups only consecutive technical activity, preserving visible messages, plans and warnings", () => {
  const items: Item[] = [message("a"), tool("b"), { kind: "reasoning", id: "c", text: "thinking" },
    { kind: "notice", id: "d", text: "warning", level: "warning" }, tool("e"),
    { kind: "plan", id: "f", entries: [] }, message("g")];
  const rows = transcriptRows(items, "compact");
  assert.deepEqual(rows.map((r) => r.items.map((i) => i.id)), [["a"], ["b", "c"], ["d"], ["e"], ["f"], ["g"]]);
  assert.equal(rowAt(rows, 2), 1);
  assert.equal(rowAt(rows, 6), 5);
  assert.equal(transcriptRows(items, "detailed").length, items.length);
});

test("prepending history and growing a group preserve existing virtual row coordinates", () => {
  const before = anchorRows(transcriptRows([tool("b"), tool("c"), message("d")], "compact"), 8);
  const prepend = anchorRows(transcriptRows([message("a"), tool("b"), tool("c"), message("d")], "compact"), 7, before);
  assert.equal(prepend.first + 1, before.first);
  const grow = anchorRows(transcriptRows([message("a"), tool("b"), tool("c"), message("d"), tool("e"), tool("f")], "compact"), 7, prepend);
  assert.equal(grow.first, prepend.first);
  // A partial group at a page boundary changes its ID; the following message anchors it.
  const partial = anchorRows(transcriptRows([tool("a"), tool("b"), tool("c"), message("d")], "compact"), 7, before);
  assert.equal(partial.first + 1, before.first + 1);
});

test("compact is the default, detailed persists, unavailable storage is harmless", () => {
  assert.equal(readWorkView({ getItem: () => null }), "compact");
  assert.equal(readWorkView({ getItem: () => "invalid" }), "compact");
  assert.equal(readWorkView({ getItem: () => "detailed" }), "detailed");
  const blocked = { getItem() { throw Error(); }, setItem() { throw Error(); } };
  assert.equal(readWorkView(blocked), "compact");
  assert.doesNotThrow(() => writeWorkView(blocked, "compact"));
});

test("routine approval notices join tool activity, but unrelated warnings and review failures remain visible", () => {
  const approved: Item = { kind: "notice", id: "old-approval", level: "warning", text: "Automatic approval review approved (risk: low, authorization: high): local calculation" };
  const current: Item = { ...tool("review:current"), name: "Review approved" };
  const denied: Item = { ...tool("review:denied"), name: "Review denied", status: "error" };
  const strict: Item = { kind: "notice", id: "strict-review:turn:1", level: "info", text: "Codex requires a fresh automatic approval review for this turn." };
  const items: Item[] = [message("a"), approved, tool("command"), current, strict, denied,
    { ...approved, id: "old-denied", text: "Automatic approval review denied (risk: high): not authorized" },
    { kind: "notice", id: "warning", text: "Reviewer is retrying", level: "warning" },
    { ...approved, id: "error", level: "error" },
    { ...approved, id: "restart", restart: true },
    { ...approved, id: "unknown", text: "Automatic approval review approvedSomethingUnexpected" }, message("b")];
  const rows = transcriptRows(items, "compact");
  assert.deepEqual(rows.filter((r) => r.work).map((r) => r.items.map((i) => i.id)), [["old-approval", "command", "review:current", "strict-review:turn:1"]]);
  assert.equal(rows.find((r) => r.id === "review:denied")?.work, false);
  assert.equal(rowAt(rows, 3), 1);
  assert.equal(transcriptRows(items, "detailed").length, items.length);
  assert.deepEqual(rows.flatMap((r) => r.items), items);
});
