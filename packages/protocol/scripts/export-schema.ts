// Writes spec/protocol.json: every method's params/result and every
// notification as JSON Schema. This is the contract for non-TypeScript clients
// (the Swift apps generate their Codable types from it).
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { PROTOCOL_VERSION, ErrorCode, methods, notifications } from "../src/index.ts";

// Clients must ignore unknown fields, so the spec never forbids them.
function allowExtra(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(allowExtra);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node).filter(([k, v]) => !(k === "additionalProperties" && v === false)).map(([k, v]) => [k, allowExtra(v)]),
  );
}

const schema = (s: z.ZodType, io: "input" | "output") => allowExtra(z.toJSONSchema(s, { io, unrepresentable: "any" }));

const spec = {
  protocol: PROTOCOL_VERSION,
  transport: "JSON-RPC 2.0 over WebSocket; authenticate with Authorization: Bearer <token> on the upgrade request, or (browsers) with an auth request as the first message, within 10 s; never put the token in the URL; GET /health is unauthenticated; a request's optional top-level \"host\" (a peer name or server id) forwards it to that peer, and notifications relayed from the peer carry the same \"host\"",
  errors: ErrorCode,
  methods: Object.fromEntries(
    Object.entries(methods).map(([name, m]) => [name, { params: schema(m.params, "input"), result: schema(m.result, "output") }]),
  ),
  notifications: Object.fromEntries(Object.entries(notifications).map(([name, s]) => [name, schema(s, "output")])),
};

const out = new URL("../../../spec/protocol.json", import.meta.url);
writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
console.log(`wrote ${out.pathname}`);
