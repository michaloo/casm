import { NewProject } from "./new-project";
import { useRef, useState } from "react";
import type { Project } from "@casm/protocol";
import type { Rpc } from "./state";
import { HostSettings, type HostSection } from "./host-settings";
import { MoreGlyph, PlusGlyph } from "./row-menu";
import { offlineNote } from "./connection";
import { gib, pctTone, ramPercent, useHostStats } from "./host-stats";

export type HostState = "online" | "slow" | "offline" | "connecting";
const stateLabels: Record<HostState, string> = { online: "Online", slow: "Slow", offline: "Offline", connecting: "Connecting" };
export const hostStateLabel = (state: HostState) => stateLabels[state];

export function ServerGlyph() {
  return <svg className="server-glyph" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <rect x="2.5" y="3" width="15" height="6" rx="1.8" />
    <rect x="2.5" y="11" width="15" height="6" rx="1.8" />
    <circle cx="6" cy="6" r="1" /><circle cx="6" cy="14" r="1" />
    <path d="M10 6h4.5M10 14h4.5" />
  </svg>;
}

/** The host's icon, name and status, shown in its fold button and its modal.
 * `bare` leaves the status to the dot (and the row's tooltip). */
export function HostIdentity({ name, state, detail, bare = false }: { name: string; state: HostState; detail?: string; bare?: boolean }) {
  return <>
    <span className="host-icon"><ServerGlyph /><span className={`host-dot ${state}`} /></span>
    <span className="host-label">
      <span className="host-name">{name}</span>
      {!bare && <small>{stateLabels[state]}{detail ? ` · ${detail}` : ""}</small>}
    </span>
  </>;
}

/** The host row's actions: + adds a project, ⋯ opens the host modal. */
export function HostActions({ host, name, state, rpc, projects, openProject }: {
  host: string; name: string; state: HostState; rpc: Rpc | null; projects: Project[]; openProject: (project: Project) => void;
}) {
  const options = useRef<HTMLButtonElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  // The open host modal's first section, and where focus returns when it closes (⋯, or what the launcher left focused).
  const [settings, setSettings] = useState<{ section: HostSection; back: HTMLElement | null; opened: number }>();
  const opened = useRef(0);
  const [newProject, setNewProject] = useState(false);
  const online = state === "online" || state === "slow";
  return <>
    <button ref={plus} type="button" className="row-more row-add" disabled={!online} aria-haspopup="dialog" aria-expanded={newProject}
      aria-label={`New project on ${name}`} title={online ? "New project" : offlineNote} onClick={() => setNewProject(true)}>
      <PlusGlyph />
    </button>
    <button ref={options} type="button" className="row-more" data-host-menu-trigger aria-haspopup="dialog" aria-expanded={!!settings}
      aria-label={`Host options for ${name}`} title="Host options" onClick={() => setSettings({ section: "usage", back: options.current, opened: ++opened.current })}>
      <MoreGlyph />
    </button>
    <HostMeter host={host} name={name} rpc={rpc} online={online} open={(back) => setSettings({ section: "resources", back, opened: ++opened.current })} />
    {newProject && <NewProject host={host} name={name} projects={projects} rpc={rpc} online={online}
      close={() => { setNewProject(false); plus.current?.focus(); }}
      created={project => { setNewProject(false); openProject(project); }} />}
    {settings && <HostSettings key={settings.opened} host={host} name={name} state={state} rpc={rpc} online={online}
      initialSection={settings.section}
      // The dialog's close event is async: a reopen may already have replaced this one.
      close={() => { const back = settings.back; setSettings(current => current === settings ? undefined : current);
        if (!document.querySelector("dialog[open]")) (back?.isConnected ? back : options.current)?.focus(); }} />}
  </>;
}


/** CPU and RAM as two small bars beside the fold chevron, read every 30 s. Its slot
 * stays reserved while hidden (offline, or a host without host.stats), so the row never shifts. */
function HostMeter({ host, name, rpc, online, open }: { host: string; name: string; rpc: Rpc | null; online: boolean; open: (back: HTMLElement) => void }) {
  const stats = useHostStats(host, rpc, online, 30_000);
  if (!stats) return <span className="host-meter" aria-hidden="true" />;
  const cpu = stats.cpuPercent, ram = ramPercent(stats);
  const summary = `CPU ${cpu === null ? "measuring" : `${Math.round(cpu)}%`} · RAM ${gib(stats.memory.used).replace(" GB", "")} of ${gib(stats.memory.total)}`;
  const bar = (percent: number | null, kind: string) => <span className={`host-meter-bar ${kind} ${percent === null ? "" : pctTone(percent)}`}>
    <span style={{ height: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} /></span>;
  return <button type="button" className="host-meter" title={summary} aria-label={`${name} resources: ${summary}`}
    onClick={(event) => open(event.currentTarget)}>{bar(cpu, "cpu")}{bar(ram, "ram")}</button>;
}
