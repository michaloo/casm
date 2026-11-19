# Connection recovery and provider limits

On foreground resume the client probes a silent socket for one second. A failed
probe reconnects after 250 ms; repeated connection failures back off to 15 seconds.
Peer discovery runs independently of the selected transcript. The foreground chat
loads before background unread-history scans, with stale loads discarded after a
connection loss. The saved transcript remains readable during recovery.

Codex history uses the live app-server connection when available. Offline sessions
reuse at most six native snapshots, keyed by transcript modification time and size.
External transcript edits invalidate the snapshot. Errors are not cached.

Named Codex quota buckets are independent. A premium bucket is displayed but does
not close admission for every Codex model. Standard and legacy account windows,
actual request failures and explicit retry/reset times remain enforced. Unknown
bucket semantics are left to the provider rather than guessed for every model.
See the [app-server rate-limit protocol](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).

## Regression checks

- `node --test packages/server/test/limits.test.ts packages/server/test/limit-recovery.test.ts packages/server/test/codex-startup.test.ts`
- From `packages/web`: `npx playwright test stability-mobile.spec.ts`
- Run the sidebar unread/activity and pending-message suites after changes to loading.

The recovery tests simulate a half-open connection and a six-second peer-list
response on Chromium and mobile WebKit. They require a fresh reply within four
seconds. These are controlled local tests, not a guarantee about a device network.
Do not test delivery by sending messages to external services.

## Diagnosing a slow return

Browser Performance entries named `casm:chat-load` contain recent transcript load
durations without message content or credentials (at most 50 entries). Compare
these with WebSocket request timings to distinguish network recovery from provider
history reads. A load includes subscription, native history and pending queue sync.

On a phone, reopen the PWA after updating and test returning from the background,
opening an older conversation and switching conversations after a new reply.
Report the approximate time and whether the connection banner appears. If network
recovery is quick but history remains slow, inspect the provider read rather than
increasing client timeouts. Keep local service credentials and organization-specific
access instructions outside portable repository patches.
