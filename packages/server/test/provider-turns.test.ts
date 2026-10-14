import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piProvider } from "../src/providers/pi.ts";
import { claudeProvider } from "../src/providers/claude.ts";
import type { ProviderEvent, ProviderSession } from "../src/providers/types.ts";

for (const kind of ["pi", "claude"] as const) {
  test(`${kind} does not end the successor on a delayed prior response`, { timeout: 10000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "casm-turn-owner-"));
    const binary = join(dir, "fake.cjs");
    const variable = kind === "pi" ? "CASM_PI_PATH" : "CASM_CLAUDE_PATH";
    const previous = process.env[variable];
    writeFileSync(binary, `#!${process.execPath}
const write = m => process.stdout.write(JSON.stringify(m) + '\\n');
let first;
const result = {type:'result',subtype:'success',uuid:'result-1',session_id:'session',is_error:false,result:'ok',total_cost_usd:0,modelUsage:{}};
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') return write({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
  if (m.type === 'get_state') return write({type:'response',id:m.id,success:true,data:{}});
  if (m.type !== '${kind === "pi" ? "prompt" : "user"}') return;
  if (!first) {
    first = m;
    write(${kind === "pi" ? "{type:'agent_settled'}" : "result"});
  } else {
    write(${kind === "pi" ? "{type:'response',id:first.id,success:true,data:{disposition:'handled'}}" : "result"});
    setTimeout(() => write(${kind === "pi" ? "{type:'extension_ui_request',method:'notify',id:'fence',message:'fence'}" : "{type:'assistant',uuid:'fence',session_id:'session',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:'fence'}]}}"}), 25);
  }
});
`, { mode: 0o755 });
    process.env[variable] = binary;
    const events: ProviderEvent[] = [];
    const fence = Promise.withResolvers<void>();
    let session: ProviderSession;
    try {
      session = (kind === "pi" ? piProvider() : claudeProvider()).open({
        cwd: dir, config: {}, resumeId: null,
        emit(e) {
          events.push(e);
          if (e.type === "turnEnded" && e.turnId === "first") session.send("second", "user-2", undefined, "second");
          if (e.type === "item" && "text" in e.item && e.item.text === "fence") fence.resolve();
        },
        async askPermission() { throw new Error("unexpected permission"); },
        async askQuestion() { throw new Error("unexpected question"); },
      });
      session.send("first", "user-1", undefined, "first");
      await fence.promise;
      assert.deepEqual(events.filter((e) => e.type === "turnEnded").map((e) => e.turnId), ["first"]);
    } finally {
      await session!?.close();
      if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
