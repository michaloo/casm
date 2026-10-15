import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

function ExitGlyph() {
  return <svg className="exit-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M6.5 2.75h-2a1.75 1.75 0 0 0-1.75 1.75v7a1.75 1.75 0 0 0 1.75 1.75h2M10.5 5l3 3-3 3M13.25 8H6.5" />
  </svg>;
}

/** The sidebar's Sign out: never one click away, it asks first. */
export function SignOut({ host, signOut }: { host: string; signOut: () => void }) {
  const [asking, setAsking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="sign-out" aria-haspopup="dialog" aria-expanded={asking}
      title="Sign out of this server on this device" onClick={() => setAsking(true)}>
      <ExitGlyph />Sign out
    </button>
    {asking && <ConfirmSignOut host={host} confirm={signOut} close={() => { setAsking(false); trigger.current?.focus(); }} />}
  </>;
}

// Cancel is focused, so Enter or Escape keeps the session.
function ConfirmSignOut({ host, confirm, close }: { host: string; confirm: () => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const title = useId();
  const body = useId();
  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
  }, []);
  return createPortal(<dialog ref={dialog} className="confirm-dialog" role="alertdialog" aria-labelledby={title} aria-describedby={body} onClose={close}>
    <h2 id={title}>Sign out of {host || "this server"} on this device?</h2>
    <p id={body}>You'll need the token to sign in again. Saved offline chats on this device are deleted.</p>
    <div className="confirm-actions">
      <button ref={cancel} type="button" onClick={() => dialog.current?.close()}>Cancel</button>
      <button type="button" className="danger" onClick={confirm}>Sign out</button>
    </div>
  </dialog>, document.body);
}
