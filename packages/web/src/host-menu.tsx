import { NewProject } from "./new-project";
import { useEffect, useRef, useState } from "react";
import type { Agent, Project } from "@casm/protocol";
import type { Rpc } from "./state";
import { HostSettings } from "./host-settings";
import { ClockGlyph, MoreGlyph, PlusGlyph } from "./row-menu";
import { HostSchedules, onOpenSchedules } from "./host-schedules";
import { SettingsDialog } from "./settings-shared";
import { offlineNote } from "./connection";

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

/** The host's icon, name and status, shown in its fold button and its modals.
 * `quiet` leaves "Online" to the dot, naming only other states and the detail. */
export function HostIdentity({ name, state, detail, quiet = false }: { name: string; state: HostState; detail?: string; quiet?: boolean }) {
  const status = [quiet && state === "online" ? "" : stateLabels[state], detail].filter(Boolean).join(" · ");
  return <>
    <span className="host-icon"><ServerGlyph /><span className={`host-dot ${state}`} /></span>
    <span className="host-label">
      <span className="host-name">{name}</span>
      {status && <small>{status}</small>}
    </span>
  </>;
}

/** The host row's actions: the clock opens its schedules, + adds a project, ⋯ opens the host modal. */
export function HostActions({ host, name, state, rpc, agents, projects, openAgent, openProject }: {
  host: string; name: string; state: HostState; rpc: Rpc | null; agents: Agent[]; projects: Project[];
  openAgent?: (agent: Agent) => void; openProject: (project: Project) => void;
}) {
  const options = useRef<HTMLButtonElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const [settings, setSettings] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const clock = useRef<HTMLButtonElement>(null);
  // Where focus returns when the schedules modal closes: the clock, or what the launcher left focused.
  const [schedules, setSchedules] = useState<HTMLElement | null>();
  useEffect(() => onOpenSchedules(host, () => setSchedules(document.activeElement instanceof HTMLElement ? document.activeElement : null)), [host]);
  const online = state === "online" || state === "slow";
  return <>
    <button ref={clock} type="button" className="row-more row-schedules" aria-haspopup="dialog" aria-expanded={schedules !== undefined}
      aria-label={`Schedules on ${name}`} title="Schedules" onClick={() => setSchedules(clock.current)}>
      <ClockGlyph />
    </button>
    <button ref={plus} type="button" className="row-more row-add" disabled={!online} aria-haspopup="dialog" aria-expanded={newProject}
      aria-label={`New project on ${name}`} title={online ? "New project" : offlineNote} onClick={() => setNewProject(true)}>
      <PlusGlyph />
    </button>
    <button ref={options} type="button" className="row-more" data-host-menu-trigger aria-haspopup="dialog" aria-expanded={settings}
      aria-label={`Host options for ${name}`} title="Host options" onClick={() => setSettings(true)}>
      <MoreGlyph />
    </button>
    {newProject && <NewProject host={host} name={name} projects={projects} rpc={rpc} online={online}
      close={() => { setNewProject(false); plus.current?.focus(); }}
      created={project => { setNewProject(false); openProject(project); }} />}
    {settings && <HostSettings host={host} name={name} state={state} rpc={rpc} online={online}
      close={() => { setSettings(false); options.current?.focus(); }} />}
    {schedules !== undefined && <SchedulesDialog host={host} name={name} state={state} rpc={rpc} online={online} agents={agents} projects={projects}
      openAgent={openAgent && ((agent) => { setSchedules(undefined); openAgent(agent); })}
      close={() => { const back = schedules; setSchedules(undefined); (back?.isConnected ? back : clock.current)?.focus(); }} />}
  </>;
}

/** A host's schedules in their own modal, in the same shell as the host and project modals. */
function SchedulesDialog({ host, name, state, rpc, online, agents, projects, openAgent, close }: {
  host: string; name: string; state: HostState; rpc: Rpc | null; online: boolean; agents: Agent[]; projects: Project[];
  openAgent?: (agent: Agent) => void; close: () => void;
}) {
  return <SettingsDialog label={`Schedules on ${name}`} closeLabel="Close schedules"
    title={<span className="settings-title-host"><HostIdentity name={name} state={state} /><span className="settings-kind">schedules</span></span>}
    sections={[["schedules", "Schedules"]] as const} section="schedules" setSection={() => {}} close={close}>
    <section aria-label="Schedules" className="settings-schedules">
      <p className="settings-lede">Prompts sent on a cadence to an agent on this host, or to a new one.</p>
      {!online || !rpc ? <p role="status">Host offline. Reconnect to load its schedules.</p>
        : <HostSchedules host={host} rpc={rpc} online={online} agents={agents} projects={projects} openAgent={openAgent} />}
    </section>
  </SettingsDialog>;
}
