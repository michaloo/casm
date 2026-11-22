import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { chatMemoryChoices, type ChatMemory } from "./chat-memory";
import type { ProviderId } from "@casm/protocol";
import type { ChatAppearance } from "./chat-appearance";
import { newChatProviders } from "./new-chat-provider";
import type { WorkView } from "./work-details";
type Props = { appearance: ChatAppearance; changeAppearance: (value: ChatAppearance) => void; defaultProvider: ProviderId; changeDefaultProvider: (value: ProviderId) => void; memory: ChatMemory; change: (value: ChatMemory) => void; workView: WorkView; changeWorkView: (value: WorkView) => void };

function DeviceGlyph() {
  return <svg className="exit-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <rect x="2.75" y="3" width="10.5" height="7.5" rx="1.25" /><path d="M5.5 13h5M8 10.5V13" />
  </svg>;
}

/** The sidebar footer's settings for this browser only (stored in localStorage). */
export function DeviceSettings({ memory, change, workView, changeWorkView, appearance, changeAppearance, defaultProvider, changeDefaultProvider }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="sign-out device-settings" aria-haspopup="dialog" aria-expanded={open}
      aria-label="This device" title="Settings for this device" onClick={() => setOpen(true)}>
      <DeviceGlyph />
    </button>
    {open && <DeviceDialog appearance={appearance} changeAppearance={changeAppearance} defaultProvider={defaultProvider} changeDefaultProvider={changeDefaultProvider} memory={memory} change={change} workView={workView} changeWorkView={changeWorkView} close={() => { setOpen(false); trigger.current?.focus(); }} />}
  </>;
}

function DeviceDialog({ memory, change, workView, changeWorkView, appearance, changeAppearance, defaultProvider, changeDefaultProvider, close }: Props & { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const done = useRef<HTMLButtonElement>(null);
  // showModal() focuses the first radio; start on Done instead, so nothing opens outlined.
  useEffect(() => { dialog.current?.showModal(); done.current?.focus(); }, []);
  return createPortal(<dialog ref={dialog} className="confirm-dialog device-dialog" aria-labelledby={title} onClose={close}>
    <h2 id={title}>This device</h2>
    <fieldset>
      <legend>Chat list</legend>
      <label><input type="checkbox" checked={appearance.unreadIndicators} onChange={event => changeAppearance({ ...appearance, unreadIndicators: event.target.checked })} />
        <span><strong>Show unread reply indicators</strong><small>Use a green dot for unread assistant replies.</small></span></label>
      <label><input type="checkbox" checked={appearance.recentFirst} onChange={event => changeAppearance({ ...appearance, recentFirst: event.target.checked })} />
        <span><strong>Recent activity first</strong><small>Turn off to sort chats alphabetically.</small></span></label>
    </fieldset>
    <fieldset>
      <legend>Default agent for new chats</legend>
      {newChatProviders.map(p => <label key={p.id}>
        <input type="radio" name="default-provider" checked={defaultProvider === p.id} onChange={() => changeDefaultProvider(p.id)} />
        <span><strong>{p.label}</strong></span>
      </label>)}
    </fieldset>
    <fieldset>
      <legend>Work details in chat</legend>
      <label><input type="radio" name="work-view" checked={workView === "compact"} onChange={() => changeWorkView("compact")} />
        <span><strong>Grouped</strong><small>Keep the conversation in focus. Expand work details when needed.</small></span></label>
      <label><input type="radio" name="work-view" checked={workView === "detailed"} onChange={() => changeWorkView("detailed")} />
        <span><strong>Individual</strong><small>Show each tool, thinking and subagent row in the conversation.</small></span></label>
    </fieldset>
    <fieldset>
      <legend>Keep chats in memory</legend>
      {chatMemoryChoices.map((c) => <label key={c.value}>
        <input type="radio" name="chat-memory" value={c.value} checked={memory === c.value} onChange={() => change(c.value)} />
        <span><strong>{c.label}</strong><small>{c.hint}</small></span>
      </label>)}
    </fieldset>
    <div className="confirm-actions">
      <button ref={done} type="button" onClick={() => dialog.current?.close()}>Done</button>
    </div>
  </dialog>, document.body);
}
