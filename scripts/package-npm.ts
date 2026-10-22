// Build a standalone npm package; no private workspace packages are published.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "dist/npm");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packages = ["cli", "client", "protocol", "server"];
const aliases = new Map<string, string>();
const dependencies: Record<string, string> = {};
for (const name of packages) {
  const base = join(root, "packages", name);
  const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
  for (const [key, value] of Object.entries(pkg.exports ?? {}))
    aliases.set(pkg.name + (key === "." ? "" : key.slice(1)), resolve(base, value as string));
  for (const [key, value] of Object.entries(pkg.dependencies ?? {})) {
    if (key.startsWith("@casm/")) continue;
    if (dependencies[key] && dependencies[key] !== value) throw new Error(`Conflicting dependency: ${key}`);
    dependencies[key] = value as string;
  }
}

execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
function compile(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) { compile(file); continue; }
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) throw new Error(`Unexpected runtime file: ${file}`);
    const target = join(out, relative(root, file).replace(/\.ts$/, ".js"));
    const js = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" })
      // Runtime module specifiers and the two provider helper paths. Preserve
      // the source layout so import.meta-relative asset paths still work.
      .replace(/(["'])(@casm\/[^"'\n]+|\.\.?\/[^"'\n]+\.ts)\1/g, (_all, quote: string, spec: string) => {
        if (!spec.startsWith("@casm/")) return quote + spec.replace(/\.ts$/, ".js") + quote;
        const source = aliases.get(spec);
        if (!source) throw new Error(`Unknown workspace import: ${spec} in ${file}`);
        let path = relative(dirname(file), source).split(sep).join("/").replace(/\.ts$/, ".js");
        if (!path.startsWith(".")) path = "./" + path;
        return quote + path + quote;
      });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, js);
  }
}
for (const name of packages) compile(join(root, "packages", name, "src"));
cpSync(join(root, "packages/web/dist"), join(out, "packages/web/dist"), { recursive: true });
for (const file of ["README.md", "LICENSE", "scripts/service.sh", "scripts/npm-launcher.mjs"]) {
  const target = join(out, file === "scripts/npm-launcher.mjs" ? "bin/casm.mjs" : file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, file), target);
}
// README links and screenshots work on npm as well as in the installed tree.
cpSync(join(root, "docs"), join(out, "docs"), { recursive: true });
cpSync(join(root, "spec"), join(out, "spec"), { recursive: true });
chmodSync(join(out, "bin/casm.mjs"), 0o755);
chmodSync(join(out, "scripts/service.sh"), 0o755);
writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "casm-cli",
  version: manifest.version,
  description: "Self-hosted coding-agent orchestrator: Claude Code, Codex, OpenCode and pi, with a web app and CLI",
  type: "module",
  bin: { casm: "bin/casm.mjs" },
  engines: { node: ">=24" },
  os: ["linux", "darwin"],
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/michaloo/casm.git" },
  homepage: "https://github.com/michaloo/casm#readme",
  bugs: { url: "https://github.com/michaloo/casm/issues" },
  keywords: ["claude-code", "codex", "opencode", "pi", "agents", "orchestration", "pwa", "cli"],
  files: ["bin", "packages", "scripts/service.sh", "docs", "spec", "README.md", "LICENSE"],
  dependencies,
}, null, 2) + "\n");
console.log(`Ready to pack: ${out}`);
