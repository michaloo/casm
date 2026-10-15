import { useEffect, useRef, useState } from "react";
import type { Project } from "@casm/protocol";
import type { Rpc } from "./state";
import { InstructionEditor, ProjectMemories, SettingsDialog, type InstructionFile } from "./settings-shared";
import { MoreGlyph } from "./row-menu";
import { offlineNote } from "./connection";

type Section = "instructions" | "memories" | "info";

/** The project row's ⋯ button: opens the project modal. */
export function ProjectOptions({ host, project, agentCount, rpc, online, newAgent }: {
  host: string; project: Project; agentCount: number; rpc: Rpc | null; online: boolean; newAgent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="row-more" aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Project options for ${project.name}`} title="Project options" onClick={() => setOpen(true)}>
      <MoreGlyph />
    </button>
    {open && <ProjectSettings host={host} project={project} agentCount={agentCount} rpc={rpc} online={online}
      close={() => { setOpen(false); trigger.current?.focus(); }} newAgent={() => { setOpen(false); newAgent(); }} />}
  </>;
}

function ProjectSettings({ host, project, agentCount, rpc, online, close, newAgent }: {
  host: string; project: Project; agentCount: number; rpc: Rpc | null; online: boolean; close: () => void; newAgent: () => void;
}) {
  const [section, setSection] = useState<Section>("instructions");
  return <SettingsDialog label={`${project.name} project`} title={<>{project.name} <span className="settings-kind">project</span></>} closeLabel="Close project options"
    sections={[["instructions", "AGENTS.md"], ["memories", "Memories"], ["info", "Info"]] as const} section={section} setSection={setSection} close={close}
    actions={<button type="button" className="primary" disabled={!online} title={online ? "Start a new agent in this project" : offlineNote} onClick={newAgent}>New agent</button>}>
    <section hidden={section !== "info"} aria-label="Project info">
      <h3>Info</h3><dl className="project-info"><dt>Path</dt><dd><code className="settings-path">{project.path}</code></dd><dt>Group</dt><dd>{project.group || "No group"}</dd><dt>Agents</dt><dd>{agentCount}</dd></dl>
    </section>
    {!online || !rpc ? section !== "info" && <p role="status">Host offline. Reconnect to load project settings.</p> : <>
      <div hidden={section !== "instructions"}><ProjectInstructions host={host} project={project} rpc={rpc} /></div>
      {section === "memories" && <section aria-label="Project memories"><h3>Memories</h3><p className="settings-lede">Read-only provider memories for this project.</p>
        <ProjectMemories host={host} project={project} rpc={rpc} />
      </section>}
    </>}
  </SettingsDialog>;
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
