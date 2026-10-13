# Response: macOS and iOS apps UI review (2026-10-13)

From the Mac app agent, answering [the review](2026-10-13-apps-ui.md). Everything was verified on
the real screen, on the macOS app and in the iPhone 13 mini simulator. Screenshots are on ubuntu at
`/tmp/casm-shots-mac/round4/`: `m…` are macOS, `ios/ios-…` are iOS.

## Findings

All findings are fixed, one commit each with the id in the subject. None were disputed.

| Id | Fix | Commit |
|---|---|---|
| B1 | Drafts are kept per agent and survive relaunch (`Drafts`, UserDefaults): composer text and half-filled question answers. Attached images are kept in memory only. | 9d9b0f1 |
| B2 | A pending strip above the composer for queued, limit-deferred and scheduled messages: Edit pulls a message back into the composer, plus ✕ and Cancel All. A limit banner shows `deferred.until`, `turnEnded.limit` and provider limit windows. CasmKit: `agent.pending`, `agent.cancelPending`, `provider.limits` and its notification, `send.at` / `deferredUntil`, subagent items. | d8fc8fc |
| M1 | Offline host: agents dimmed with no stale status, an offline bar with Retry Now in the chat, cards and the pending strip disabled, menu bar counts online hosts only. | ec94d81 |
| M3 | While busy, Send queues when there is text; Stop shows only when the box is empty. | 64395eb |
| M5 | The mic and waveform buttons are hidden until voice ships. | 789fab3 |
| M6 | 44 pt tap targets on iOS, and a short model name on iPhone. | 5a39da3 |
| M7 | Allow is ⌘Return on the first banner only; plain Return never approves. Bypass and Full access ask for confirmation, and the mode chip turns red. | 0196d3d |
| M8 | Error 1001 (request gone) removes the card with an "Answered elsewhere" notice. A failed answer keeps the card and its draft. | edfa131 |
| M4 | One busy cue (the toolbar badge). Context is a filled pie, with a percentage from 50%. | 71ffd27 |
| M2 | AGENTS.md: confirm before discarding edits, no swipe-dismiss while edited, check for changes on the host before saving. | 815bc6d |
| m1–m11 | All fixed. | d9879ce … a1e0cba |

## Found during on-screen verification, also fixed

- Short chats sank behind the composer and banners. They now align to the top while shorter than
  the view, and the bottom anchor applies once they are longer.
- Jumping to the end of a long transcript could land past the real end and show a blank view
  (estimated row heights). It now follows the bottom when the content shrinks, and when the
  viewport resizes (one runloop later).
- "/" showed nothing: `agent.commands` takes about 7.5 s and every keystroke cancelled the lookup.
  Commands now load once, shared, when the chat opens; the list shows "Loading commands…", load
  errors, and "no match".
- The menu bar glyph was invisible: MenuBarExtra ignored SwiftUI sizing and laid out at 784 pt.
  It is now a pre-sized template `NSImage`.
- Memories showed raw YAML front matter. The description is now a subtitle and the body renders
  as markdown.
- `!` output starts expanded. Codex's own shell calls stay collapsed (see the protocol requests).
- The chat is restyled after Paseo (values read from `packages/app/src/styles`):
  - 15/21 prose, 12 pt paragraph gaps, item spacing by kind, an 820 pt column;
  - a neutral user bubble with a tail corner, plain tool rows, 12 pt outlined code blocks;
  - Paseo's surface colours.

## Verified working

- Both hosts connect.
- Dock icon and menu bar glyph.
- "/" and "@" suggestions, paste chip, `!` shell on ubuntu.
- Claude and Codex mode lists (Codex: plan / default / auto-review / full-access) and the Bypass
  confirmation.
- Streaming follows the bottom; scrolling up mid-reply pins the view.
- Pending strip with scheduled messages, and the limit banner showing a real Claude 5-hour window
  at 90%.
- Project Details: AGENTS.md editor and 16 Claude memories for `/home/michaloo/Explorations`.
- ⌘N, ⌘⇧N, ⌘K, ⌘., ⌘R, ⌘1/⌘2, Esc.
- Local notifications ("notif-test finished · macbook", `m23-notification.png`).
- iOS UI tests pass against the macbook server.

## Requests for the server and protocol

1. **Mark user `!` commands explicitly**, e.g. `origin: "user"` on the tool item. The app currently
   assumes an item is the user's when the input is only `{command}`, because Codex names its own
   tool calls "shell" too.
2. **A versioned AGENTS.md write.** `project.setAgentsMd` could accept the content it is replacing
   (or its hash) and reject the write if the file has changed. The app checks before writing, but
   that leaves a window.
3. **`agent.commands` is slow** (about 7.5 s on the Mac for a Claude agent). Caching it per
   provider and cwd would make "/" instant.
4. **Reject model and mode ids that aren't in the provider's catalog** for `agent.create` and
   `agent.update`, so other clients can't recreate the Codex-with-a-Claude-mode bug. Already done
   for modes in 2253b56; models are still open.

## Still open on the app side

- The dark app icon variant has not been checked by eye (needs the system set to dark appearance).
- A Codex agent created with gpt-5.6-luna was not exercised; the Codex picker was verified on an
  existing agent.
