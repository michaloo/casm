import type { Schedule, ScheduleCadence } from "@casm/protocol";
import { nextCron, parseCron } from "@casm/protocol/cron";

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

export function everyLabel(m: number): string {
  if (m % 1440 === 0) return m === 1440 ? "Every day" : `Every ${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
  return m === 1 ? "Every minute" : `Every ${m} min`;
}

/** Common 5-field crons in words ("Weekdays at 09:00"); undefined for anything else. */
export function describeCron(expr: string): string | undefined {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [min, hour, dom, month, dow] = parts;
  const num = (s: string) => /^\d+$/.test(s) ? Number(s) : undefined;
  const m = num(min);
  const h = num(hour);
  if (month !== "*") return undefined;
  const step = /^\*\/(\d+)$/;
  if (dom === "*" && dow === "*") {
    if (hour === "*" && step.test(min)) return everyLabel(Number(min.match(step)![1]));
    if (hour === "*" && min === "*") return "Every minute";
    if (hour === "*" && m !== undefined) return m ? `Hourly at :${pad(m)}` : "Every hour";
    if (step.test(hour) && m !== undefined) return `Every ${hour.match(step)![1]} hours${m ? ` at :${pad(m)}` : ""}`;
  }
  if (m === undefined || h === undefined) return undefined;
  const time = `${pad(h)}:${pad(m)}`;
  if (dom === "*" && dow === "*") return `Daily at ${time}`;
  if (dom === "*") {
    if (dow === "1-5") return `Weekdays at ${time}`;
    if (dow === "0,6" || dow === "6,0" || dow === "6,7") return `Weekends at ${time}`;
    const days = dow.split(",").map(num);
    if (days.some((d) => d === undefined || d > 7)) return undefined;
    const names = days.map((d) => d! % 7);
    return names.length === 1 ? `${DAY_NAMES[names[0]]} at ${time}` : `${names.map((d) => DAYS[d]).join(", ")} at ${time}`;
  }
  const day = num(dom);
  if (dow === "*" && day !== undefined) return `Monthly on day ${day} at ${time}`;
  return undefined;
}

export function cadenceLabel(cadence: ScheduleCadence, now = Date.now()): string {
  if (cadence.type === "cron") return describeCron(cadence.expr) ?? `Cron ${cadence.expr}`;
  if (cadence.type === "once") return `Once · ${dateLabel(cadence.at, now)}`;
  return everyLabel(cadence.minutes);
}

/** "today 09:00", "tomorrow 09:00", "yesterday 23:45", "Thu 16 Oct 09:00", with the year when it differs. */
export function dateLabel(at: string, now = Date.now()): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return "an unknown time";
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date(now))) / 864e5);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  if (diff === -1) return `yesterday ${time}`;
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${DAYS[d.getDay()]} ${d.getDate()} ${d.toLocaleString("en", { month: "short" })}${year} ${time}`;
}

/** The next few run times of a cron, or an error message for an invalid one. */
export function cronPreview(expr: string, count = 3, now = new Date()): Date[] | string {
  try {
    const cron = parseCron(expr);
    const runs: Date[] = [];
    let at = now;
    for (let i = 0; i < count; i++) runs.push(at = nextCron(cron, at));
    return runs;
  } catch (e) {
    const text = (e as Error).message;
    return text.charAt(0).toUpperCase() + text.slice(1) + ".";
  }
}

export function targetLabel(
  target: Schedule["target"],
  names: { agents: Map<string, string>; projects: Map<string, string> },
): string {
  if (target.type === "agent")
    return `Message ${names.agents.get(target.agentId) ?? "a removed agent"}${target.whenBusy === "skip" ? " · skip when busy" : ""}`;
  return `New agent in ${names.projects.get(target.projectId) ?? "a removed project"}`;
}

/** A one-off that already ran and switched itself off. The server deletes those
 * whose run went through, so what remains failed or was skipped. */
export function isFinished(s: Schedule): boolean {
  return s.cadence.type === "once" && !s.enabled && !!s.lastRun;
}

export const outcomeLabels: Record<NonNullable<Schedule["lastRun"]>["outcome"], string> = {
  sent: "Sent", queued: "Queued", skipped: "Skipped (busy)", created: "Started agent", failed: "Failed",
};

/** Parses the form's cadence fields; returns an error message instead when invalid. */
export function parseCadence(kind: string, value: string): ScheduleCadence | string {
  const text = value.trim();
  if (kind === "every") {
    const minutes = Number(text);
    return Number.isInteger(minutes) && minutes > 0 ? { type: "every", minutes } : "Enter a whole number of minutes.";
  }
  if (kind === "cron") {
    const preview = cronPreview(text, 1);
    return typeof preview === "string" ? preview : { type: "cron", expr: text.split(/\s+/).join(" ") };
  }
  const at = new Date(text);
  return text && Number.isFinite(at.getTime()) ? { type: "once", at: at.toISOString() } : "Choose a date and time.";
}

/** The local value for a datetime-local input. */
export function localInput(at: Date): string {
  return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function agoLabel(at: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(at).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "at an unknown time";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
