import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { rolldown } from "rolldown";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Bundle TSX for a DOM-free render test; no browser or listening server.
test("casm CLI calls render as casm rows; other shell calls keep the generic row", async () => {
  const dir = await mkdtemp(fileURLToPath(new URL(".casm-render-", import.meta.url)));
  const bundle = await rolldown({ input: fileURLToPath(new URL("../src/transcript.tsx", import.meta.url)), external: (id) => !id.startsWith(".") && !id.startsWith("/"), transform: { jsx: "react-jsx" } });
  try {
    const file = join(dir, "transcript.mjs");
    await bundle.write({ file, format: "esm", codeSplitting: false });
    const { Row } = await import(pathToFileURL(file).href);
    const render = (input: unknown, output = "", expansion: Record<string, boolean> = {}) =>
      renderToStaticMarkup(createElement(Row, { item: { kind: "tool", id: "t", name: "Bash", input, status: "done", output }, expansion }));
    const send = render({ command: `casm send 370bc4a8 "Main agent: **rebase** please"`, description: "Message" });
    assert.match(send, /class="item tool casm-tool"/);
    assert.match(send, /<strong class="casm-verb"[^>]*>Send<\/strong>/);
    assert.match(send, /<strong>rebase<\/strong>/);
    assert.match(send, />370bc4a8</);
    assert.doesNotMatch(send, /&quot;command&quot;/);
    // The raw disclosure keeps the command and output.
    const raw = render({ command: `casm -H fedora wait w` }, "Reply **text**", { "t:raw": true });
    assert.match(raw, /casm -H fedora wait w/);
    assert.match(raw, /Reply \*\*text\*\*/);
    assert.match(raw, />@fedora</);
    assert.match(render({ command: "ls -la" }), /<strong>Bash<\/strong>/);
  } finally {
    await bundle.close();
    await rm(dir, { recursive: true, force: true });
  }
});
