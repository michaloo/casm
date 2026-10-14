// Static files of the web client. Paths without a file extension get index.html
// (client-side routes). Hashed assets are cached for good; everything else is
// revalidated, so a rebuilt client shows up on the next load.
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function file(path: string): number | undefined {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

// True when it answered the request.
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    return false;
  }
  const rel = normalize(pathname).replace(/^([/\\])+/, "");
  if (rel.split(sep).includes("..")) return false;
  let path = join(root, rel);
  let size = rel ? file(path) : undefined;
  if (size === undefined) {
    if (extname(rel)) return false;
    path = join(root, "index.html");
    size = file(path);
    if (size === undefined) return false;
  }
  const immutable = rel.startsWith("assets/");
  res.writeHead(200, {
    "content-type": types[extname(path)] ?? "application/octet-stream",
    "content-length": size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(path).pipe(res);
  return true;
}
