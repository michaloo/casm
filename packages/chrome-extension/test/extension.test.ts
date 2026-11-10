// The extension's pure parts: the snapshot text and key parsing. The rest
// needs a browser: scripts/e2e.ts runs it in Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";

// Plain JavaScript modules (the extension has no build), so untyped here.
const dir = new URL("../extension/", import.meta.url).href;
const { formatAXTree } = await import(`${dir}snapshot.js`);
const { keyEvents } = await import(`${dir}keys.js`);

const ax = (nodeId: string, role: string, name: string, childIds: string[] = [], extra: object = {}) => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  childIds,
  ...extra,
});

test("snapshot: roles with names and refs, structure-only nodes flattened, repeated text dropped", () => {
  const nodes = [
    ax("1", "RootWebArea", "Login", ["2"], { backendDOMNodeId: 1 }),
    ax("2", "generic", "", ["3", "4", "6", "8"], { backendDOMNodeId: 2 }),
    ax("3", "heading", "Sign in", ["3t"], { backendDOMNodeId: 3, properties: [{ name: "level", value: { value: 1 } }] }),
    ax("3t", "StaticText", "Sign in"),
    ax("4", "textbox", "Email", [], { backendDOMNodeId: 4, value: { value: "me@example.com" }, properties: [{ name: "focused", value: { value: true } }, { name: "required", value: { value: false } }] }),
    ax("6", "button", "Continue", ["7"], { backendDOMNodeId: 6, properties: [{ name: "expanded", value: { value: false } }] }),
    ax("7", "StaticText", "Continue"),
    ax("8", "paragraph", "", ["9"], { backendDOMNodeId: 8 }),
    ax("9", "StaticText", "Forgot   your\npassword?"),
    { nodeId: "10", ignored: true, role: { value: "button" }, name: { value: "hidden" }, childIds: [] },
  ];
  const parents: Record<string, string> = { "2": "1", "3": "2", "3t": "3", "4": "2", "6": "2", "7": "6", "8": "2", "9": "8", "10": "2" };
  for (const n of nodes) Object.assign(n, { parentId: parents[n.nodeId] });
  const { text, refs } = formatAXTree(nodes);
  assert.equal(
    text,
    [
      '- heading "Sign in" [level=1] [e1]',
      '- textbox "Email" value="me@example.com" [focused] [e2]',
      '- button "Continue" [collapsed] [e3]',
      "- paragraph [e4]",
      '  - text "Forgot your password?"',
    ].join("\n"),
  );
  assert.deepEqual(refs, { e1: 3, e2: 4, e3: 6, e4: 8 });
});

test("snapshot: long pages are cut, empty ones say so", () => {
  const many = Array.from({ length: 10 }, (_, i) => ax(`n${i}`, "link", `L${i}`, [], { backendDOMNodeId: i + 1, parentId: "root" }));
  const { text } = formatAXTree([ax("root", "RootWebArea", "", many.map((n) => n.nodeId)), ...many], { maxLines: 3 });
  assert.equal(text.split("\n").length, 4);
  assert.match(text, /cut at 3 lines/);
  assert.equal(formatAXTree([ax("r", "RootWebArea", "")]).text, "(the page has no accessible content)");
});

test("keys: named keys, characters, modifiers and editing commands", () => {
  assert.deepEqual(keyEvents("Enter").down, { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r", unmodifiedText: "\r" });
  assert.equal(keyEvents("Tab").down.type, "rawKeyDown");
  assert.equal(keyEvents("Esc").down.key, "Escape");
  assert.deepEqual(keyEvents("Shift+a").down, { type: "keyDown", key: "A", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 8, text: "A", unmodifiedText: "A" });
  assert.deepEqual(keyEvents("Control+a").down, { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
  assert.equal(keyEvents("Meta+Shift+Tab").down.modifiers, 12);
  assert.equal(keyEvents("Control++").down.key, "+");
  assert.throws(() => keyEvents("Hyper+a"), /unknown modifier/);
  assert.throws(() => keyEvents("F13"), /unknown key "F13"/);
});
