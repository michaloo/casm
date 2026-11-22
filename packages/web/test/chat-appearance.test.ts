import { test } from "node:test";
import assert from "node:assert/strict";
import { readChatAppearance, writeChatAppearance } from "../src/chat-appearance.ts";
test("device chat options are independent, resilient and persist explicit opt-outs", () => {
  assert.deepEqual(readChatAppearance({ getItem: () => null }), { unreadIndicators: true, recentFirst: true });
  assert.deepEqual(readChatAppearance({ getItem: () => '{"unreadIndicators":false}' }), { unreadIndicators: false, recentFirst: true });
  assert.deepEqual(readChatAppearance({ getItem: () => '{bad' }), { unreadIndicators: true, recentFirst: true });
  let saved = "";
  writeChatAppearance({ setItem: (_key, value) => { saved = value; } }, { unreadIndicators: false, recentFirst: false });
  assert.deepEqual(readChatAppearance({ getItem: () => saved }), { unreadIndicators: false, recentFirst: false });
});
