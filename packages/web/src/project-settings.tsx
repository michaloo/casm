import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Project } from "@casm/protocol";
import type { Rpc } from "./state";
import { InstructionEditor, ProjectMemories, type InstructionFile } from "./settings-shared";
import { FileBrowser, FilePreview } from "./files";

export function ProjectSettingsButton({ host, project, agentCount, rpc, online, newAgent }: {
  host: string; project: Project; agentCount: number; rpc: Rpc | null; online: boolean; newAgent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="project-settings-trigger" aria-label={`Settings for ${project.name}`} title={`Settings for ${project.name}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>⋯</button>
    {open && <ProjectSettings host={host} project={project} agentCount={agentCount} rpc={rpc} online={online}
      close={() => { setOpen(false); trigger.current?.focus(); }} newAgent={() => { setOpen(false); newAgent(); }} />}
  </>;
}

function ProjectSettings({ host, project, agentCount, rpc, online, close, newAgent }: {
  host: string; project: Project; agentCount: number; rpc: Rpc | null; online: boolean; close: () => void; newAgent: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<"instructions" | "memories" | "files" | "info">("instructions");
  useEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} className="host-settings" aria-label={`${project.name} project settings`} onClose={close}>
    <header><h2>{project.name} settings</h2><button type="button" aria-label="Close project settings" onClick={() => dialog.current?.close()}>×</button></header>
    <nav aria-label="Project settings sections">{([["instructions", "AGENTS.md"], ["memories", "Memories"], ["files", "Files"], ["info", "Project info"]] as const).map(([id, name]) =>
      <button key={id} type="button" aria-pressed={section === id} onClick={() => setSection(id)}>{name}</button>)}</nav>
    <div className="settings-content">
      <section hidden={section !== "info"} aria-label="Project info">
        <h3>Project info</h3><dl className="project-info"><dt>Path</dt><dd><code className="settings-path">{project.path}</code></dd><dt>Group</dt><dd>{project.group || "No group"}</dd><dt>Agents</dt><dd>{agentCount}</dd></dl>
        <button type="button" disabled={!online} onClick={newAgent}>New agent here</button>
      </section>
      {!online || !rpc ? section !== "info" && <p role="status">Host offline. Reconnect to load project settings.</p> : <>
        <div hidden={section !== "instructions"}><ProjectInstructions host={host} project={project} rpc={rpc} /></div>
        {section === "files" && <ProjectFiles host={host} project={project} rpc={rpc} />}
        <section hidden={section !== "memories"} aria-label="Project memories"><h3>Memories</h3><p>Read-only provider memories for this project.</p><ProjectMemories host={host} project={project} rpc={rpc} initiallyOpen /></section>
      </>}
    </div>
  </dialog>, document.body);
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

function ProjectFiles({ host, project, rpc }: { host: string; project: Project; rpc: Rpc }) {
  const [dir, setDir] = useState(project.path);
  const [preview, setPreview] = useState<string>();
  return <section aria-label="Project files"><h3>Files</h3><p>Read-only. Open a file to preview or download it.</p>
    <FileBrowser rpc={rpc} host={host} root={project.path} dir={dir} setDir={setDir} openFile={setPreview} />
    {preview && <FilePreview rpc={rpc} host={host} path={preview} roots={[project.path]} close={() => setPreview(undefined)} />}
  </section>;
}
