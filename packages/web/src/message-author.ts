/** Missing provenance denotes human or legacy messages. */
export function messageAuthor(item: { kind: "user"; sender?: { serverId: string; agentId: string; name?: string } }): string {
  return item.sender ? item.sender.name?.trim() || item.sender.agentId : "You";
}
