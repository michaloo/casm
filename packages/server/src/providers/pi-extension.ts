// A pi extension casm loads into its pi sessions (`pi -e <this file>`; pi
// compiles it itself). It registers the agent's config.mcpServers for this
// session only: they are never written to pi's mcp.json. pi's RPC mode has
// no MCP commands, so /casm-mcp enables or disables one of them.
//
// The servers arrive as JSON in CASM_PI_MCP_SERVERS, which is removed from the
// environment so the agent's own commands don't inherit their credentials.
// /reload re-runs this file; the servers are kept on globalThis for that.

type McpConfig = Record<string, unknown> & { enabled?: boolean };
type Ui = { notify(message: string, type?: "info" | "warning" | "error"): void };
type Pi = {
  registerMcpServer(name: string, config: McpConfig): void;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: { ui: Ui }): Promise<void> }): void;
  on(event: "session_start", handler: (event: unknown, ctx: { ui: Ui }) => void): void;
};

export const ENV = "CASM_PI_MCP_SERVERS";
export const COMMAND = "casm-mcp";

const state = globalThis as { casmMcpServers?: Record<string, McpConfig> };

export default function casmPiExtension(pi: Pi) {
  const env = process.env[ENV];
  if (env) {
    try {
      state.casmMcpServers = JSON.parse(env) as Record<string, McpConfig>;
    } catch {}
    delete process.env[ENV];
  }
  const servers = state.casmMcpServers ?? {};
  // pi rejects an invalid entry by throwing; report it and keep the others.
  const invalid: string[] = [];
  for (const [name, config] of Object.entries(servers)) {
    try {
      pi.registerMcpServer(name, config);
    } catch (e) {
      invalid.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (invalid.length) pi.on("session_start", (_event, ctx) => ctx.ui.notify(`casm could not add MCP servers:\n${invalid.join("\n")}`, "error"));
  pi.registerCommand(COMMAND, {
    description: "casm: enable or disable an MCP server casm added to this session",
    async handler(args, ctx) {
      const [action, name = ""] = args.trim().split(/\s+/);
      const config = servers[name];
      if ((action !== "enable" && action !== "disable") || !config) {
        ctx.ui.notify(`${COMMAND}: ${config ? `usage: /${COMMAND} enable|disable <server>` : `"${name}" is not an MCP server casm added to this session`}`, "error");
        return;
      }
      config.enabled = action === "enable";
      pi.registerMcpServer(name, config);
      ctx.ui.notify(`${COMMAND}: ${name} ${action}d`, "info");
    },
  });
}
