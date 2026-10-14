import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Agent, Project, ProviderId, Schedule, ScheduleTarget } from "@casm/protocol";
import type { Rpc } from "./state";
import { providerNames } from "./provider-icon";
import { resetLabel } from "./usage-label";
import { agoLabel, cadenceLabel, parseCadence, targetLabel } from "./schedule-label";

// schedule.changed/removed notifications, by host, for open schedule lists.
const listeners = new Set<(host: string) => void>();
export function schedulesChanged(host: string) {
  for (const listener of listeners) listener(host);
}

export function HostSchedules({ host, rpc, online, agents, projects }: {
  host: string; rpc: Rpc | null; online: boolean; agents: Agent[]; projects: Project[];
}) {
  const [schedules, setSchedules] = useState<Schedule[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = (changed: string) => { if (changed === host) setVersion((v) => v + 1); };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [host]);
  useEffect(() => {
    if (!online || !rpc) return;
    let active = true;
    void rpc.call("schedule.list", {}, host).then((value) => {
      if (active) { setSchedules(value.schedules); setError(""); }
    }).catch((e) => { if (active) setError((e as Error).message || "Schedules unavailable on this host."); });
    return () => { active = false; };
  }, [online, rpc, host, version]);
  const names = useMemo(() => ({
    agents: new Map(agents.map((a) => [a.id, a.name])),
    projects: new Map(projects.map((p) => [p.id, p.name])),
  }), [agents, projects]);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError("");
    try { await fn(); } catch (e) { setError((e as Error).message); }
    setBusy("");
    setVersion((v) => v + 1);
  };
  if (!online) return <p>Host offline.</p>;
  return <>
    <div className="host-panel-toolbar">
      <button type="button" aria-expanded={creating} onClick={() => { setEditing(undefined); setCreating((v) => !v); }}>{creating ? "Cancel" : "New schedule"}</button>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {creating && <ScheduleForm agents={agents} projects={projects} onCreate={(params) => act("create", async () => {
      await rpc!.call("schedule.create", params, host);
      setCreating(false);
    })} />}
    {!schedules ? <p role="status">Loading schedules…</p> : !schedules.length ? <p className="host-empty">No schedules on this host yet. Schedules message an agent or start a new one on a cadence.</p> :
      <ul className="schedule-list">
        {schedules.map((s) => <li key={s.id} className={s.enabled ? "" : "disabled"}>
          <div className="schedule-head">
            <button type="button" role="switch" className="switch" aria-checked={s.enabled} disabled={busy === s.id}
              aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`} title={s.enabled ? "Enabled · click to disable" : "Disabled · click to enable"}
              onClick={() => act(s.id, () => rpc!.call("schedule.update", { id: s.id, enabled: !s.enabled }, host))} />
            <strong title={s.name}>{s.name}</strong>
            {confirming === s.id ? <span className="schedule-actions">
              <button type="button" className="danger" disabled={busy === s.id} onClick={() => { setConfirming(""); void act(s.id, () => rpc!.call("schedule.delete", { id: s.id }, host)); }}>Delete</button>
              <button type="button" onClick={() => setConfirming("")}>Keep</button>
            </span> : <span className="schedule-actions">
              <button type="button" disabled={busy === s.id} aria-label={`Run ${s.name} now`} onClick={() => act(s.id, () => rpc!.call("schedule.runNow", { id: s.id }, host))}>Run now</button>
              <button type="button" disabled={busy === s.id} aria-label={`Edit ${s.name}`} onClick={() => { setCreating(false); setEditing(editing === s.id ? undefined : s.id); }}>Edit</button>
              <button type="button" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => setConfirming(s.id)}>Delete</button>
            </span>}
          </div>
          {editing === s.id && <ScheduleForm key={s.id} initial={s} agents={agents} projects={projects} busy={busy === s.id}
            onCancel={() => setEditing(undefined)} onCreate={(params) => act(s.id, async () => {
              await rpc!.call("schedule.update", { id: s.id, ...params }, host);
              setEditing(undefined);
            })} />}
          <small>{cadenceLabel(s.cadence)} · {targetLabel(s.target, names)}</small>
          <small>
            {s.enabled ? s.nextRunAt ? <>Next <time dateTime={s.nextRunAt} title={new Date(s.nextRunAt).toLocaleString()}>{resetLabel(s.nextRunAt)}</time></> : "Not scheduled" : "Disabled"}
            {s.lastRun && <> · Last {s.lastRun.outcome} <time dateTime={s.lastRun.at} title={new Date(s.lastRun.at).toLocaleString()}>{agoLabel(s.lastRun.at)}</time></>}
            {s.lastRun?.error && <span className="error" title={s.lastRun.error}> · {s.lastRun.error}</span>}
          </small>
        </li>)}
      </ul>}
  </>;
}

type CreateParams = { name?: string; cadence: Schedule["cadence"]; target: ScheduleTarget; prompt: string };

function ScheduleForm({ agents, projects, onCreate, initial, onCancel, busy }: {
  agents: Agent[]; projects: Project[]; onCreate: (p: CreateParams) => void;
  initial?: Schedule; onCancel?: () => void; busy?: boolean;
}) {
  const live = agents.filter((a) => !a.archivedAt).sort((a, b) => a.name.localeCompare(b.name));
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState(initial?.cadence.type ?? "every");
  const [when, setWhen] = useState(() => {
    const cadence = initial?.cadence;
    if (!cadence) return "60";
    if (cadence.type === "every") return String(cadence.minutes);
    if (cadence.type === "cron") return cadence.expr;
    const at = new Date(cadence.at);
    return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [targetKind, setTargetKind] = useState<"agent" | "newAgent">(initial?.target.type ?? (live.length ? "agent" : "newAgent"));
  const [agentId, setAgentId] = useState(initial?.target.type === "agent" ? initial.target.agentId : live[0]?.id ?? "");
  const [projectId, setProjectId] = useState(initial?.target.type === "newAgent" ? initial.target.projectId : projects[0]?.id ?? "");
  const [provider, setProvider] = useState<ProviderId>(initial?.target.type === "newAgent" ? initial.target.provider : "claude");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [problem, setProblem] = useState("");
  const whenLabel = kind === "every" ? "Minutes" : kind === "cron" ? "Cron expression" : "At";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const cadence = parseCadence(kind, when);
    if (typeof cadence === "string") return setProblem(cadence);
    if (targetKind === "agent" ? !agentId : !projectId) return setProblem("Choose a target.");
    setProblem("");
    onCreate({
      name: name.trim() || undefined,
      cadence,
      target: targetKind === "agent"
        ? { ...(initial?.target.type === "agent" ? initial.target : {}), type: "agent", agentId }
        : { ...(initial?.target.type === "newAgent" ? initial.target : {}), type: "newAgent", projectId, provider },
      prompt,
    });
  };
  return <form className="schedule-form" onSubmit={submit}>
    <label><span>Name</span><input aria-label="Name" value={name} placeholder="Optional" onChange={(e) => setName(e.target.value)} /></label>
    <div className="schedule-form-row">
      <label><span>When</span><select aria-label="When" value={kind} onChange={(e) => { setKind(e.target.value as Schedule["cadence"]["type"]); setWhen(e.target.value === "every" ? "60" : ""); }}>
        <option value="every">Every N minutes</option><option value="cron">Cron</option><option value="once">Once</option>
      </select></label>
      <label><span>{whenLabel}</span>
        <input required aria-label={whenLabel} value={when} onChange={(e) => setWhen(e.target.value)}
          type={kind === "every" ? "number" : kind === "once" ? "datetime-local" : "text"} min={kind === "every" ? 1 : undefined}
          placeholder={kind === "cron" ? "0 9 * * 1-5" : undefined} />
      </label>
    </div>
    <div className="schedule-form-row">
      <label><span>Target</span><select aria-label="Target" value={targetKind} onChange={(e) => setTargetKind(e.target.value as "agent" | "newAgent")}>
        <option value="agent">Message an agent</option><option value="newAgent">Start a new agent</option>
      </select></label>
      {targetKind === "agent"
        ? <label><span>Agent</span><select aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>{live.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        : <label><span>Project</span><select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
    </div>
    {targetKind === "newAgent" && <label><span>Provider</span><select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
      {(Object.keys(providerNames) as ProviderId[]).map((p) => <option key={p} value={p}>{providerNames[p]}</option>)}
    </select></label>}
    <label><span>Prompt</span><textarea aria-label="Prompt" required rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
    {problem && <p role="alert" className="error">{problem}</p>}
    {onCancel && <button type="button" onClick={onCancel}>Cancel edit</button>}
    <button className="primary" disabled={busy}>{initial ? "Save schedule" : "Create schedule"}</button>
  </form>;
}
