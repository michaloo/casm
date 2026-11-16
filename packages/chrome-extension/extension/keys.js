// "Enter", "a", "Control+a", "Shift+Tab" → CDP Input.dispatchKeyEvent params
// for keyDown and keyUp. Pure, tested in Node.

const NAMED = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};
const ALIASES = { Esc: "Escape", Return: "Enter", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Del: "Delete" };
// CDP modifier bits.
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };
// Editing shortcuts are not run by synthetic key events; CDP takes them as commands.
const COMMANDS = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

/** @returns {{ down: object, up: object }} */
export function keyEvents(spec) {
  const parts = String(spec).split("+");
  // "Control++" means the "+" key.
  if (parts.length > 1 && parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+");
  const name = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIERS[m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()] ?? MODIFIERS[m];
    if (!bit) throw new Error(`unknown modifier "${m}" in "${spec}" (Alt, Control, Meta, Shift)`);
    modifiers |= bit;
  }
  const canonical = ALIASES[name] ?? name;
  let key;
  if (NAMED[canonical]) key = { key: canonical, ...NAMED[canonical] };
  else if ([...canonical].length === 1) {
    const upper = canonical.toUpperCase();
    const code = /[a-z]/i.test(canonical) ? `Key${upper}` : /\d/.test(canonical) ? `Digit${canonical}` : "";
    const shifted = modifiers & 8 ? upper : canonical;
    key = { key: shifted, code, keyCode: code ? upper.charCodeAt(0) : 0, text: shifted };
  } else throw new Error(`unknown key "${name}" (Enter, Tab, Escape, Backspace, Delete, Arrow…, Home, End, PageUp, PageDown, Space or one character)`);

  const chord = (modifiers & (2 | 4)) !== 0;
  const command = chord && COMMANDS[canonical.toLowerCase()];
  const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers };
  // Text is typed only without Control/Meta (Control+a selects, it doesn't type "a").
  const text = !chord && key.text ? { text: key.text, unmodifiedText: key.text } : {};
  return {
    down: { type: text.text ? "keyDown" : "rawKeyDown", ...base, ...text, ...(command ? { commands: [command] } : {}) },
    up: { type: "keyUp", ...base },
  };
}
