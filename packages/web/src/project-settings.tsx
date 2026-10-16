import { useEffect, useRef, useState } from "react";
import type { Agent, Project } from "@casm/protocol";
import type { Rpc } from "./state";
import { InstructionEditor, ProjectMemories, SettingsDialog, type InstructionFile } from "./settings-shared";
import { MoreGlyph } from "./row-menu";
import { ServerGlyph } from "./host-menu";
import { copy } from "./transcript";
import { offlineNote } from "./connection";
import { ProjectSchedules } from "./project-schedules";

export type ProjectSection = "instructions" | "memories" | "schedules";

/** The project row's ⋯ button: opens the project modal. */
export function ProjectOptions({ host, hostName, project, agents, rpc, online, newAgent, openAgent }: {
  host: string; hostName: string; project: Project; agents: Agent[]; rpc: Rpc | null; online: boolean; newAgent: () => void;
  openAgent: (agent: Agent) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="row-more" aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Project options for ${project.name}`} title="Project options" onClick={() => setOpen(true)}>
      <MoreGlyph />
    </button>
    {open && <ProjectSettings host={host} hostName={hostName} project={project} agents={agents} rpc={rpc} online={online}
      close={() => { setOpen(false); trigger.current?.focus(); }} newAgent={() => { setOpen(false); newAgent(); }}
      openAgent={(agent) => { setOpen(false); openAgent(agent); }} />}
  </>;
}

/** `agents` are the host's; the Schedules tab targets this project's. */
export function ProjectSettings({ host, hostName, project, agents, rpc, online, initialSection = "instructions", close, newAgent, openAgent }: {
  host: string; hostName: string; project: Project; agents: Agent[]; rpc: Rpc | null; online: boolean; initialSection?: ProjectSection;
  close: () => void; newAgent: () => void; openAgent: (agent: Agent) => void;
}) {
  const [section, setSection] = useState<ProjectSection>(initialSection);
  return <SettingsDialog label={`${project.name} project`} title={<>{project.name} <span className="settings-kind">project</span></>} closeLabel="Close project options"
    subtitle={<ProjectContext project={project} hostName={hostName} />}
    sections={[["instructions", "AGENTS.md"], ["memories", "Memories"], ["schedules", "Schedules"]] as const} section={section} setSection={setSection} close={close}
    actions={<button type="button" className="primary compact" disabled={!online} title={online ? "Start a new agent in this project" : offlineNote} onClick={newAgent}>New agent</button>}>
    {!online || !rpc ? <p role="status">Host offline. Reconnect to load project settings.</p> : <>
      <div hidden={section !== "instructions"}><ProjectInstructions host={host} project={project} rpc={rpc} /></div>
      {section === "memories" && <section aria-label="Project memories"><h3>Memories</h3><p className="settings-lede">Read-only provider memories for this project.</p>
        <ProjectMemories host={host} project={project} rpc={rpc} />
      </section>}
      {section === "schedules" && <section aria-label="Schedules" className="settings-schedules"><h3>Schedules</h3>
        <p className="settings-lede">Prompts sent on a cadence to an agent in this project, or to a new one started here.</p>
        <ProjectSchedules host={host} rpc={rpc} online={online} project={project} agents={agents} openAgent={openAgent} /></section>}
    </>}
  </SettingsDialog>;
}

/** Under the title: where the project lives. The path truncates in the middle,
 * keeping its last folder; the tooltip and Copy give the whole path. */
function ProjectContext({ project, hostName }: { project: Project; hostName: string }) {
  const [copied, setCopied] = useState(false);
  const path = project.path.replace(/\/+$/, "") || project.path;
  const cut = path.lastIndexOf("/");
  const [head, tail] = cut > 0 ? [path.slice(0, cut), path.slice(cut)] : ["", path];
  return <p className="settings-context">
    <code className="middle-path" title={path}><span className="path-head">{head}</span><span className="path-tail">{tail}</span></code>
    <button type="button" className="copy-path" aria-label="Copy project path" title={copied ? "Copied" : "Copy path"}
      onClick={() => void copy(path).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})}>{copied ? "Copied" : "Copy"}</button>
    <span className="settings-context-item" title={`Host: ${hostName}`}><ServerGlyph />{hostName}</span>
    {project.group && <span className="settings-context-item" title="Group">{project.group}</span>}
  </p>;
}

function ProjectInstructions({ host, project, rpc }: { host: string; project: Project; rpc: Rpc }) {
  const [file, setFile] = useState<InstructionFile>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void rpc.call("project.agentsMd", { id: project.id }, host).then((next) => { if (active) setFile(next); }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [rpc, host, project.id]);
  return <section aria-label="Project instructions"><h3>Project AGENTS.md</h3>
    {error && <p role="alert" className="error">{error}</p>}
    {!file && !error && <p role="status">Loading AGENTS.md…</p>}
    {file && <InstructionEditor file={file} saved={setFile} title="AGENTS.md" label="Project instructions" createLabel="Create AGENTS.md"
      save={async (content, expectedSha256) => {
        await rpc.call("project.setAgentsMd", { id: project.id, content, expectedSha256 }, host);
        return rpc.call("project.agentsMd", { id: project.id }, host);
      }}
      load={async () => { const next = await rpc.call("project.agentsMd", { id: project.id }, host); return next.path === file.path ? next : undefined; }} />}
  </section>;
}
