import { openSchedules } from "./open-schedules";
import { HostSettings } from "./host-settings";
import { ProjectSettings } from "./project-settings";
import { NewProject } from "./new-project";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Agent, ModelInfo, Project } from "@casm/protocol";
import { chats, key, type Host } from "./state";
import type { Selection } from "./navigation";
import { ProviderIcon, providerNames } from "./provider-icon";
import { AgentActivity } from "./agent-activity-view";
import { modelLabels } from "./model-label";
import { agentRecentKey, rankEntries, readRecent, type SearchEntry, type LauncherGroup } from "./launcher-search";

export type LauncherAction = { kind: "project" | "new-project" | "host"; host: Host; project?: Project; section?: "usage" | "instructions" };
type Entry = SearchEntry & { schedules?: boolean; host: Host; agent?: Agent; project?: Project; status?: string; action?: LauncherAction; selection?: Selection };
export function SearchGlyph() {
  return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>;
}
function Highlight({ text, positions, offset = 0 }: { text: string; positions: number[]; offset?: number }) {
  const hits = new Set(positions);
  return <>{text.split("").map((char, index) => hits.has(index + offset) ? <mark key={index}>{char}</mark> : char)}</>;
}
function age(time: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(time)) / 60000));
  return !Number.isFinite(minutes) ? "" : minutes < 1 ? "now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

export function Launcher({ hosts, models, online, choose, action, close }: {
  hosts: Host[]; models: Record<string, ModelInfo[]>; online: boolean; choose: (selection: Selection) => void;
  action: (action: LauncherAction) => void; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(480);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent] = useState(() => readRecent(localStorage));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal(); input.current?.focus();
    return () => { requestAnimationFrame(() => { if (!document.querySelector("dialog[open]")) previous?.isConnected && previous.focus(); }); };
  }, []);
  const entries = useMemo(() => {
    const result: Entry[] = [];
    for (const host of hosts) {
      const projects = new Map(host.projects.filter(project => !project.archivedAt).map(project => [project.id, project]));
      for (const agent of host.agents) {
        if (agent.archivedAt || !projects.has(agent.projectId)) continue;
        const project = projects.get(agent.projectId)!;
        const cached = chats.get(key(host.id, agent.id));
        const status = agent.status === "idle" && (cached?.failed || cached?.pending.some(item => item.reason === "failed")) ? "failed" : agent.status;
        const label = modelLabels(agent.config.model, agent.effectiveModel, models[`${host.id}\n${agent.provider}`] ?? []);
        result.push({ id: agentRecentKey(host.id, agent.id), group: "Agents", title: agent.name,
          subtitle: [project.name, host.name, providerNames[agent.provider], label.actual ?? (agent.config.model ? label.selectedLabel : label.sessionLabel)].join(" · "),
          attention: status === "waiting" || status === "failed" || !!agent.pending?.held || !!agent.deferred,
          running: status === "running", activity: Date.parse(agent.updatedAt) || 0, host, project, agent, status,
          selection: { host: host.id, project: project.id, id: agent.id } });
      }
      for (const project of projects.values()) {
        const base = `${host.id}\n${project.id}`;
        const subtitle = `${project.name} · ${host.name} · ${project.path}`;
        result.push({ id: `project:${base}`, group: "Projects", title: `Open project options: ${project.name}`, subtitle, host, project,
          action: { kind: "project", host, project } });
        result.push({ id: `new-agent:${base}`, group: "Projects", title: `New agent in ${project.name}`, subtitle, host, project,
          selection: { host: host.id, project: project.id } });
      }
      result.push({ id: `new-project:${host.id}`, group: "Actions", title: `New project on ${host.name}`, subtitle: host.name, host, action: { kind: "new-project", host } });
      result.push({ id: `schedules:${host.id}`, group: "Actions", title: `Schedules on ${host.name}`, subtitle: host.name, host, schedules: true });
      for (const section of ["usage", "instructions"] as const) result.push({ id: `${section}:${host.id}`, group: "Actions",
        title: `Host options: ${section[0].toUpperCase()}${section.slice(1)}`, subtitle: host.name, host, action: { kind: "host", host, section } });
    }
    return result;
  }, [hosts, models]);
  const ranked = useMemo(() => rankEntries(entries, query, recent), [entries, query, recent]);
  // Groups follow their best match, keeping the strongest result at the top.
  const availableGroups = [...new Set(ranked.map(result => result.entry.group))];
  const groups = query.trim() ? availableGroups : (["Agents", "Projects", "Actions"] as LauncherGroup[]).filter(group => availableGroups.includes(group));
  const results = groups.flatMap(group => ranked.filter(result => result.entry.group === group));
  const rows: ({ heading: string } | { result: (typeof results)[number]; index: number })[] = [];
  for (const group of groups) {
    rows.push({ heading: group });
    results.forEach((result, index) => { if (result.entry.group === group) rows.push({ result, index }); });
  }
  const selected = Math.min(active, Math.max(0, results.length - 1));
  // Known row heights avoid measuring hundreds of offscreen rows during a
  // group jump. Keep an extra screenful around the visible window for touch.
  let totalHeight = 0;
  const positioned = rows.map(row => {
    const top = totalHeight;
    const height = "heading" in row ? 30 : 68;
    totalHeight += height;
    return { row, top, height };
  });
  useLayoutEffect(() => {
    const element = list.current!;
    const observer = new ResizeObserver(() => setListHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = list.current!;
    const target = positioned.find(item => "index" in item.row && item.row.index === selected);
    if (!target) { element.scrollTop = 0; setScrollTop(0); return; }
    if (target.top < element.scrollTop) element.scrollTop = target.top;
    else if (target.top + target.height > element.scrollTop + element.clientHeight) element.scrollTop = target.top + target.height - element.clientHeight;
    setScrollTop(element.scrollTop);
  }, [selected, query, results.length, listHeight]);
  const open = (entry: Entry, draft = false) => {
    if (draft && !entry.agent) return;
    close();
    if (entry.selection) choose(draft ? { host: entry.host.id, project: entry.agent!.projectId } : entry.selection);
    else if (entry.schedules) openSchedules(entry.host.id);
    else if (entry.action) action(entry.action);
  };
  return createPortal(<dialog ref={dialog} className="launcher" aria-label="Global launcher"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } }}>
    <div className="launcher-search"><SearchGlyph />
      <input ref={input} type="text" role="combobox" aria-label="Search agents, projects and actions" aria-expanded="true" aria-autocomplete="list"
        aria-controls="launcher-results" aria-activedescendant={results.length ? `launcher-option-${selected}` : undefined} placeholder="Search agents, projects, actions…"
        value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          const down = event.key === "ArrowDown" || (event.ctrlKey && event.key.toLowerCase() === "n");
          const up = event.key === "ArrowUp" || (event.ctrlKey && event.key.toLowerCase() === "p");
          if (down || up) { event.preventDefault(); setActive((selected + (down ? 1 : -1) + results.length) % (results.length || 1)); }
          else if (event.key === "Enter") { event.preventDefault(); if (results[selected]) open(results[selected].entry, event.metaKey || event.ctrlKey); }
          else if (event.key === "Tab") {
            event.preventDefault();
            const group = results[selected]?.entry.group;
            const next = groups[(groups.indexOf(group!) + (event.shiftKey ? -1 : 1) + groups.length) % groups.length];
            setActive(Math.max(0, results.findIndex(result => result.entry.group === next)));
          }
        }} />
      <button type="button" aria-label="Close launcher" onClick={close}>×</button>
    </div>
    <div id="launcher-results" role="listbox" aria-label="Launcher results" className="launcher-results" ref={list} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      {rows.length ? <div style={{ height: totalHeight, position: "relative" }}>
        {positioned.filter(item => ("index" in item.row && item.row.index === selected) || (item.top + item.height >= scrollTop - 160 && item.top <= scrollTop + listHeight + 160)).map(({ row, top }) => <div key={"heading" in row ? row.heading : row.result.entry.id} style={{ position: "absolute", top, left: 0, right: 0 }}>
        {"heading" in row ? <div className="launcher-group" role="presentation">{row.heading}</div> : <button type="button" role="option" tabIndex={-1}
          id={`launcher-option-${row.index}`} aria-selected={row.index === selected} className="launcher-result"
          onClick={() => open(row.result.entry)}>
          {row.result.entry.agent ? <ProviderIcon provider={row.result.entry.agent.provider} /> : <span className="launcher-action-icon" aria-hidden="true">{row.result.entry.group === "Projects" ? "▱" : row.result.entry.schedules ? "▦" : row.result.entry.action?.kind === "host" ? "⚙" : "＋"}</span>}
          <span className="launcher-copy"><span className="launcher-title"><Highlight text={row.result.entry.title} positions={row.result.positions} /></span>
            <small title={row.result.entry.subtitle}><Highlight text={row.result.entry.subtitle} positions={row.result.positions} offset={row.result.entry.title.length + 1} /></small></span>
          {row.result.entry.agent && <span className="launcher-state"><AgentActivity agent={row.result.entry.agent} status={row.result.entry.status} online={online && !row.result.entry.host.error} />
            {(row.result.entry.agent.pending?.count || row.result.entry.agent.subagents?.running) ? <small className="launcher-counts">{[row.result.entry.agent.pending?.count ? `${row.result.entry.agent.pending.count} queued` : "", row.result.entry.agent.subagents?.running ? `${row.result.entry.agent.subagents.running} sub` : ""].filter(Boolean).join(" · ")}</small> : null}
            <time dateTime={row.result.entry.agent.updatedAt} title={`Last activity: ${new Date(row.result.entry.agent.updatedAt).toLocaleString()}`}>{age(row.result.entry.agent.updatedAt)}</time></span>}
        </button>}</div>)}
      </div> : <p className="launcher-empty">No matches. Try an agent, project or host name.</p>}
    </div>
    <footer><span>↑↓ / Ctrl N/P · Navigate</span><span>Enter · Open</span><span>⌘/Ctrl Enter · New agent</span><span>Tab · Groups</span><span>Esc · Close</span></footer>
  </dialog>, document.body);
}

export function LauncherDestination({ target, rpc, online, choose, created, close }: {
  target: LauncherAction; rpc: import("./state").Rpc | null; online: boolean; choose: (selection: Selection) => void;
  created: (host: string, project: Project) => void; close: () => void;
}) {
  const host = target.host;
  const available = online && !host.error && !host.loading;
  if (target.kind === "new-project") return <NewProject host={host.id} name={host.name} projects={host.projects} rpc={rpc} online={available} close={close}
    created={project => { close(); created(host.id, project); }} />;
  if (target.kind === "project" && target.project) return <ProjectSettings host={host.id} project={target.project} rpc={rpc} online={available}
    agentCount={host.agents.filter(agent => agent.projectId === target.project!.id && !agent.archivedAt).length} close={close}
    newAgent={() => { close(); choose({ host: host.id, project: target.project!.id }); }} />;
  return <HostSettings host={host.id} name={host.name} state={available ? "online" : "offline"} online={available} rpc={rpc}
    agents={host.agents} projects={host.projects} initialSection={target.section} close={close}
    openAgent={agent => { close(); choose({ host: host.id, project: agent.projectId, id: agent.id }); }} />;
}
