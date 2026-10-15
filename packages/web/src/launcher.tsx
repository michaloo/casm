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
type Icon = "folder" | "plus" | "schedules" | "usage" | "instructions" | "options";
type Entry = SearchEntry & {
  host: Host; icon?: Icon; parts: string[]; agent?: Agent; project?: Project; status?: string;
  schedules?: boolean; action?: LauncherAction; selection?: Selection; alternate?: LauncherAction | Selection; empty?: boolean;
};
export function SearchGlyph() {
  return <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>;
}
/** Line glyphs drawn like the sidebar's server glyph: 20px box, 1.5 stroke. */
function LauncherGlyph({ icon }: { icon: Icon }) {
  return <svg className="launcher-glyph" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    {icon === "folder" && <path d="M2.75 5.5c0-.97.78-1.75 1.75-1.75h3.2l1.8 2h6c.97 0 1.75.78 1.75 1.75v6.75c0 .97-.78 1.75-1.75 1.75H4.5c-.97 0-1.75-.78-1.75-1.75Z" />}
    {icon === "plus" && <path d="M10 4.5v11M4.5 10h11" />}
    {icon === "schedules" && <><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.75 1.75" /></>}
    {icon === "usage" && <path d="M3.5 16.25h13M5.75 13v-2.5M10 13V6.5M14.25 13V9" />}
    {icon === "instructions" && <><path d="M5.25 2.75h6.5l3 3v11.5h-9.5Z" /><path d="M8 9.5h4.5M8 12.5h4.5" /></>}
    {icon === "options" && <><circle cx="10" cy="10" r="2.25" /><path d="M10 2.75v2M10 15.25v2M2.75 10h2M15.25 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4" /></>}
  </svg>;
}
function Highlight({ text, positions, offset = 0 }: { text: string; positions: Set<number>; offset?: number }) {
  if (!positions.size) return <>{text}</>;
  return <>{text.split("").map((char, index) => positions.has(index + offset) ? <mark key={index}>{char}</mark> : char)}</>;
}
function age(time: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(time)) / 60000));
  return !Number.isFinite(minutes) ? "" : minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
const touch = typeof matchMedia === "function" ? matchMedia("(max-width: 600px), (pointer: coarse)") : undefined;
const groupOrder: LauncherGroup[] = ["Agents", "Projects", "Actions"];

export function Launcher({ hosts, models, online, current, choose, action, close }: {
  hosts: Host[]; models: Record<string, ModelInfo[]>; online: boolean; current?: string; choose: (selection: Selection) => void;
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
  const [compact, setCompact] = useState(() => !touch?.matches);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal(); input.current?.focus();
    const change = () => setCompact(!touch?.matches);
    touch?.addEventListener("change", change);
    return () => {
      touch?.removeEventListener("change", change);
      requestAnimationFrame(() => { if (!document.querySelector("dialog[open]")) previous?.isConnected && previous.focus(); });
    };
  }, []);
  const many = hosts.length > 1;
  const entries = useMemo(() => {
    const result: Entry[] = [];
    // Host actions are listed once, for the current host, until the user types.
    const home = hosts.find(host => host.id === current) ?? hosts[0];
    for (const host of hosts) {
      const projects = new Map(host.projects.filter(project => !project.archivedAt).map(project => [project.id, project]));
      const latest = new Map<string, number>();
      for (const agent of host.agents) {
        if (agent.archivedAt || !projects.has(agent.projectId)) continue;
        const project = projects.get(agent.projectId)!;
        const cached = chats.get(key(host.id, agent.id));
        const status = agent.status === "idle" && (cached?.failed || cached?.pending.some(item => item.reason === "failed")) ? "failed" : agent.status;
        const label = modelLabels(agent.config.model, agent.effectiveModel, models[`${host.id}\n${agent.provider}`] ?? []);
        const activity = Date.parse(agent.updatedAt) || 0;
        const id = agentRecentKey(host.id, agent.id);
        latest.set(project.id, Math.max(latest.get(project.id) ?? 0, recent[id] ?? 0, activity));
        const parts = [project.name, label.actual ?? (agent.config.model ? label.selectedLabel : label.sessionLabel) ?? "", host.name, providerNames[agent.provider]];
        result.push({ id, group: "Agents", title: agent.name, parts, subtitle: parts.join(" · "),
          attention: status === "waiting" || status === "failed" || !!agent.pending?.held || !!agent.deferred,
          running: status === "running", activity, host, project, agent, status,
          selection: { host: host.id, project: project.id, id: agent.id }, alternate: { host: host.id, project: project.id } });
      }
      for (const project of projects.values()) {
        const base = `${host.id}\n${project.id}`;
        const parts = [project.path, host.name];
        result.push({ id: `project:${base}`, group: "Projects", title: project.name, parts, subtitle: parts.join(" · "), icon: "folder", host, project,
          activity: latest.get(project.id) ?? 0, selection: { host: host.id, project: project.id }, alternate: { kind: "project", host, project } });
        const options = [project.name, host.name];
        result.push({ id: `options:${base}`, group: "Actions", title: "Project options", parts: options, subtitle: options.join(" · "), icon: "options", host, project,
          action: { kind: "project", host, project } });
      }
      const hostParts = [host.name];
      const empty = host === home;
      result.push({ id: `new-project:${host.id}`, group: "Actions", title: "New project", parts: hostParts, subtitle: host.name, icon: "plus", host, empty, action: { kind: "new-project", host } });
      result.push({ id: `schedules:${host.id}`, group: "Actions", title: "Schedules", parts: hostParts, subtitle: host.name, icon: "schedules", host, empty, schedules: true });
      for (const section of ["usage", "instructions"] as const) result.push({ id: `${section}:${host.id}`, group: "Actions",
        title: `Host ${section}`, parts: hostParts, subtitle: host.name, icon: section, host, action: { kind: "host", host, section } });
    }
    return result;
  }, [hosts, models, current, recent]);
  const searching = !!query.trim();
  const ranked = useMemo(() => {
    const all = rankEntries(entries, query, recent);
    if (searching) return all;
    // The empty state is a short start page: agents that need you, then running,
    // then recent ones; the busiest projects; and this host's main actions.
    const agents = all.filter(result => result.entry.group === "Agents");
    const urgent = agents.filter(result => result.entry.attention || result.entry.running).length;
    const projects = all.filter(result => result.entry.group === "Projects").sort((a, b) => (b.entry.activity ?? 0) - (a.entry.activity ?? 0));
    return [...agents.slice(0, Math.min(16, Math.max(8, urgent))), ...projects.slice(0, 4), ...all.filter(result => result.entry.empty)];
  }, [entries, query, recent, searching]);
  // While searching, groups follow their best match, keeping the strongest result at the top.
  const availableGroups = [...new Set(ranked.map(result => result.entry.group))];
  const groups = searching ? availableGroups : groupOrder.filter(group => availableGroups.includes(group));
  const results = groups.flatMap(group => ranked.filter(result => result.entry.group === group));
  const rows: ({ heading: string } | { result: (typeof results)[number]; index: number })[] = [];
  for (const group of groups) {
    rows.push({ heading: group });
    results.forEach((result, index) => { if (result.entry.group === group) rows.push({ result, index }); });
  }
  const selected = Math.min(active, Math.max(0, results.length - 1));
  // Known row heights avoid measuring hundreds of offscreen rows during a
  // group jump. Keep an extra screenful around the visible window for touch.
  const rowHeight = compact ? 38 : 44;
  let totalHeight = 6;
  const positioned = rows.map((row, at) => {
    const top = totalHeight;
    const height = "heading" in row ? (at ? 34 : 28) : rowHeight;
    totalHeight += height;
    return { row, top, height };
  });
  totalHeight += 6;
  useLayoutEffect(() => {
    const element = list.current!;
    const observer = new ResizeObserver(() => setListHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = list.current!;
    const index = positioned.findIndex(item => "index" in item.row && item.row.index === selected);
    const target = positioned[index];
    if (!target) { element.scrollTop = 0; setScrollTop(0); return; }
    // Show a group's heading along with its first row.
    const top = "heading" in (positioned[index - 1]?.row ?? {}) ? (index === 1 ? 0 : positioned[index - 1].top) : target.top;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (target.top + target.height > element.scrollTop + element.clientHeight) element.scrollTop = target.top + target.height - element.clientHeight + 6;
    setScrollTop(element.scrollTop);
  }, [selected, query, results.length, listHeight, rowHeight]);
  const open = (entry: Entry, alternate = false) => {
    const target = alternate ? entry.alternate : entry.selection ?? entry.action;
    if (!target && !entry.schedules) return;
    close();
    if (entry.schedules && !alternate) openSchedules(entry.host.id);
    else if (target && "kind" in target) action(target);
    else if (target) choose(target);
  };
  const current_ = results[selected]?.entry;
  const hint = current_?.agent ? "New agent in project" : current_?.group === "Projects" ? "Project options" : "";
  return createPortal(<dialog ref={dialog} className="launcher" aria-label="Global launcher"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } }}>
    <div className="launcher-search"><SearchGlyph />
      <input ref={input} type="text" role="combobox" aria-label="Search agents, projects and actions" aria-expanded="true" aria-autocomplete="list"
        aria-controls="launcher-results" aria-activedescendant={results.length ? `launcher-option-${selected}` : undefined} placeholder={compact ? "Search agents, projects, actions…" : "Search agents and projects"}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go"
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
      <button type="button" className="launcher-close" aria-label="Close launcher" onClick={close}>Cancel</button>
    </div>
    <div id="launcher-results" role="listbox" aria-label="Launcher results" className="launcher-results" ref={list} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      {rows.length ? <div style={{ height: totalHeight, position: "relative" }}>
        {positioned.filter(item => ("index" in item.row && item.row.index === selected) || (item.top + item.height >= scrollTop - 160 && item.top <= scrollTop + listHeight + 160)).map(({ row, top, height }) => <div key={"heading" in row ? row.heading : row.result.entry.id} style={{ position: "absolute", top, height, left: 0, right: 0 }}>
        {"heading" in row ? <div className="launcher-group" role="presentation">{row.heading}</div> : <LauncherRow entry={row.result.entry} positions={row.result.positions}
          index={row.index} selected={row.index === selected} many={many} online={online} open={open} hover={() => setActive(row.index)} />}</div>)}
      </div> : <p className="launcher-empty">No matches for “{query.trim()}”</p>}
    </div>
    <footer aria-hidden="true">
      <span><kbd>↵</kbd> Open</span>
      {hint && <span><kbd>{mac ? "⌘" : "Ctrl"}</kbd><kbd>↵</kbd> {hint}</span>}
      <span><kbd>Tab</kbd> Next group</span>
      <span className="launcher-footer-end"><kbd>Esc</kbd> Close</span>
    </footer>
  </dialog>, document.body);
}
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function LauncherRow({ entry, positions, index, selected, many, online, open, hover }: {
  entry: Entry; positions: number[]; index: number; selected: boolean; many: boolean; online: boolean;
  open: (entry: Entry) => void; hover: () => void;
}) {
  const hits = new Set(positions);
  const agent = entry.agent;
  // Matches inside hidden fields (provider, host) still count; only shown text is marked.
  let offset = entry.title.length + 1;
  const parts = entry.parts.map(text => { const part = { text, offset }; offset += text.length + 3; return part; });
  const shown = agent ? parts.slice(0, 2) : entry.group === "Projects" ? parts.slice(0, 1) : parts;
  const host = agent ? parts[2] : entry.group === "Projects" ? parts[1] : undefined;
  const counts = agent ? [agent.pending?.count ? `${agent.pending.count} queued` : "", agent.subagents?.running ? `${agent.subagents.running} sub` : ""].filter(Boolean).join(" · ") : "";
  return <button type="button" role="option" tabIndex={-1} id={`launcher-option-${index}`} aria-selected={selected} className="launcher-result"
    onClick={() => open(entry)} onPointerMove={selected ? undefined : hover}>
    <span className="launcher-icon">{agent ? <ProviderIcon provider={agent.provider} /> : <LauncherGlyph icon={entry.icon!} />}</span>
    <span className="launcher-title"><Highlight text={entry.title} positions={hits} /></span>
    <span className="launcher-detail">{shown.filter(part => part.text).map((part, at) => <span key={at}>
      <Highlight text={part.text} positions={hits} offset={part.offset} /></span>)}</span>
    <span className="launcher-meta">
      {counts && <span className="launcher-counts">{counts}</span>}
      {host && many && <span className="launcher-host"><Highlight text={host.text} positions={hits} offset={host.offset} /></span>}
      {agent && <AgentActivity agent={agent} status={entry.status} online={online && !entry.host.error} />}
      {agent && <time dateTime={agent.updatedAt} title={`Last activity: ${new Date(agent.updatedAt).toLocaleString()}`}>{age(agent.updatedAt)}</time>}
    </span>
  </button>;
}

export function LauncherDestination({ target, rpc, online, choose, created, close }: {
  target: LauncherAction; rpc: import("./state").Rpc | null; online: boolean; choose: (selection: Selection) => void;
  created: (host: string, project: Project) => void; close: () => void;
}) {
  const host = target.host;
  const available = online && !host.error && !host.loading;
  if (target.kind === "new-project") return <NewProject host={host.id} name={host.name} projects={host.projects} rpc={rpc} online={available} close={close}
    created={project => { close(); created(host.id, project); }} />;
  if (target.kind === "project" && target.project) return <ProjectSettings host={host.id} hostName={host.name} project={target.project} rpc={rpc} online={available} close={close}
    newAgent={() => { close(); choose({ host: host.id, project: target.project!.id }); }} />;
  return <HostSettings host={host.id} name={host.name} state={available ? "online" : "offline"} online={available} rpc={rpc}
    agents={host.agents} projects={host.projects} initialSection={target.section} close={close}
    openAgent={agent => { close(); choose({ host: host.id, project: agent.projectId, id: agent.id }); }} />;
}
