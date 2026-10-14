import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentMemories, Project } from "@casm/protocol";
import type { Rpc } from "./state";
import { providerNames } from "./provider-icon";
import { Prose } from "./transcript";
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** The settings dialog shared by host and project settings: sticky header, section nav, and a guard for unsaved edits. */
export function SettingsDialog<S extends string>({ label, title, closeLabel, sections, section, setSection, close, children }: {
  label: string; title: ReactNode; closeLabel: string; sections: readonly (readonly [S, string])[]; section: S; setSection: (s: S) => void;
  close: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const dirty = () => !!dialog.current?.querySelector("[data-dirty=true]");
  const request = () => { if (dirty()) setConfirming(true); else dialog.current?.close(); };
  return createPortal(<dialog ref={dialog} className="host-settings settings-dialog" aria-label={label} onClose={close}
    onCancel={(e) => { if (dirty()) { e.preventDefault(); setConfirming(true); } }}>
    <header>
      <h2>{title}</h2>
      <button type="button" className="settings-close" aria-label={closeLabel} title="Close" onClick={request}>×</button>
    </header>
    {confirming && <div className="settings-discard" role="alert">
      <span>You have unsaved changes.</span>
      <button type="button" className="danger" onClick={() => dialog.current?.close()}>Discard and close</button>
      <button type="button" className="primary" onClick={() => {
        setConfirming(false);
        dialog.current?.querySelector<HTMLElement>("[data-dirty=true] textarea")?.focus();
      }}>Keep editing</button>
    </div>}
    <nav aria-label={`${label} sections`}>
      {sections.map(([id, name]) => <button type="button" key={id} aria-pressed={section === id} onClick={() => setSection(id)}>{name}</button>)}
    </nav>
    <div className="settings-content">{children}</div>
  </dialog>, document.body);
}

/** A monospace editor with a dirty marker, Ctrl/⌘+S, and sticky Cancel/Save. */
export function TextEditor({ label, value, onChange, dirty, busy, saveLabel, onCancel, children }: {
  label: string; value: string; onChange: (text: string) => void; dirty: boolean; busy: boolean; saveLabel: string; onCancel: () => void; children?: ReactNode;
}) {
  return <>
    <label className="settings-editor-label"><span>{label}</span>
      <textarea value={value} spellCheck={false} autoFocus onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
    </label>
    {children}
    <div className="settings-editor-actions">
      <span className={`dirty-state ${dirty ? "dirty" : ""}`} aria-live="polite">{dirty ? "Unsaved changes" : "No changes"}</span>
      <button type="button" disabled={busy} onClick={onCancel}>{dirty ? "Discard" : "Cancel"}</button>
      <button className="primary" disabled={busy || !dirty}>{busy ? "Saving…" : saveLabel}</button>
    </div>
  </>;
}

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
  const dirty = editing && text !== (file.content ?? "");
  const stop = () => { setEditing(false); setError(""); setLatest(undefined); };
  return <article className="settings-card" data-dirty={dirty}>
    <header className="settings-card-head">
      <div>
        <h4>{title}</h4>
        <code className="settings-path">{file.path}</code>
      </div>
      {!editing && <button type="button" className={file.content === null ? "primary" : ""} onClick={() => { setText(file.content ?? ""); setEditing(true); }}>
        {file.content === null ? createLabel : "Edit instructions"}
      </button>}
    </header>
    {children}
    {error && <div role="alert" className="settings-conflict">
      <p><strong>Not saved.</strong> {error}</p><p>Your draft has been kept.</p>
      <button type="button" disabled={busy} onClick={() => {
        setBusy(true);
        void load().then((found) => {
          if (found) setLatest(found); else setError("The file target changed. Close and reopen settings to load the current files; copy your draft first.");
        }).catch((e) => setError(message(e))).finally(() => setBusy(false));
      }}>Review latest version</button>
    </div>}
    {latest && <div className="settings-latest"><h4>Latest version on host</h4><div className="settings-prose"><Prose text={latest.content ?? "File no longer exists."} /></div>
      <div className="settings-actions">
        <button type="button" className="primary" onClick={() => { saved(latest); setLatest(undefined); setError(""); }}>Keep my draft and use this version for the next save</button>
        <button type="button" onClick={() => { saved(latest); setText(latest.content ?? ""); setLatest(undefined); setError(""); }}>Replace draft with latest</button>
      </div>
    </div>}
    {editing ? <form onSubmit={(e) => {
      e.preventDefault(); setBusy(true); setError(""); setLatest(undefined);
      void save(text, file.sha256)
        .then((next) => { saved(next); setEditing(false); }).catch((e) => setError(message(e))).finally(() => setBusy(false));
    }}>
      <TextEditor label={label} value={text} onChange={setText} dirty={dirty || !!latest} busy={busy} saveLabel="Save instructions" onCancel={stop} />
    </form> : file.content === null ? <p className="settings-note">This file does not exist yet.</p>
      : file.content ? <div className="settings-prose"><Prose text={file.content} /></div> : <p className="settings-note">This file is empty.</p>}
  </article>;
}

/** Search across memory titles, descriptions and text. */
export function MemorySearch({ query, setQuery }: { query: string; setQuery: (q: string) => void }) {
  return <input type="search" className="settings-search" aria-label="Search memories" placeholder="Search memories" value={query} onChange={(e) => setQuery(e.target.value)} />;
}

const matches = (query: string, ...texts: (string | undefined)[]) => texts.some((t) => t?.toLowerCase().includes(query));

export function ProjectMemories({ host, rpc, project, initiallyOpen = false, query = "" }: { host: string; rpc: Rpc; project: Project; initiallyOpen?: boolean; query?: string }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [memories, setMemories] = useState<AgentMemories[]>();
  const [error, setError] = useState("");
  const q = query.trim().toLowerCase();
  // A search loads every project so it can match inside them.
  const load = open || !!q;
  useEffect(() => {
    if (!load || memories) return;
    let active = true;
    void rpc.call("project.memories", { id: project.id }, host).then((r) => { if (active) setMemories(r.agents); }).catch((e) => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [load, memories, host, project.id, rpc]);
  const stores = useMemo(() => memories?.map((store) => ({
    ...store, entries: q ? store.entries.filter((e) => matches(q, e.title, e.id, e.description, e.text)) : store.entries,
  })).filter((store) => !q || store.entries.length), [memories, q]);
  const total = stores?.reduce((n, s) => n + s.entries.length, 0);
  if (q && (!memories || total === 0) && !error) return null;
  return <details className="settings-card memory-project" open={open || !!q} onToggle={(e) => { if (!q) setOpen(e.currentTarget.open); }}>
    <summary><span className="memory-project-name">{project.name}</span>{total !== undefined && <span className="count" aria-label={`${total} memories`}>{total}</span>}</summary>
    <code className="settings-path">{project.path}</code>
    {error && <p role="alert" className="error">{error}</p>}
    {load && !memories && !error && <p role="status">Loading memories…</p>}
    {memories?.length === 0 && <p className="settings-note">No provider memories found for this project.</p>}
    {stores?.map((store) => <section key={`${store.provider}:${store.location}`} className="memory-store">
      <h4>{providerNames[store.provider]} · {store.scope} <span className="count">{store.entries.length}</span></h4>
      <code className="settings-path">{store.location}</code>
      {store.entries.map((entry) => <details key={entry.id} className="memory-entry"><summary><span>{entry.title ?? entry.id}</span>{entry.description && <small>{entry.description}</small>}</summary>
        <div className="settings-prose"><Prose text={entry.text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")} /></div></details>)}
    </section>)}
  </details>;
}
