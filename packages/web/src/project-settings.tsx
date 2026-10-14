import { useEffect, useRef, useState } from "react";
import type { Project } from "@casm/protocol";
import type { Rpc } from "./state";
import { InstructionEditor, MemorySearch, ProjectMemories, SettingsDialog, type InstructionFile } from "./settings-shared";
import { FileBrowser, FilePreview } from "./files";
import { RowMenu } from "./row-menu";

type Section = "instructions" | "memories" | "files" | "info";

/** The project row's ⋯ menu: settings, files and a new agent. */
export function ProjectMenu({ host, project, agentCount, rpc, online, newAgent }: {
  host: string; project: Project; agentCount: number; rpc: Rpc | null; online: boolean; newAgent: () => void;
}) {
  const [open, setOpen] = useState<Section>();
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <RowMenu label={`Project options for ${project.name}`} title="Project options" triggerRef={trigger}
      heading={<span><strong>{project.name}</strong><small>{agentCount === 1 ? "1 agent" : `${agentCount} agents`}</small></span>}
      items={[
        { label: "Settings", hint: "AGENTS.md, memories and project info", onSelect: () => setOpen("instructions") },
        { label: "Files", hint: "Browse, preview and download", onSelect: () => setOpen("files") },
        { label: "New agent here", hint: "Start a conversation in this project", disabled: !online, onSelect: newAgent },
      ]} />
    {open && <ProjectSettings host={host} project={project} agentCount={agentCount} rpc={rpc} online={online} initial={open}
      close={() => { setOpen(undefined); trigger.current?.focus(); }} newAgent={() => { setOpen(undefined); newAgent(); }} />}
  </>;
}

function ProjectSettings({ host, project, agentCount, rpc, online, close, newAgent, initial }: {
  host: string; project: Project; agentCount: number; rpc: Rpc | null; online: boolean; close: () => void; newAgent: () => void; initial: Section;
}) {
  const [section, setSection] = useState<Section>(initial);
  const [query, setQuery] = useState("");
  return <SettingsDialog label={`${project.name} project settings`} title={<>{project.name} <span className="settings-kind">project settings</span></>} closeLabel="Close project settings"
    sections={[["instructions", "AGENTS.md"], ["memories", "Memories"], ["files", "Files"], ["info", "Project info"]] as const} section={section} setSection={setSection} close={close}>
    <section hidden={section !== "info"} aria-label="Project info">
      <h3>Project info</h3><dl className="project-info"><dt>Path</dt><dd><code className="settings-path">{project.path}</code></dd><dt>Group</dt><dd>{project.group || "No group"}</dd><dt>Agents</dt><dd>{agentCount}</dd></dl>
      <button type="button" className="primary" disabled={!online} onClick={newAgent}>New agent here</button>
    </section>
    {!online || !rpc ? section !== "info" && <p role="status">Host offline. Reconnect to load project settings.</p> : <>
      <div hidden={section !== "instructions"}><ProjectInstructions host={host} project={project} rpc={rpc} /></div>
      {section === "files" && <ProjectFiles host={host} project={project} rpc={rpc} />}
      <section hidden={section !== "memories"} aria-label="Project memories"><h3>Memories</h3><p className="settings-lede">Read-only provider memories for this project.</p>
        <MemorySearch query={query} setQuery={setQuery} />
        <ProjectMemories host={host} project={project} rpc={rpc} initiallyOpen query={query} />
        {query.trim() && <p className="settings-note">Only matching memories are shown.</p>}
      </section>
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

function ProjectFiles({ host, project, rpc }: { host: string; project: Project; rpc: Rpc }) {
  const [dir, setDir] = useState(project.path);
  const [preview, setPreview] = useState<string>();
  return <section aria-label="Project files"><h3>Files</h3><p className="settings-lede">Read-only. Open a file to preview or download it.</p>
    <FileBrowser rpc={rpc} host={host} root={project.path} dir={dir} setDir={setDir} openFile={setPreview} />
    {preview && <FilePreview rpc={rpc} host={host} path={preview} roots={[project.path]} close={() => setPreview(undefined)} />}
  </section>;
}
