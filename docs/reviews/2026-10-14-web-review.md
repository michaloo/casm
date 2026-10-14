# Web/server adversarial review — 2026-10-14

Scope: changes after `9263bb8` through `09e11c2`, especially `70b3753`
(provenance/recovery), `43af01b` (sidebar/theme), `7b0ce52` (transcripts/drafts),
and `09e11c2` (steering/pending). Reviewed in the `w-health` worktree based on
`c77dae2`; build-health fix `be6e5e8` was pushed first. Findings below describe
that snapshot plus the two fixes accompanying this document. Concurrent worker
changes may supersede the handoffs; they are not claimed fixed here.

## Findings, ranked by severity

### P1 — peer reconnect leaves previously visited chats permanently stale (handoff)

Location: `packages/web/src/main.tsx`, `peer.disconnected` handler and `load()`.
Visit two agents on a peer, leave the second selected, then disconnect/reconnect
that peer while the browser's connection to its local server stays open. The
server drops both subscriptions, but the client reloads only the selected chat.
The first chat keeps `loaded=true`. Selecting it calls only `agent.pending`, not
`agent.subscribe` or `agent.history`, so its transcript and permissions stop
updating until a full browser/local-socket reconnect. If the peer is unavailable
at the single 1.6-second retry, the selected chat can also remain stale.

Static control-flow finding; the existing reconnect browser test exercises the
local socket, not this two-chat peer case. Handed to the reliability/send-path
worker via the main agent. Invalidate every cached chat for the disconnected
host and retry subscription when the host returns; add a two-chat peer test.
This reconnect path predates some reviewed UI work, but is relevant to its
claims about live pending state.

### P2 — empty account refresh forgets known exhaustion (fixed)

Location: `packages/server/src/agents.ts`, `limits()` / `recordLimits()`.
After one agent hits a provider limit, an explicit refresh returning
`{windows: []}` previously replaced the cached windows with an empty array.
The existing agent's persisted queue stayed deferred, but a newly created agent
on the same provider passed admission and immediately made another provider
request. An empty report supplies no evidence of available capacity.

Keep previous windows when an explicit refresh has no windows. The regression
in `packages/server/test/limit-recovery.test.ts` exercises the real RPC server:
hit a limit, refresh an empty report, then send to a different recipient. It
asserts the exhausted window survives and no second provider send occurs.
Healthy nonempty refresh and explicit Send now recovery remain covered.

### P2 — multiline questions silently strip line breaks (fixed)

Location: `packages/web/src/question.tsx`, text prompt rendering.
A protocol question with `kind: "text", multiline: true` used an HTML text
input. Pasted or entered multiline answers could not retain their line breaks.
Render a textarea for multiline non-secret text prompts. Secret prompts retain
the password input so this fix does not expose secrets.

`packages/web/test/question.spec.ts` checks the textarea and exact multiline
wire answer, together with masking when both `multiline` and `secret` are set.

### P2 — create succeeds / send fails leaves two copies of the draft (handoff)

Location: `packages/web/src/main.tsx`, `send()` new-agent branch.
Create copies the project draft into an agent draft and navigates there before
sending. If `agent.send` then fails, both persisted drafts remain. Retrying in
the new agent clears only its draft; returning to the project restores the old
text/images, from which another agent can be created with the same message.
The existing-agent failed-image test does not exercise this partial success.

Static finding. Handed to reliability/send-path ownership. Treat draft transfer
as a move once creation is acknowledged, retaining the only recoverable copy
with the created agent; test failure after create, retry, then return to project.
Lost acknowledgements also need explicit reconciliation before retrying create;
this review does not claim the protocol has send/create idempotency.

### P2 — reopening usage repeats an authoritative refresh (handoff)

Location: `packages/web/src/host-usage.tsx`, effect using `refresh > 0`.
After clicking Refresh usage once, the counter stays positive. Every subsequent
popover open (and reconnect while open) sends `refresh: true` again. That RPC
can release limit-deferred work, so opening a read-only usage view acquires an
unexpected side effect after the first refresh.

Static finding; handoff to sidebar/visual ownership. Keep explicit refresh
intent separate from ordinary open/read effects. Test request flags across
open → refresh → close → open, including a deferred agent.

## Build-health prerequisite (fixed separately)

The lockfile already contained TypeScript 7.0.2. The service templates exported
`NODE_ENV=production`, inherited by coding agents, so plain `npm ci` omitted
TypeScript, Vite, Playwright and other dev dependencies. `be6e5e8` removes that
setting from both templates and scrubs inherited NODE_ENV at all four provider
process boundaries, preserving explicit per-agent environment overrides. A
subprocess regression test checks the environment. Stable service installation
is left to the coordinating agent.

The web render test now declares its direct `rolldown` dependency. Root typecheck
also checks web; both scripts call the local compiler through Node, preventing
fallback to a global compiler. Removing the local compiler was verified to
produce exit 1. The prior bare `tsc` also failed when missing: shell command
chains that continued afterwards could mask that exit; no compiler check should
be inferred from their final command's status.

## Reviewed boundaries and validation

- Provenance is trusted-client metadata, not authentication. MCP binds the
  sender to its token; ordinary RPC clients can declare a sender. This matches
  `docs/message-provenance.md`, so it is not reported as a new authorization bug.
- Sender overlays use native IDs/aliases, not message-text guesses. Pi's ordered
  event association remains dependent on provider event ordering/timestamps;
  fake-provider coverage does not prove every native CLI version compatible.
- Tool images are bounded, raster-checked and never fetched through a new file
  endpoint. Codex file reads reject final-component symlinks and nonregular
  files. Markdown uses the existing renderer without a raw-HTML plugin; code
  highlighting remains separate from arbitrary HTML execution.
- Unit tests use temporary databases/fake providers; browser tests use the
  disposable loopback fixture. No production agent, stable service, or shared
  Vite service was exercised or restarted.
- Validation: clean `NODE_ENV=development npm ci`, root/server/web typecheck,
  `TMPDIR=/var/tmp/casm-unit npm test`, production build, and the complete web
  Playwright suite. Regression coverage was added for both fixes above.

No native-app parity features, send-path UX redesign, or sidebar changes are
included in this review patch.
