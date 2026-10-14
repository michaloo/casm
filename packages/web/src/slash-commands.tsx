import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Command } from "@casm/protocol";
import type { Rpc } from "./state";

export const casmCommands = [
  { name: "mcp", description: "MCP server status, reconnect, and controls" },
  { name: "reload", description: "Reload this agent session and its configuration" },
  { name: "restart", description: "Start a fresh native session for this agent" },
  { name: "interrupt", description: "Stop the current turn; keep the queue" },
] as const;
export type CasmCommand = typeof casmCommands[number]["name"];
type Choice = Command & { source: "casm" | "agent" };

export function useSlashCommands({ rpc, host, agentId, value, setValue, action, enabled }: {
  rpc: Rpc | null; host: string; agentId?: string; value: string; setValue: (text: string) => void;
  action: (name: CasmCommand) => Promise<void>; enabled: boolean;
}) {
  const id = useId();
  const [commands, setCommands] = useState<Command[]>([]);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState<string>();
  const [active, setActive] = useState(0);
  const providerSelection = useRef<string | undefined>(undefined);
  const started = /^\/[^\s]*$/.test(value);
  const open = enabled && !!agentId && started && dismissed !== value;
  useEffect(() => {
    setCommands([]); setError(""); setDismissed(undefined); providerSelection.current = undefined;
    if (!rpc || !agentId || !enabled) return;
    let current = true;
    void rpc.call("agent.commands", { id: agentId }, host).then((r) => { if (current) setCommands(r.commands); }).catch((e) => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [rpc, host, agentId, enabled]);
  useEffect(() => { setActive(0); setDismissed(undefined); if (value.split(/\s/, 1)[0] !== `/${providerSelection.current}`) providerSelection.current = undefined; }, [value]);
  const choices: Choice[] = [
    ...casmCommands.map((c) => ({ ...c, source: "casm" as const })),
    ...commands.map((c) => ({ ...c, name: c.name.replace(/^\//, ""), source: "agent" as const })),
  ].filter((c) => `${c.name} ${c.description ?? ""}`.toLowerCase().includes(value.slice(1).toLowerCase()));
  const index = Math.min(active, Math.max(choices.length - 1, 0));
  const choose = (choice: Choice, complete = false) => {
    if (choice.source === "agent") providerSelection.current = choice.name;
    if (choice.source === "casm" && !complete) void action(choice.name as CasmCommand);
    else setValue(`/${choice.name} `);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === "Escape") { e.preventDefault(); setDismissed(value); return true; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); setActive((index + (e.key === "ArrowDown" ? 1 : -1) + choices.length) % (choices.length || 1)); return true;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && choices[index]) {
      e.preventDefault(); choose(choices[index], e.key === "Tab"); return true;
    }
    return false;
  };
  const sendAction = () => {
    if (!agentId || !enabled || providerSelection.current) return false;
    const command = casmCommands.find((c) => `/${c.name}` === value.trim());
    if (!command) return false;
    void action(command.name); return true;
  };
  const selected = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) selected.current?.scrollIntoView({ block: "nearest" }); }, [index, open]);
  const palette = open ? <div className="slash-palette">
    <div id={id} role="listbox" aria-label="Slash commands">
      {choices.map((choice, i) => <button type="button" role="option" id={`${id}-${i}`} key={`${choice.source}:${choice.name}:${i}`}
        aria-selected={i === index} ref={i === index ? selected : undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(choice)}>
        <span><strong>/{choice.name}</strong>{choice.argumentHint && <code>{choice.argumentHint}</code>}<small>{choice.source === "casm" ? "casm action" : `To agent${choice.kind === "skill" ? " · skill" : ""}`}</small></span>
        {choice.description && <span className="slash-description">{choice.description}</span>}
      </button>)}
      {!choices.length && <p>No matching commands</p>}
    </div>
    {error && <p role="status">Agent commands unavailable: {error}</p>}
  </div> : null;
  return { palette, onKeyDown, sendAction, inputProps: {
    role: "combobox" as const, "aria-autocomplete": "list" as const, "aria-expanded": open,
    "aria-controls": open ? id : undefined, "aria-activedescendant": open && choices.length ? `${id}-${index}` : undefined,
  } };
}
