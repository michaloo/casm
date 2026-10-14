// An OpenCode plugin casm loads into its shared `opencode serve` (through
// OPENCODE_CONFIG_CONTENT; Bun runs this file itself, so it imports nothing).
// OpenCode's config and MCP servers belong to the whole server, but casm's
// per-agent settings belong to one session, so casm writes them per session to
// <CASM_OPENCODE_STATE>/<sessionID>.json (see opencode.ts SessionState):
//
// - "shell.env" adds the agent's env (config.env and casm's CASM_* variables)
//   to its bash tool calls and user shell commands.
// - casm's MCP tools become plugin tools named casm_<tool>, which call casm's
//   MCP endpoint with the agent's own token. Sessions see them only when the
//   agent has casmTools: casm sets a session permission rule for casm_*.
//
// A subagent's child session uses the state of the session that started it.
// OpenCode loads every export of a plugin file as a plugin: export nothing else.

type State = { env?: Record<string, string>; casm?: { url: string; token: string } };
type Tool = { name: string; description: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } };
type Context = { sessionID: string; directory: string };

export default async function casmOpencodePlugin(input: { serverUrl: URL; directory: string }) {
  // Taken out of the env so agents' commands don't inherit it; OpenCode loads
  // the plugin once per directory, so the first load keeps it for the others.
  const kept = globalThis as { casmOpencodeState?: string };
  const dir = (kept.casmOpencodeState ??= process.env.CASM_OPENCODE_STATE);
  delete process.env.CASM_OPENCODE_STATE;
  if (!dir) return {};
  const { readFile } = await import("node:fs/promises");
  const read = async (name: string) => JSON.parse(await readFile(`${dir}/${name}`, "utf8")) as unknown;

  // The state of a session, or of the nearest ancestor casm wrote one for.
  async function state(sessionID: string | undefined, directory: string): Promise<State | null> {
    for (let id = sessionID, depth = 0; id && depth < 8; depth++) {
      if (!/^[\w-]+$/.test(id)) return null;
      const own = (await read(`${id}.json`).catch(() => null)) as State | null;
      if (own) return own;
      const url = new URL(`/session/${encodeURIComponent(id)}`, input.serverUrl);
      url.searchParams.set("directory", directory);
      const info = (await fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { parentID?: string } | null;
      id = info?.parentID;
    }
    return null;
  }

  const tools: Record<string, unknown> = {};
  for (const t of ((await read("tools.json").catch(() => [])) as Tool[])) {
    const props = t.inputSchema.properties ?? {};
    const required = new Set(t.inputSchema.required ?? []);
    tools[`casm_${t.name}`] = {
      description: t.description,
      // Plain JSON Schema args make every one required, so optional ones also take null.
      args: Object.fromEntries(Object.entries(props).map(([k, s]) => [k, required.has(k) ? s : { anyOf: [s, { type: "null" }] }])),
      async execute(args: Record<string, unknown>, ctx: Context) {
        const casm = (await state(ctx.sessionID, ctx.directory))?.casm;
        if (!casm) throw new Error("casm tools are not enabled for this agent");
        const res = await fetch(casm.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${casm.token}` },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: t.name, arguments: Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null)) },
          }),
        });
        const reply = (await res.json().catch(() => null)) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } } | null;
        if (!res.ok || !reply?.result) throw new Error(reply?.error?.message ?? `casm MCP: HTTP ${res.status}`);
        const text = (reply.result.content ?? []).map((c) => c.text ?? "").join("\n");
        if (reply.result.isError) throw new Error(text);
        return text;
      },
    };
  }

  return {
    tool: tools,
    async "shell.env"(hook: { cwd: string; sessionID?: string }, output: { env: Record<string, string> }) {
      const env = (await state(hook.sessionID, hook.cwd))?.env;
      if (env) Object.assign(output.env, env);
    },
  };
}
