import { test } from "node:test";
import assert from "node:assert/strict";
import { fileHref, insideRoot, pathFromHref } from "../src/file-paths.ts";

test("file links round-trip Windows drives, UNC, spaces, Unicode and line suffixes", () => {
  for (const path of ["C:\\Users\\Name\\my project\\zażółć.ts:12", "D:/project/file.ts#L7", "\\\\server\\share\\folder\\file.txt", "/home/user/a b.ts#L4"]) {
    const href = fileHref(path);
    assert.equal(pathFromHref(href), path);
    assert.equal(new URL(href, "https://casm.example").pathname, href);
  }
  assert.equal(pathFromHref("/f/%ZZ"), null);
  assert.equal(pathFromHref("/other/path"), null);
});

test("link matching uses Windows case and separator rules without matching sibling folders", () => {
  assert.ok(insideRoot("c:/PROJECT/file.ts", ["C:\\project"]));
  assert.ok(insideRoot("\\\\SERVER\\share\\file.txt", ["\\\\server\\share"]));
  assert.ok(!insideRoot("C:\\project-other\\file.ts", ["C:\\project"]));
  assert.ok(!insideRoot("D:\\project\\file.ts", ["C:\\project"]));
  assert.ok(insideRoot("/Home/User/file", ["C:\\project", "/Home/User"]));
  assert.ok(!insideRoot("/home/user/file", ["/Home/User"]));
});
