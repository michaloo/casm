import type { MessageSender } from "@casm/protocol";

/** Missing provenance denotes human or legacy messages. */
export function messageAuthor(item: { kind: "user"; sender?: MessageSender }): string {
  const sender = item.sender;
  if (!sender) return "You";
  const author = sender.schedule
    ? `Schedule: ${sender.schedule.name.trim() || sender.schedule.id}`
    : sender.name?.trim() || sender.agentId;
  return sender.host?.trim() ? `${author} · ${sender.host.trim()}` : author;
}
