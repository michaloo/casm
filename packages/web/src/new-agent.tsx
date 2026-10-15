import type { Agent, Project } from "@casm/protocol";
import { ServerGlyph } from "./host-menu";
import { ProviderIcon } from "./provider-icon";
import { agoLabel } from "./schedule-label";

// Starter chips fill the composer; nothing is sent until the user says so.
const starters = [
  { label: "Explore this project", prompt: "Explore this project and give me a short overview: what it does, how it is laid out, and how to build and test it." },
  { label: "Summarize recent changes", prompt: "Summarize the recent changes in this project (the git log and any uncommitted work), grouped by theme." },
  { label: "Run the tests", prompt: "Run this project's tests and report what passes and what fails, with the likely cause of each failure." },
];

/** The new-agent screen above the composer: where the agent will run. */
export function NewAgentWelcome({ project, host }: { project: Project; host: string }) {
  return <div className="start-welcome">
    <span className="brand-glyph start-glyph" aria-hidden="true" />
    <p className="start-eyebrow">New agent in</p>
    <h1>{project.name}</h1>
    <p className="start-context">
      <code title={project.path}>{project.path}</code>
      <span className="start-host" title={`Runs on ${host}`}><ServerGlyph />{host}</span>
    </p>
  </div>;
}

/** Below the composer: starter prompts, the project's recent agents, and the keys. */
export function NewAgentStarters({ agents, fill, open, mac }: {
  agents: Agent[]; fill: (prompt: string) => void; open: (agent: Agent) => void; mac: boolean;
}) {
  const recent = agents.filter((a) => !a.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  return <div className="start-extras">
    <div className="start-chips" role="group" aria-label="Starter prompts">
      {starters.map((s) => <button type="button" key={s.label} className="start-chip" title={s.prompt} onClick={() => fill(s.prompt)}>{s.label}</button>)}
    </div>
    {recent.length > 0 && <div className="start-chips start-recent" role="group" aria-label="Recent agents in this project">
      <span className="start-label">Jump back in</span>
      {recent.map((a) => <button type="button" key={a.id} className="start-chip start-agent" title={`Open ${a.name}`} onClick={() => open(a)}>
        <ProviderIcon provider={a.provider} /><span className="start-agent-name">{a.name}</span><small>{agoLabel(a.updatedAt)}</small>
      </button>)}
    </div>}
    <p className="start-keys">
      <span><kbd>Enter</kbd> send</span>
      <span><kbd>Shift</kbd><kbd>Enter</kbd> newline</span>
      <span><kbd>/</kbd> commands</span>
      <span><kbd>{mac ? "⌘" : "Ctrl"}</kbd><kbd>K</kbd> launcher</span>
    </p>
  </div>;
}
