// Waiting messages under the transcript, with Send now / Retry now, Edit and
// Cancel. Each action hides or changes the row at once and reconciles with the
// server's queue by id; a row already gone on the server is simply dropped.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { PendingMessage } from "@casm/protocol";
import { pendingLabel, queueHeld } from "./outbox";

export type PendingActions = {
  sendNow: (p: PendingMessage) => void;
  retry: (p: PendingMessage) => void;
  cancel: (p: PendingMessage) => void;
  edit: (p: PendingMessage, text: string) => void;
};

export function PendingRows({ rows, unconfirmed, online, labels, actions }: {
  rows: PendingMessage[];
  // Rows not yet confirmed by the server (just sent): no actions yet.
  unconfirmed: Set<string>;
  online: boolean;
  // Overrides for a row's status text, by id.
  labels?: Map<string, string>;
  actions: PendingActions;
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const held = queueHeld(rows);
  return (
    <>
      {rows.map((p, i) => {
        const { status, action } = pendingLabel(p);
        const local = unconfirmed.has(p.id);
        const edit = editing?.id === p.id ? editing : null;
        return (
          <div className={`pending-row ${p.reason}`} key={p.id} data-pending-id={p.id}>
            {edit ? (
              <form
                className="pending-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!edit.text.trim() && !p.imageCount) return;
                  actions.edit(p, edit.text);
                  setEditing(null);
                }}
              >
                <textarea
                  aria-label="Edit queued message"
                  autoFocus
                  value={edit.text}
                  onChange={(e) => setEditing({ id: p.id, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditing(null);
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <button type="button" onClick={() => setEditing(null)}>Discard</button>
                <button disabled={!online}>Save</button>
              </form>
            ) : (
              <>
                <div className="pending-body">
                  <ClampedText>
                    {p.text}
                    {p.imageCount ? <em> · {p.imageCount} image{p.imageCount > 1 ? "s" : ""}</em> : null}
                  </ClampedText>
                  <small>
                    {local ? "Sending…" : labels?.get(p.id) ?? status}
                    {i === 0 && held && rows.length > 1 ? " · holds the queue" : ""}
                  </small>
                </div>
                <div className="pending-actions">
                  <button type="button" disabled={!online || local} onClick={() => actions.cancel(p)}>Cancel</button>
                  <button type="button" disabled={!online || local} onClick={() => setEditing({ id: p.id, text: p.text })}>Edit</button>
                  <button
                    type="button"
                    className="pending-primary"
                    disabled={!online || local}
                    onClick={() => (action === "retry" ? actions.retry(p) : actions.sendNow(p))}
                  >
                    {action === "retry" ? "Retry now" : "Send now"}
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Two lines of a queued message, with Show more when it is longer. */
function ClampedText({ children }: { children: ReactNode }) {
  const text = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = text.current;
    if (!el) return;
    const measure = () => setLong(open || el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, children]);
  return <span className="pending-text-wrap">
    <span ref={text} className={`pending-text${open ? " open" : ""}`}>{children}</span>
    {long && <button type="button" className="pending-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Show less" : "Show more"}</button>}
  </span>;
}
