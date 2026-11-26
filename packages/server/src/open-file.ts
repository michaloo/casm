import { execFile } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const DOCUMENTS = new Set([
  ".txt", ".md", ".markdown", ".log", ".csv", ".tsv", ".json", ".xml",
  ".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".rtf", ".html", ".htm",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff",
  ".mp3", ".wav", ".ogg", ".flac", ".mp4", ".webm", ".mov",
]);
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type TailscaleDesktop = { origin: string; addresses: () => ReadonlySet<string> };

// Enable only for a loopback-bound CASM behind Tailscale Serve. Serve
// replaces forwarding headers with the authenticated connection's source.
export function tailscaleDesktop(origin: unknown, listenHost: string): TailscaleDesktop | undefined {
  if (typeof origin !== "string" || !(LOOPBACK.has(listenHost) || listenHost === "localhost")) return;
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== "https:" || !url.hostname.endsWith(".ts.net")) return;
    return { origin, addresses: () => new Set(
      (networkInterfaces().Tailscale ?? []).filter(address => !address.internal).map(address => address.address),
    ) };
  } catch { /* Invalid configuration leaves proxy access disabled. */ }
}

export function localDesktopRequest(req: {
  headers: IncomingMessage["headers"];
  socket: Pick<IncomingMessage["socket"], "remoteAddress" | "localPort">;
}, tailscale?: TailscaleDesktop) {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "") || !req.headers.origin || !req.headers.host) return false;
  try {
    const origin = new URL(req.headers.origin);
    const forwardedFor = req.headers["x-forwarded-for"];
    if (tailscale && origin.origin === tailscale.origin && req.headers.origin === tailscale.origin) {
      return origin.host === req.headers.host &&
        req.headers["x-forwarded-host"] === origin.host &&
        req.headers["x-forwarded-proto"] === "https" &&
        !req.headers.forwarded && !req.headers["tailscale-funnel-request"] &&
        typeof forwardedFor === "string" && tailscale.addresses().has(forwardedFor);
    }
    const port = Number(origin.port || (origin.protocol === "https:" ? 443 : 80));
    return (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.origin === req.headers.origin &&
      origin.host === req.headers.host &&
      port === req.socket.localPort &&
      LOCAL_HOSTS.has(origin.hostname) &&
      !req.headers.forwarded && !req.headers["x-forwarded-for"] && !req.headers["x-forwarded-host"];
  } catch {
    return false;
  }
}

export function canOpenDesktopFile(path: string) {
  // Resolved local drive paths only. This excludes UNC/device paths and
  // alternate data streams, even when Windows could resolve them.
  return /^[a-z]:\\[^:]+$/iu.test(path) &&
    DOCUMENTS.has(extname(path).toLowerCase());
}

const exec = promisify(execFile);
export async function openDesktopFile(path: string) {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // The document path is data in the environment. ShellExecute uses the
  // user's registered Open verb, and never parses the path as shell code.
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {",
    "  $scheduler = New-Object -ComObject 'Schedule.Service'",
    "  $scheduler.Connect()",
    "  $task = $scheduler.GetFolder('\\').GetTask('CASM Open Document')",
    "  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($env:CASM_OPEN_DOCUMENT))",
    "  [void]$task.Run($encoded)",
    "  return",
    "}",
    "$start = New-Object System.Diagnostics.ProcessStartInfo",
    "$start.FileName = $env:CASM_OPEN_DOCUMENT",
    "$env:CASM_OPEN_DOCUMENT = $null",
    "$start.UseShellExecute = $true",
    "[void][System.Diagnostics.Process]::Start($start)",
  ].join("\n");
  const env: NodeJS.ProcessEnv = { SystemRoot: root, WINDIR: root, CASM_OPEN_DOCUMENT: path };
  for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATH"])
    if (process.env[key]) env[key] = process.env[key];
  await exec(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { env, windowsHide: true, timeout: 10_000 });
}
