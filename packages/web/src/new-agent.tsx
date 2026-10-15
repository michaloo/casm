import type { Project } from "@casm/protocol";
import { ServerGlyph } from "./host-menu";

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

/** Below the composer: the keys. */
export function NewAgentKeys({ mac }: { mac: boolean }) {
  return <div className="start-extras">
    <p className="start-keys">
      <span><kbd>Enter</kbd> send</span>
      <span><kbd>Shift</kbd><kbd>Enter</kbd> newline</span>
      <span><kbd>/</kbd> commands</span>
      <span><kbd>{mac ? "⌘" : "Ctrl"}</kbd><kbd>K</kbd> launcher</span>
    </p>
  </div>;
}
