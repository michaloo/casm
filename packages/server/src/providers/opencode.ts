// OpenCode via one shared `opencode serve` per provider: HTTP API for sessions,
// prompts and permission replies, one /global/event SSE stream routed by session.
// History comes from the server's `session/:id/message`.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import type { Answers, Catalog, Item, QuestionRequest } from "@casm/protocol";
import type { OpenOptions, Provider, ProviderEvent, ProviderSession } from "./types.ts";

const MAX_TOOL_OUTPUT = 8000;
// Keep an unused server around briefly so a reload or history read doesn't respawn it.
const IDLE_SHUTDOWN_MS = 30_000;

// --- wire shapes (the subset we read)

type ToolState = {
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
  error?: string;
};

export type OcPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start?: number; end?: number };
  tool?: string;
  callID?: string;
  state?: ToolState;
};

type OcError = { name?: string; data?: { message?: string } };

export type OcMessage = {
  info: { id: string; sessionID: string; role: "user" | "assistant"; error?: OcError };
  parts: OcPart[];
};

type OcPermission = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
};

export type OcQuestion = {
  id: string;
  sessionID: string;
  questions: {
    question: string;
    header?: string;
    options?: { label: string; description?: string }[];
    multiple?: boolean;
    custom?: boolean;
  }[];
};

export type OcProviders = {
  providers: {
    id: string;
    name?: string;
    models: Record<string, { id?: string; name?: string; status?: string; variants?: Record<string, unknown> }>;
  }[];
  default: Record<string, string>;
};

export type OcAgent = { name: string; description?: string; mode?: string; hidden?: boolean };

type OcEvent = { type: string; properties: Record<string, unknown> };

// --- normalization (shared by history and live events)

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + "\n…(truncated)" : text;
}

// One assistant part as an item, or null when there is nothing to show yet.
export function normalizePart(p: OcPart): Item | null {
  if (p.type === "text" && !p.synthetic && !p.ignored && p.text?.trim()) return { kind: "assistant", id: p.id, text: p.text };
  if (p.type === "reasoning" && p.text?.trim()) return { kind: "reasoning", id: p.id, text: p.text };
  if (p.type === "tool" && p.state) {
    const s = p.state;
    const base = { kind: "tool" as const, id: p.id, name: p.tool ?? "tool", input: s.input };
    if (s.status === "completed") return { ...base, status: "done", output: truncate(s.output ?? "") };
    if (s.status === "error") return { ...base, status: "error", output: truncate(s.error ?? "") };
    return { ...base, status: "running" };
  }
  return null;
}

export function normalizeMessages(messages: OcMessage[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (m.info.role === "user") {
      const text = m.parts
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim();
      if (text) out.push({ kind: "user", id: m.info.id, text });
      continue;
    }
    for (const p of m.parts) {
      const item = normalizePart(p);
      if (item) out.push(item);
    }
    if (m.info.error && m.info.error.name !== "MessageAbortedError")
      out.push({ kind: "notice", id: `${m.info.id}:error`, text: errorText(m.info.error) });
  }
  return out;
}

function errorText(e: OcError | undefined): string {
  return e?.data?.message || e?.name || "unknown error";
}

// --- questions: one prompt per native question; the reply is one label list per question, in order

export function questionRequest(q: OcQuestion): QuestionRequest {
  return {
    id: q.id,
    prompts: q.questions.map((x, i) => {
      const options = (x.options ?? []).map((o) => (o.description ? o : { label: o.label }));
      const base = { id: `q${i}`, text: x.question, header: x.header || undefined };
      if (!options.length) return { ...base, kind: "text" as const };
      // OpenCode allows a typed answer unless the question sets custom: false.
      return { ...base, kind: "select" as const, options, multiple: x.multiple === true, allowOther: x.custom !== false };
    }),
  };
}

export function questionReply(q: OcQuestion, answers: Answers): string[][] {
  return q.questions.map((_, i) => {
    const v = answers[`q${i}`];
    if (Array.isArray(v)) return v.filter((s) => s.trim());
    if (typeof v === "boolean") return [v ? "Yes" : "No"];
    return v?.trim() ? [v.trim()] : [];
  });
}

// --- catalog

export function parseCatalog(providers: OcProviders, agents: OcAgent[], configModel: string | undefined): Catalog {
  const first = providers.providers.find((p) => providers.default[p.id]);
  const defaultModel = configModel ?? (first ? `${first.id}/${providers.default[first.id]}` : undefined);
  const models = providers.providers.flatMap((p) =>
    Object.entries(p.models)
      .filter(([, m]) => m.status !== "deprecated")
      .map(([key, m]) => {
        const id = `${p.id}/${key}`;
        const efforts = Object.keys(m.variants ?? {});
        return {
          id,
          name: m.name ?? key,
          description: p.name ?? p.id,
          ...(id === defaultModel ? { isDefault: true } : {}),
          ...(efforts.length ? { efforts } : {}),
        };
      }),
  );
  const modes = agents
    .filter((a) => (a.mode === "primary" || a.mode === "all") && a.hidden !== true)
    .map((a) => ({ id: a.name, ...(a.description ? { description: a.description } : {}) }));
  return { models, modes };
}

// --- shared server

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

type Listener = { onEvent: (e: OcEvent) => void; onClosed: (error: string) => void };

class OpencodeServer {
  url = "";
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private stream: AbortController | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private refs = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  async acquire(): Promise<() => void> {
    this.refs++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try {
      await (this.ready ??= this.start());
    } catch (e) {
      this.release();
      throw e;
    }
    let released = false;
    return () => {
      if (!released) (released = true), this.release();
    };
  }

  private release() {
    if (--this.refs > 0) return;
    this.idleTimer = setTimeout(() => this.stop(), IDLE_SHUTDOWN_MS);
    this.idleTimer.unref();
  }

  private async start() {
    const port = await freePort();
    const bin = process.env.CASM_OPENCODE_PATH ?? "opencode";
    const proc = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    this.url = `http://127.0.0.1:${port}`;
    let stderr = "";
    proc.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    const listening = new Promise<void>((resolve, reject) => {
      proc.stdout!.on("data", (d) => String(d).includes("listening on") && resolve());
      proc.once("error", reject);
      proc.once("exit", (code) => reject(new Error(`opencode serve exited (${code}): ${stderr.trim()}`)));
    });
    proc.once("exit", (code, signal) => this.died(`opencode serve exited (${signal ?? code})`));
    process.once("exit", () => proc.kill());
    await listening;
    await this.subscribe();
  }

  private async subscribe() {
    const ctrl = new AbortController();
    this.stream = ctrl;
    const res = await fetch(`${this.url}/global/event`, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`opencode event stream: HTTP ${res.status}`);
    void (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body!) {
          buf += decoder.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (data) this.dispatch(data);
          }
        }
        if (this.stream === ctrl) this.died("opencode event stream ended");
      } catch (e) {
        if (this.stream === ctrl) this.died(`opencode event stream failed: ${e instanceof Error ? e.message : e}`);
      }
    })();
  }

  private dispatch(data: string) {
    let payload: OcEvent | undefined;
    try {
      payload = (JSON.parse(data) as { payload?: OcEvent }).payload;
    } catch {
      return;
    }
    const sid = payload?.properties?.sessionID;
    if (typeof sid !== "string") return;
    for (const l of this.listeners.get(sid) ?? []) l.onEvent(payload!);
  }

  private died(error: string) {
    if (!this.proc) return;
    this.proc = null;
    this.ready = null;
    this.stream?.abort();
    this.stream = null;
    const all = [...this.listeners.values()].flatMap((s) => [...s]);
    this.listeners.clear();
    for (const l of all) l.onClosed(error);
  }

  stop() {
    const p = this.proc;
    this.died("opencode serve stopped");
    p?.kill();
  }

  listen(sessionId: string, l: Listener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) this.listeners.set(sessionId, (set = new Set()));
    set.add(l);
    return () => set.delete(l);
  }

  async request<T>(method: string, path: string, directory: string, body?: unknown): Promise<T> {
    const url = `${this.url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`;
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`opencode ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

// --- session

function modelRef(model: string | undefined): { providerID: string; modelID: string } | undefined {
  const i = model?.indexOf("/") ?? -1;
  return model && i > 0 ? { providerID: model.slice(0, i), modelID: model.slice(i + 1) } : undefined;
}

class OpencodeSession implements ProviderSession {
  private opts: OpenOptions;
  private server: OpencodeServer;
  private sessionId: Promise<string>;
  private release: (() => void) | null = null;
  private unlisten: (() => void) | null = null;
  private closed = false;
  private busy = false;
  private interrupted = false;
  private error: string | undefined;
  private turnAbort = new AbortController();
  // Roles by message id, part types by part id, last emitted tool status by part id.
  private roles = new Map<string, string>();
  private partTypes = new Map<string, string>();
  private toolStatus = new Map<string, string>();

  constructor(opts: OpenOptions, server: OpencodeServer) {
    this.opts = opts;
    this.server = server;
    this.sessionId = this.init();
    this.sessionId.catch((e) => this.finish(e instanceof Error ? e.message : String(e)));
  }

  private async init(): Promise<string> {
    this.release = await this.server.acquire();
    if (this.closed) {
      this.release();
      throw new Error("closed");
    }
    const id =
      this.opts.resumeId ?? (await this.server.request<{ id: string }>("POST", "/session", this.opts.cwd, {})).id;
    this.unlisten = this.server.listen(id, { onEvent: (e) => this.handle(e), onClosed: (err) => this.finish(err) });
    this.opts.emit({ type: "sessionId", id });
    return id;
  }

  private emit(e: ProviderEvent) {
    if (!this.closed) this.opts.emit(e);
  }

  private handle(e: OcEvent) {
    const p = e.properties;
    switch (e.type) {
      case "message.updated": {
        const info = p.info as OcMessage["info"];
        this.roles.set(info.id, info.role);
        if (info.error && info.error.name !== "MessageAbortedError") this.error = errorText(info.error);
        return;
      }
      case "message.part.updated": {
        const part = p.part as OcPart;
        this.partTypes.set(part.id, part.type);
        if (this.roles.get(part.messageID) !== "assistant") return;
        const item = normalizePart(part);
        if (!item) return;
        if (item.kind === "tool") {
          // Running updates repeat with streamed output; only status changes matter.
          if (part.state?.status === "pending" || this.toolStatus.get(item.id) === item.status) return;
          this.toolStatus.set(item.id, item.status);
        } else if (!part.time?.end) return;
        this.emit({ type: "item", item });
        return;
      }
      case "message.part.delta": {
        if (p.field !== "text" || this.roles.get(String(p.messageID)) !== "assistant") return;
        const kind = this.partTypes.get(String(p.partID));
        if (kind === "text") this.emit({ type: "delta", kind: "assistant", text: String(p.delta) });
        else if (kind === "reasoning") this.emit({ type: "delta", kind: "reasoning", text: String(p.delta) });
        return;
      }
      case "session.error": {
        const err = p.error as OcError | undefined;
        if (err && err.name !== "MessageAbortedError") this.error = errorText(err);
        return;
      }
      case "session.status": {
        const status = (p.status as { type: string }).type;
        if (status === "busy") this.busy = true;
        else if (status === "idle" && this.busy) this.endTurn();
        return;
      }
      case "permission.asked":
        void this.permission(p as unknown as OcPermission);
        return;
      case "question.asked":
        void this.question(p as unknown as OcQuestion);
        return;
    }
  }

  private async question(q: OcQuestion) {
    const signal = this.turnAbort.signal;
    let answers: Answers | null = null;
    try {
      answers = await this.opts.askQuestion(questionRequest(q), signal);
    } catch {
      // Aborted: reject so the tool call ends like a dismissal.
    }
    const path = answers ? `/question/${q.id}/reply` : `/question/${q.id}/reject`;
    const body = answers ? { answers: questionReply(q, answers) } : undefined;
    await this.server.request("POST", path, this.opts.cwd, body).catch(() => {
      // The server already dropped it (turn aborted or answered elsewhere).
    });
  }

  private async permission(req: OcPermission) {
    const signal = this.turnAbort.signal;
    try {
      const answer = await this.opts.askPermission(
        {
          id: req.id,
          toolName: req.permission,
          input: req.metadata,
          title: `${req.permission} ${req.patterns.join(", ")}`.trim(),
          canAlwaysAllow: req.always.length > 0,
        },
        signal,
      );
      const reply = answer.decision === "allow" ? "once" : answer.decision === "allowAlways" ? "always" : "reject";
      await this.server.request("POST", `/permission/${req.id}/reply`, this.opts.cwd, {
        reply,
        message: reply === "reject" ? answer.message : undefined,
      });
    } catch {
      // Aborted turn or a stale request; the server cleans up on abort.
    }
  }

  private endTurn() {
    const interrupted = this.interrupted;
    const error = this.error;
    this.busy = false;
    this.interrupted = false;
    this.error = undefined;
    this.turnAbort.abort();
    this.turnAbort = new AbortController();
    if (interrupted) this.emit({ type: "turnEnded", outcome: "interrupted" });
    else this.emit({ type: "turnEnded", outcome: error ? "failed" : "completed", error });
  }

  private finish(error: string) {
    if (this.closed) return;
    this.emit({ type: "closed", error });
    void this.close();
  }

  send(text: string, _itemId: string) {
    const { config, cwd } = this.opts;
    void this.sessionId
      .then((id) => {
        this.busy = true;
        return this.server.request("POST", `/session/${id}/prompt_async`, cwd, {
          parts: [{ type: "text", text }],
          model: modelRef(config.model),
          agent: config.mode,
          variant: config.effort,
          system: config.systemPrompt,
        });
      })
      .catch((e) => {
        if (this.closed) return;
        this.busy = false;
        this.emit({ type: "turnEnded", outcome: "failed", error: e instanceof Error ? e.message : String(e) });
      });
  }

  async interrupt() {
    this.interrupted = true;
    this.turnAbort.abort();
    const id = await this.sessionId;
    await this.server.request("POST", `/session/${id}/abort`, this.opts.cwd);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.turnAbort.abort();
    if (this.busy) {
      const id = await this.sessionId.catch(() => null);
      if (id) await this.server.request("POST", `/session/${id}/abort`, this.opts.cwd).catch(() => {});
    }
    this.unlisten?.();
    this.release?.();
  }
}

export function opencodeProvider(): Provider {
  const server = new OpencodeServer();
  return {
    id: "opencode",
    open: (opts) => new OpencodeSession(opts, server),
    async history(sessionId, cwd) {
      const release = await server.acquire();
      try {
        return normalizeMessages(await server.request<OcMessage[]>("GET", `/session/${sessionId}/message`, cwd));
      } finally {
        release();
      }
    },
    async catalog() {
      const release = await server.acquire();
      try {
        const dir = homedir();
        const [providers, agents, config] = await Promise.all([
          server.request<OcProviders>("GET", "/config/providers", dir),
          server.request<OcAgent[]>("GET", "/agent", dir),
          server.request<{ model?: string }>("GET", "/config", dir),
        ]);
        return parseCatalog(providers, agents, config.model);
      } finally {
        release();
      }
    },
  };
}
