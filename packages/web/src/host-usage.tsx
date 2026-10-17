import { useEffect, useState } from "react";
import type { HostStats, LimitWindow, ProviderCosts, ProviderLimits } from "@casm/protocol";
import type { Rpc } from "./state";
import { gib, pctTone, ramPercent, useHostStats } from "./host-stats";
import { ProviderIcon, providerNames } from "./provider-icon";
import { usageLabel, resetLabel, elapsedPercent } from "./usage-label";
import { CostCard } from "./cost-chart";

/** Provider limit windows and the agents' estimated cost per day for one host, read when shown. */
export function HostUsage({ host, rpc, online }: { host: string; rpc: Rpc | null; online: boolean }) {
  const [refresh, setRefresh] = useState(0);
  const [limits, setLimits] = useState<ProviderLimits[]>([]);
  // Only providers with any cost in the window get a card.
  const [costs, setCosts] = useState<{ today: string; costs: ProviderCosts[] }>({ today: "", costs: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!online || !rpc) return;
    let active = true;
    setLoading(true);
    setError("");
    void rpc.call("provider.limits", { refresh: refresh > 0 }, host).then((value) => {
      if (active) setLimits(value.limits);
    }).catch(() => {
      if (active) setError("Usage unavailable on this host.");
    }).finally(() => { if (active) setLoading(false); });
    // Servers without provider.costs (older ones) just show no cost cards.
    void rpc.call("provider.costs", {}, host).then((value) => {
      if (active) setCosts({ today: value.today, costs: value.costs.filter((c) => c.totalUsd > 0) });
    }).catch(() => { if (active) setCosts({ today: "", costs: [] }); });
    return () => { active = false; };
  }, [online, rpc, host, refresh]);
  return <>
    <div className="host-panel-toolbar"><button type="button" disabled={loading || !online} onClick={() => setRefresh((value) => value + 1)}>Refresh usage</button></div>
    {!online ? <p>Host offline.</p> : error ? <p role="status">{error}</p> : <>
      {loading && <p role="status">Loading usage…</p>}
      {!loading && !limits.length && !costs.costs.length && <p>No provider usage reported.</p>}
      {(limits.length > 0 || costs.costs.length > 0) && <div className="usage-grid">
        {limits.slice().sort((a, b) => a.provider.localeCompare(b.provider)).map((limit) => {
          const state = providerState(limit);
          return <section key={limit.provider} className="host-provider-usage usage-card" aria-label={providerNames[limit.provider]}>
            <div className="usage-card-head">
              <strong><ProviderIcon provider={limit.provider} /> {providerNames[limit.provider]}</strong>
              {limit.plan && <span className="chip" title="Plan">{limit.plan}</span>}
              {limit.windows.length > 0 && <span className={`chip usage-state ${state.tone}`}>{state.label}</span>}
            </div>
            {!limit.windows.length && <p>No usage windows reported.</p>}
            {limit.windows.map((window) => <div className="usage-window" key={window.id}>
              <div className="usage-window-values">
              <span>{window.label || window.id}</span>
              <span>{usageLabel(window)}</span>
              </div>
              {window.usedPercent !== undefined && <span className={`usage-meter ${meterTone(window)}`} aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} />
                {elapsedPercent(window) !== undefined && <i className="usage-now" style={{ left: `${elapsedPercent(window)}%` }} title={`${Math.round(elapsedPercent(window)!)}% of the window has passed`} />}</span>}
              {window.resetsAt && <small>Resets <time dateTime={window.resetsAt} title={new Date(window.resetsAt).toLocaleString()}>{resetLabel(window.resetsAt)}</time>{clock(window.resetsAt)}</small>}
            </div>)}
            <small className="usage-reported">Reported <time dateTime={limit.updatedAt} title={new Date(limit.updatedAt).toLocaleString()}>{agoLabel(limit.updatedAt)}</time></small>
          </section>;
        })}
        {costs.costs.slice().sort((a, b) => a.provider.localeCompare(b.provider)).map((c) => <CostCard key={`cost-${c.provider}`} costs={c} today={costs.today} />)}
      </div>}
    </>}
  </>;
}

/** The host's load, refreshed every 10 s while shown (shared with the sidebar's mini bars). */
export function HostResources({ host, rpc, online }: { host: string; rpc: Rpc | null; online: boolean }) {
  const stats = useHostStats(host, rpc, online, 10_000);
  return !online ? <p>Host offline.</p> : stats ? <HostCard stats={stats} />
    : <p role="status">{stats === null ? "Resources unavailable on this host." : "Loading resources…"}</p>;
}

const loadTone = (stats: HostStats) => stats.loadAverage && stats.loadAverage[0] > stats.cores ? "high" : "";

function HostCard({ stats }: { stats: HostStats }) {
  const ram = ramPercent(stats);
  const swap = stats.swap && stats.swap.total ? (stats.swap.used / stats.swap.total) * 100 : null;
  const row = (label: string, value: string, percent: number | null, tone: string, name: string) => <div className="usage-window" aria-label={name}>
    <div className="usage-window-values"><span>{label}</span><span>{value}</span></div>
    {percent !== null && <span className={`usage-meter ${tone}`} aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></span>}
  </div>;
  return <section className="host-provider-usage usage-card host-stats-card" aria-label="Host load">
    <div className="usage-card-head">
      <strong>Host</strong>
      <span className="chip" title="Cores">{stats.cores} cores</span>
      {stats.runningAgents > 0 && <span className="chip" title="Agents running a turn">{stats.runningAgents} running</span>}
    </div>
    {row("CPU", stats.cpuPercent === null ? "measuring…" : `${Math.round(stats.cpuPercent)}%`, stats.cpuPercent, stats.cpuPercent === null ? "" : pctTone(stats.cpuPercent), "CPU")}
    {stats.loadAverage && row("Load 1 / 5 / 15 min", stats.loadAverage.map((n) => n.toFixed(2)).join(" · "), Math.min(100, (stats.loadAverage[0] / stats.cores) * 100), loadTone(stats), "Load")}
    {row("RAM", `${gib(stats.memory.used)} of ${gib(stats.memory.total)}`, ram, pctTone(ram), "RAM")}
    {stats.swap && swap !== null && row("Swap", `${gib(stats.swap.used)} of ${gib(stats.swap.total)}`, swap, pctTone(swap), "Swap")}
    <small className="usage-reported">Up {uptimeLabel(stats.uptimeSeconds)} · casm uses {Math.round(stats.processRss / 2 ** 20)} MB</small>
  </section>;
}

function uptimeLabel(seconds: number): string {
  const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600);
  return days ? `${days} d ${hours} h` : hours ? `${hours} h ${Math.floor((seconds % 3600) / 60)} min` : `${Math.floor(seconds / 60)} min`;
}

const meterTone = (w: LimitWindow) => w.status === "exhausted" || (w.usedPercent ?? 0) >= 100 ? "full" : w.status === "warning" || (w.usedPercent ?? 0) >= 80 ? "high" : "";

// The provider's tightest window decides its badge.
function providerState(limit: ProviderLimits): { tone: string; label: string } {
  const tones = limit.windows.map(meterTone);
  if (tones.includes("full")) return { tone: "full", label: "Limit reached" };
  if (tones.includes("high")) return { tone: "high", label: "Near limit" };
  return { tone: "ok", label: "Available" };
}

// " · 22:30" today, " · Fri 09:00" within a week, else the date.
function clock(reset: string, now = new Date()): string {
  const at = new Date(reset);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = (at.getTime() - now.getTime()) / 86_400_000;
  if (at.toDateString() === now.toDateString()) return ` · ${time}`;
  if (days < 6) return ` · ${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return ` · ${at.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function agoLabel(at: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(at).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "at an unknown time";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(at).toLocaleString();
}
