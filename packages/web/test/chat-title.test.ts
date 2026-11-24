import test from "node:test";
import assert from "node:assert/strict";
import { chatTitle } from "../src/chat-title.ts";

test("uses a topic heading and skips greetings and request boilerplate", () => {
  assert.equal(chatTitle("We talked last week. Could you review invoice export permissions before we release?"), "Review invoice export permissions before we release");
  assert.equal(chatTitle("Hi!\n\n## Stripe refund status\nCould you look into it?"), "Stripe refund status");
  assert.equal(chatTitle("ROZW\u00d3J CASM\n\nPotrzebuj\u0119 zmiany w interfejsie."), "ROZW\u00d3J CASM");
  assert.equal(chatTitle("Please can you help me figure out why the checkout total doubles after a refund?"), "Checkout total doubles after a refund");
  assert.equal(chatTitle("Cze\u015b\u0107, potrzebuj\u0119, \u017ceby\u015b zrobi\u0142 nowy widok faktur w panelu klienta."), "Nowy widok faktur w panelu klienta");
});

test("keeps topics short and names attachment-only chats", () => {
  assert.equal(chatTitle("Please fix invoice export in the accounting module before tomorrow."), "Fix invoice export in the accounting module");
  assert.equal(chatTitle("", "budget.xlsx"), "budget.xlsx");
  assert.equal(chatTitle(""), "Image message");
  assert.equal(chatTitle("Hej!"), "New conversation");
});
