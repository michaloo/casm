import "./chat-working.css";

export function ChatWorking({ running }: { running: boolean }) {
  // The live region stays mounted; only its pill comes and goes.
  return (
    <div className="chat-working" role="status" aria-live="polite" aria-atomic="true">
      {running && <span className="working-pill"><span className="activity-spinner" aria-hidden="true" />Working</span>}
    </div>
  );
}
