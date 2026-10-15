// An OpenCode plugin casm loads into its shared `opencode serve` (through
// OPENCODE_CONFIG_CONTENT; Bun runs this file itself, so it imports nothing).
// OpenCode's config and MCP servers belong to the whole server, but casm's
// per-agent settings belong to one session, so casm writes them per session to
// <CASM_OPENCODE_STATE>/<sessionID>.json (see opencode.ts SessionState):
//
// "shell.env" adds the agent's env (config.env and casm's CASM_* variables,
// so the `casm` CLI links and attributes to the agent) to its bash tool calls
// and user shell commands.
//
// A subagent's child session uses the state of the session that started it.
// OpenCode loads every export of a plugin file as a plugin: export nothing else.

type State = { env?: Record<string, string> };

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

  return {
    async "shell.env"(hook: { cwd: string; sessionID?: string }, output: { env: Record<string, string> }) {
      const env = (await state(hook.sessionID, hook.cwd))?.env;
      if (env) Object.assign(output.env, env);
    },
  };
}
