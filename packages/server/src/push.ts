// Web Push to subscribed browsers (the web client's service worker), for the
// notifications agents send on the user's request (push.notify, `casm notify`).
// The VAPID key pair is generated once into $CASM_HOME (push-vapid.json, 0600)
// and never logged; payloads are small and encrypted for each device.
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, type MessageSender, type Params, type PushDevice, type Result, type UserNotification } from "@casm/protocol";
import { RpcError } from "./agents.ts";
import type { Store, StoredPushDevice } from "./db.ts";
import { generateVapidKeys, pushRequest, type PushRequest, type VapidKeys } from "./web-push.ts";

// push.notify per sender (an agent, a schedule, or a client): this many a minute.
export const NOTIFY_PER_MINUTE = 10;

export type PushSend = (req: PushRequest) => Promise<{ status: number; headers: Headers; body: string }>;

const fetchSend: PushSend = async (req) => {
  const res = await fetch(req.endpoint, { method: "POST", headers: req.headers, body: new Uint8Array(req.body), signal: AbortSignal.timeout(15_000) });
  return { status: res.status, headers: res.headers, body: (await res.text().catch(() => "")).slice(0, 300) };
};

// The service worker shows `title` and `body`; a click opens `url`.
export type PushPayload = { title: string; body: string; tag: string; url: string };

export type PushContext = {
  // This server's identity: its name is the web client's host in agent URLs.
  server: { id: string; name: string };
  // Who started the agent's running turn, to attribute a schedule's notifications.
  turnSender: (agentId: string) => MessageSender | undefined;
};

export class PushService {
  private store: Store;
  private file: string | null;
  private log: (msg: string) => void;
  private send: PushSend;
  private now: () => number;
  private keys: VapidKeys | null = null;
  // Recent push.notify times per sender, for the rate limit.
  private recent = new Map<string, number[]>();
  // Devices whose push service asked to slow down (429), until then.
  private backoff = new Map<string, number>();

  constructor(opts: { store: Store; home?: string; log?: (msg: string) => void; send?: PushSend; now?: () => number }) {
    this.store = opts.store;
    this.file = opts.home ? join(opts.home, "push-vapid.json") : null;
    this.log = opts.log ?? (() => {});
    this.send = opts.send ?? fetchSend;
    this.now = opts.now ?? Date.now;
  }

  // Loaded or generated on first use, so servers nobody subscribes to write nothing.
  vapid(): VapidKeys {
    if (this.keys) return this.keys;
    if (this.file && existsSync(this.file)) this.keys = JSON.parse(readFileSync(this.file, "utf8")) as VapidKeys;
    else {
      this.keys = generateVapidKeys();
      if (this.file) {
        writeFileSync(this.file, JSON.stringify(this.keys), { mode: 0o600 });
        chmodSync(this.file, 0o600);
      }
    }
    return this.keys;
  }

  private device(d: StoredPushDevice, endpoint?: string): PushDevice {
    return {
      id: d.id, label: d.label, service: new URL(d.endpoint).host, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt,
      ...(endpoint !== undefined ? { current: d.endpoint === endpoint } : {}),
    };
  }

  list(endpoint?: string): Result<"push.list"> {
    return { publicKey: this.vapid().publicKey, devices: this.store.listPushDevices().map((d) => this.device(d, endpoint)) };
  }

  subscribe(p: Params<"push.subscribe">): PushDevice {
    const { endpoint, keys } = p.subscription;
    if (!endpoint.startsWith("https://")) throw new RpcError(ErrorCode.InvalidParams, "a push endpoint must be an https URL");
    if (Buffer.from(keys.p256dh, "base64url").length !== 65 || Buffer.from(keys.auth, "base64url").length !== 16)
      throw new RpcError(ErrorCode.InvalidParams, "the subscription's keys are not a P-256 key and a 16-byte auth secret");
    const d = this.store.savePushDevice({ endpoint, p256dh: keys.p256dh, auth: keys.auth, label: p.label.trim() || "Browser", origin: p.origin ?? null });
    this.backoff.delete(d.id);
    return this.device(d, endpoint);
  }

  unsubscribe(p: Params<"push.unsubscribe">): Result<"push.unsubscribe"> {
    if (!p.id && !p.endpoint) throw new RpcError(ErrorCode.InvalidParams, "give the device id or its endpoint");
    const d = this.store.listPushDevices().find((x) => (p.id ? x.id === p.id : x.endpoint === p.endpoint));
    return { removed: !!d && this.store.removePushDevice(d.id) };
  }

  async test(id: string, serverName: string) {
    const d = this.store.listPushDevices().find((x) => x.id === id);
    if (!d) throw new RpcError(ErrorCode.NotFound, `push device ${id} not found`);
    const error = await this.deliver(d, { title: `casm · ${serverName}`, body: `Test notification for ${d.label}.`, tag: `test-${randomUUID()}`, url: "/" });
    if (error) throw new RpcError(ErrorCode.Unreachable, error);
    return { ok: true as const };
  }

  // Builds the notification (titled and linked after a local agent sender),
  // then pushes it to the devices.
  async notify(p: Params<"push.notify">, ctx: PushContext, caller: string): Promise<Result<"push.notify">> {
    const devices = this.store.listPushDevices();
    const targets = p.device ? devices.filter((d) => d.id === p.device || d.label.toLowerCase() === p.device!.toLowerCase()) : devices;
    if (p.device && !targets.length)
      throw new RpcError(ErrorCode.NotFound, `no device "${p.device}" subscribed on ${ctx.server.name} (devices: ${devices.map((d) => d.label).join(", ") || "none"})`);
    if (p.url !== undefined && !/^\/(?!\/)/.test(p.url)) throw new RpcError(ErrorCode.InvalidParams, `url must be a path on the web client, like /h/${ctx.server.name}/a/<agent>`);
    this.limit(p.sender ? `${p.sender.serverId}/${p.sender.agentId}` : `client/${caller}`);

    const notification: UserNotification = { id: randomUUID(), title: p.title ?? "", body: p.message, at: new Date(this.now()).toISOString() };
    const sender = p.sender;
    const local = sender?.serverId === ctx.server.id ? this.store.getAgent(sender.agentId) : undefined;
    if (local) {
      const project = this.store.getProject(local.projectId)?.name;
      const schedule = sender!.schedule ?? ctx.turnSender(local.id)?.schedule;
      notification.title ||= [local.name, project, schedule && `schedule ${schedule.name}`].filter(Boolean).join(" · ");
      notification.agentId = local.id;
      notification.url = `/h/${encodeURIComponent(ctx.server.name)}/a/${encodeURIComponent(local.id)}`;
    } else if (sender) {
      notification.title ||= [sender.schedule ? `schedule ${sender.schedule.name}` : (sender.name ?? "agent"), sender.host].filter(Boolean).join(" · ");
    }
    notification.title ||= `casm · ${ctx.server.name}`;
    if (p.url) notification.url = p.url;

    const payload: PushPayload = { title: notification.title, body: notification.body, tag: notification.id, url: notification.url ?? "/" };
    const errors = await Promise.all(targets.map((d) => this.deliver(d, payload)));
    const failed = targets.flatMap((d, i) => (errors[i] ? [{ device: d.label, error: errors[i] }] : []));
    return { notification, delivered: targets.length - failed.length, devices: targets.length, failed };
  }

  private limit(key: string) {
    const now = this.now();
    const times = (this.recent.get(key) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= NOTIFY_PER_MINUTE) {
      const wait = Math.ceil((times[0] + 60_000 - now) / 1000);
      throw new RpcError(ErrorCode.Busy, `too many notifications: at most ${NOTIFY_PER_MINUTE} a minute; try again in ${wait} s`);
    }
    this.recent.set(key, [...times, now]);
  }

  // Null when the push service took it, else why not. A gone subscription
  // (404/410) is deleted; 429 pauses the device for its Retry-After.
  private async deliver(d: StoredPushDevice, payload: PushPayload): Promise<string | null> {
    if ((this.backoff.get(d.id) ?? 0) > this.now()) return "the push service asked to slow down; try again later";
    const subject = d.origin?.startsWith("https://") ? d.origin : "mailto:casm@localhost";
    let res: Awaited<ReturnType<PushSend>>;
    try {
      res = await this.send(pushRequest(d, JSON.stringify(payload), this.vapid(), { ttl: 86_400, urgency: "high", subject }));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.log(`push to ${d.label} failed: ${why}`);
      return why;
    }
    if (res.status >= 200 && res.status < 300) {
      this.store.touchPushDevice(d.id);
      return null;
    }
    if (res.status === 404 || res.status === 410) {
      this.store.removePushDevice(d.id);
      this.log(`push subscription of ${d.label} expired (${res.status}); removed`);
      return "the subscription expired and was removed; enable notifications on the device again";
    }
    if (res.status === 429) {
      const after = Number(res.headers.get("retry-after"));
      this.backoff.set(d.id, this.now() + (after > 0 ? after * 1000 : 60_000));
    }
    this.log(`push to ${d.label} answered ${res.status}: ${res.body}`);
    return `the push service answered ${res.status}${res.body ? `: ${res.body}` : ""}`;
  }
}
