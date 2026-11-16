import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Agent } from "@casm/protocol";
import type { Rpc } from "./state";
import { MoreGlyph } from "./row-menu";
import { providerNames } from "./provider-icon";

export function ChatOptions({ agent, rpc, host, online, archived }: {
  agent: Agent; rpc: Rpc | null; host: string; online: boolean; archived: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  const close = () => { setOpen(false); setConfirm(false); setError(""); trigger.current?.focus(); };
  return <>
    <button type="button" className="launcher-trigger chat-options-trigger" aria-label="Chat options" title="Chat options" ref={trigger} onClick={() => setOpen(true)}><MoreGlyph /></button>
    {open && createPortal(<dialog ref={dialog} className="confirm-dialog chat-options" aria-label="Chat options" onClose={close} onCancel={event => { if (busy) event.preventDefault(); }}>
      <h2>Chat options</h2><p className="chat-options-name">{agent.name}</p>
      <p>Archive hides this chat on all devices and keeps its history. Restore it under Project options &gt; Archived chats.</p>
      {(agent.status === "running" || agent.status === "waiting" || !!agent.pending?.count) && <p className="error">Archiving stops this agent. Queued messages will wait until it is restored.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="confirm-actions">
        <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="button" disabled={!online || !rpc || busy} className={confirm ? "danger" : ""} onClick={() => {
          if (!confirm) { setConfirm(true); return; }
          setBusy(true); setError("");
          void rpc!.call("agent.update", { id: agent.id, archived: true }, host).then(() => { close(); archived(); }, e => setError(String(e.message ?? e))).finally(() => setBusy(false));
        }}>{busy ? "Archiving..." : confirm ? "Confirm archive" : "Archive chat"}</button>
      </div>
    </dialog>, document.body)}
  </>;
}

export function ArchivedChats({ rpc, host, projectId, online, openAgent }: {
  rpc: Rpc; host: string; projectId: string; online: boolean; openAgent: (agent: Agent) => void;
}) {
  const [agents, setAgents] = useState<Agent[]>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string>();
  const [name, setName] = useState("");
  useEffect(() => {
    let current = true;
    void rpc.call("agent.list", { projectId, includeArchived: true }, host).then(result => { if (current) setAgents(result.agents.filter(a => a.archivedAt)); }, e => { if (current) setError(String(e.message ?? e)); });
    return () => { current = false; };
  }, [rpc, host, projectId]);
  return <section aria-label="Archived chats"><h3>Archived chats</h3>
    <p className="settings-lede">Hidden on every device. Restore to continue the same chat, or delete its CASM entry.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!agents && !error && <p role="status">Loading...</p>}
    {agents?.length === 0 && <p>No archived chats.</p>}
    {agents?.map(agent => <article className="settings-card archived-chat" key={agent.id}>
      <strong>{agent.name}</strong>
      <small>{providerNames[agent.provider]} | Created {new Date(agent.createdAt).toLocaleString()}</small>
      <div className="settings-actions">
        <button type="button" disabled={!online || !!busy} onClick={() => {
          setBusy(agent.id); setError("");
          void rpc.call("agent.update", { id: agent.id, archived: false }, host).then(restored => { setAgents(list => list?.filter(a => a.id !== agent.id)); openAgent(restored); }, e => setError(String(e.message ?? e))).finally(() => setBusy(undefined));
        }}>Restore chat</button>
        <button type="button" disabled={!online || !!busy} onClick={() => { setDeleting(agent.id); setName(""); }}>Delete from CASM...</button>
      </div>
      {deleting === agent.id && <div className="archive-delete-confirm">
        <p>This removes the chat entry and cannot be undone in CASM. Provider history files are kept.</p>
        <label>Type the chat name to confirm<input aria-label="Chat name to delete" value={name} onChange={event => setName(event.target.value)} /></label>
        <div className="settings-actions"><button type="button" disabled={!!busy} onClick={() => setDeleting(undefined)}>Cancel deletion</button>
          <button type="button" className="danger" disabled={!online || !!busy || name !== agent.name} onClick={() => {
            setBusy(agent.id); setError("");
            void rpc.call("agent.delete", { id: agent.id }, host).then(() => { setAgents(list => list?.filter(a => a.id !== agent.id)); setDeleting(undefined); }, e => setError(String(e.message ?? e))).finally(() => setBusy(undefined));
          }}>Confirm delete</button>
        </div>
      </div>}
    </article>)}
  </section>;
}
