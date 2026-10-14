import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { PendingMessage } from "@casm/protocol";

export function PendingQueue({ agentKey, messages, children }: {
  agentKey: string; messages: PendingMessage[]; children: ReactNode;
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
  if (!messages.length) return null;
  return <section className="pending-queue" aria-label="Queue">
    <button type="button" className="queue-toggle" aria-expanded={expanded} aria-controls={listId}
      onClick={() => setExpanded((value) => !value)}>
      <span className="queue-count">{messages.length} queued</span>
      <span className="queue-hints">{[limited ? `${limited} waiting for limit` : "", failed.length ? `${failed.length} failed` : ""].filter(Boolean).join(" · ")}</span>
      <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
    </button>
    <div id={listId} hidden={!expanded}>{children}</div>
  </section>;
}
