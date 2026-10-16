// A heavy workspace for memory measurements: about 40 agents across several
// projects, some with thousands of items, big tool outputs and inline images.
import { deflateSync, crc32 } from "node:zlib";
import type { Item } from "@casm/protocol";
import { scrollItems } from "./scroll-fixture.ts";

// A noisy PNG compresses badly, like a real screenshot: ~width*height*3 bytes.
function noisePng(width: number, height: number, seed: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  let s = seed * 2654435761 >>> 0;
  for (let i = 0; i < rows.length; i++) {
    if (i % (width * 3 + 1) === 0) continue;
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    rows[i] = s >>> 24;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

// Long transcripts: the scroll fixture's rounds plus big outputs, screenshots
// in tool results and user messages, and casm rows.
export function heavyItems(rounds: number, seed: number): Item[] {
  const shots = Array.from({ length: 3 }, (_, i) => noisePng(360, 240, seed * 10 + i));
  const items: Item[] = [];
  for (const item of scrollItems(rounds)) {
    const r = Number(item.id.split("-").at(-1));
    const id = `${item.id}-${seed}`;
    if (item.kind === "tool" && item.images) items.push({ ...item, id, images: [{ mediaType: "image/png", data: shots[r % 3] }] });
    else if (item.kind === "user" && item.images) items.push({ ...item, id, images: [{ mediaType: "image/png", data: shots[(r + 1) % 3] }] });
    else if (item.kind === "tool" && r % 4 === 0) items.push({ ...item, id, output: Array.from({ length: 1500 }, (_, i) => `${String(i).padStart(5)} | log line for round ${r} with some details ${"x".repeat(20)}`).join("\n") });
    else items.push({ ...item, id });
  }
  return items;
}

export type Seeded = { project: string; agents: { name: string; history: Item[] }[] };
export function memoryWorkspace(): Seeded[] {
  return ["Alpha", "Beta", "Gamma", "Delta"].map((project, p) => ({
    project: `Memory ${project}`,
    agents: Array.from({ length: 10 }, (_, a) => {
      const n = p * 10 + a;
      // Every fifth agent has thousands of items; the rest a few hundred.
      return { name: `Mem ${String(n).padStart(2, "0")}`, history: heavyItems(a % 5 === 0 ? 700 : 60, n) };
    }),
  }));
}
