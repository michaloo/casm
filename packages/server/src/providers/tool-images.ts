import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { ImageData } from "@casm/protocol";

const MAX_BYTES = 1024 * 1024;
const MAX_BASE64 = 4 * Math.ceil(MAX_BYTES / 3);

function rasterType(bytes: Buffer): string | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 13 && /^(GIF87a|GIF89a)$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 16 && bytes.toString("ascii", 4, 8) === "ftyp" && /^(avif|avis)$/.test(bytes.toString("ascii", 8, 12))) return "image/avif";
}

// Only used for the path emitted by a native Codex imageView item. No URL route.
export function viewedImage(path: unknown): ImageData | undefined {
  if (typeof path !== "string" || !path) return;
  let fd: number | undefined;
  try {
    // Nonblocking open avoids hanging on a FIFO; fstat checks the opened file.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || !stat.size) return;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) return;
      offset += count;
    }
    if (fstatSync(fd).size !== stat.size) return;
    const mediaType = rasterType(bytes);
    return mediaType ? { mediaType, data: bytes.toString("base64") } : undefined;
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Native MCP, Claude, Pi and Codex dynamic-tool inline content. Never fetch URLs.
export function toolImages(content: unknown): { images?: ImageData[] } {
  const images: ImageData[] = [];
  let total = 0;
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== "object") continue;
    let data: unknown;
    if (block.type === "image") data = block.source?.type === "base64" ? block.source.data : block.data;
    const url = block.type === "inputImage" ? block.imageUrl : block.type === "file" ? block.url : undefined;
    if (typeof url === "string") data = /^data:image\/[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(url)?.[1];
    if (typeof data !== "string" || !data || data.length > MAX_BASE64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) continue;
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_BYTES || total + bytes.length > MAX_BYTES) continue;
    const mediaType = rasterType(bytes);
    if (!mediaType) continue;
    images.push({ mediaType, data });
    total += bytes.length;
  }
  return images.length ? { images } : {};
}
