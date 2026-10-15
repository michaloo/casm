import { useEffect, useState } from "react";
import type { PushDevice } from "@casm/protocol";
import type { Rpc } from "./state";
import { savedTime } from "./connection";
import { deviceLabel, keyBytes, pushEnv, pushSupport, sameKey, unsupportedText, type PushSupport } from "./push-support";

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

// The service worker's push subscription on this page, if it has one.
async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Push notifications for this device (from `casm notify`) and the host's subscribed devices. */
export function HostNotifications({ rpc, name }: { rpc: Rpc; name: string }) {
  const [support] = useState<PushSupport>(() => pushSupport(pushEnv()));
  const [permission, setPermission] = useState(() => support.ok ? Notification.permission : "default");
  const [publicKey, setPublicKey] = useState("");
  const [devices, setDevices] = useState<PushDevice[]>();
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const load = async (own = endpoint) => {
    const r = await rpc.call("push.list", own ? { endpoint: own } : {});
    setPublicKey(r.publicKey);
    setDevices(r.devices);
  };
  useEffect(() => {
    let active = true;
    void (async () => {
      const sub = support.ok ? await currentSubscription().catch(() => null) : null;
      if (!active) return;
      setEndpoint(sub?.endpoint ?? null);
      await load(sub?.endpoint ?? null);
    })().catch((e) => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [rpc]);
  const current = devices?.find((d) => d.current);
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true); setError(""); setNote("");
    void fn().catch((e) => setError(message(e))).finally(() => setBusy(false));
  };
  // From the tap itself: iOS asks for permission only during a user gesture.
  const enable = () => act(async () => {
    const asked = await Notification.requestPermission();
    setPermission(asked);
    if (asked !== "granted") return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) throw new Error(unsupportedText["no-worker"]);
    const key = keyBytes(publicKey || (await rpc.call("push.list", {})).publicKey);
    let sub = await reg.pushManager.getSubscription();
    // Subscribed for another server key (a reset state directory): start over.
    if (sub && !sameKey(sub.options.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await rpc.call("push.subscribe", { subscription: { endpoint: json.endpoint, keys: json.keys }, label: deviceLabel(pushEnv()), origin: location.origin });
    setEndpoint(sub.endpoint);
    await load(sub.endpoint);
  });
  const disable = () => act(async () => {
    const sub = await currentSubscription();
    await rpc.call("push.unsubscribe", current ? { id: current.id } : { endpoint: sub?.endpoint });
    await sub?.unsubscribe();
    setEndpoint(null);
    await load(null);
  });
  // A failed test may have removed an expired device: the list reloads either way.
  const test = (device: PushDevice) => act(async () => {
    try {
      await rpc.call("push.test", { id: device.id });
      setNote(`Test notification sent to ${device.label}.`);
    } finally {
      await load().catch(() => {});
    }
  });
  const remove = (device: PushDevice) => act(async () => {
    await rpc.call("push.unsubscribe", { id: device.id });
    if (device.current) { await (await currentSubscription())?.unsubscribe(); setEndpoint(null); }
    await load(device.current ? null : endpoint);
  });

  const status = !support.ok ? unsupportedText[support.reason]
    : permission === "denied" ? "Blocked for this site. Allow notifications for casm in the browser's (or the system's) settings, then reload."
    : current ? "On: this device gets notifications from agents on this host."
    : "Off on this device.";
  return <section aria-label="Notifications" className="settings-notifications"><h3>Notifications</h3>
    <p className="settings-lede">Agents notify you when you ask them to, e.g. “tell me when the tests pass”: they run <code>casm notify</code>, and every device enabled here gets it, open or not. Open casm windows show it too.</p>
    <div className="settings-card">
      <header className="settings-card-head">
        <div><h4>This device</h4><p role="status" className="push-status" data-state={!support.ok ? "unavailable" : permission === "denied" ? "denied" : current ? "on" : "off"}>{status}</p></div>
        {support.ok && permission !== "denied" && <span className={`chip ${current ? "custom" : ""}`}>{current ? "On" : "Off"}</span>}
      </header>
      {support.ok && permission !== "denied" && <div className="settings-actions">
        {current
          ? <><button type="button" className="primary" disabled={busy} onClick={() => test(current)}>Send test notification</button>
            <button type="button" className="danger quiet" disabled={busy} onClick={disable}>Turn off on this device</button></>
          : <button type="button" className="primary" disabled={busy || !devices} onClick={enable}>Enable notifications</button>}
      </div>}
      {error && <p role="alert" className="error">{error}</p>}
      {note && <p role="status" className="settings-note">{note}</p>}
    </div>
    <h4 className="settings-subhead">Devices on {name}</h4>
    {!devices && !error && <p role="status">Loading devices…</p>}
    {devices && !devices.length && <p className="settings-note">No devices yet.</p>}
    {!!devices?.length && <ul className="push-devices" aria-label="Subscribed devices">
      {devices.map((d) => <li key={d.id}>
        <div><strong>{d.label}</strong>{d.current && <span className="chip custom">This device</span>}
          <small>{d.service} · {d.lastUsedAt ? `last notified ${savedTime(Date.parse(d.lastUsedAt))}` : `added ${savedTime(Date.parse(d.createdAt))}`}</small></div>
        <button type="button" disabled={busy} onClick={() => test(d)} aria-label={`Send a test notification to ${d.label}`}>Test</button>
        <button type="button" className="danger quiet" disabled={busy} onClick={() => remove(d)} aria-label={`Remove ${d.label}`}>Remove</button>
      </li>)}
    </ul>}
  </section>;
}
