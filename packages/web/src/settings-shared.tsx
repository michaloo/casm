import { useEffect, useState, type ReactNode } from "react";
import type { AgentMemories, Project } from "@casm/protocol";
import type { Rpc } from "./state";
import { providerNames } from "./provider-icon";
import { Prose } from "./transcript";
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export type InstructionFile = { path: string; content: string | null; sha256: string | null };
export function InstructionEditor<T extends InstructionFile>({ file, saved, save, load, title, children, label = "Global instructions", createLabel = "Create instructions" }: {
  file: T; saved: (file: T) => void; save: (text: string, sha: string | null) => Promise<T>;
  load: () => Promise<T | undefined>; title: ReactNode; children?: ReactNode; label?: string; createLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(file.content ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [latest, setLatest] = useState<T>();
  return <article className="settings-card">
    <h4>{title}</h4>
    <code className="settings-path">{file.path}</code>
    {children}
    {editing ? <form onSubmit={(e) => {
      e.preventDefault(); setBusy(true); setError(""); setLatest(undefined);
      void save(text, file.sha256)
        .then((next) => { saved(next); setEditing(false); }).catch((e) => setError(message(e))).finally(() => setBusy(false));
    }}>
      <label>{label}<textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} /></label>
      <div className="settings-actions"><button disabled={busy}>Save instructions</button><button type="button" disabled={busy} onClick={() => { setEditing(false); setError(""); setLatest(undefined); }}>Cancel edit</button></div>
    </form> : <>
      {file.content === null ? <p>This file does not exist yet.</p> : file.content ? <Prose text={file.content} /> : <p>This file is empty.</p>}
      <button type="button" onClick={() => { setText(file.content ?? ""); setEditing(true); }}>{file.content === null ? createLabel : "Edit instructions"}</button>
    </>}
    {error && <div role="alert" className="error"><p>{error}</p><p>Your draft has been kept.</p><button type="button" disabled={busy} onClick={() => {
      setBusy(true);
      void load().then((found) => {
        if (found) setLatest(found); else setError("The file target changed. Close and reopen settings to load the current files; copy your draft first.");
      }).catch((e) => setError(message(e))).finally(() => setBusy(false));
    }}>Review latest version</button></div>}
    {latest && <div className="settings-latest"><h4>Latest version on host</h4><Prose text={latest.content ?? "File no longer exists."} />
      <button type="button" onClick={() => { saved(latest); setLatest(undefined); setError(""); }}>Keep my draft and use this version for the next save</button>
      <button type="button" onClick={() => { saved(latest); setText(latest.content ?? ""); setLatest(undefined); setError(""); }}>Replace draft with latest</button>
    </div>}
  </article>;
}


export function ProjectMemories({ host, rpc, project, initiallyOpen = false }: { host: string; rpc: Rpc; project: Project; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [memories, setMemories] = useState<AgentMemories[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || memories) return;
    let active = true;
    void rpc.call("project.memories", { id: project.id }, host).then((r) => { if (active) setMemories(r.agents); }).catch((e) => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [open, memories, host, project.id, rpc]);
  return <details className="settings-card" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}><summary>{project.name}</summary>
    <code className="settings-path">{project.path}</code>
    {error && <p role="alert" className="error">{error}</p>}
    {open && !memories && !error && <p role="status">Loading memories…</p>}
    {memories?.length === 0 && <p>No provider memories found for this project.</p>}
    {memories?.map((store) => <section key={`${store.provider}:${store.location}`}><h4>{providerNames[store.provider]} · {store.scope}</h4><code className="settings-path">{store.location}</code>
      {store.entries.map((entry) => <details key={entry.id} className="memory-entry"><summary><span>{entry.title ?? entry.id}</span>{entry.description && <small>{entry.description}</small>}</summary><Prose text={entry.text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")} /></details>)}
    </section>)}
  </details>;
}

