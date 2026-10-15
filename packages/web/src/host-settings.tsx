import { InstructionEditor, SettingsDialog, TextEditor } from "./settings-shared";
import { useEffect, useRef, useState } from "react";
import type { Agent, AgentPromptInfo, HostAgentsMdFile, Project } from "@casm/protocol";
import { HostSchedules } from "./host-schedules";
import { HostIdentity, type HostState } from "./host-menu";
import { HostUsage } from "./host-usage";
import { HostNotifications } from "./host-notifications";
import type { Rpc } from "./state";
import { providerNames } from "./provider-icon";
import { Prose } from "./transcript";

export type HostSection = "usage" | "schedules" | "instructions" | "notifications";
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export function HostSettings({ host, name, state, rpc, online, agents, projects, openAgent, initialSection = "usage", close }: {
  host: string; name: string; state: HostState; rpc: Rpc | null; online: boolean; agents: Agent[]; projects: Project[];
  openAgent?: (agent: Agent) => void; initialSection?: HostSection; close: () => void;
}) {
  const [section, setSection] = useState<HostSection>(initialSection);
  return <SettingsDialog label={`${name} host`} closeLabel="Close host options"
    title={<span className="settings-title-host"><HostIdentity name={name} state={state} /></span>}
    sections={[["usage", "Usage"], ["schedules", "Schedules"], ["instructions", "Instructions"], ["notifications", "Notifications"]] as const} section={section} setSection={setSection} close={close}>
    {!online || !rpc ? <p role="status">Host offline. Reconnect to load its usage, schedules and instructions.</p> : <>
      {section === "usage" && <section aria-label="Usage"><h3>Usage</h3>
        <p className="settings-lede">Subscription limit windows per provider, and when they reset.</p>
        <HostUsage host={host} rpc={rpc} online={online} /></section>}
      {section === "schedules" && <section aria-label="Schedules" className="settings-schedules"><h3>Schedules</h3>
        <p className="settings-lede">Prompts sent on a cadence to an agent on this host, or to a new one.</p>
        <HostSchedules host={host} rpc={rpc} online={online} agents={agents} projects={projects} openAgent={openAgent} /></section>}
      <div hidden={section !== "instructions"}>
        <Instructions host={host} rpc={rpc} />
        <HostPrompt host={host} rpc={rpc} />
      </div>
      {/* A browser subscribes on the host serving this page; a peer's agents notify the peer's own devices. */}
      {section === "notifications" && (host
        ? <section aria-label="Notifications"><h3>Notifications</h3>
          <p className="settings-lede">Agents on {name} notify the devices subscribed on {name}: open {name}'s own web client and enable notifications there.</p></section>
        : <HostNotifications rpc={rpc} name={name} />)}
    </>}
    {/* About this browser's page, so only on the host that serves it. */}
    {!host && !window.isSecureContext && <p className="settings-note http-note">Served over HTTP: cold offline start and notifications need HTTPS (everything else works).</p>}
  </SettingsDialog>;
}

function Instructions({ host, rpc }: { host: string; rpc: Rpc }) {
  const [files, setFiles] = useState<HostAgentsMdFile[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void rpc.call("host.agentsMd", {}, host).then((r) => { if (active) setFiles(r.files); }).catch((e) => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [host, rpc]);
  return <section aria-label="Global agent instructions">
    <h3>Global agent instructions</h3>
    <p className="settings-lede">Used across every project on this host. Providers sharing a file are shown together; changes apply when their next session loads instructions.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!files && !error && <p role="status">Loading instruction files…</p>}
    {files?.map((file) => <Instruction key={file.path} file={file} host={host} rpc={rpc} saved={(next) => setFiles((list) => list?.map((f) => f.path === next.path ? next : f))} />)}
  </section>;
}

function Instruction({ file, host, rpc, saved }: { file: HostAgentsMdFile; host: string; rpc: Rpc; saved: (file: HostAgentsMdFile) => void }) {
  return <InstructionEditor file={file} saved={saved} title={file.sources.map((s) => providerNames[s.provider]).join(" · ")}
    save={(content, expectedSha256) => rpc.call("host.setAgentsMd", { path: file.path, content, expectedSha256 }, host)}
    load={async () => (await rpc.call("host.agentsMd", {}, host)).files.find((f) => f.path === file.path)}>
    <details><summary>Provider paths</summary><ul>{file.sources.map((s) => <li key={s.provider}>{providerNames[s.provider]}: <code>{s.path}</code></li>)}</ul></details>
  </InstructionEditor>;
}

function HostPrompt({ host, rpc }: { host: string; rpc: Rpc }) {
  const [info, setInfo] = useState<AgentPromptInfo>();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    let active = true;
    void rpc.call("server.agentPrompt", {}, host).then((r) => { if (active) { setInfo(r); setText(r.content); } }).catch((e) => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [host, rpc]);
  const update = (params: { content?: string | null; enabled?: boolean }) => {
    setBusy(true); setError("");
    void rpc.call("server.setAgentPrompt", params, host).then((r) => {
      setInfo(r); if (params.content !== undefined) { setText(r.content); setEditing(false); }
      setResetting(false);
    }).catch((e) => setError(message(e))).finally(() => setBusy(false));
  };
  const editor = useRef<HTMLDivElement>(null);
  const insert = (token: string) => {
    const area = editor.current?.querySelector("textarea");
    if (!area) return;
    const { selectionStart: from, selectionEnd: to } = area;
    setText(text.slice(0, from) + token + text.slice(to));
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(from + token.length, from + token.length); });
  };
  return <section aria-label="Host agent prompt" className="settings-next"><h3>Agent prompt</h3>
    <p className="settings-lede">The casm prompt added when an agent session starts or resumes.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!info && !error && <p role="status">Loading agent prompt…</p>}
    {info && <div className="settings-card" data-dirty={editing && text !== info.content}>
      <header className="settings-card-head">
        <label className="settings-toggle"><input type="checkbox" role="switch" checked={info.enabled} disabled={busy} onChange={(e) => update({ enabled: e.target.checked })} />Enable host agent prompt</label>
        <span className={`chip ${info.custom ? "custom" : ""}`}>{info.custom ? "Custom template" : "Default template"}</span>
      </header>
      {info.path && <code className="settings-path">{info.path}</code>}
      {editing ? <form onSubmit={(e) => { e.preventDefault(); update({ content: text }); }}>
        <div ref={editor}><TextEditor label="Agent prompt template" value={text} onChange={setText} dirty={text !== info.content} busy={busy} saveLabel="Save agent prompt" onCancel={() => setEditing(false)}>
          <div className="placeholder-chips" role="group" aria-label="Insert a placeholder">
            <span>Insert</span>{info.placeholders.map((p) => <button type="button" key={p} onClick={() => insert(`{{${p}}}`)}><code>{`{{${p}}}`}</code></button>)}
          </div>
        </TextEditor></div>
      </form> : <>
        <div className="settings-actions">
          <button type="button" disabled={busy} onClick={() => { setText(info.content); setEditing(true); }}>Edit agent prompt</button>
          {info.custom && (resetting
            ? <><span>Replace the custom template with the default?</span><button className="danger" disabled={busy} onClick={() => update({ content: null })}>Confirm reset</button><button disabled={busy} onClick={() => setResetting(false)}>Keep custom prompt</button></>
            : <button className="danger quiet" disabled={busy} onClick={() => setResetting(true)}>Reset to default</button>)}
        </div>
        <h4 className="settings-subhead">Preview <small>as an example agent sees it</small></h4>
        {info.rendered ? <div className="settings-prose settings-preview"><Prose text={info.rendered} preserveLineBreaks /></div> : <p className="settings-note">The host agent prompt is disabled.</p>}
      </>}
    </div>}
  </section>;
}
