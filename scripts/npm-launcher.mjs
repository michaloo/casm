#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("casm requires Node.js 24 or newer.");
  process.exit(1);
}
const command = process.argv[2];
if (command === "--version" || command === "-v" || command === "version") {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
} else if (command === "service") {
  const child = spawnSync("bash", [fileURLToPath(new URL("../scripts/service.sh", import.meta.url)), ...process.argv.slice(3)], {
    stdio: "inherit",
    env: { ...process.env, CASM_NODE_BIN: process.execPath },
  });
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
} else {
  await import("../packages/cli/src/main.js");
}
