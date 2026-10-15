import { useEffect } from "react";
import type { UserNotification } from "@casm/protocol";

export const TOAST_MS = 10_000;

/** casm notify messages while the app is open: newest last, each for a few seconds; a click opens its view. */
export function NotificationToasts({ toasts, open, dismiss }: {
  toasts: UserNotification[]; open: (url: string) => void; dismiss: (id: string) => void;
}) {
  useEffect(() => {
    const timers = toasts.map((t) => setTimeout(() => dismiss(t.id), Math.max(0, Date.parse(t.at) + TOAST_MS - Date.now())));
    return () => timers.forEach(clearTimeout);
  }, [toasts]);
  if (!toasts.length) return null;
  return <div className="notification-toasts" role="log" aria-label="Notifications" aria-live="polite">
    {toasts.map((t) => <div key={t.id} className="notification-toast">
      <button type="button" className="notification-toast-body" disabled={!t.url} onClick={() => { dismiss(t.id); if (t.url) open(t.url); }}>
        <strong>{t.title}</strong><span>{t.body}</span>
      </button>
      <button type="button" className="notification-toast-close" aria-label={`Dismiss “${t.title}”`} onClick={() => dismiss(t.id)}>×</button>
    </div>)}
  </div>;
}
