import { InstructionEditor, ProjectMemories } from "./settings-shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentPromptInfo, HostAgentsMdFile, Project } from "@casm/protocol";
import type { Rpc } from "./state";
import { providerNames } from "./provider-icon";
import { Prose } from "./transcript";

type Section = "instructions" | "memories" | "prompt";
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export function HostSettings({ host, name, rpc, online, projects, close }: {
  host: string; name: string; rpc: Rpc | null; online: boolean; projects: Project[]; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<Section>("instructions");
  useEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} className="host-settings" aria-label={`${name} settings`} onClose={close}>
    <header><h2>{name} settings</h2><button type="button" aria-label="Close settings" onClick={() => dialog.current?.close()}>×</button></header>
    <nav aria-label="Settings sections">
      {([ ["instructions", "AGENTS.md"], ["memories", "Memories"], ["prompt", "Agent prompt"] ] as const).map(([id, label]) =>
        <button type="button" key={id} aria-pressed={section === id} onClick={() => setSection(id)}>{label}</button>)}
    </nav>
    <div className="settings-content">
      {!online || !rpc ? <p role="status">Host offline. Reconnect to load settings.</p> : <>
        <div hidden={section !== "instructions"}><Instructions host={host} rpc={rpc} /></div>
        <div hidden={section !== "memories"}><Memories host={host} rpc={rpc} projects={projects} /></div>
        <div hidden={section !== "prompt"}><HostPrompt host={host} rpc={rpc} /></div>
      </>}
    </div>
  </dialog>, document.body);
}

function Instructions({ host, rpc }: { host: string; rpc: Rpc }) {
  const [files, setFiles] = useState<HostAgentsMdFile[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void rpc.call("host.agentsMd", {}, host).then((r) => { if (active) setFiles(r.files); }).catch((e) => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [host, rpc]);
  return <section aria-label="Global agent instructions">
    <h3>Global agent instructions</h3>
    <p>Instructions used across projects on this host. Providers sharing a file are shown together. Changes apply when their next session loads instructions.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!files && !error && <p role="status">Loading instruction files…</p>}
    {files?.map((file) => <Instruction key={file.path} file={file} host={host} rpc={rpc} saved={(next) => setFiles((list) => list?.map((f) => f.path === next.path ? next : f))} />)}
  </section>;
}

function Instruction({ file, host, rpc, saved }: { file: HostAgentsMdFile; host: string; rpc: Rpc; saved: (file: HostAgentsMdFile) => void }) {
  return <InstructionEditor file={file} saved={saved} title={file.sources.map((s) => providerNames[s.provider]).join(" · ")}
    save={(content, expectedSha256) => rpc.call("host.setAgentsMd", { path: file.path, content, expectedSha256 }, host)}
    load={async () => (await rpc.call("host.agentsMd", {}, host)).files.find((f) => f.path === file.path)}>
    <details><summary>Provider paths</summary><ul>{file.sources.map((s) => <li key={s.provider}>{providerNames[s.provider]}: <code>{s.path}</code></li>)}</ul></details>
  </InstructionEditor>;
}

function Memories({ host, rpc, projects }: { host: string; rpc: Rpc; projects: Project[] }) {
  return <section aria-label="Provider memories"><h3>Memories</h3><p>Read-only provider memories, grouped by project.</p>
    {!projects.length && <p>No projects on this host.</p>}
    {[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((project) => <ProjectMemories key={project.id} host={host} rpc={rpc} project={project} />)}
  </section>;
}


function HostPrompt({ host, rpc }: { host: string; rpc: Rpc }) {
  const [info, setInfo] = useState<AgentPromptInfo>();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    let active = true;
    void rpc.call("server.agentPrompt", {}, host).then((r) => { if (active) { setInfo(r); setText(r.content); } }).catch((e) => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [host, rpc]);
  const update = (params: { content?: string | null; enabled?: boolean }) => {
    setBusy(true); setError("");
    void rpc.call("server.setAgentPrompt", params, host).then((r) => {
      setInfo(r); if (params.content !== undefined) { setText(r.content); setEditing(false); }
      setResetting(false);
    }).catch((e) => setError(message(e))).finally(() => setBusy(false));
  };
  return <section aria-label="Host agent prompt"><h3>Agent prompt</h3><p>The casm prompt added when an agent session starts or resumes.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!info && !error && <p role="status">Loading agent prompt…</p>}
    {info && <>
      <label className="settings-toggle"><input type="checkbox" checked={info.enabled} disabled={busy} onChange={(e) => update({ enabled: e.target.checked })} />Enable host agent prompt</label>
      <p>{info.custom ? "Custom template" : "Default template"}</p>
      {info.path && <code className="settings-path">{info.path}</code>}
      {editing ? <form onSubmit={(e) => { e.preventDefault(); update({ content: text }); }}>
        <label>Agent prompt template<textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} /></label>
        <p>Placeholders: {info.placeholders.map((p) => `{{${p}}}`).join(", ")}</p>
        <div className="settings-actions"><button disabled={busy}>Save agent prompt</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel edit</button></div>
      </form> : <button type="button" disabled={busy} onClick={() => { setText(info.content); setEditing(true); }}>Edit agent prompt</button>}
      {info.custom && <div className="settings-actions">{resetting ? <><span>Replace the custom template with the default?</span><button disabled={busy} onClick={() => update({ content: null })}>Confirm reset</button><button disabled={busy} onClick={() => setResetting(false)}>Keep custom prompt</button></> : <button disabled={busy} onClick={() => setResetting(true)}>Reset to default</button>}</div>}
      <h4>Example agent preview</h4>{info.rendered ? <Prose text={info.rendered} /> : <p>The host agent prompt is disabled.</p>}
    </>}
  </section>;
}
