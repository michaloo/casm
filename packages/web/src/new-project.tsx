import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Project } from "@casm/protocol";
import type { Rpc } from "./state";

function homeFromProjects(projects: Project[]) {
  return projects.map(project => project.path.match(/^\/(?:home|Users)\/[^/]+|^\/root(?=\/|$)/)?.[0]).find(Boolean);
}

export function NewProject({ host, name, projects, rpc, online, close, created }: {
  host: string; name: string; projects: Project[]; rpc: Rpc | null; online: boolean;
  close: () => void; created: (project: Project) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const home = homeFromProjects(projects);
  const [path, setPath] = useState(() => (home || projects[0]?.path) ? `${(home ?? projects[0].path).replace(/\/+$/, "")}/` : "");
  const [projectName, setName] = useState("");
  const [group, setGroup] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState("");
  const [searchError, setSearchError] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [active, setActive] = useState(0);
  const listId = useId();
  const hintId = useId();
  const folder = path.trim();
  const absolute = folder.startsWith("/");
  const defaultName = folder.split("/").filter(Boolean).at(-1) ?? "";
  const groups = [...new Set(projects.map(project => project.group).filter((value): value is string => !!value))].sort();
  useEffect(() => { dialog.current?.showModal(); folderInput.current?.focus(); }, []);
  useEffect(() => {
    let current = true;
    setSuggestions([]); setActive(0); setSearchError("");
    const expanded = home && (folder === "~" || folder.startsWith("~/")) ? home + folder.slice(1) : folder;
    if (!online || !rpc || !expanded.startsWith("/") || !showSuggestions || busy) return;
    const at = expanded.lastIndexOf("/");
    const cwd = expanded.slice(0, at) || "/";
    const query = expanded.slice(at + 1);
    const timer = setTimeout(() => {
      void rpc.call("fs.search", { cwd, query, limit: 40 }, host).then(result => {
        if (!current) return;
        const base = result.root.replace(/\/+$/, "");
        setSuggestions(result.entries.filter(entry => entry.kind === "dir")
          .map(entry => `${base}/${entry.path}`).filter(value => value !== folder.replace(/\/+$/, "")).slice(0, 6));
      }).catch(error => { if (current) setSearchError(error instanceof Error ? error.message : String(error)); });
    }, 150);
    return () => { current = false; clearTimeout(timer); };
  }, [folder, home, host, online, rpc, showSuggestions, busy]);
  useEffect(() => { document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, listId]);
  const pick = (value: string) => { setPath(value); setSuggestions([]); setShowSuggestions(false); setError(""); folderInput.current?.focus(); };
  const submit = async () => {
    if (!absolute || !online || !rpc || busy) return;
    setBusy(true); setError("");
    try {
      const project = await rpc.call("project.create", {
        path: folder, ...(projectName.trim() ? { name: projectName.trim() } : {}),
        ...(group.trim() ? { group: group.trim() } : {}),
        ...(tags.trim() ? { tags: tags.split(",").map(tag => tag.trim()).filter(Boolean) } : {}),
      }, host);
      created(project);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const expanded = showSuggestions && suggestions.length > 0;
  return createPortal(<dialog ref={dialog} className="host-settings new-project" aria-label={`New project on ${name}`}
    onClose={close} onCancel={event => { if (busy) event.preventDefault(); }}>
    <header><h2>New project</h2><button type="button" aria-label="Close new project" disabled={busy} onClick={close}>×</button></header>
    <form className="settings-content new-project-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label htmlFor={`${listId}-folder`}>Folder</label>
      <input ref={folderInput} id={`${listId}-folder`} role="combobox" aria-autocomplete="list" aria-expanded={expanded}
        aria-controls={listId} aria-activedescendant={expanded ? `${listId}-${active}` : undefined} aria-describedby={hintId}
        required autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} disabled={busy}
        value={path} placeholder={home ? `${home}/Projects/app` : "/absolute/path/to/project"}
        onChange={event => { setPath(event.target.value); setShowSuggestions(true); setError(""); }}
        onKeyDown={event => {
          if (expanded && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault(); setActive(index => (index + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
          } else if (expanded && event.key === "Enter") { event.preventDefault(); pick(suggestions[active]); }
          else if (expanded && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setShowSuggestions(false); }
        }} />
      {expanded && <ul id={listId} role="listbox" aria-label="Folder suggestions" className="folder-suggestions">
        {suggestions.map((value, index) => <li key={value} role="presentation"><button type="button" role="option" tabIndex={-1}
          id={`${listId}-${index}`} aria-selected={active === index} title={value}
          onMouseDown={event => event.preventDefault()} onClick={() => pick(value)}><span aria-hidden="true">▱</span><span>{value}</span></button></li>)}
      </ul>}
      <p id={hintId} className="muted">A folder on {name}. It can't be changed later.</p>
      {folder && !absolute && <p className="muted">Choose a suggestion or enter an absolute path starting with /.</p>}
      {searchError && <p className="muted" role="status">Folder suggestions unavailable: {searchError}</p>}
      <label htmlFor={`${listId}-name`}>Name</label>
      <input id={`${listId}-name`} value={projectName} onChange={event => setName(event.target.value)} placeholder={defaultName || "Folder name"} disabled={busy} />
      <label htmlFor={`${listId}-group`}>Group</label>
      <div className="project-group-fields"><input id={`${listId}-group`} value={group} onChange={event => setGroup(event.target.value)} placeholder="Optional" disabled={busy} />
        {groups.length > 0 && <select aria-label="Existing groups" value="" disabled={busy} onChange={event => setGroup(event.target.value)}>
          <option value="">Groups…</option>{groups.map(value => <option key={value} value={value}>{value}</option>)}
        </select>}
      </div>
      <label htmlFor={`${listId}-tags`}>Tags</label>
      <input id={`${listId}-tags`} value={tags} onChange={event => setTags(event.target.value)} placeholder="Comma-separated, optional" disabled={busy} />
      {!online && <p role="status">Host offline. Reconnect to create a project.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="settings-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button>
        <button className="primary" type="submit" disabled={!absolute || !online || !rpc || busy}>{busy ? "Creating…" : "Create project"}</button></div>
    </form>
  </dialog>, document.body);
}
