import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Agent, Project, ProviderId, Schedule, ScheduleTarget } from "@casm/protocol";
import type { Rpc } from "./state";
import { providerNames } from "./provider-icon";
import { resetLabel } from "./usage-label";
import { agoLabel, cadenceLabel, cronPreview, dateLabel, describeCron, everyLabel, isFinished, localInput, outcomeLabels, parseCadence } from "./schedule-label";

// schedule.changed/removed notifications, by host, for open schedule lists.
const listeners = new Set<(host: string) => void>();
export function schedulesChanged(host: string) {
  for (const listener of listeners) listener(host);
}

type Names = { agents: Map<string, Agent>; projects: Map<string, string> };

export function HostSchedules({ host, rpc, online, agents, projects, openAgent }: {
  host: string; rpc: Rpc | null; online: boolean; agents: Agent[]; projects: Project[]; openAgent?: (agent: Agent) => void;
}) {
  const [schedules, setSchedules] = useState<Schedule[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  // The open form: "new", or the id of the schedule being edited.
  const [form, setForm] = useState<string>();
  const [version, setVersion] = useState(0);
  const list = useRef<HTMLDivElement>(null);
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
  const names: Names = useMemo(() => ({
    agents: new Map(agents.map((a) => [a.id, a])),
    projects: new Map(projects.map((p) => [p.id, p.name])),
  }), [agents, projects]);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError("");
    let ok = true;
    try { await fn(); } catch (e) { ok = false; setError((e as Error).message); }
    setBusy("");
    setVersion((v) => v + 1);
    return ok;
  };
  // Where focus returns once the form closes: a row's Edit button, or New schedule.
  const [restore, setRestore] = useState<string>();
  useEffect(() => {
    if (form || restore === undefined) return;
    const target = list.current?.querySelector<HTMLElement>(restore ? `[data-schedule="${restore}"] .schedule-edit` : ".schedule-new");
    if (target) { target.focus(); setRestore(undefined); }
  }, [form, restore, schedules]);
  const closeForm = (focus?: string) => {
    setForm(undefined);
    setRestore(focus ?? "");
  };
  if (!online) return <p>Host offline.</p>;
  if (form) {
    const initial = schedules?.find((s) => s.id === form);
    return <ScheduleForm key={form} initial={initial} agents={agents} projects={projects} busy={busy === form} error={error}
      onCancel={() => { setError(""); closeForm(initial?.id); }}
      onDelete={initial && (async () => { if (await act(form, () => rpc!.call("schedule.delete", { id: form }, host))) closeForm(); })}
      onSave={async (params) => {
        const ok = initial
          ? await act(form, () => rpc!.call("schedule.update", { id: form, ...params }, host))
          : await act(form, () => rpc!.call("schedule.create", params, host));
        if (ok) closeForm(initial?.id);
      }} />;
  }
  const active = schedules?.filter((s) => s.enabled) ?? [];
  const paused = schedules?.filter((s) => !s.enabled && !isFinished(s)) ?? [];
  const finished = schedules?.filter(isFinished) ?? [];
  const row = (s: Schedule) => <ScheduleRow key={s.id} schedule={s} names={names} busy={busy === s.id} openAgent={openAgent}
    toggle={() => act(s.id, () => rpc!.call("schedule.update", { id: s.id, enabled: !s.enabled }, host))}
    runNow={() => act(s.id, () => rpc!.call("schedule.runNow", { id: s.id }, host))}
    edit={() => { setError(""); setForm(s.id); }} />;
  return <div ref={list} className="schedules">
    <div className="schedule-toolbar">
      <span className="schedule-summary" role="status">{schedules?.length ? [
        `${active.length} active`, paused.length && `${paused.length} paused`, finished.length && `${finished.length} finished`,
      ].filter(Boolean).join(" · ") : ""}</span>
      <button type="button" className="primary schedule-new" onClick={() => { setError(""); setForm("new"); }}>New schedule</button>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {!schedules ? !error && <p role="status">Loading schedules…</p> : !schedules.length ? <div className="schedule-empty">
      <strong>No schedules on this host yet</strong>
      <p>A schedule sends a prompt on a cadence: check in on an agent every 90 minutes, or start a fresh agent every weekday at 09:00.</p>
    </div> : <>
      <ScheduleGroup title="Active" count={active.length}>{active.map(row)}</ScheduleGroup>
      <ScheduleGroup title="Paused" count={paused.length}>{paused.map(row)}</ScheduleGroup>
      {finished.length > 0 && <details className="schedule-finished">
        <summary><span>Finished one-offs</span><span className="count">{finished.length}</span></summary>
        <ul className="schedule-list">{finished.map(row)}</ul>
      </details>}
    </>}
  </div>;
}

function ScheduleGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const id = useId();
  if (!count) return null;
  return <section className="schedule-group" aria-labelledby={id}>
    <h3 id={id}><span>{title}</span><span className="count">{count}</span></h3>
    <ul className="schedule-list">{children}</ul>
  </section>;
}

function ScheduleRow({ schedule: s, names, busy, toggle, runNow, edit, openAgent }: {
  schedule: Schedule; names: Names; busy: boolean; toggle: () => void; runNow: () => void; edit: () => void; openAgent?: (agent: Agent) => void;
}) {
  const finished = isFinished(s);
  const target = s.target;
  const targetAgent = target.type === "agent" ? names.agents.get(target.agentId) : undefined;
  const ranAgent = s.lastRun?.agentId ? names.agents.get(s.lastRun.agentId) : s.lastRun ? targetAgent : undefined;
  // Default names just repeat the target ("→ Reviewer"); the prompt says more.
  const autoName = s.name.startsWith("→ ") || /^new \w+ agent$/.test(s.name);
  const agentLink = (agent: Agent | undefined, label: ReactNode) => agent && !agent.archivedAt && openAgent
    ? <button type="button" className="link" onClick={() => openAgent(agent)}>{label}</button> : label;
  return <li className="schedule-row" data-schedule={s.id} data-state={s.enabled ? "on" : finished ? "done" : "off"}>
    <button type="button" role="switch" className="switch" aria-checked={s.enabled} disabled={busy}
      aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`} title={s.enabled ? "Active · click to pause" : "Paused · click to activate"}
      onClick={toggle} />
    <div className="schedule-main">
      <strong className="schedule-name" title={autoName ? s.prompt : s.name}>{autoName ? s.prompt.split("\n").find((l) => l.trim()) ?? s.name : s.name}</strong>
      <span className="schedule-meta">
        <span className="schedule-cadence">{cadenceLabel(s.cadence)}</span>
        <span aria-hidden="true" className="arrow"> → </span>
        {target.type === "agent"
          ? <span className={targetAgent ? "" : "missing"}>{agentLink(targetAgent, targetAgent?.name ?? "removed agent")}{target.whenBusy === "skip" ? " · skips when busy" : ""}</span>
          : <span className={names.projects.has(target.projectId) ? "" : "missing"}>new {providerNames[target.provider] ?? target.provider} agent in {names.projects.get(target.projectId) ?? "a removed project"}</span>}
      </span>
      {!autoName && <span className="schedule-prompt" title={s.prompt}>{s.prompt}</span>}
      <span className="schedule-status">
        {s.enabled
          ? s.nextRunAt ? <span className="next">Next <time dateTime={s.nextRunAt} title={new Date(s.nextRunAt).toLocaleString()}>{resetLabel(s.nextRunAt)}</time></span> : "Not scheduled"
          : finished ? "Done" : "Paused"}
        {s.lastRun && <> · <span className={`outcome ${s.lastRun.outcome}`}>{agentLink(ranAgent, `${outcomeLabels[s.lastRun.outcome]}`)} <time dateTime={s.lastRun.at} title={new Date(s.lastRun.at).toLocaleString()}>{agoLabel(s.lastRun.at)}</time></span></>}
      </span>
      {s.lastRun?.error && <span className="schedule-error" title={s.lastRun.error}>{s.lastRun.error}</span>}
    </div>
    <div className="schedule-actions">
      <button type="button" className="icon-button" disabled={busy} aria-label={`Run ${s.name} now`} title="Run now" onClick={runNow}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" /></svg>
      </button>
      <button type="button" className="icon-button schedule-edit" disabled={busy} aria-label={`Edit ${s.name}`} title="Edit" onClick={edit}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.1 2.3a1.5 1.5 0 0 1 2.1 0l.5.5a1.5 1.5 0 0 1 0 2.1L6 12.6l-3.2.8.8-3.2z" /></svg>
      </button>
    </div>
  </li>;
}

type SaveParams = { name?: string; cadence: Schedule["cadence"]; target: ScheduleTarget; prompt: string };
type Kind = Schedule["cadence"]["type"];
type Unit = 1 | 60 | 1440;
const units: [Unit, string][] = [[1, "minutes"], [60, "hours"], [1440, "days"]];
const presets: [string, string][] = [["0 9 * * 1-5", "Weekdays 09:00"], ["0 9 * * *", "Daily 09:00"], ["0 * * * *", "Hourly"], ["0 9 * * 1", "Mondays 09:00"], ["30 17 * * 1-5", "Weekdays 17:30"]];

function ScheduleForm({ agents, projects, onSave, onCancel, onDelete, initial, busy, error }: {
  agents: Agent[]; projects: Project[]; onSave: (p: SaveParams) => void; onCancel: () => void; onDelete?: () => void;
  initial?: Schedule; busy?: boolean; error?: string;
}) {
  const id = useId();
  const live = agents.filter((a) => !a.archivedAt).sort((a, b) => a.name.localeCompare(b.name));
  const cadence = initial?.cadence;
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<Kind>(cadence?.type ?? "every");
  const startMinutes = cadence?.type === "every" ? cadence.minutes : 60;
  const [unit, setUnit] = useState<Unit>(startMinutes % 1440 === 0 ? 1440 : startMinutes % 60 === 0 ? 60 : 1);
  const [every, setEvery] = useState(String(startMinutes / unit));
  const [cron, setCron] = useState(cadence?.type === "cron" ? cadence.expr : "0 9 * * 1-5");
  const [once, setOnce] = useState(() => {
    if (cadence?.type === "once") return localInput(new Date(cadence.at));
    const next = new Date();
    next.setHours(next.getHours() + 1, 0, 0, 0);
    return localInput(next);
  });
  const target = initial?.target;
  const [targetKind, setTargetKind] = useState<ScheduleTarget["type"]>(target?.type ?? (live.length ? "agent" : "newAgent"));
  const [agentId, setAgentId] = useState(target?.type === "agent" ? target.agentId : live[0]?.id ?? "");
  const [whenBusy, setWhenBusy] = useState(target?.type === "agent" ? target.whenBusy ?? "queue" : "queue");
  const [projectId, setProjectId] = useState(target?.type === "newAgent" ? target.projectId : projects[0]?.id ?? "");
  const [provider, setProvider] = useState<ProviderId>(target?.type === "newAgent" ? target.provider : "claude");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [problems, setProblems] = useState<Partial<Record<"when" | "target" | "prompt", string>>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const missingAgent = target?.type === "agent" && !live.some((a) => a.id === target.agentId);
  const whenValue = kind === "every" ? String(Number(every) * unit) : kind === "cron" ? cron : once;
  const preview = useMemo(() => {
    if (kind === "every") {
      const minutes = Number(every) * unit;
      return Number.isInteger(minutes) && minutes > 0 ? `${everyLabel(minutes)}, starting ${initial ? "from the last run" : "after you create it"}.` : undefined;
    }
    if (kind === "once") {
      const at = new Date(once);
      if (!Number.isFinite(at.getTime())) return undefined;
      return at.getTime() <= Date.now() ? "That time has passed; pick a time in the future." : `Runs ${dateLabel(at.toISOString())} (${resetLabel(at.toISOString())}), then pauses itself.`;
    }
    const runs = cronPreview(cron);
    if (typeof runs === "string") return cron.trim() ? runs : undefined;
    return `${describeCron(cron) ?? "Custom cron"} · next ${runs.map((d) => dateLabel(d.toISOString())).join(", ")}`;
  }, [kind, every, unit, once, cron, initial]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseCadence(kind, whenValue);
    const next = {
      when: typeof parsed === "string" ? (kind === "every" ? "Enter a whole number greater than 0." : parsed) : undefined,
      target: (targetKind === "agent" ? !agentId || missingAgent : !projectId) ? targetKind === "agent" ? "Choose an agent." : "Choose a project." : undefined,
      prompt: prompt.trim() ? undefined : "Write the prompt to send.",
    };
    setProblems(next);
    const first = (Object.keys(next) as (keyof typeof next)[]).find((k) => next[k]);
    if (first) return requestAnimationFrame(() => form.current?.querySelector<HTMLElement>(`[data-field="${first}"] [aria-invalid="true"], [data-field="${first}"] input, [data-field="${first}"] select, [data-field="${first}"] textarea`)?.focus());
    onSave({
      name: name.trim() || undefined,
      cadence: parsed as Schedule["cadence"],
      target: targetKind === "agent"
        ? { ...(target?.type === "agent" ? target : {}), type: "agent", agentId, whenBusy }
        : { ...(target?.type === "newAgent" ? target : {}), type: "newAgent", projectId, provider },
      prompt,
    });
  };
  const invalid = (field: keyof typeof problems) => problems[field] ? { "aria-invalid": true, "aria-describedby": `${id}-${field}` } as const : {};
  const problem = (field: keyof typeof problems) => problems[field] && <p id={`${id}-${field}`} className="field-error">{problems[field]}</p>;
  return <form ref={form} className="schedule-form" aria-label={initial ? `Edit ${initial.name}` : "New schedule"} noValidate onSubmit={submit}
    onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
    <h3>{initial ? "Edit schedule" : "New schedule"}</h3>
    <label className="field" data-field="prompt"><span>Prompt</span>
      <textarea aria-label="Prompt" rows={Math.min(10, Math.max(4, prompt.split("\n").length + Math.floor(prompt.length / 70)))} value={prompt} autoFocus={!initial} placeholder="What should the agent do each time?" {...invalid("prompt")}
        onChange={(e) => setPrompt(e.target.value)} />
      {problem("prompt")}
    </label>

    <fieldset className="field" data-field="target">
      <legend>Send to</legend>
      <Segmented name={`${id}-target`} value={targetKind} onChange={(v) => setTargetKind(v as ScheduleTarget["type"])}
        options={[["agent", "Existing agent"], ["newAgent", "New agent"]]} />
      {targetKind === "agent" ? <div className="field-row">
        <label><span>Agent</span><select aria-label="Agent" value={missingAgent && agentId === target?.agentId ? "" : agentId} {...invalid("target")} onChange={(e) => setAgentId(e.target.value)}>
          {missingAgent && <option value="" disabled>Removed agent: choose another</option>}
          {live.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select></label>
        <label><span>If it is busy</span><select aria-label="If it is busy" value={whenBusy} onChange={(e) => setWhenBusy(e.target.value as "queue" | "skip")}>
          <option value="queue">Queue the message</option><option value="skip">Skip this run</option>
        </select></label>
      </div> : <div className="field-row">
        <label><span>Project</span><select aria-label="Project" value={projectId} {...invalid("target")} onChange={(e) => setProjectId(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label><span>Provider</span><select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
          {(Object.keys(providerNames) as ProviderId[]).map((p) => <option key={p} value={p}>{providerNames[p]}</option>)}
        </select></label>
      </div>}
      {problem("target")}
    </fieldset>

    <fieldset className="field" data-field="when">
      <legend>When</legend>
      <Segmented name={`${id}-kind`} value={kind} onChange={(v) => { setKind(v as Kind); setProblems((p) => ({ ...p, when: undefined })); }}
        options={[["every", "Repeat"], ["cron", "Calendar"], ["once", "Once"]]} />
      {kind === "every" ? <div className="field-row every">
        <label><span>Every</span><input aria-label="Every" type="number" inputMode="numeric" min={1} step={1} value={every} {...invalid("when")} onChange={(e) => setEvery(e.target.value)} /></label>
        <label><span>Unit</span><select aria-label="Unit" value={unit} onChange={(e) => setUnit(Number(e.target.value) as Unit)}>{units.map(([u, label]) => <option key={u} value={u}>{label}</option>)}</select></label>
      </div> : kind === "cron" ? <>
        <div className="cron-presets" role="group" aria-label="Common times">
          {presets.map(([expr, label]) => <button type="button" key={expr} aria-pressed={cron === expr} onClick={() => setCron(expr)}>{label}</button>)}
        </div>
        <label><span>Cron expression <small>minute hour day month weekday, host time</small></span>
          <input aria-label="Cron expression" className="mono" value={cron} spellCheck={false} autoCapitalize="off" autoCorrect="off" {...invalid("when")} onChange={(e) => setCron(e.target.value)} /></label>
      </> : <label><span>Date and time</span><input aria-label="Date and time" type="datetime-local" value={once} {...invalid("when")} onChange={(e) => setOnce(e.target.value)} /></label>}
      {problems.when ? problem("when") : preview && <p className="field-hint" aria-live="polite">{preview}</p>}
    </fieldset>

    <label className="field"><span>Name <small>optional</small></span>
      <input aria-label="Name" value={name} placeholder="Named after the target when empty" onChange={(e) => setName(e.target.value)} /></label>

    {error && <p role="alert" className="error">{error}</p>}
    {onDelete && <div className="schedule-delete">{confirmDelete
      ? <><span>Delete this schedule?</span><button type="button" className="danger" disabled={busy} onClick={onDelete}>Delete</button><button type="button" onClick={() => setConfirmDelete(false)}>Keep</button></>
      : <button type="button" className="danger quiet" disabled={busy} aria-label={`Delete ${initial?.name}`} onClick={() => setConfirmDelete(true)}>Delete schedule…</button>}</div>}
    <div className="schedule-form-actions">
      <button type="button" onClick={onCancel}>Cancel</button>
      <button className="primary" disabled={busy}>{initial ? "Save schedule" : "Create schedule"}</button>
    </div>
  </form>;
}

function Segmented({ name, value, options, onChange }: { name: string; value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return <div className="segmented">
    {options.map(([v, label]) => <label key={v}>
      <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} /><span>{label}</span>
    </label>)}
  </div>;
}
