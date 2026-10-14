import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Item } from "@casm/protocol";
import { normalize as codex } from "../src/providers/codex.ts";
import { Normalizer, historyItems } from "../src/providers/claude.ts";
import { normalize as pi } from "../src/providers/pi.ts";
import { toolImages } from "../src/providers/tool-images.ts";

const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const image = { mediaType: "image/png", data };
const content = [{ type: "text", text: "A pixel" }, { type: "image", mimeType: "image/png", data }];
function check(item: unknown, id: string) {
  const parsed = Item.parse(item);
  assert.equal(parsed.id, id);
  assert.equal(parsed.kind, "tool");
  if (parsed.kind === "tool") assert.deepEqual(parsed.images, [image]);
}

test("Codex native imageView retains its ID live/history and reads only bounded regular raster files", () => {
  const dir = mkdtempSync(join(tmpdir(), "casm-tool-image-"));
  try {
    const path = join(dir, "pixel.png");
    writeFileSync(path, Buffer.from(data, "base64"));
    const raw = { type: "imageView", id: "view-1", path };
    check(codex(raw, true), "view-1");
    check(codex(raw), "view-1");
    const boundary = Buffer.alloc(1024 * 1024);
    Buffer.from(data, "base64").copy(boundary);
    writeFileSync(join(dir, "boundary.png"), boundary);
    const exact = codex({ ...raw, path: join(dir, "boundary.png") });
    assert.ok(exact?.kind === "tool" && exact.images?.[0].data);
    writeFileSync(join(dir, "large.png"), Buffer.concat([boundary, Buffer.from([0])]));
    writeFileSync(join(dir, "fake.png"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    symlinkSync(path, join(dir, "link.png"));
    execFileSync("mkfifo", [join(dir, "fifo.png")]);
    for (const name of ["missing.png", "large.png", "fake.png", "link.png", "fifo.png", ""]) {
      const item = codex({ ...raw, path: join(dir, name) });
      assert.ok(item?.kind === "tool");
      assert.equal(item.images, undefined, name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Codex MCP, dynamic and function outputs preserve inline images and IDs", () => {
  check(codex({ type: "mcpToolCall", id: "mcp", result: { content } }), "mcp");
  check(codex({ type: "dynamicToolCall", id: "dynamic", contentItems: [{ type: "inputImage", imageUrl: `data:image/png;base64,${data}` }] }), "dynamic");
  check(codex({ type: "functionCallOutput", id: "function", output: content }), "function");
});

test("Claude tool results preserve images and tool-use identity in live/history", () => {
  const entry = { type: "user", uuid: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }] } };
  check(new Normalizer().entry(entry)[0], "call");
  check(historyItems([entry])[0], "call");
});

test("Pi tool-result images use the tool call ID", () => {
  check(pi({ role: "toolResult", toolCallId: "pi-call", content }, new Map())[0], "pi-call");
});

test("inline extraction omits missing, external, malformed, nonraster and oversized data", () => {
  assert.deepEqual(toolImages([
    { type: "image", data: "%%%" }, { type: "image" },
    { type: "inputImage", imageUrl: "https://example.com/pixel.png" },
    { type: "image", data: Buffer.from("<svg/>").toString("base64") },
    { type: "image", data: "A".repeat(1400000) },
  ]), {});
  assert.deepEqual(toolImages(content), { images: [image] });
});
