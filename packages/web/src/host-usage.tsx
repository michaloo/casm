import { useEffect, useState } from "react";
import type { ProviderLimits } from "@casm/protocol";
import type { Rpc } from "./state";
import { ProviderIcon, providerNames } from "./provider-icon";
import { usageLabel, resetLabel } from "./usage-label";

/** Provider limit windows for one host, read when shown. */
export function HostUsage({ host, rpc, online }: { host: string; rpc: Rpc | null; online: boolean }) {
  const [refresh, setRefresh] = useState(0);
  const [limits, setLimits] = useState<ProviderLimits[]>([]);
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
    return () => { active = false; };
  }, [online, rpc, host, refresh]);
  return <>
    <div className="host-panel-toolbar"><button type="button" disabled={loading || !online} onClick={() => setRefresh((value) => value + 1)}>Refresh usage</button></div>
    {!online ? <p>Host offline.</p> : error ? <p role="status">{error}</p> : <>
      {loading && <p role="status">Loading usage…</p>}
      {!loading && !limits.length && <p>No provider usage reported.</p>}
      {limits.slice().sort((a, b) => a.provider.localeCompare(b.provider)).map((limit) => <section key={limit.provider} className="host-provider-usage">
        <strong><ProviderIcon provider={limit.provider} /> {providerNames[limit.provider]}{limit.plan ? ` · ${limit.plan}` : ""}</strong>
        {!limit.windows.length && <p>No usage windows reported.</p>}
        {limit.windows.map((window) => <div className="usage-window" key={window.id}>
          <div className="usage-window-values">
          <span>{window.label || window.id}</span>
          <span>{usageLabel(window)}</span>
          </div>
          {window.usedPercent !== undefined && <span className={`usage-meter ${window.status === "exhausted" || window.usedPercent >= 100 ? "full" : window.usedPercent >= 80 ? "high" : ""}`} aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} /></span>}
          {window.resetsAt && <small>Resets <time dateTime={window.resetsAt} title={new Date(window.resetsAt).toLocaleString()}>{resetLabel(window.resetsAt)}</time></small>}
        </div>)}
        <small>Reported <time dateTime={limit.updatedAt}>{new Date(limit.updatedAt).toLocaleString()}</time></small>
      </section>)}
    </>}
  </>;
}
