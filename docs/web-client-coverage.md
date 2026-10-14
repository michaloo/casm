# Web client coverage vs macOS

Reviewed 2026-10-14 against the current working tree, including concurrent uncommitted web work. Static source review only; no tests, browser sessions, or server operations. Native reference: `apple/App/Shared` (used by macOS) and `apple/CasmKit`; macOS entry/menu integration is in `apple/App/Shared/CasmApp.swift:55–100`.

Integration followup: the findings below preserve the original review snapshot.
The multi-select/custom-answer bug and requested host usage popover are now fixed
with browser regressions. Pasted images, image-only sends, and bounded image draft
persistence are implemented. Sender labels, user-message line breaks, centered
Working status, and explicit active-turn steering are also implemented and tested.
Tool-result image display is implemented with bounded raster payloads; the remaining parity gaps
below are not automatically added to milestone 1.

## Scope and coverage already present

The coordinator confirmed the original milestone 2 deferrals: schedules, limits, images, `/commands`, and PWA/iPhone polish. Latest feedback explicitly brings **image paste/viewing and a host/provider usage tooltip** into requested work. These are no longer blanket deferrals. Other missing native features below are parity gaps, not proven milestone commitments.

| Workflow | Current web evidence | Native comparison |
| --- | --- | --- |
| Connect, discover hosts/projects/agents, reconnect | `packages/web/src/state.ts:123–157`; `packages/web/src/main.tsx:214–242` uses `server.info`, `peer.list`, `project.list`, `agent.list` with protocol `host` routing | Native manages independent configured connections too: `apple/App/Shared/SidebarView.swift:143–151` |
| Create on first message; choose provider/model/mode; Queue/Steer/Interrupt | `packages/web/src/main.tsx:358–414,717–762,810–840` | Native composer: `apple/App/Shared/Composer.swift:284–293,610–632`; effort remains a gap |
| Live/history transcript, tools/thinking/plans/subagent summaries, markdown/code/diffs | `packages/web/src/main.tsx:180–205,587–604`; `packages/web/src/transcript.tsx:89–167,190–270,306–350` | Core reading workflow is represented; subagent summary disclosure is not a child-history browser |
| Permissions/questions and pending cancellation/steering | `packages/web/src/main.tsx:615–707` | Native retains explicit retry; pending extraction/editing was intentionally removed |
| Shareable routes and durable text drafts | `README.md:378–384`; `packages/web/src/main.tsx:128–143,343–356,391–421` | Keep the web's browser navigation and virtualization; this review recommends no native state/scroll port |

## Prioritized actionable findings

Priorities reflect user value, not authorization to implement.

| Priority / classification | Finding and consequence | Exact evidence / suggested next step |
| --- | --- | --- |
| P1 — bug in supported questions | A select prompt with both `multiple` and `allowOther` falls through to a single text input and submits a string. Users cannot return several selected/custom answers correctly. | Web `packages/web/src/main.tsx:49–89`; native preserves selections plus custom text as an array in `apple/App/Shared/QuestionCard.swift:85–96,135–161`. Preserve array semantics in this existing workflow. |
| P1 — requested, not yet present in reviewed source | Host/provider usage tooltip is absent. Users cannot see which provider is near its allowance or when a window resets. | Native `apple/App/Shared/UsageViews.swift:57–88,133–163`, `apple/App/Shared/AppModel.swift:311–324,375`; web host rendering `packages/web/src/main.tsx:464–475` and refresh `214–242` contain no `provider.limits` request/display. Add the requested tooltip; the rest of the limits dashboard remains deferred. |
| P1 — recovery gap | Pending messages offer Cancel and Send now, but no dedicated failed-message Retry. | Web `packages/web/src/main.tsx:668–707`; native `apple/App/Shared/ChatModel.swift:444–449`; RPC `agent.retryPending` in `apple/CasmKit/Sources/CasmKit/Methods.swift:427–428`. Pending extraction/editing is intentionally removed across clients; it is not a missing web feature. Recipients should observe the pending count and go idle for normal queued delivery. |
| P1 — failure-feedback gap | Web consumes a failed `turnEnded` only as a boolean/sidebar status; its error detail is discarded by that handler. A failure without a separate notice leaves little actionable explanation. | Web `packages/web/src/state.ts:59–61,97–100`, `packages/web/src/main.tsx:501–507`; native `apple/App/Shared/ChatModel.swift:249–258` creates a failure notice from the error. Surface the supplied error; static finding, not a reproduced runtime failure. |
| P2 — find/manage existing work | No agent/project search or archive recovery, rename, archive, or delete controls. Archived agents are excluded and cannot be opened through routes. | Web `packages/web/src/main.tsx:476–529`; documented archived-route rejection `README.md:378–381`. Native archive-inclusive search `apple/App/Shared/AppModel.swift:416–440`, agent actions `apple/App/Shared/SidebarView.swift:433–446`. Start with search/archive recovery, then lightweight agent actions. |
| P2 — model control | Effort selection is absent even for catalog models advertising efforts. | Web config sends only model/mode at `packages/web/src/main.tsx:373,405–408` and renders only their selectors at `733–762`; native `apple/App/Shared/Composer.swift:610–632`. Add a catalog-driven effort selector rather than fixed provider assumptions. |
| P2 — session recovery | No Reload Agent / New Session action; users must leave the web client to recover a provider process or deliberately reset a conversation. | Web chat toolbar `packages/web/src/main.tsx:549–567`; native `apple/App/Shared/ChatView.swift:97–122`. Expose the distinct operations with confirmation for reset. |
| P2 — project setup/context | Existing projects can start chats, but web has no project creation/management, AGENTS.md editor, or memory inspection. | Web project navigation `packages/web/src/main.tsx:476–491`; native creation `apple/App/Shared/Sheets.swift:5–8,147`, details/read/write `apple/App/Shared/ProjectDetails.swift:168–199`, group/tags/archive/delete `apple/App/Shared/AppModel.swift:517–544`. Project creation and viewing instructions are the highest-value subset. |
| P3 — desktop convenience / future scope | Independent host management, notifications, `!shell`, and `@file` completion are absent. Peer routing already covers the normal single-server web deployment. | Native host menu `apple/App/Shared/SidebarView.swift:143–151`, notifications `apple/App/Shared/Notifier.swift:23–45`, shell/files `apple/App/Shared/ChatModel.swift:379–385,490–493`; web has a token footer `packages/web/src/main.tsx:535–547` and plain `agent.send` at `410–414`. Keep these separate from the explicitly deferred `/commands`. |

## Explicit deferrals and work already in progress

- **Images: now requested/in progress.** Current web source already pastes/removes/sends images (`packages/web/src/main.tsx:410–416,764–797`) and renders inline attachments (`packages/web/src/transcript.tsx:375–392`). Native supports attachment picking as well (`apple/App/Shared/Composer.swift:241–268`). Do not report image support as wholly missing or complete without integration validation. Draft persistence remains text-only by documented scope (`README.md:382–384`).
- **Schedules/send later: deferred.** Native screens/actions: `apple/App/Shared/SchedulesView.swift:55–71,112–124`; composer entry: `apple/App/Shared/Composer.swift:266–268`. No corresponding web screen/RPC use in `packages/web/src/main.tsx`.
- **Limits: deferred except the requested host/provider tooltip.** Native also has per-chat context/limit presentation (`apple/App/Shared/Composer.swift:134`, `apple/App/Shared/ChatView.swift:71`). Those broader surfaces are not prerequisites for the tooltip.
- **`/commands`: deferred.** Native loads `agent.commands` in `apple/App/Shared/ChatModel.swift:473–487`; web currently sends plain composer text. Do not describe autocomplete absence as a milestone bug.
- **PWA/iPhone polish: deferred.** Brand icons/manifest hooks already exist (`packages/web/src/main.tsx:104–126`), but they do not establish offline or push support. No native scrolling/cache architecture should be copied to close these gaps.

Sender-origin attribution was addressed in a separate authorized followup: protocol/server/CLI/MCP now carry explicit sender metadata, with a persistent native-history overlay. Web label integration is owned separately by root/image worker. See [message provenance](message-provenance.md) for behavior and limits.

Pending-message policy update: `casm take`, its RPC, and native pending Edit controls were removed at Michal's explicit request. Cancel, Send now/steer, Retry, Interrupt, and normal queued delivery remain supported. Earlier native line references above describe the reviewed snapshot and may shift after this removal.
