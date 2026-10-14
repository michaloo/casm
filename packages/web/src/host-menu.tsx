import { useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Agent, Project } from "@casm/protocol";
import type { Rpc } from "./state";
import { HostUsage, useAnchoredPosition } from "./host-usage";
import { HostSettings } from "./host-settings";
import { HostSchedules } from "./host-schedules";

export type HostState = "online" | "slow" | "offline" | "connecting";
const stateLabels: Record<HostState, string> = { online: "Online", slow: "Slow", offline: "Offline", connecting: "Connecting" };
type View = "menu" | "usage" | "schedules";

export function ServerGlyph() {
  return <svg className="server-glyph" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <rect x="2.5" y="3" width="15" height="6" rx="1.8" />
    <rect x="2.5" y="11" width="15" height="6" rx="1.8" />
    <circle cx="6" cy="6" r="1" /><circle cx="6" cy="14" r="1" />
    <path d="M10 6h4.5M10 14h4.5" />
  </svg>;
}

/** The host row: a server button that opens a menu with on-demand usage and schedules. */
export function HostMenu({ host, name, state, detail, rpc, agents, projects }: {
  host: string; name: string; state: HostState; detail?: string; rpc: Rpc | null; agents: Agent[]; projects: Project[];
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [view, setView] = useState<View>("menu");
  useAnchoredPosition(open, trigger, panel, view);
  const online = state === "online" || state === "slow";
  const status = stateLabels[state];
  const focusFirst = () => requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled), .host-panel-back")?.focus());
  const show = (next: View) => { setView(next); focusFirst(); };
  const menuKeys = (e: KeyboardEvent) => {
    const items = [...(panel.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  };
  const title = view === "usage" ? `${name} provider usage` : view === "schedules" ? `${name} schedules` : `${name} host`;
  return <>
    <button ref={trigger} type="button" className={`host-trigger host-${state}`} popoverTarget={id} data-host-menu-trigger
      aria-haspopup="menu" aria-expanded={open} aria-label={`${name}, ${status.toLowerCase()} · host menu`} title={`${name} · ${status}`}>
      <span className="host-icon"><ServerGlyph /><span className={`host-dot ${state}`} /></span>
      <span className="host-label">
        <span className="host-name">{name}</span>
        <small>{status}{detail ? ` · ${detail}` : ""}</small>
      </span>
      <span className="host-chevron" aria-hidden="true" />
    </button>
    {createPortal(<div ref={panel} id={id} popover="auto" className="host-panel" data-view={view}
      role={view === "menu" ? "menu" : "dialog"} aria-label={title} onKeyDown={view === "menu" ? menuKeys : undefined}
      onToggle={(event) => {
        const isOpen = event.currentTarget.matches(":popover-open");
        setOpen(isOpen);
        if (isOpen) focusFirst(); else setView("menu");
      }}>
      {view === "menu" ? <>
        <div className="host-panel-heading" role="presentation">
          <span className="host-icon"><ServerGlyph /><span className={`host-dot ${state}`} /></span>
          <span><strong>{name}</strong><small>{status}{detail ? ` · ${detail}` : ""}</small></span>
        </div>
        <button type="button" role="menuitem" onClick={() => show("usage")}>
          <span>Usage</span><small>Provider limits and reset times</small>
        </button>
        <button type="button" role="menuitem" onClick={() => show("schedules")}>
          <span>Schedules</span><small>Recurring and one-off prompts</small>
        </button>
        <button type="button" role="menuitem" onClick={() => { panel.current?.hidePopover(); setSettings(true); }}>
          <span>Settings</span><small>Global instructions, memories, and agent prompt</small>
        </button>
      </> : <>
        <div className="host-panel-heading">
          <button type="button" className="host-panel-back" aria-label="Back to host menu" title="Back" onClick={() => show("menu")}>‹</button>
          <strong>{view === "usage" ? `${name} usage` : `${name} schedules`}</strong>
          <button type="button" className="host-panel-close" popoverTarget={id} popoverTargetAction="hide" aria-label={`Close ${view}`}>×</button>
        </div>
        {view === "usage"
          ? <HostUsage host={host} rpc={rpc} online={online} />
          : <HostSchedules host={host} rpc={rpc} online={online} agents={agents} projects={projects} />}
      </>}
    </div>, document.body)}
    {settings && <HostSettings host={host} name={name} rpc={rpc} online={online} projects={projects}
      close={() => { setSettings(false); trigger.current?.focus(); }} />}
  </>;
}
