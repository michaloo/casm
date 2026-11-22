import { test } from "node:test";
import assert from "node:assert/strict";
import { readNewChatProvider, writeNewChatProvider } from "../src/new-chat-provider.ts";
test("new chats default to Codex and preserve an explicit device preference", () => {
  assert.equal(readNewChatProvider({ getItem: () => null }), "codex");
  assert.equal(readNewChatProvider({ getItem: () => "claude" }), "claude");
  assert.equal(readNewChatProvider({ getItem: () => "invalid" }), "codex");
  assert.equal(readNewChatProvider({ getItem: () => { throw new Error("blocked"); } }), "codex");
  let saved = "";
  writeNewChatProvider({ setItem: (key, value) => { saved = `${key}=${value}`; } }, "codex");
  assert.equal(saved, "casm.new-chat-provider=codex");
});
