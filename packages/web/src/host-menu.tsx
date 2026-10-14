import { NewProject } from "./new-project";
import { useRef, useState } from "react";
import type { Agent, Project } from "@casm/protocol";
import type { Rpc } from "./state";
import { HostSettings } from "./host-settings";
import { MoreGlyph, PlusGlyph } from "./row-menu";

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

/** The host's icon, name and status, shown in its fold button and its menu. */
export function HostIdentity({ name, state, detail }: { name: string; state: HostState; detail?: string }) {
  return <>
    <span className="host-icon"><ServerGlyph /><span className={`host-dot ${state}`} /></span>
    <span className="host-label">
      <span className="host-name">{name}</span>
      <small>{stateLabels[state]}{detail ? ` · ${detail}` : ""}</small>
    </span>
  </>;
}

/** The host row's actions: + adds a project, ⋯ opens the host modal. */
export function HostActions({ host, name, state, rpc, agents, projects, openAgent, openProject }: {
  host: string; name: string; state: HostState; rpc: Rpc | null; agents: Agent[]; projects: Project[];
  openAgent?: (agent: Agent) => void; openProject: (project: Project) => void;
}) {
  const options = useRef<HTMLButtonElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const [settings, setSettings] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const online = state === "online" || state === "slow";
  return <>
    <button ref={plus} type="button" className="row-more row-add" disabled={!online} aria-haspopup="dialog" aria-expanded={newProject}
      aria-label={`New project on ${name}`} title="New project" onClick={() => setNewProject(true)}>
      <PlusGlyph />
    </button>
    <button ref={options} type="button" className="row-more" data-host-menu-trigger aria-haspopup="dialog" aria-expanded={settings}
      aria-label={`Host options for ${name}`} title="Host options" onClick={() => setSettings(true)}>
      <MoreGlyph />
    </button>
    {newProject && <NewProject host={host} name={name} projects={projects} rpc={rpc} online={online}
      close={() => { setNewProject(false); plus.current?.focus(); }}
      created={project => { setNewProject(false); openProject(project); }} />}
    {settings && <HostSettings host={host} name={name} state={state} rpc={rpc} online={online} agents={agents} projects={projects}
      openAgent={openAgent && ((agent) => { setSettings(false); openAgent(agent); })}
      close={() => { setSettings(false); options.current?.focus(); }} />}
  </>;
}
