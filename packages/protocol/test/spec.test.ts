import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("spec/protocol.json is up to date with the zod schemas", () => {
  const file = new URL("../../../spec/protocol.json", import.meta.url);
  const before = readFileSync(file, "utf8");
  execFileSync(process.execPath, [new URL("../scripts/export-schema.ts", import.meta.url).pathname]);
  assert.equal(readFileSync(file, "utf8"), before, 'run "npm run schema" and commit spec/protocol.json');
});
