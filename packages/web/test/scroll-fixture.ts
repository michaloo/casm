// A long transcript mixing every row kind, for scrolling up through it.
import { deflateSync, crc32 } from "node:zlib";
import type { Item } from "@casm/protocol";

// A real width × height PNG, so images take their size only once decoded.
function png(width: number, height: number, hue: number) {
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
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rows.set([hue, (x * 255) / width, (y * 255) / height], y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

export function scrollItems(rounds = 45): Item[] {
  const wide = png(640, 400, 120), tall = png(200, 360, 40);
  const items: Item[] = [];
  let t = Date.UTC(2026, 9, 14, 8, 0, 0);
  const at = () => new Date((t += 23_000)).toISOString();
  for (let r = 0; r < rounds; r++) {
    items.push({ kind: "user", id: `s-user-${r}`, at: at(), text: `Round ${r}: check the layout and report.${r % 3 ? "" : "\n\nWith a second paragraph\nand a line break."}`, ...(r % 4 === 1 ? { images: [{ mediaType: "image/png", data: wide }, { mediaType: "image/png", data: tall }] } : {}) });
    items.push({ kind: "reasoning", id: `s-think-${r}`, at: at(), text: `Thinking about round ${r}. ` + "Weighing the options carefully. ".repeat(3 + (r % 5)) });
    items.push({ kind: "tool", id: `s-bash-${r}`, at: at(), name: "Bash", status: r % 7 === 3 ? "error" : "done", input: { command: `npm test -- --grep round-${r}`, description: "Run the round's checks" }, output: Array.from({ length: 4 + (r % 9) * 3 }, (_, i) => `  ✓ ${i} check passed for round ${r}`).join("\n") });
    if (r % 3 === 0) items.push({ kind: "tool", id: `s-casm-${r}`, at: at(), name: "Bash", status: "done", input: { command: `casm send 4983919b "Round ${r} is **done**. Rebase \`main\` and:\n\n- keep the styling\n- run the specs"`, description: "Message main agent" }, output: "" });
    if (r % 5 === 2) items.push({ kind: "tool", id: `s-shot-${r}`, at: at(), name: "Read", status: "done", input: { file_path: `/tmp/shot-${r}.png` }, output: "", images: [{ mediaType: "image/png", data: wide }] });
    if (r % 6 === 4) items.push({ kind: "plan", id: `s-plan-${r}`, at: at(), entries: [{ text: "Measure", status: "completed" }, { text: "Fix", status: "in_progress" }, { text: "Verify", status: "pending" }] });
    if (r % 8 === 5) items.push({ kind: "notice", id: `s-notice-${r}`, at: at(), text: "Reconnected. The transcript is up to date.", level: "info" });
    items.push({
      kind: "assistant",
      id: `s-reply-${r}`,
      at: at(),
      text: `## Round ${r}\n\nThe layout holds. ${"A sentence that wraps across the column. ".repeat(2 + (r % 6))}\n\n- first point\n- second point with \`code\`\n\n` +
        (r % 2 ? "```typescript\n" + Array.from({ length: 3 + (r % 10) }, (_, i) => `const value${i} = compute(${i}, "round ${r}");`).join("\n") + "\n```\n\n" : "") +
        (r % 4 === 3 ? "| Column | Value |\n| --- | --- |\n| width | 1440 |\n| height | 900 |\n\n" : "") +
        "Done.",
    });
  }
  return items;
}
