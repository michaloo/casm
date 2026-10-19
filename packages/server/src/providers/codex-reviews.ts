// Auto-review is a decision about an action, not the action's execution.
// These notifications are absent from Codex's native history.
import type { Item } from "@casm/protocol";
import { isoTime } from "../item-times.ts";

type ToolItem = Extract<Item, { kind: "tool" }>;
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === "string" ? v : "";

export function approvalReview(p: Record<string, unknown>): ToolItem | null {
  if (typeof p.reviewId !== "string" || !p.reviewId) return null;
  const action = record(p.action);
  const review = record(p.review);
  let description: string;
  switch (action.type) {
    case "command": description = text(action.command); break;
    case "execve": description = `${text(action.program)} ${JSON.stringify(action.argv ?? [])}`; break;
    case "writeStdin": description = `Input to ${text(action.processId)}: ${JSON.stringify(action.stdin)}`; break;
    case "applyPatch": description = `Edit files: ${Array.isArray(action.files) ? action.files.join(", ") : ""}`; break;
    case "networkAccess": description = `Network: ${text(action.target) || `${text(action.protocol)}://${text(action.host)}:${action.port}`}`; break;
    case "mcpToolCall": description = `MCP: ${text(action.server)}/${text(action.toolName)}`; break;
    case "requestPermissions": description = `Permissions: ${text(action.reason) || JSON.stringify(action.permissions ?? {})}`; break;
    default: description = `Action: ${text(action.type) || "unknown"}`;
  }
  const labels: Record<string, string> = { inProgress: "Approval review", approved: "Review approved", denied: "Review denied", timedOut: "Review timed out", aborted: "Review cancelled" };
  const status = text(review.status);
  const at = isoTime(p.startedAtMs);
  const endedAt = isoTime(p.completedAtMs);
  const output = [
    text(review.rationale),
    review.riskLevel ? `Risk: ${review.riskLevel}` : "",
    review.userAuthorization ? `User authorization: ${review.userAuthorization}` : "",
    status === "approved" ? "Approval permits this action; it does not mean the action ran or succeeded." : "",
    !labels[status] ? `Review outcome unknown (${status || "missing status"}).` : "",
  ].filter(Boolean).join("\n");
  return {
    kind: "tool", id: `review:${p.reviewId}`, name: labels[status] ?? "Review outcome unknown",
    status: status === "inProgress" ? "running" : status === "approved" ? "done" : "error",
    input: { description, action, ...(typeof p.targetItemId === "string" ? { targetItemId: p.targetItemId } : {}), ...(p.decisionSource ? { decisionSource: p.decisionSource } : {}) },
    ...(at ? { at } : {}), ...(endedAt ? { endedAt } : {}), ...(output ? { output } : {}),
  };
}

export function unfinishedReview(item: ToolItem): ToolItem {
  return { ...item, name: "Review outcome unknown", status: "error", endedAt: new Date().toISOString(), output: "The session ended before a final review result was received. This does not indicate approval or denial." };
}
