import { useState } from "react";
import type { Project } from "@casm/protocol";

export type ProjectOrders = Record<string, string[]>;
const storageKey = "casm.project-orders";

export function readProjectOrders(storage: Pick<Storage, "getItem">): ProjectOrders {
  try {
    const value: unknown = JSON.parse(storage.getItem(storageKey) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, order]) =>
      Array.isArray(order) && order.every(id => typeof id === "string")));
  } catch { return {}; }
}

export function saveProjectOrders(storage: Pick<Storage, "setItem">, orders: ProjectOrders) {
  try { storage.setItem(storageKey, JSON.stringify(orders)); } catch { /* Optional preference. */ }
}

export function orderedProjects(projects: readonly Project[], order: readonly string[] = []): Project[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...projects].sort((a, b) =>
    (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length) ||
    a.sort - b.sort || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export type ProjectOrderControls = { projects: readonly Project[]; change: (ids: string[]) => void };

export function ProjectOrder({ projects, change }: ProjectOrderControls) {
  const [announcement, announce] = useState("");
  return <section aria-label="Project order">
    <h3>Project order</h3>
    <p className="settings-lede">Choose a position to move a project. This order is saved in this browser.</p>
    <ol className="project-order-list">
      {projects.map((project, index) => <li key={project.id}>
        <label>
          <span>{project.name}</span>
          <select aria-label={`Position of ${project.name}`} value={index} onChange={event => {
            const position = Number(event.currentTarget.value);
            const ids = projects.map(p => p.id);
            ids.splice(index, 1);
            ids.splice(position, 0, project.id);
            change(ids);
            announce(`${project.name} moved to position ${position + 1}.`);
          }}>
            {projects.map((p, i) => <option key={p.id} value={i}>{i === 0 ? "1 (top)" : i + 1}</option>)}
          </select>
        </label>
      </li>)}
    </ol>
    <span className="visually-hidden" role="status">{announcement}</span>
  </section>;
}
