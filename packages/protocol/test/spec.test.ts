import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("spec/protocol.json is up to date with the zod schemas", () => {
  const file = new URL("../../../spec/protocol.json", import.meta.url);
  const contents = () => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const before = contents();
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/export-schema.ts", import.meta.url))]);
  assert.equal(contents(), before, 'run "npm run schema" and commit spec/protocol.json');
});
