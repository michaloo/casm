// A shell tool call that ran the casm CLI, shown as what it did: "Send →
// worker" with the message as prose, instead of a raw command and JSON input.
// The raw command and output stay one click away.
import { createContext, useContext, useState, type MouseEvent, type ReactNode } from "react";
import type { Item } from "@casm/protocol";
import { createdAgent, shellCommand, type CasmCall } from "./casm-command";
import { CodeBlock, Images, Prose, ToolStatus, type ToolTime } from "./transcript";

export type CasmAgentLink = { name: string; href?: string; open?: () => void };
/** Resolves an agent reference (id, prefix or name) on the transcript's host, or on -H <peer>. */
export const CasmAgentsContext = createContext<((ref: string, peer?: string) => CasmAgentLink | null) | null>(null);

const LONG_LINES = 4;
const LONG_CHARS = 320;
const isLong = (text: string) => text.length > LONG_CHARS || text.split("\n").length > LONG_LINES;
const shortRef = (ref: string) => (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ref) ? ref.slice(0, 8) : ref);

function AgentName({ agent, peer }: { agent: string; peer?: string }) {
  const resolve = useContext(CasmAgentsContext);
  const link = resolve?.(agent, peer);
  const name = link?.name || shortRef(agent);
  const title = link && link.name !== agent ? `${link.name} (${agent})` : agent;
  return (
    <span className="casm-agent">
      {link?.href ? (
        <a
          href={link.href}
          title={title}
          onClick={(e: MouseEvent) => {
            if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !link.open) return;
            e.preventDefault();
            link.open();
          }}
        >
          {name}
        </a>
      ) : (
        <span title={title}>{name}</span>
      )}
      {peer && <span className="casm-peer">@{peer}</span>}
    </span>
  );
}

function Clamped({ id, text, expansion, label }: { id: string; text: string; expansion: Record<string, boolean>; label?: ReactNode }) {
  const [expanded, setExpanded] = useState(expansion[id] ?? false);
  const long = isLong(text);
  return (
    <div className={`casm-text ${long && !expanded ? "clamped" : ""}`}>
      {label && <div className="casm-text-label">{label}</div>}
      <div className="casm-prose">
        <Prose text={text} />
      </div>
      {long && (
        <button
          type="button"
          className="casm-more"
          aria-expanded={expanded}
          onClick={() => {
            expansion[id] = !expanded;
            setExpanded(!expanded);
          }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// One short line of output reads as the call's result; longer output stays raw.
function resultLine(call: CasmCall, output: string, status: string) {
  const text = /^\(.*no output\)$/i.test(output.trim()) ? "" : output.trim();
  if (!text) return status === "done" && (call.verb === "send" || call.verb === "notify") ? (call.label === "Steer" ? "steered" : "sent") : "";
  const lines = text.split("\n");
  if (status === "error") return lines.find((l) => l.trim()) ?? "";
  return lines.length === 1 && text.length <= 160 ? text : "";
}

export function CasmToolRow({
  item,
  calls,
  time,
  expansion,
}: {
  item: Extract<Item, { kind: "tool" }>;
  calls: CasmCall[];
  time?: ToolTime;
  expansion: Record<string, boolean>;
}) {
  const rawKey = `${item.id}:raw`;
  const [raw, setRaw] = useState(expansion[rawKey] ?? false);
  const output = item.output ?? "";
  const first = calls[0];
  const last = calls[calls.length - 1];
  const labels = [...new Set(calls.map((c) => c.label))];
  const targets = [...new Set(calls.map((c) => c.agent && `${c.agent}@${c.peer ?? ""}`).filter(Boolean))];
  const shared = targets.length === 1 ? calls.find((c) => c.agent) : undefined;
  const created = first.verb === "run" && calls.length === 1 ? createdAgent(output) : undefined;
  // A wait (or run/send --wait) prints the agent's reply: prose, not a log.
  const reply = (last.verb === "wait" || (last.flags.wait === true && (last.verb === "run" || last.verb === "send"))) && item.status === "done" && output.trim() ? output.trim() : "";
  const result = reply || created ? "" : resultLine(last, output, item.status);
  const texts = calls.filter((c) => c.text || c.code);
  const command = shellCommand(item.name, item.input) ?? "";
  return (
    <div className="item tool casm-tool">
      <div className="casm-card">
        <div className="casm-head">
          <span className="mini-glyph" aria-hidden="true" />
          <strong className="casm-verb" title={calls.map((c) => `casm ${c.verb}`).join(" · ")}>
            {first.known || calls.length > 1 ? labels.join(" · ") : `casm ${first.verb}`}
          </strong>
          {shared?.agent ? (
            <AgentName agent={shared.agent} peer={shared.peer} />
          ) : created ? (
            <>
              <span className="casm-arrow" aria-hidden="true">→</span>
              <AgentName agent={created} peer={first.peer} />
            </>
          ) : first.ref && calls.length === 1 ? (
            <span className="casm-ref">{shortRef(first.ref)}</span>
          ) : first.peer && calls.every((c) => c.peer === first.peer) ? (
            <span className="casm-peer">@{first.peer}</span>
          ) : null}
          <span className="casm-result" title={result}>{result}</span>
          <ToolStatus status={item.status} time={time} />
          <button
            type="button"
            className="casm-raw-toggle"
            aria-expanded={raw}
            aria-label={raw ? "Hide raw command and output" : "Show raw command and output"}
            title="Raw command and output"
            onClick={() => {
              expansion[rawKey] = !raw;
              setRaw(!raw);
            }}
          >
            raw
          </button>
        </div>
        {texts.map((c, i) => {
          const label = calls.length > 1 && (texts.length > 1 || !shared) ? (
            <>
              {c.label}
              {c.agent && <AgentName agent={c.agent} peer={c.peer} />}
            </>
          ) : undefined;
          return c.code ? (
            <div key={i} className="casm-text">
              {label && <div className="casm-text-label">{label}</div>}
              <code className="casm-code">{c.code}</code>
            </div>
          ) : (
            <Clamped key={i} id={`${item.id}:text:${i}`} text={c.text!} expansion={expansion} label={label} />
          );
        })}
        {reply && <Clamped id={`${item.id}:reply`} text={reply} expansion={expansion} label="Reply" />}
        {raw && (
          <div className="tool-body casm-raw">
            <CodeBlock text={command} language="bash" expansion={expansion} expansionKey={`${item.id}:input`} truncate />
            {output ? (
              <CodeBlock text={output} expansion={expansion} expansionKey={`${item.id}:output`} language={/^\s*[\[{]/.test(output) ? "json" : "text"} truncate />
            ) : !item.images?.length ? (
              <p className="muted">{item.status === "running" ? "Waiting for output…" : "No output"}</p>
            ) : null}
            {item.images?.length ? <Images images={item.images} name={item.name} /> : null}
          </div>
        )}
      </div>
    </div>
  );
}
