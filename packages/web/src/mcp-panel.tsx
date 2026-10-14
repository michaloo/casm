import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { McpAction, McpStatus } from "@casm/protocol";
import type { Rpc } from "./state";

export function McpPanel({ rpc, host, id, name, close }: { rpc: Rpc; host: string; id: string; name: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<McpStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = async () => setStatus(await rpc.call("agent.mcpStatus", { id }, host));
  useEffect(() => { dialog.current?.showModal(); let active = true;
    void rpc.call("agent.mcpStatus", { id }, host).then((s) => { if (active) setStatus(s); }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [rpc, host, id]);
  const run = async (op: () => Promise<McpAction | void>) => {
    setBusy(true); setError(""); setNotice("");
    try { const result = await op(); if (result) setNotice(result.message); }
    catch (e) { setError(String(e)); }
    finally { try { await refresh(); } catch (e) { setError((old) => old || String(e)); } setBusy(false); }
  };
  return createPortal(<dialog className="host-settings mcp-panel" ref={dialog} aria-label={`MCP servers for ${name}`} onClose={close}>
    <header><h2>MCP servers · {name}</h2><button type="button" aria-label="Close MCP servers" onClick={() => dialog.current?.close()}>×</button></header>
    <div className="settings-content">
      <p>Connections for this agent's provider session. Opening this panel starts a session if needed.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {status?.message && <p>{status.message}</p>}
      {status?.reconnect === "all" && <p>This provider reloads all MCP servers together. The next active turn applies refreshed configuration.</p>}
      <div className="settings-actions">
        <button type="button" disabled={busy} onClick={() => void run(async () => {})}>Refresh status</button>
        {status && <button type="button" disabled={busy} onClick={() => void run(() => rpc.call("agent.mcpReconnect", { id }, host))}>{status.reconnect === "reload" ? "Reload agent to reconnect" : "Reconnect all"}</button>}
      </div>
      {!status && !error && <p role="status">Loading MCP servers…</p>}
      {status && !status.servers.length && status.reconnect !== "reload" && <p>No MCP servers configured.</p>}
      {status?.servers.map((server) => <article className="settings-card" key={server.name}>
        <h3>{server.name}</h3><p>{server.status} · {server.toolsKnown === false ? "Tool count unavailable" : `${server.tools} tools`}</p>
        {server.error && <p className="error">{server.error}</p>}
        <div className="settings-actions">
          {status.reconnect === "server" && <button type="button" disabled={busy || server.status === "disabled"} onClick={() => void run(() => rpc.call("agent.mcpReconnect", { id, server: server.name }, host))}>Reconnect {server.name}</button>}
          {status.canToggle && <button type="button" disabled={busy} onClick={() => void run(() => rpc.call("agent.mcpToggle", { id, server: server.name, enabled: server.status === "disabled" }, host))}>{server.status === "disabled" ? "Enable" : "Disable"} {server.name}</button>}
        </div>
      </article>)}
    </div>
  </dialog>, document.body);
}
