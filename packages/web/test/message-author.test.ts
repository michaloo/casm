import { test } from "node:test";
import assert from "node:assert/strict";
import { messageAuthor } from "../src/message-author.ts";
test("human and legacy messages retain You while agent messages show provenance", () => {
  assert.equal(messageAuthor({ kind: "user" }), "You");
  assert.equal(messageAuthor({ kind: "user", sender: { serverId: "host", agentId: "agent", name: "Researcher" } }), "Researcher");
  assert.equal(messageAuthor({ kind: "user", sender: { serverId: "host", agentId: "agent" } }), "agent");
  assert.equal(messageAuthor({ kind: "user", sender: { serverId: "host", agentId: "agent", name: " " } }), "agent");
});
