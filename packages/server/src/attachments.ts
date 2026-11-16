// Files attached to messages. A client uploads each one in chunks into a
// staging folder ($CASM_HOME/uploads), then names the finished upload in
// agent.send or agent.create. Accepting that message moves the file into the
// root of the agent's project folder, never overwriting anything, and the
// message text gains a line saying where it is; the agent reads it with its
// own tools. Images a client sends inline (`images`) are not saved this way.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { copyFile, constants, link, open, rm, stat, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { ErrorCode, MAX_ATTACHMENT_BYTES, attachmentLine, formatBytes } from "@casm/protocol";
import { RpcError } from "./agents.ts";
import { mimeOf } from "./files.ts";

// Raw bytes per upload.chunk: as base64 in JSON well under the 16 MiB frame.
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const UPLOAD_TTL_MS = 60 * 60_000;
// Bytes of a saved name, extension included (file systems allow 255).
const MAX_NAME_BYTES = 200;

type Upload = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  received: number;
  staged: string;
  touched: number;
  // Once saved: the project folder and the line, so the same message sent
  // again (a lost response, a retry) gets the same file instead of a copy.
  saved?: { root: string; line: string };
};

// A file name safe to create in a folder: no directories, no "." or "..",
// no leading dots (hidden files) or control characters, a bounded length.
export function safeName(name: string): string {
  let base = name.split(/[\\/]/).pop() ?? "";
  base = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  if (!base) return "attachment";
  if (Buffer.byteLength(base) > MAX_NAME_BYTES) {
    const ext = extname(base);
    const keep = Buffer.byteLength(ext) < 20 ? ext : "";
    let stem = base.slice(0, base.length - keep.length);
    while (Buffer.byteLength(stem + keep) > MAX_NAME_BYTES) stem = stem.slice(0, -1);
    base = stem.trimEnd() + keep;
  }
  return base;
}

// "report.pdf", then "report (1).pdf", "report (2).pdf"... as browsers do.
export function numberedName(name: string, n: number): string {
  if (!n) return name;
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

const mediaTypeOf = (given: string | undefined, name: string) =>
  given && /^[\w.+-]+\/[\w.+-]+$/.test(given) ? given.toLowerCase() : mimeOf(name);

export class Uploads {
  private dir: string;
  private uploads = new Map<string, Upload>();
  private now: () => number;

  constructor(opts: { home?: string; now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    if (opts.home) {
      this.dir = join(opts.home, "uploads");
      // Left from before a restart: nothing can name those uploads any more.
      rmSync(this.dir, { recursive: true, force: true });
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } else this.dir = mkdtempSync(join(tmpdir(), "casm-uploads-"));
  }

  async start(p: { name: string; size: number; mediaType?: string }) {
    await this.expire();
    const name = safeName(p.name);
    if (p.size > MAX_ATTACHMENT_BYTES)
      throw new RpcError(ErrorCode.InvalidParams, `${name} is ${formatBytes(p.size)}, over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit for a file attachment`);
    const id = randomUUID();
    const staged = join(this.dir, id);
    await (await open(staged, "wx")).close();
    this.uploads.set(id, { id, name, mediaType: mediaTypeOf(p.mediaType, name), size: p.size, received: 0, staged, touched: this.now() });
    return { uploadId: id, chunkSize: CHUNK_BYTES };
  }

  async chunk(p: { uploadId: string; offset: number; data: string }) {
    const u = this.get(p.uploadId);
    if (u.saved) throw new RpcError(ErrorCode.Conflict, `${u.name} was already attached to a message`);
    const bytes = Buffer.from(p.data, "base64");
    if (bytes.length > CHUNK_BYTES) throw new RpcError(ErrorCode.InvalidParams, `a chunk can be at most ${CHUNK_BYTES} bytes`);
    // Resending the chunk that just arrived (a lost response) is harmless.
    if (p.offset + bytes.length === u.received && p.offset < u.received) return { received: u.received, size: u.size };
    if (p.offset !== u.received) throw new RpcError(ErrorCode.Conflict, `${u.name}: expected the chunk at offset ${u.received}, got ${p.offset}`);
    if (u.received + bytes.length > u.size) throw new RpcError(ErrorCode.InvalidParams, `${u.name} is longer than the ${u.size} bytes announced`);
    const f = await open(u.staged, "a");
    try {
      await f.write(bytes);
    } finally {
      await f.close();
    }
    u.received += bytes.length;
    u.touched = this.now();
    return { received: u.received, size: u.size };
  }

  // Checks the uploads are complete before anything is saved, so a message
  // with a missing one saves none of its files.
  check(ids: string[], root: string) {
    for (const id of ids) {
      const u = this.get(id);
      if (u.saved && u.saved.root !== root) throw new RpcError(ErrorCode.Conflict, `${u.name} was already attached to a message in another project`);
      if (!u.saved && u.received !== u.size)
        throw new RpcError(ErrorCode.InvalidParams, `${u.name} is not fully uploaded (${u.received} of ${u.size} bytes)`);
    }
  }

  // Moves each upload into `root` and returns the lines the message gains.
  async save(ids: string[], root: string): Promise<string[]> {
    this.check(ids, root);
    const lines: string[] = [];
    for (const id of ids) {
      const u = this.get(id);
      if (!u.saved) {
        const path = await place(u.staged, root, u.name);
        await rm(u.staged, { force: true });
        u.saved = { root, line: attachmentLine({ name: u.name, mediaType: u.mediaType, size: formatBytes(u.size), path }) };
      }
      u.touched = this.now();
      lines.push(u.saved.line);
    }
    return lines;
  }

  private get(id: string): Upload {
    const u = this.uploads.get(id);
    if (!u) throw new RpcError(ErrorCode.NotFound, `no upload ${id} (uploads expire an hour after their last use)`);
    return u;
  }

  private async expire() {
    const cutoff = this.now() - UPLOAD_TTL_MS;
    for (const u of [...this.uploads.values()])
      if (u.touched < cutoff) {
        this.uploads.delete(u.id);
        await rm(u.staged, { force: true });
      }
  }
}

// Claims the first free name in `root` without ever replacing a file: a hard
// link fails when the name exists. Across file systems it copies instead,
// which fails the same way.
async function place(staged: string, root: string, name: string): Promise<string> {
  if (!(await stat(root).catch(() => null))?.isDirectory())
    throw new RpcError(ErrorCode.InvalidParams, `the project folder does not exist on this host: ${root}`);
  for (let n = 0; n < 10_000; n++) {
    const target = join(root, numberedName(name, n));
    try {
      await link(staged, target);
      await unlink(staged);
      return target;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP") throw e;
    }
    try {
      await copyFile(staged, target, constants.COPYFILE_EXCL);
      return target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new RpcError(ErrorCode.Conflict, `no free name for ${name} in ${root}`);
}
