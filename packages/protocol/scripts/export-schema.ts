// Writes spec/protocol.json: every method's params/result and every
// notification as JSON Schema. This is the contract for non-TypeScript clients
// (the Swift apps generate their Codable types from it).
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { PROTOCOL_VERSION, ErrorCode, methods, notifications } from "../src/index.ts";

const schema = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { io, unrepresentable: "any" });

const spec = {
  protocol: PROTOCOL_VERSION,
  transport: "JSON-RPC 2.0 over WebSocket; Authorization: Bearer <token> on the upgrade request; GET /health is unauthenticated",
  errors: ErrorCode,
  methods: Object.fromEntries(
    Object.entries(methods).map(([name, m]) => [name, { params: schema(m.params, "input"), result: schema(m.result, "output") }]),
  ),
  notifications: Object.fromEntries(Object.entries(notifications).map(([name, s]) => [name, schema(s, "output")])),
};

const out = new URL("../../../spec/protocol.json", import.meta.url);
writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
console.log(`wrote ${out.pathname}`);
