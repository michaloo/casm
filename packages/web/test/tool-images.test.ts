import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { rolldown } from "rolldown";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Bundle TSX for a DOM-free render test; no browser or listening server.
test("tool disclosure renders inline images and preserves text-only fallback", async () => {
  const dir = await mkdtemp(fileURLToPath(new URL(".tool-render-", import.meta.url)));
  const bundle = await rolldown({ input: fileURLToPath(new URL("../src/transcript.tsx", import.meta.url)), external: (id) => !id.startsWith(".") && !id.startsWith("/"), transform: { jsx: "react-jsx" } });
  try {
    const file = join(dir, "transcript.mjs");
    await bundle.write({ file, format: "esm", codeSplitting: false });
    const { Row } = await import(pathToFileURL(file).href);
    const base = { kind: "tool", id: "view", name: "view_image", input: { path: "/private/pixel.png" }, status: "done" };
    const render = (item: unknown, open = true) => renderToStaticMarkup(createElement(Row, { item, expansion: { view: open } }));
    const html = render({ ...base, images: [{ mediaType: "image/png", data: "YWJj" }] });
    assert.match(html, /src="data:image\/png;base64,YWJj"/);
    assert.doesNotMatch(html, /No output/);
    assert.doesNotMatch(html, /src="\/private/);
    assert.doesNotMatch(render({ ...base, images: [{ mediaType: "image/png", data: "YWJj" }] }, false), /<img/);
    assert.match(render(base), /No output/);
    assert.match(render({ ...base, output: "read failed" }), /read failed/);
    assert.doesNotMatch(render({ ...base, images: [{ mediaType: "image/svg+xml", data: "YWJj" }] }), /<img/);
    const user = render({ kind: "user", id: "user", text: "first\nsecond" });
    assert.match(user, /first<br\/>\nsecond/);
  } finally {
    await bundle.close();
    await rm(dir, { recursive: true, force: true });
  }
});
