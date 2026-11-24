import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Agent } from "@casm/protocol";
import type { Rpc } from "./state";

export function ChatRename({ agent, rpc, host, online, saved, cancel, saving }: {
  agent: Agent; rpc: Rpc | null; host: string; online: boolean; saved: (agent: Agent) => void;
  cancel: () => void; saving: (busy: boolean) => void;
}) {
  const [name, setName] = useState(agent.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form onSubmit={event => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!rpc || !online || busy || !trimmed || trimmed === agent.name) return;
    setBusy(true);
    saving(true);
    setError("");
    void rpc.call("agent.update", { id: agent.id, name: trimmed }, host).then(
      updated => saved(updated),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    ).finally(() => { setBusy(false); saving(false); });
  }}>
    <label>Chat name <input type="text" name="chat-name" value={name} autoFocus
      onFocus={event => event.currentTarget.select()}
      onChange={event => setName(event.target.value)} disabled={busy} required /></label>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="confirm-actions">
      <button type="button" disabled={busy} onClick={cancel}>Cancel</button>
      <button type="submit" className="primary" disabled={!rpc || !online || busy || !name.trim() || name.trim() === agent.name}>Save name</button>
    </div>
  </form>;
}

export function ChatRenameButton({ agent, rpc, host, online }: {
  agent: Agent; rpc: Rpc | null; host: string; online: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  const close = () => dialog.current?.close();
  return <>
    <button type="button" className="launcher-trigger" aria-label="Rename chat" title="Rename chat" ref={trigger}
      disabled={!online || !rpc} onClick={() => setOpen(true)}>
      <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="m3 10-1 4 4-1 8-8-3-3ZM10 3l3 3" />
      </svg>
    </button>
    {open && createPortal(<dialog ref={dialog} className="confirm-dialog chat-rename" aria-label="Rename chat"
      onCancel={event => { if (busy) event.preventDefault(); }}
      onClose={() => { setOpen(false); trigger.current?.focus(); }}>
      <h2>Rename chat</h2>
      <ChatRename agent={agent} rpc={rpc} host={host} online={online} saved={close} cancel={close} saving={setBusy} />
    </dialog>, document.body)}
  </>;
}
