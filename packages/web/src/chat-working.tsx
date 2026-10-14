import "./chat-working.css";

export function ChatWorking({ running }: { running: boolean }) {
  // Keep this slot's height stable so status changes never move the reader or composer.
  return (
    <div className="chat-working" role="status" aria-live="polite" aria-atomic="true">
      {running && <><span className="activity-spinner" aria-hidden="true" />Working…</>}
    </div>
  );
}
