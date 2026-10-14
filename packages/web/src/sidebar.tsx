import { useState } from "react";
import type { Agent } from "@casm/protocol";
import type { Host } from "./state";
import { key } from "./state";
export type Selection = { host: string; project: string; id?: string };
type Entry = { host: Host; agent: Agent };
const order = (a: Entry, b: Entry) =>
  a.agent.name.localeCompare(b.agent.name) ||
  a.agent.createdAt.localeCompare(b.agent.createdAt) ||
  a.host.id.localeCompare(b.host.id) ||
  a.agent.id.localeCompare(b.agent.id);
const route = (e: Entry) => key(e.host.id, e.agent.id);
export function agentTree(hosts: Host[]) {
  const entries = hosts
    .flatMap((host) => host.agents.map((agent) => ({ host, agent })))
    .sort(order);
  const canonical = new Map(
    entries
      .filter((e) => e.host.serverId)
      .map((e) => [key(e.host.serverId!, e.agent.id), e]),
  );
  const parents = new Map<string, Entry>();
  for (const e of entries) {
    const p = e.agent.parent;
    const parent = p && canonical.get(key(p.serverId, p.agentId));
    if (parent && parent !== e) parents.set(route(e), parent);
  }
  // Malformed imported parent cycles must never hide rows or recurse forever.
  const raw = new Map(parents);
  for (const e of entries) {
    const seen = new Set([route(e)]);
    let p = raw.get(route(e));
    while (p) {
      if (seen.has(route(p))) {
        parents.delete(route(e));
        break;
      }
      seen.add(route(p));
      p = raw.get(route(p));
    }
  }
  const children = new Map<string, Entry[]>();
  for (const e of entries) {
    const p = parents.get(route(e));
    if (p) children.set(route(p), [...(children.get(route(p)) ?? []), e]);
  }
  return { entries, parents, children };
}
type Tree = ReturnType<typeof agentTree>;
export function ProjectAgents({
  tree,
  host,
  project,
  selection,
  choose,
}: {
  tree: Tree;
  host: Host;
  project: string;
  selection?: Selection;
  choose: (s: Selection) => void;
}) {
  return (
    <>
      {tree.entries
        .filter((e) => e.host.id === host.id && e.agent.projectId === project)
        .filter((e) => {
          const p = tree.parents.get(route(e));
          return !p || p.host.id !== host.id || p.agent.projectId !== project;
        })
        .map((e) => (
          <AgentBranch
            key={route(e)}
            entry={e}
            tree={tree}
            selection={selection}
            choose={choose}
            depth={0}
          />
        ))}
    </>
  );
}
function AgentBranch({
  entry: e,
  tree,
  selection,
  choose,
  depth,
}: {
  entry: Entry;
  tree: Tree;
  selection?: Selection;
  choose: (s: Selection) => void;
  depth: number;
}) {
  const a = e.agent;
  const parent = tree.parents.get(route(e));
  const children = tree.children.get(route(e)) ?? [];
  const [open, setOpen] = useState(() =>
    children.some(
      (c) => c.host.id === e.host.id && c.agent.projectId === a.projectId,
    ),
  );
  const pick = (target: Entry) =>
    choose({
      host: target.host.id,
      project: target.agent.projectId,
      id: target.agent.id,
    });
  return (
    <div
      className="agent-branch"
      data-agent-id={a.id}
      style={
        depth
          ? { marginLeft: 12, borderLeft: "1px solid var(--line)" }
          : undefined
      }
    >
      <button
        className={`agent ${selection?.id === a.id && selection.host === e.host.id ? "selected" : ""}`}
        onClick={() => pick(e)}
      >
        <span className={`dot ${a.status}`} />
        <span className="agent-name">{a.name}</span>
        <small>
          {a.pending?.count ? `${a.pending.count} queued ` : ""}
          {a.subagents?.running ? `${a.subagents.running} sub ` : ""}
          {a.status}
        </small>
      </button>
      {parent && (
        <button className="parent-link" onClick={() => pick(parent)}>
          ↳ from {parent.agent.name}
        </button>
      )}
      {depth > 0 &&
        (e.host.id !== parent?.host.id ||
          a.projectId !== parent?.agent.projectId) && (
          <small className="agent-location">
            {e.host.name} ·{" "}
            {e.host.projects.find((p) => p.id === a.projectId)?.name ??
              a.projectId}
          </small>
        )}
      {children.length > 0 && (
        <>
          <button
            className="children-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "▾" : "▸"} {children.length} casm agents
          </button>
          {open && (
            <div role="group" aria-label={`Children of ${a.name}`}>
              {children.map((child) => (
                <AgentBranch
                  key={route(child)}
                  entry={child}
                  tree={tree}
                  selection={selection}
                  choose={choose}
                  depth={depth + 1}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
