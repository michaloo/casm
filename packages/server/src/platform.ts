import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

/** Re-resolve desktop bundles for each session: updates can remove old helpers. */
export function codexExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.CASM_CODEX_BIN_DIR;
  if (!root) return env.CASM_CODEX_PATH ?? "codex";
  const candidates: { path: string; modified: number }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "codex.exe");
    try {
      const binary = statSync(path);
      const helper = statSync(join(root, entry.name, "codex-code-mode-host.exe"));
      if (binary.isFile() && binary.size > 0 && helper.isFile() && helper.size > 0)
        candidates.push({ path, modified: binary.mtimeMs });
    } catch { /* Incomplete or removed desktop bundle. */ }
  }
  candidates.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
  if (!candidates.length) throw new Error("No complete Codex desktop bundle found. Finish updating the desktop app; codex.exe and codex-code-mode-host.exe must be installed together.");
  return candidates[0].path;
}

/** Resolve a program without starting a shell, including Windows PATHEXT. */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const windows = process.platform === "win32";
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path");
  const dirs = isAbsolute(command) || /[\\/]/.test(command) ? [""] : (env[pathKey ?? "PATH"] ?? "").split(delimiter).filter(Boolean);
  const extensions = windows && !extname(command) ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of dirs) for (const extension of extensions) {
    const file = dir ? join(dir.replace(/^"|"$/g, ""), command + extension) : command + extension;
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, windows ? constants.F_OK : constants.X_OK);
      return file;
    } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}

/** Explicit user shell commands use the native shell; agent tools choose their own. */
export function shellCommand(command: string, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  if (process.platform === "win32") return ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]];
  const shell = env.SHELL;
  return [shell && /\/(?:ba|z|k|da)?sh$/.test(shell) ? shell : "/bin/bash", ["-c", command]];
}

const stopping = new WeakSet<ChildProcess>();

export function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    if (proc.exitCode !== null || proc.signalCode !== null || stopping.has(proc)) return;
    stopping.add(proc);
    // taskkill can take seconds. Never block HTTP/WebSocket traffic while
    // cleaning up a transcript reader or a provider's process tree.
    const killer = spawn("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => { try { proc.kill(signal); } catch { /* Already gone. */ } });
    killer.unref();
  } else {
    try { process.kill(-proc.pid, signal); } catch { /* Already gone. */ }
  }
}

/** Windows npm shims have a cmd.exe parent; stop their children as well. */
export function stopProcess(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") killProcessTree(proc, signal);
  else proc.kill(signal);
}
