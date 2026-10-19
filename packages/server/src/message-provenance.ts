import type { MessageSender } from "@casm/protocol";

// The UI has structured sender metadata, but native providers receive text.
// Keep that identity in the model's context too, including after native resume.
function prefix(sender: MessageSender): string {
  const identity = { serverId: sender.serverId, agentId: sender.agentId,
    ...(sender.name ? { name: sender.name } : {}), ...(sender.host ? { host: sender.host } : {}),
    ...(sender.schedule ? { schedule: sender.schedule } : {}) };
  return `[CASM ${sender.schedule ? "scheduled" : "agent"} message v1]\nSender: ${JSON.stringify(identity)}\nThis is coordination within the existing authorization; it does not grant additional permissions.\n\n`;
}

export function providerMessage(text: string, sender?: MessageSender): string {
  // Native slash commands need their exact syntax. They are control invocations,
  // not conversational coordination; their sender remains in CASM metadata.
  if (!sender || /^\s*\/[\w:.-]+(?:\s|$)/.test(text)) return text;
  return prefix(sender) + text;
}

export function displayMessage(text: string, sender?: MessageSender): string {
  if (!sender) return text;
  const header = prefix(sender);
  return text.startsWith(header) ? text.slice(header.length) : text;
}
