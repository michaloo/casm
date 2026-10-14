import type { Schedule, ScheduleCadence } from "@casm/protocol";

export function cadenceLabel(cadence: ScheduleCadence): string {
  if (cadence.type === "cron") return `Cron ${cadence.expr}`;
  if (cadence.type === "once") return `Once · ${new Date(cadence.at).toLocaleString()}`;
  const m = cadence.minutes;
  if (m % 1440 === 0) return m === 1440 ? "Every day" : `Every ${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
  return m === 1 ? "Every minute" : `Every ${m} minutes`;
}

export function targetLabel(
  target: Schedule["target"],
  names: { agents: Map<string, string>; projects: Map<string, string> },
): string {
  if (target.type === "agent")
    return `Message ${names.agents.get(target.agentId) ?? "a removed agent"}${target.whenBusy === "skip" ? " · skip when busy" : ""}`;
  return `New agent in ${names.projects.get(target.projectId) ?? "a removed project"}`;
}

/** Parses the create form's cadence fields; returns an error message instead when invalid. */
export function parseCadence(kind: string, value: string): ScheduleCadence | string {
  const text = value.trim();
  if (kind === "every") {
    const minutes = Number(text);
    return Number.isInteger(minutes) && minutes > 0 ? { type: "every", minutes } : "Enter a whole number of minutes.";
  }
  if (kind === "cron") return text.split(/\s+/).length === 5 ? { type: "cron", expr: text } : "Cron needs 5 fields, e.g. 0 9 * * 1-5.";
  const at = new Date(text);
  return text && Number.isFinite(at.getTime()) ? { type: "once", at: at.toISOString() } : "Choose a date and time.";
}

export function agoLabel(at: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(at).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "at an unknown time";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
