import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { rolldown } from "rolldown";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("markdown anchors isolate external tabs and preserve app/file navigation", async () => {
  const dir = await mkdtemp(fileURLToPath(new URL(".link-render-", import.meta.url)));
  const bundle = await rolldown({ input: fileURLToPath(new URL("../src/file-links.tsx", import.meta.url)), external: id => !id.startsWith(".") && !id.startsWith("/"), transform: { jsx: "react-jsx" } });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { value: new URL("https://casm.example/h/local"), configurable: true });
  try {
    const file = join(dir, "links.mjs");
    await bundle.write({ file, format: "esm", codeSplitting: false });
    const { MarkdownLink, FileLinksContext } = await import(pathToFileURL(file).href);
    const render = (href: string) => renderToStaticMarkup(createElement(FileLinksContext.Provider, { value: { roots: ["/project"], open() {} } }, createElement(MarkdownLink, { href }, "Link")));
    for (const href of ["https://developers.google.com/tag-platform/tag-manager/server-side/dependency-serving?option=sgtm", "http://other.example", "//other.example/path", "mailto:hello@example.com", "https://casm.example:444/path"]) {
      assert.match(render(href), /target="_blank"/);
      assert.match(render(href), /rel="noopener noreferrer"/);
    }
    for (const href of ["/h/local/agent", "/f/project/AGENTS.md", "/project/AGENTS.md", "https://casm.example/h/local", "//casm.example/h/local", "#heading", "relative-path"]) {
      assert.doesNotMatch(render(href), /target=|rel=/);
    }
    assert.match(render("/project/AGENTS.md"), /class="file-link" href="\/f\/project\/AGENTS.md"/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else Reflect.deleteProperty(globalThis, "location");
    await bundle.close();
    await rm(dir, { recursive: true, force: true });
  }
});
