import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appShellWorker } from "../pwa-build.ts";

test("shell version tracks asset and manifest changes, excluding unrelated public data", () => {
  const root = mkdtempSync(join(tmpdir(), "casm-pwa-build-"));
  try {
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "shell");
    writeFileSync(join(root, "manifest.webmanifest"), '{"name":"casm"}');
    writeFileSync(join(root, "assets/app.js"), "app v1");
    writeFileSync(join(root, "private.json"), "never offline");
    // Exercise the build hooks without starting Vite or changing real output.
    const plugin = appShellWorker() as any;
    plugin.configResolved({ root, build: { outDir: "." } });
    const build = () => {
      plugin.closeBundle();
      return readFileSync(join(root, "sw.js"), "utf8");
    };
    const first = build();
    assert.match(first, /casm-shell-[0-9a-f]{20}/);
    assert.match(first, /"\/assets\/app.js"/);
    assert.doesNotMatch(first, /private.json|"\/sw.js"|__CASM_/);
    assert.equal(build(), first);
    writeFileSync(join(root, "private.json"), "changed private data");
    assert.equal(build(), first);
    writeFileSync(join(root, "assets/app.js"), "app v2");
    const second = build();
    assert.notEqual(second, first);
    writeFileSync(join(root, "manifest.webmanifest"), '{"name":"new name"}');
    assert.notEqual(build(), second);
    writeFileSync(join(root, "icon-192.png"), "old icon");
    const iconVersion = build();
    writeFileSync(join(root, "icon-192.png"), "full-bleed icon");
    assert.notEqual(build(), iconVersion);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
