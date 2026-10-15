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

test("file references: a line suffix is parsed, real colons in names are kept", async () => {
  const dir = await mkdtemp(fileURLToPath(new URL(".link-render-", import.meta.url)));
  const bundle = await rolldown({ input: fileURLToPath(new URL("../src/file-links.tsx", import.meta.url)), external: id => !id.startsWith(".") && !id.startsWith("/"), transform: { jsx: "react-jsx" } });
  try {
    const file = join(dir, "links.mjs");
    await bundle.write({ file, format: "esm", codeSplitting: false });
    const { splitLine, findPaths, pathFromHref, fileHref } = await import(pathToFileURL(file).href);
    assert.deepEqual(splitLine("/p/a.ts:123"), { path: "/p/a.ts", line: 123 });
    assert.deepEqual(splitLine("/p/a.ts:123:45"), { path: "/p/a.ts", line: 123 });
    assert.deepEqual(splitLine("/p/a.ts#L7"), { path: "/p/a.ts", line: 7 });
    assert.deepEqual(splitLine("/p/a.ts#L7-L9"), { path: "/p/a.ts", line: 7 });
    assert.deepEqual(splitLine("/p/a.ts"), { path: "/p/a.ts" });
    for (const odd of ["/p/a:b", "/p/a:12x", "/p/a:1:2:3", "/p/a:0", "/p/a#L", "/p/a#x12", "/p/dir:12/"]) assert.deepEqual(splitLine(odd), { path: odd }, odd);
    const found = (text: string) => findPaths(text, ["/p"]).map(f => f.path);
    assert.deepEqual(found("see /p/a.ts:12:3, then /p/b.ts#L4. and /p/c.ts:9."), ["/p/a.ts:12:3", "/p/b.ts#L4", "/p/c.ts:9"]);
    assert.deepEqual(found("/p/a.ts:12abc and /p/x:y"), ["/p/a.ts", "/p/x"]);
    assert.deepEqual(found("/other/a.ts:12"), []);
    assert.equal(pathFromHref(fileHref("/p/a.ts#L7")), "/p/a.ts#L7");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
