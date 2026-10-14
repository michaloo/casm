import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderLimits } from "@casm/protocol";
import type { Rpc } from "./state";
import { ProviderIcon, providerNames } from "./provider-icon";
import { usageLabel, resetLabel } from "./usage-label";

export function HostUsage({ host, name, rpc, online }: { host: string; name: string; rpc: Rpc | null; online: boolean }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!panel.current || !trigger.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const box = panel.current.getBoundingClientRect();
      const left = Math.max(12, Math.min(anchor.left, innerWidth - box.width - 12));
      const below = anchor.bottom + 8;
      const top = Math.max(12, Math.min(below + box.height <= innerHeight - 12 ? below : anchor.top - box.height - 8, innerHeight - box.height - 12));
      panel.current.style.left = `${left}px`;
      panel.current.style.top = `${top}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open]);
  const [refresh, setRefresh] = useState(0);
  const [limits, setLimits] = useState<ProviderLimits[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || !online || !rpc) return;
    let active = true;
    setLoading(true);
    setError("");
    void rpc.call("provider.limits", { refresh: refresh > 0 }, host).then((value) => {
      if (active) setLimits(value.limits);
    }).catch(() => {
      if (active) setError("Usage unavailable on this host.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, online, rpc, host, refresh]);
  return <span className="host-usage">
    <button ref={trigger} type="button" className="host-usage-trigger" popoverTarget={id} aria-expanded={open} aria-label={`Provider usage on ${name}`} title={`Provider usage on ${name}`}>Usage</button>
    {createPortal(<div ref={panel} id={id} popover="auto" className="host-usage-panel" role="dialog" aria-label={`${name} provider usage`}
      onToggle={(event) => setOpen(event.currentTarget.matches(":popover-open"))}>
      <div className="host-usage-heading"><strong>{name} usage</strong><div className="host-usage-actions"><button type="button" disabled={loading || !online} onClick={() => setRefresh((value) => value + 1)}>Refresh usage</button><button type="button" popoverTarget={id} popoverTargetAction="hide" aria-label="Close usage">×</button></div></div>
      {!online ? <p>Offline</p> : error ? <p role="status">{error}</p> : <>
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
            {window.resetsAt && <small>Resets <time dateTime={window.resetsAt} title={new Date(window.resetsAt).toLocaleString()}>{resetLabel(window.resetsAt)}</time></small>}
          </div>)}
          <small>Reported <time dateTime={limit.updatedAt}>{new Date(limit.updatedAt).toLocaleString()}</time></small>
        </section>)}
      </>}
    </div>, document.body)}
  </span>;
}
