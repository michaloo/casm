// Why actions are unavailable while disconnected; shown as their tooltip.
export const offlineNote = "Offline: reconnect to do this. Drafts are kept on this device.";

// Today's copies show the time only; older ones the date too.
export function savedTime(at: number, now = Date.now()) {
  const date = new Date(at);
  const today = new Date(now).toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Says, whenever the view is not live, that it isn't and how old it is. */
export function ConnectionBanner({ online, fresh, checking, networkOffline, connected, savedAt }: {
  online: boolean; fresh: boolean; checking: boolean; networkOffline: boolean;
  // Whether this page has had a live connection yet.
  connected: boolean; savedAt?: number;
}) {
  if (online && fresh && !checking) return null;
  const copy = savedAt === undefined ? "" : savedTime(savedAt);
  const text = networkOffline && !online
    ? `Offline${copy ? ` · saved copy from ${copy}` : " · nothing saved on this device yet"}`
    : `${checking && online ? "Checking connection…" : connected ? "Reconnecting…" : "Connecting…"}${copy ? ` · showing saved copy from ${copy}` : ""}`;
  return <div role="status" className="connection-banner" data-state={online ? "syncing" : "offline"}>{text}</div>;
}
