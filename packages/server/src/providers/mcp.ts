import type { McpServer } from "@casm/protocol";

export function codexMcpServer(s: Record<string, unknown>): McpServer {
  const runtime: Record<string, McpServer["status"]> = {
    connected: "connected", disabled: "disabled", failed: "failed", cancelled: "failed",
    authenticationRequired: "needs-auth", starting: "pending", notStarted: "pending",
  };
  const tools = s.tools && typeof s.tools === "object" ? Object.keys(s.tools).length : 0;
  const error = typeof s.toolsError === "string" ? s.toolsError : undefined;
  return {
    name: String(s.name), tools,
    status: runtime[String(s.runtimeStatus)] ?? (s.authStatus === "notLoggedIn" ? "needs-auth" : error ? "failed" : tools || s.serverInfo ? "connected" : "pending"),
    ...(error ? { error } : {}),
  };
}

