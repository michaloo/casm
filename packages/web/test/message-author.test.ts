import { test } from "node:test";
import assert from "node:assert/strict";
import { messageAuthor } from "../src/message-author.ts";
test("human and legacy messages retain You while agent messages show provenance", () => {
  assert.equal(messageAuthor({ kind: "user" }), "You");
  assert.equal(messageAuthor({ kind: "user", sender: { serverId: "host", agentId: "agent", name: "Researcher" } }), "Researcher");
  assert.equal(messageAuthor({ kind: "user", sender: { serverId: "host", agentId: "agent" } }), "agent");
  assert.equal(messageAuthor({ kind: "user", sender: { serverId: "host", agentId: "agent", name: " " } }), "agent");
});

test("sender hosts distinguish agents and schedules have explicit attribution", () => {
  assert.equal(messageAuthor({ kind: "user", sender: { serverId: "server", agentId: "agent", name: "Researcher", host: "studio" } }), "Researcher · studio");
  assert.equal(messageAuthor({ kind: "user", sender: { serverId: "server", agentId: "schedule:job", name: "Legacy label", host: "laptop", schedule: { id: "job", name: "Morning check" } } }), "Schedule: Morning check · laptop");
  assert.equal(messageAuthor({ kind: "user", sender: { serverId: "server", agentId: "schedule:job", host: " ", schedule: { id: "job", name: " " } } }), "Schedule: job");
});
