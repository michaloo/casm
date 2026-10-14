import { useState } from "react";
import type { PermissionDecision, PermissionRequest } from "@casm/protocol";

const ruleLabels = { bash: "Commands to always allow (one pattern per line, * matches anything)", edit: "Files to always allow (glob inside the project)", tool: "Tool to always allow" };

/** A pending permission request: Allow, Always allow (with the rule it saves, editable when the agent allows it) or Deny. */
export function PermissionCard({ request: p, online, respond }: {
  request: PermissionRequest;
  online: boolean;
  respond: (decision: PermissionDecision, rule?: string) => void;
}) {
  const [rule, setRule] = useState(p.rule?.value ?? "");
  const lines = Math.min(6, Math.max(1, rule.split("\n").length));
  return <div className="card">
    <strong>{p.title ?? `Permission: ${p.toolName}`}</strong>
    <pre>{JSON.stringify(p.input, null, 2)}</pre>
    {p.rule && <label className="permission-rule">
      <span>{ruleLabels[p.rule.kind]}</span>
      {p.rule.editable
        ? <textarea aria-label="Rule to always allow" rows={lines} value={rule} onChange={(e) => setRule(e.target.value)} />
        : <code>{p.rule.value}</code>}
      {p.rule.savedTo && <small>Saved in {p.rule.savedTo}</small>}
    </label>}
    {(["allow", ...(p.canAlwaysAllow ? ["allowAlways"] : []), "deny"] as const).map((d) => (
      <button key={d} disabled={!online || (d === "allowAlways" && !!p.rule?.editable && !rule.trim())}
        onClick={() => respond(d as PermissionDecision, d === "allowAlways" && p.rule?.editable ? rule : undefined)}>
        {d === "allow" ? "Allow" : d === "deny" ? "Deny" : "Always allow"}
      </button>
    ))}
  </div>;
}
