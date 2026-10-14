import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentMemories, AgentPromptInfo, HostAgentsMdFile, Project } from "@casm/protocol";
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
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(file.content ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [latest, setLatest] = useState<HostAgentsMdFile>();
  return <article className="settings-card">
    <h4>{file.sources.map((s) => providerNames[s.provider]).join(" · ")}</h4>
    <code className="settings-path">{file.path}</code>
    <details><summary>Provider paths</summary><ul>{file.sources.map((s) => <li key={s.provider}>{providerNames[s.provider]}: <code>{s.path}</code></li>)}</ul></details>
    {editing ? <form onSubmit={(e) => {
      e.preventDefault(); setBusy(true); setError(""); setLatest(undefined);
      void rpc.call("host.setAgentsMd", { path: file.path, content: text, expectedSha256: file.sha256 }, host)
        .then((next) => { saved(next); setEditing(false); }).catch((e) => setError(message(e))).finally(() => setBusy(false));
    }}>
      <label>Global instructions<textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} /></label>
      <div className="settings-actions"><button disabled={busy}>Save instructions</button><button type="button" disabled={busy} onClick={() => { setEditing(false); setError(""); setLatest(undefined); }}>Cancel edit</button></div>
    </form> : <>
      {file.content === null ? <p>This file does not exist yet.</p> : file.content ? <Prose text={file.content} /> : <p>This file is empty.</p>}
      <button type="button" onClick={() => { setText(file.content ?? ""); setEditing(true); }}>{file.content === null ? "Create instructions" : "Edit instructions"}</button>
    </>}
    {error && <div role="alert" className="error"><p>{error}</p><p>Your draft has been kept.</p><button type="button" disabled={busy} onClick={() => {
      setBusy(true);
      void rpc.call("host.agentsMd", {}, host).then((r) => {
        const found = r.files.find((f) => f.path === file.path);
        if (found) setLatest(found); else setError("The file target changed. Close and reopen settings to load the current files; copy your draft first.");
      }).catch((e) => setError(message(e))).finally(() => setBusy(false));
    }}>Review latest version</button></div>}
    {latest && <div className="settings-latest"><h4>Latest version on host</h4><Prose text={latest.content ?? "File no longer exists."} />
      <button type="button" onClick={() => { saved(latest); setLatest(undefined); setError(""); }}>Keep my draft and use this version for the next save</button>
      <button type="button" onClick={() => { saved(latest); setText(latest.content ?? ""); setLatest(undefined); setError(""); }}>Replace draft with latest</button>
    </div>}
  </article>;
}

function Memories({ host, rpc, projects }: { host: string; rpc: Rpc; projects: Project[] }) {
  return <section aria-label="Provider memories"><h3>Memories</h3><p>Read-only provider memories, grouped by project.</p>
    {!projects.length && <p>No projects on this host.</p>}
    {[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((project) => <ProjectMemories key={project.id} host={host} rpc={rpc} project={project} />)}
  </section>;
}

function ProjectMemories({ host, rpc, project }: { host: string; rpc: Rpc; project: Project }) {
  const [open, setOpen] = useState(false);
  const [memories, setMemories] = useState<AgentMemories[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || memories) return;
    let active = true;
    void rpc.call("project.memories", { id: project.id }, host).then((r) => { if (active) setMemories(r.agents); }).catch((e) => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [open, memories, host, project.id, rpc]);
  return <details className="settings-card" onToggle={(e) => setOpen(e.currentTarget.open)}><summary>{project.name}</summary>
    <code className="settings-path">{project.path}</code>
    {error && <p role="alert" className="error">{error}</p>}
    {open && !memories && !error && <p role="status">Loading memories…</p>}
    {memories?.length === 0 && <p>No provider memories found for this project.</p>}
    {memories?.map((store) => <section key={`${store.provider}:${store.location}`}><h4>{providerNames[store.provider]} · {store.scope}</h4><code className="settings-path">{store.location}</code>
      {store.entries.map((entry) => <details key={entry.id} className="memory-entry"><summary><span>{entry.title ?? entry.id}</span>{entry.description && <small>{entry.description}</small>}</summary><Prose text={entry.text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")} /></details>)}
    </section>)}
  </details>;
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
