# Message sender provenance

New `agent.send` and `agent.create` prompts can carry optional `sender: {serverId, agentId, name?, host?, schedule?}`. The same metadata appears on pending entries and user transcript items. An absent sender means human or legacy/unknown origin; clients keep “You” for those messages and show the agent name (or agent ID) for attributed sends. No message text is inspected to decide who sent it.

The CLI supplies origin IDs from `CASM_SERVER_ID` / `CASM_AGENT_ID`, plus `CASM_AGENT_NAME` injected into new agent sessions. The origin server resolves its own agent's current name before local delivery or forwarding to a peer. General client-token RPC provenance remains a trusted-client declaration, not an authorization boundary. Name is a snapshot; IDs remain useful after a rename or source-agent deletion.

The server adds a nullable `pending.sender` column without changing existing entries. Queueing, limit deferral, failed-prompt retention, retry, steering and normal delivery carry the metadata with the prompt. A separate SQLite `message_senders` table stores only sender metadata keyed by recipient agent and exact message ID; transcripts remain in native provider storage. Deleting the recipient cascades its metadata. Restarting the server preserves the overlay.

Native provider files do not retain arbitrary CASM fields, so history responses apply the overlay before pagination:

- Claude uses the supplied prompt UUID; Codex uses `clientUserMessageId` / native `clientId`.
- OpenCode receives an explicit native `messageID`; the adapter records its exact alias before dispatch, including command requests.
- pi matches the dedicated session's ordered user events to dispatched prompt IDs, records their native timestamps, and maps disk entry IDs through those timestamps. Existing disk entry IDs are unchanged. Rejected or handled extension prompts and completed turns discard unmatched dispatch IDs.

This covers new sends observed by this server. Legacy history cannot be backfilled reliably; messages written outside CASM, native versions that omit identity fields, pi user events without timestamps, or a crash before a provider-specific identity binding is observed can remain unattributed. The server deliberately does not guess from identical text, sender-like prefixes or display names. Native app decoding remains compatible with the additive fields; native sender-label UI is separate from the web integration.

Validation uses fake providers and temporary databases: live/pending/failed metadata, normal queue delivery, database migration/reopen, native-ID alias overlays, history pagination, and cross-host CLI attribution alongside identical human text. No production queue is consumed for verification.

`host` is the origin server name, from `CASM_SERVER_NAME` in the agent's
environment. Schedule prompts carry `schedule: {id, name}`
and the scheduling host, including new-agent targets. Their compatibility
`agentId` is `schedule:<id>`; consumers should prefer the schedule origin when
present. Display names and hosts are snapshots, not authorization claims.
CLI history shows `from <name> · <host>` for attributed prompts.
