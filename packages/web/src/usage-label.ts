import type { LimitWindow } from "@casm/protocol";

export function usageLabel(window: LimitWindow): string {
  const percent = window.usedPercent === undefined ? undefined : `${Math.round(window.usedPercent)}% used`;
  return [percent, window.status].filter(Boolean).join(" · ") || "Usage unknown";
}

export function resetLabel(reset: string, now = Date.now()): string {
  const remaining = new Date(reset).getTime() - now;
  if (!Number.isFinite(remaining)) return "at an unknown time";
  if (remaining <= 0) return "now";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `in ${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}
