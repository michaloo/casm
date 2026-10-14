import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { Plugin } from "vite";

// Public assets are explicitly named: adding an unrelated public file must not
// silently make it available offline. Vite's hashed bundle assets are shell-only.
const PUBLIC = new Set(["index.html", "manifest.webmanifest", "favicon.svg", "favicon.png", "apple-touch-icon.png",
  "icon-192.png", "icon-512.png", "icon-maskable-192.png", "icon-maskable-512.png"]);
export function appShellWorker(): Plugin {
  let output = "";
  return {
    name: "casm-app-shell-worker", apply: "build",
    configResolved(config) { output = resolve(config.root, config.build.outDir); },
    closeBundle() {
      const files = readdirSync(output, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
        .map(entry => relative(output, resolve(entry.parentPath, entry.name)).replaceAll("\\", "/"))
        .filter(path => PUBLIC.has(path) || /^assets\/.+\.(?:js|css|woff2|png|svg)$/.test(path)).sort();
      const template = readFileSync(new URL("./service-worker.js", import.meta.url), "utf8");
      const hash = createHash("sha256").update(template);
      for (const path of files) hash.update(path).update(readFileSync(resolve(output, path)));
      writeFileSync(resolve(output, "sw.js"), template.replace("__CASM_VERSION__", hash.digest("hex").slice(0, 20))
        .replace("__CASM_ASSETS__", JSON.stringify(files.map(path => `/${path}`))));
    },
  };
}
