import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { chatMemoryChoices, type ChatMemory } from "./chat-memory";

function DeviceGlyph() {
  return <svg className="exit-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <rect x="2.75" y="3" width="10.5" height="7.5" rx="1.25" /><path d="M5.5 13h5M8 10.5V13" />
  </svg>;
}

/** The sidebar footer's settings for this browser only (stored in localStorage). */
export function DeviceSettings({ memory, change }: { memory: ChatMemory; change: (value: ChatMemory) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="sign-out device-settings" aria-haspopup="dialog" aria-expanded={open}
      aria-label="This device" title="Settings for this device" onClick={() => setOpen(true)}>
      <DeviceGlyph />
    </button>
    {open && <DeviceDialog memory={memory} change={change} close={() => { setOpen(false); trigger.current?.focus(); }} />}
  </>;
}

function DeviceDialog({ memory, change, close }: { memory: ChatMemory; change: (value: ChatMemory) => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} className="confirm-dialog device-dialog" aria-labelledby={title} onClose={close}>
    <h2 id={title}>This device</h2>
    <fieldset>
      <legend>Keep chats in memory</legend>
      {chatMemoryChoices.map((c) => <label key={c.value}>
        <input type="radio" name="chat-memory" value={c.value} checked={memory === c.value} onChange={() => change(c.value)} />
        <span><strong>{c.label}</strong><small>{c.hint}</small></span>
      </label>)}
    </fieldset>
    <div className="confirm-actions">
      <button type="button" autoFocus onClick={() => dialog.current?.close()}>Done</button>
    </div>
  </dialog>, document.body);
}
