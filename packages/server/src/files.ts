// Read-only access to files inside project folders: directory listings, text
// previews, and short-lived signed download links served at GET /dl/<token>.
// A link carries no client token; it is an HMAC (with a secret kept in
// $CASM_HOME) over one path and an expiry. Links to a peer's file wrap the
// peer's own link, so the download streams through this server.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { ErrorCode, type FileContent, type FileEntry, type FileType, type Project, type Result } from "@casm/protocol";
import { RpcError } from "./agents.ts";
import type { Store, StoredPeer } from "./db.ts";
import type { PeerPool } from "./peers.ts";

export const LINK_TTL_MS = 5 * 60_000;
export const MAX_READ_BYTES = 1024 * 1024;
const SECRET_FILE = "download-secret";

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/x-typescript",
  ".tsx": "text/x-typescript",
  ".jsx": "text/javascript",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/plain",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
};
export const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
// Shown in the page rather than downloaded. SVG is safe there only because
// every /dl response is sandboxed by its Content-Security-Policy.
const INLINE = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml)$/;
const TEXTUAL = /^text\/|^application\/(json|x-ndjson|xml)$|^image\/svg\+xml$/;

const inside = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const typeOf = (s: { isFile(): boolean; isDirectory(): boolean }): FileType => (s.isFile() ? "file" : s.isDirectory() ? "dir" : "other");

type LinkPayload = { p: string; n: string; e: number; i?: boolean; h?: string; t?: string };

// The ASCII fallback first, then the exact name (RFC 6266 / 5987).
export function contentDisposition(kind: "attachment" | "inline", name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${exact}`;
}

// Binary when it has a NUL byte or isn't UTF-8. A cut-off read may end inside
// a character, so up to 3 trailing bytes are dropped before deciding.
function decodeText(buf: Buffer, truncated: boolean): string | null {
  if (buf.subarray(0, 8192).includes(0)) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let cut = 0; cut <= (truncated ? 3 : 0); cut++) {
    try {
      return decoder.decode(buf.subarray(0, buf.length - cut));
    } catch {}
  }
  return null;
}

export class Files {
  private secret: Buffer;
  private store: Store;
  private peers: PeerPool;
  private ttlMs: number;
  private now: () => number;

  constructor(opts: { store: Store; peers: PeerPool; home?: string; ttlMs?: number; now?: () => number }) {
    this.store = opts.store;
    this.peers = opts.peers;
    this.ttlMs = opts.ttlMs ?? LINK_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.secret = opts.home ? loadSecret(join(opts.home, SECRET_FILE)) : randomBytes(32);
  }

  // The project folder `path` is in, refusing paths outside every project
  // before looking at the disk (so they don't reveal what exists), then
  // following symlinks and ".." and checking again.
  async resolve(path: string): Promise<{ real: string; project: Project; root: string }> {
    if (!isAbsolute(path)) throw new RpcError(ErrorCode.InvalidParams, `the path must be absolute: ${path}`);
    const wanted = resolve(path);
    const roots: { project: Project; given: string; real: string }[] = [];
    for (const project of this.store.listProjects(true)) {
      const real = await realpath(project.path).catch(() => null);
      if (real) roots.push({ project, given: resolve(project.path), real });
    }
    if (!roots.some((r) => inside(r.given, wanted) || inside(r.real, wanted)))
      throw new RpcError(ErrorCode.InvalidParams, `${path} is not inside a project folder on this host`);
    const real = await realpath(wanted).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") throw new RpcError(ErrorCode.NotFound, `no such file or directory: ${path}`);
      throw new RpcError(ErrorCode.InvalidParams, `cannot open ${path}: ${e.code ?? e.message}`);
    });
    // The deepest project wins when folders nest.
    const match = roots.filter((r) => inside(r.real, real)).sort((a, b) => b.real.length - a.real.length)[0];
    if (!match) throw new RpcError(ErrorCode.InvalidParams, `${path} resolves to ${real}, outside every project folder on this host`);
    return { real, project: match.project, root: match.real };
  }

  async list(p: { projectId?: string; path?: string; dir?: string }): Promise<Result<"fs.list">> {
    let dir: string;
    if (p.projectId) {
      const project = this.store.getProject(p.projectId);
      if (!project) throw new RpcError(ErrorCode.NotFound, `project ${p.projectId} not found`);
      dir = resolve(project.path, p.dir ?? p.path ?? ".");
    } else {
      dir = p.path ?? p.dir ?? "";
      if (!isAbsolute(dir)) throw new RpcError(ErrorCode.InvalidParams, "give a projectId, or an absolute path");
      dir = resolve(dir);
    }
    const { real, project } = await this.resolve(dir);
    if (!(await stat(real)).isDirectory()) throw new RpcError(ErrorCode.InvalidParams, `not a directory: ${dir}`);
    const entries: FileEntry[] = [];
    for (const d of await readdir(real, { withFileTypes: true })) {
      const full = join(real, d.name);
      const link = await lstat(full).catch(() => null);
      if (!link) continue;
      const target = link.isSymbolicLink() ? await stat(full).catch(() => null) : link;
      entries.push({
        name: d.name,
        type: target ? typeOf(target) : "other",
        size: target?.isFile() ? target.size : 0,
        mtime: (target ?? link).mtime.toISOString(),
        hidden: d.name.startsWith("."),
        ...(link.isSymbolicLink() ? { symlink: true } : {}),
      });
    }
    entries.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
    return { projectId: project.id, root: project.path, dir, entries };
  }

  async read(p: { path: string; maxBytes?: number }): Promise<FileContent> {
    const { real, project } = await this.resolve(p.path);
    const st = await stat(real);
    const mime = st.isDirectory() ? "inode/directory" : mimeOf(real);
    const info = { path: resolve(p.path), projectId: project.id, type: typeOf(st), size: st.isFile() ? st.size : 0, mtime: st.mtime.toISOString(), mime };
    // Raster images are only ever shown through a download link.
    if (!st.isFile() || (mime.startsWith("image/") && !TEXTUAL.test(mime)))
      return { ...info, binary: st.isFile(), truncated: false, content: null };
    const max = Math.min(p.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES);
    const fh = await open(real, "r");
    try {
      const buf = Buffer.alloc(Math.min(st.size, max));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const truncated = st.size > bytesRead;
      const content = decodeText(buf.subarray(0, bytesRead), truncated);
      return { ...info, binary: content === null, truncated: content !== null && truncated, content };
    } finally {
      await fh.close();
    }
  }

  async link(p: { path: string; inline?: boolean }): Promise<Result<"fs.downloadLink">> {
    const { real } = await this.resolve(p.path);
    const st = await stat(real);
    if (!st.isFile()) throw new RpcError(ErrorCode.InvalidParams, `not a file: ${p.path}`);
    const name = basename(resolve(p.path));
    return this.sign({ p: real, n: name, e: this.now() + this.ttlMs, ...(p.inline ? { i: true } : {}) }, st.size);
  }

  // A peer's link (from its fs.downloadLink) re-signed here, so the client only
  // ever talks to the server it is connected to.
  proxyLink(peer: StoredPeer, path: string, inline: boolean | undefined, theirs: Result<"fs.downloadLink">): Result<"fs.downloadLink"> {
    const token = theirs.url.replace(/^.*\/dl\//, "");
    const e = Math.min(Date.parse(theirs.expiresAt) || 0, this.now() + this.ttlMs);
    return this.sign({ p: path, n: theirs.name, e, h: peer.name, t: token, ...(inline ? { i: true } : {}) }, theirs.size);
  }

  private sign(payload: LinkPayload, size: number): Result<"fs.downloadLink"> {
    const body = b64(JSON.stringify(payload));
    const mac = b64(createHmac("sha256", this.secret).update(body).digest());
    return { url: `/dl/${body}.${mac}`, name: payload.n, size, expiresAt: new Date(payload.e).toISOString() };
  }

  private verify(token: string): LinkPayload | string {
    const [body, mac, extra] = token.split(".");
    if (!body || !mac || extra !== undefined) return "invalid download link";
    const want = createHmac("sha256", this.secret).update(body).digest();
    const got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return "invalid download link";
    let payload: LinkPayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return "invalid download link";
    }
    if (typeof payload.e !== "number" || payload.e < this.now()) return "this download link has expired; open the file again for a new one";
    return payload;
  }

  // GET|HEAD /dl/<token>. True when it answered the request.
  serve(req: IncomingMessage, res: ServerResponse, log: (msg: string) => void): boolean {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/dl/")) return false;
    void this.respond(req, res, url.pathname.slice(4)).catch((e) => {
      log(`download failed: ${e instanceof Error ? e.message : e}`);
      if (!res.headersSent) text(res, 500, "download failed");
      else res.destroy();
    });
    return true;
  }

  private async respond(req: IncomingMessage, res: ServerResponse, token: string) {
    if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "method not allowed", { allow: "GET, HEAD" });
    const payload = this.verify(token);
    if (typeof payload === "string") return text(res, 403, payload);
    if (payload.h) return this.relay(req, res, payload);
    let real: string;
    try {
      ({ real } = await this.resolve(payload.p));
    } catch (e) {
      return text(res, e instanceof RpcError && e.code === ErrorCode.NotFound ? 404 : 403, e instanceof Error ? e.message : String(e));
    }
    const st = await stat(real);
    if (!st.isFile()) return text(res, 404, "not a file");
    const mime = mimeOf(payload.n);
    const inline = !!payload.i && INLINE.test(mime);
    res.writeHead(200, {
      ...SAFE_HEADERS,
      "content-type": TEXTUAL.test(mime) ? `${mime}; charset=utf-8` : mime,
      "content-length": st.size,
      "content-disposition": contentDisposition(inline ? "inline" : "attachment", payload.n),
      "last-modified": st.mtime.toUTCString(),
    });
    if (req.method === "HEAD") return void res.end();
    const stream = createReadStream(real);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  // Streams a peer's file: its own signed link, fetched over HTTP from the
  // address this server already uses for it.
  private async relay(req: IncomingMessage, res: ServerResponse, payload: LinkPayload) {
    const peer = this.peers.find(payload.h!);
    if (!peer) return text(res, 404, `unknown host "${payload.h}"`);
    const url = new URL(peer.url);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = `/dl/${payload.t}`;
    url.search = "";
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    let upstream: Response;
    try {
      upstream = await fetch(url, { method: req.method, signal: abort.signal, redirect: "error" });
    } catch (e) {
      return text(res, 502, `host "${peer.name}" is unreachable (${e instanceof Error ? e.message : e})`);
    }
    const headers: Record<string, string> = { ...SAFE_HEADERS };
    for (const h of ["content-type", "content-length", "content-disposition", "last-modified"]) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(upstream.status, headers);
    if (!upstream.body || req.method === "HEAD") return void res.end();
    const body = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
    body.on("error", () => res.destroy());
    body.pipe(res);
  }
}

// Nothing served here may run script or be cached by shared caches.
const SAFE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  "referrer-policy": "no-referrer",
};

function text(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...SAFE_HEADERS, "content-type": "text/plain; charset=utf-8", ...extra }).end(`casm: ${message}\n`);
}

// Created once, readable only by this user; a new one invalidates old links.
function loadSecret(file: string): Buffer {
  const read = () => {
    const secret = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    if (secret.length < 32) throw new Error(`${file} is damaged; delete it to make a new one`);
    return secret;
  };
  try {
    return read();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return read();
}
