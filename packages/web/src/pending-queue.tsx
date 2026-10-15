import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PendingMessage } from "@casm/protocol";

export function PendingQueue({ agentKey, messages, children, status, row }: {
  agentKey: string; messages: PendingMessage[]; children: ReactNode; status?: ReactNode;
  // Where the status pills go: the transparent row over the transcript's end.
  row: HTMLElement | null;
}) {
  const storageKey = `casm.queue.expanded:${agentKey}`;
  const [expanded, setExpanded] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) return saved === "true";
    } catch { /* Storage may be disabled. */ }
    return false;
  });
  const seenFailures = useRef<Set<string> | undefined>(undefined);
  if (!seenFailures.current) {
    let saved: unknown;
    try { saved = JSON.parse(localStorage.getItem(`${storageKey}:failures`) ?? "[]"); } catch { /* Optional preference. */ }
    seenFailures.current = new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
  }
  const listId = useId();
  const failed = messages.filter((m) => m.reason === "failed");
  const limited = messages.filter((m) => m.reason === "limit").length;
  useEffect(() => {
    if (!messages.length) return;
    const next = new Set(failed.map((m) => m.id));
    if (failed.some((m) => !seenFailures.current!.has(m.id))) setExpanded(true);
    seenFailures.current = next;
    try { localStorage.setItem(`${storageKey}:failures`, JSON.stringify([...next])); } catch { /* Optional preference. */ }
  }, [messages]);
  useEffect(() => {
    try { localStorage.setItem(storageKey, String(expanded)); } catch { /* Optional preference. */ }
  }, [storageKey, expanded]);
  const hints = [limited ? `${limited} waiting for limit` : "", failed.length ? `${failed.length} failed` : ""].filter(Boolean).join(" · ");
  // Fades show that the list scrolls; they follow its scroll position.
  const list = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ top: false, bottom: false });
  const measure = () => {
    const el = list.current;
    if (!el) return;
    const next = { top: el.scrollTop > 1, bottom: el.scrollHeight - el.scrollTop - el.clientHeight > 1 };
    setFade((f) => f.top === next.top && f.bottom === next.bottom ? f : next);
  };
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !expanded) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [expanded, messages]);
  return <section className="pending-queue chat-column" aria-label={messages.length ? "Queue" : undefined}>
    <div ref={list} className="queue-list" id={listId} hidden={!expanded || !messages.length} onScroll={measure}
      data-fade-top={fade.top || undefined} data-fade-bottom={fade.bottom || undefined}>{children}</div>
    {row && createPortal(<div className="composer-status">
      {status}
      {messages.length > 0 && <button type="button" className="queue-toggle" aria-expanded={expanded} aria-controls={listId}
        title={[`${messages.length} queued`, hints].filter(Boolean).join(" · ")}
        onClick={() => setExpanded((value) => !value)}>
        <span className="queue-pill"><span className="queue-label"><span className="queue-count">{messages.length} queued</span>
          <svg className="queue-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></span>
        {(limited > 0 || failed.length > 0) && <span className="queue-hints">
          {limited > 0 && <span className="waiting"> · {limited} waiting</span>}
          {failed.length > 0 && <span className="failed"> · {failed.length} failed</span>}
        </span>}</span>
      </button>}
    </div>, row)}
  </section>;
}
