// Terminal-safety tests. Everything casm prints from a transcript is untrusted
// terminal input, and a sequence that reaches the terminal intact drives it -
// which is how a listing ends up leaving an unterminated escape behind and the
// shell prompt after it goes invisible.
import test from "node:test";
import assert from "node:assert";
import { plain, pad, truncate, snippet, shortProject, fitLine } from "./util.mjs";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// A CSI runs until a byte in 0x40-0x7e. One left unterminated makes the
// terminal swallow whatever prints next, the newline and prompt included.
const endsMidEscape = (s) => {
  for (const m of s.matchAll(/\x1b\[[0-9;?<>=!]*/g)) {
    const next = s[m.index + m[0].length];
    if (next === undefined || !(next >= "@" && next <= "~")) return true;
  }
  return false;
};

test("plain strips the sequences that alter terminal state", () => {
  assert.equal(plain(ESC + "[8mhidden" + ESC + "[28m"), "hidden");        // conceal
  assert.equal(plain(ESC + "[?1049hx" + ESC + "[?1049l"), "x");           // alt screen
  assert.equal(plain(ESC + "[?25lx"), "x");                              // cursor hide
  assert.equal(plain(ESC + "]0;retitled" + BEL + "x"), "x");             // OSC window title
  assert.equal(plain(ESC + "]0;retitled" + ESC + "\\x"), "x");           // OSC, ST-terminated
  assert.equal(plain("a" + ESC + "c" + "b"), "ab");                      // RIS, two-char escape
  assert.equal(plain("a\x00\x07\x1f b"), "a b");                         // stray C0
});

test("plain keeps an unterminated sequence from surviving as one", () => {
  // this is the shape a truncate leaves behind
  assert.equal(plain("text" + ESC + "[31"), "text");
  assert.ok(!endsMidEscape(plain("text" + ESC + "[31")));
});

test("plain leaves ordinary text alone", () => {
  for (const s of ["plain words", "naïve café", "日本語", "emoji 🚀 ok", "a…b", "tabs\tand\nnewlines"])
    assert.equal(plain(s), s.replace(/\t/g, " "));
});

test("truncate never cuts inside an escape sequence", () => {
  // 395 filler + ESC[31m: the 399-char cut lands between "[31" and "m"
  const out = truncate("x".repeat(395) + ESC + "[31mred and more", 400);
  assert.ok(!endsMidEscape(out), `left a chopped escape: ${JSON.stringify(out.slice(-8))}`);
  assert.ok(out.endsWith("…"));
});

test("pad never cuts inside an escape sequence, and still fills to width", () => {
  assert.ok(!endsMidEscape(pad("abc" + ESC + "[1mdefghij", 6)));
  assert.equal(pad("ab", 5), "ab   ");
  assert.equal(pad("abcdef", 4).length, 4);
});

test("snippet emits only its own highlight, balanced", () => {
  // opener inside the window, closer far outside it
  const text = "some log output here " + ESC + "[8m concealed needle here " + "tail ".repeat(30);
  const flat = plain(text).replace(/\s+/g, " ");
  const out = snippet(flat, flat.indexOf("needle"), 6);
  assert.equal((out.match(/\x1b\[/g) || []).length, 2, "expected exactly the highlight open+close");
  assert.ok(out.includes(ESC + "[33mneedle" + ESC + "[0m"), "highlight must land on the term");
  assert.ok(!endsMidEscape(out));
});

test("shortProject sanitises the cwd it was handed", () => {
  assert.equal(shortProject("/home/u/" + ESC + "[8mProjects/thing"), "Projects/thing");
  assert.equal(shortProject("/a/b/c/d"), "c/d");
  assert.equal(shortProject(null), "?");
});

test("fitLine cuts to the terminal width instead of wrapping", () => {
  const visible = (s) => plain(s).length;
  assert.equal(visible(fitLine("x".repeat(200), 60)), 60);        // 59 + the ellipsis
  assert.equal(fitLine("short", 60), "short");                    // untouched when it fits
  assert.equal(fitLine("anything", 0), "anything");               // no width known: leave it
});

test("fitLine never counts escapes as width, and closes what it cuts", () => {
  const coloured = ESC + "[32m" + "y".repeat(200) + ESC + "[0m";
  const out = fitLine(coloured, 40);
  assert.equal(plain(out).length, 40, "colour must not eat visible columns");
  assert.ok(out.endsWith(ESC + "[0m"), "a cut row must not leak its colour");
  assert.ok(!endsMidEscape(out));
});
