// The host-level agent prompt: what casm tells every agent about itself, put in
// front of the agent's own config.systemPrompt when its session opens (start or
// resume), for every provider. $CASM_HOME/agent-prompt.md replaces the built-in
// default; "agentPrompt": false in $CASM_HOME/config.json turns it off.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_PROMPT_FILE = "agent-prompt.md";

// Filled in per agent.
export const PLACEHOLDERS = ["host", "agentId", "agentName", "project", "cwd", "provider"] as const;
export type PromptVars = Record<(typeof PLACEHOLDERS)[number], string>;

export const DEFAULT_AGENT_PROMPT = `You are running as an agent inside casm, an agent orchestrator, on host {{host}}.
You are agent "{{agentName}}" (id {{agentId}}, {{provider}}) in project {{project}}, working in {{cwd}}.
To work with other agents, run the \`casm\` CLI from your shell: it is how you spawn, message and steer them, here or on other hosts. <agent> takes an id, id prefix or name.
When you delegate work to another agent, spawn it with \`casm run\` rather than your provider's built-in subagent or task tool (Claude's Agent/Task tool, Codex sub-agents, OpenCode child sessions). casm agents are visible to the user, can be messaged, steered and resumed, survive restarts, and can use any provider or host. Use built-in subagents only for quick read-only lookups inside your own turn.

- Spawn an agent: \`casm run --project <project> [--cwd <subfolder>] [--provider claude|codex|pi|opencode] [--model m] [--name n] "<prompt>"\`. You become its parent automatically; \`casm projects\` lists projects.
- Message an agent: \`casm send <agent> "<text>"\`. While it is busy the message is queued and goes when it is idle; \`--steer\` puts it into the running turn instead. Your messages show you as the sender.
- Follow up: \`casm wait <agent>\` waits for its reply, \`casm history <agent>\` reads its transcript, \`casm agents\` lists agents and their status.
- Unblock an agent: \`casm permissions <agent>\` and \`casm approve|deny <agent> <request>\`; \`casm questions <agent>\` and \`casm answer <agent> <request> <prompt>=<value>\`.
- Later or recurring tasks: \`casm schedule add (--at 18:30 | --at "in 2h" | --every 30m | --cron "0 9 * * 1-5") --agent <agent> "<prompt>"\`, one-off or repeating; \`casm schedules\` lists them.
- Waiting messages: \`casm pending\` lists queued, limit-deferred and failed messages and agents waiting for an answer; \`casm cancel <agent> <message-id>\` drops one.
- Other hosts: \`casm peers\` lists them; \`-H <peer>\` runs any command there (e.g. \`casm -H <peer> run ...\`).
- Notify the user: when the user asks to be notified (e.g. when something finishes or happens), run \`casm notify "<message>"\`. It reaches the devices they enabled notifications on.
- Limits: \`casm limits\` shows each provider's subscription windows (used %, reset time); \`casm usage <agent>\` shows an agent's context and cost.
\`casm --help\` lists every command.`;

export type AgentPromptState = {
  enabled: boolean;
  // The template in effect: the file's, else the default.
  content: string;
  custom: boolean;
  path: string | null;
};

export class AgentPrompt {
  // Null: no state directory (tests); the default applies and can't be changed.
  readonly home: string | null;
  constructor(home: string | null) {
    this.home = home;
  }

  get path(): string | null {
    return this.home && join(this.home, AGENT_PROMPT_FILE);
  }

  private configFile() {
    return this.home && join(this.home, "config.json");
  }

  private readConfig(): Record<string, unknown> {
    const file = this.configFile();
    try {
      return file ? JSON.parse(readFileSync(file, "utf8")) : {};
    } catch {
      return {};
    }
  }

  // Read on every session open, so edits apply to the next session without a restart.
  state(): AgentPromptState {
    const path = this.path;
    let custom = "";
    try {
      if (path) custom = readFileSync(path, "utf8");
    } catch {}
    return {
      enabled: this.readConfig().agentPrompt !== false,
      content: custom.trim() ? custom : DEFAULT_AGENT_PROMPT,
      custom: !!custom.trim(),
      path,
    };
  }

  // `content` null removes the file (back to the default).
  set(update: { content?: string | null; enabled?: boolean }): AgentPromptState {
    if (!this.home) throw new Error("this server has no state directory to keep the agent prompt in");
    if (update.content === null) rmSync(this.path!, { force: true });
    else if (update.content !== undefined) atomicWrite(this.path!, update.content.endsWith("\n") ? update.content : update.content + "\n");
    if (update.enabled !== undefined) atomicWrite(this.configFile()!, JSON.stringify({ ...this.readConfig(), agentPrompt: update.enabled }, null, 2) + "\n");
    return this.state();
  }

  // The prompt for one agent, or null when it is turned off.
  render(vars: PromptVars, state = this.state()): string | null {
    return state.enabled ? fill(state.content, vars) : null;
  }
}

export function fill(template: string, vars: PromptVars): string {
  // {{casmTools}} (casm's former MCP tools line) is left in older custom prompts: it fills in empty.
  const values: Record<string, string> = { ...vars, casmTools: "" };
  return template
    .split("\n")
    // A line that only held an empty placeholder goes away.
    .flatMap((line) => {
      const filled = line.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? values[k]! : m));
      return filled.trim() === "" && line.trim() !== "" ? [] : [filled];
    })
    .join("\n")
    .trim();
}

function atomicWrite(file: string, content: string) {
  writeFileSync(`${file}.tmp`, content);
  renameSync(`${file}.tmp`, file);
}
