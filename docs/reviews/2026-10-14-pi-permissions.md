# pi permissions: extension landscape and fit for casm

Reviewed **2026-10-14** against pi **1.2.0** (casm's tested baseline is 1.1.0). Research only; no product code changes. Download counts are npm "last month" figures fetched the same day; stars are GitHub.

## Recommendation

**Write a small casm-owned pi extension (about 100–150 lines) and have the adapter load it; do not adopt a community package as the default.** Offer `@gotgenes/pi-permission-system` as an optional, user-installed rule engine on top.

- There is **no single standard**. There is one clear community leader (`@gotgenes/pi-permission-system`, 68k downloads/month, release 40.2.1 published today) inside a crowd of 20+ forks, mode-switchers, sandboxes and classifiers, none official. pi itself ships only example gates and states that it "does not include a built-in permission system".
- The leader is a rule engine (allow/ask/deny with bash/path/MCP patterns). Its RPC prompt is a generic `select` with four labelled options, which casm today renders as a *question*, not as a permission card. It has `yoloMode` but nothing like `acceptEdits`. Its config surface and release churn (40 major versions in five months) make it a poor dependency for a feature casm must keep stable.
- The mechanics casm needs are small and fully supported by pi's public extension API: `tool_call` is awaited and can block, and `ctx.ui.select` crosses the RPC boundary. The part only casm can do well is mapping to its own card and modes, which no community package does.

## What pi gives an extension

Sources: [extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [rpc-extension-ui.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md), [security.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md), official [examples/extensions](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions) (`permission-gate.ts`, `protected-paths.ts`, `confirm-destructive.ts`, `sandbox/`, `plan-mode/`, `timed-confirm.ts`).

- **Interception point:** `pi.on("tool_call", async (event, ctx) => …)`. Handlers are awaited, compose in order, may mutate `event.input`, and return `{ block: true, reason }` to stop execution. The reason goes back to the model. Tool calls from one assistant message can run in parallel, so several approvals can be pending at once.
- **Awaiting a human:** `ctx.ui.confirm`, `select`, `input`, `editor` block the handler until the client answers. In `--mode rpc`, `ctx.hasUI` is `true` and these become `extension_ui_request` / `extension_ui_response` pairs on stdout/stdin. Requests may carry `timeout` (ms); pi resolves a timed-out dialog itself with `undefined`/cancelled. `notify`, `setStatus`, `setWidget`, `setTitle` are fire-and-forget. **`ctx.ui.custom()` returns `undefined` in RPC mode**; so does any TUI-only component. In print/JSON mode there is no UI at all (`hasUI` false), so gates must fail closed.
- **Loading:** `pi --extension ./file.ts` or `pi install npm:…`; project-level `.pi/extensions` only load after project trust. Extensions run with the pi process's OS permissions, so a gate is a policy layer, not a security boundary (pi's own docs say to use a container/VM for that).
- **Tool metadata:** `pi.getAllTools()` exposes MCP-style annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`); the docs' reference gate uses them.
- **No mode concept.** There is no pi RPC command to change a permission mode, so a mode switch must travel through the extension (env var at spawn, a registered slash command, or a state file).

## How casm's adapter bridges dialogs today

`packages/server/src/providers/pi.ts` (`dialog()`, ~line 748):

- `confirm` → `askPermission({ toolName: "pi confirm", canAlwaysAllow: false, … })` → permission card; answer `deny` → `confirmed: false`, otherwise `true`; abort/timeout → `cancelled: true`. A pi timeout and the turn abort signal both dismiss the card.
- `select` / `input` / `editor` → `askQuestion` (question card) via `dialogQuestion` / `dialogResponse`.
- The provider reports `modes: []`, so the web UI has no mode picker for pi.
- Concurrent dialogs are fine: each request is handled independently (`void this.dialog(r)`).

Casm's permission card supports `allow | allowAlways | deny` (`PermissionDecision` in `packages/protocol/src/index.ts`). Only `confirm` can reach it today, and only without "Always". That gap is what a casm-aware extension closes.

## Candidates

All MIT unless noted. "RPC fit" means: does the ask path work when `ctx.ui.custom()` is unavailable and the answer must come back through `extension_ui_response`?

| Package | Latest (npm) | Downloads/mo | Repo (stars, last push) | Approach | RPC fit |
|---|---|---|---|---|---|
| [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system) | 40.2.1, 2026-10-14 | **68,353** | [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages), 257★, 2026-10-14 (monorepo; the old standalone repo is archived) | Fork of MasuRii's. allow/ask/deny rules per tool, bash wildcard patterns (`git *: ask`), path/external-directory, MCP and skill gates; hides denied tools; fails closed; AST-ish bash parsing with wrapper detection (`bash -c`, `xargs`, `sudo`); per-session rules; global + project + per-agent config; `yoloMode`; subagent ask forwarding; cross-extension service and `permissions:*` events | **Works, with caveats.** In RPC it uses `ctx.ui.select` with `Yes` / `Yes, allow "<pattern>" for this session` / `No` / `No, provide reason` (+ a follow-up `input` for the reason and sometimes a scope `select`). Session approvals are memory-only. No acceptEdits-style mode; only `yoloMode` |
| [`pi-permission-system`](https://www.npmjs.com/package/pi-permission-system) (MasuRii, original) | 0.8.0, 2026-07-03 | 2,274 | [MasuRii/pi-permission-system](https://github.com/MasuRii/pi-permission-system), 172★, 2026-07-03 | Origin of the family; allow/ask/deny on tool, bash, MCP, skill | Not re-verified; superseded by the gotgenes fork, no push since July |
| [`@zhushanwen/pi-permission`](https://www.npmjs.com/package/@zhushanwen/pi-permission) | 1.6.2, 2026-10-14 | 1,823 | no repository field | Four modes yolo / auto / approve / strict; bash-only; AST analysis, 12 built-in danger rules, safe-command allowlist, wildcard user rules, optional LLM classifier. README says TUI custom component, **RPC via `select`**, headless fail-closed deny | Good on paper, closest to mode-switching, but bash only, tiny, no source link, no star signal |
| [`@ladbabynpm/picc-permission-modes`](https://www.npmjs.com/package/@ladbabynpm/picc-permission-modes) | 0.1.3, 2026-09-30 | 1,664 | [Ladbaby/picc-permission-modes](https://github.com/Ladbaby/picc-permission-modes), 0★, 2026-10-07 | Claude Code clone: `default`, `acceptEdits`, `plan`, `bypassPermissions`, `auto` (LLM classifier); reads `~/.claude/settings.json` permission rules; env `PICC_PERMISSION_MODE` for headless hosts | **Not usable in RPC today.** Its prompts use only `ctx.ui.custom` (see `index.ts` ~1186); when that returns `undefined` it blocks with "user dismissed dialog". The mode vocabulary is exactly casm's; the dialog layer is not |
| [`pi-permission-modes`](https://www.npmjs.com/package/pi-permission-modes) | 2.4.1, 2026-09-24 | 2,144 | [wynainfo/pi-permission-modes](https://github.com/wynainfo/pi-permission-modes), 14★, 2026-09-24 | Default / Plan / Build / YOLO modes as JSON; each is an OS sandbox profile (bubblewrap / sandbox-exec) + allow/ask/deny policy; `/perm`, Alt+M | Heavy (sandbox runtime); TUI-centred; mode switching via command. Not evaluated for RPC |
| [`pi-sandbox`](https://www.npmjs.com/package/pi-sandbox) | 0.7.1, 2026-10-06 | 7,600 | [carderne/pi-sandbox](https://github.com/carderne/pi-sandbox), 275★, 2026-10-09 | OS-level sandbox (Anthropic sandbox-runtime style) with interactive prompts for exceptions | Different layer (real isolation). Complementary rather than competing |
| [`pi-verdict`](https://www.npmjs.com/package/pi-verdict) | 0.15.0, 2026-10-06 | 3,659 | [jesset/pi-verdict](https://github.com/jesset/pi-verdict), 13★ | Minimal gate inspired by Claude Code auto mode (classifier) | Not evaluated |
| [`pi-minimal-permission-system`](https://www.npmjs.com/package/pi-minimal-permission-system) | 1.5.1, 2026-10-07 | 1,268 | [milanglacier/…](https://github.com/milanglacier/pi-minimal-permission-system), 2★ | Trimmed rule engine; **GPL-3.0** | Licence is a problem for bundling |
| [`@bacnh85/pi-permission`](https://www.npmjs.com/package/@bacnh85/pi-permission) | 0.2.10, 2026-10-11 | 1,484 | [bacnh85/pi-extensions](https://github.com/bacnh85/pi-extensions) | allow/ask/deny per tool, wildcards | Small; not evaluated |
| [`pi-permission-gate`](https://www.npmjs.com/package/pi-permission-gate) | 0.1.5, 2026-07-13 | 177 | [juanje/pi-permission-gate](https://github.com/juanje/pi-permission-gate), 2★ | Config-driven deny-by-default, glob matching, self-protection | Stale, tiny |
| Add-ons to the gotgenes family | e.g. `pi-permission-ai-guard` 0.15, `@mzwing/pi-permission-auto-review`, `pi-permission-classifier`, `pi-permission-explain`, `@gotgenes/pi-permission-model-judge` | low | various | LLM reviewers as "authorizer chain" links | Show that gotgenes is becoming a platform, not a stable small dependency |

Other forks of the same family on npm (`@xzzpig/…` 1.7.0, `@schuettc/…`, `@restranger/…`, `@komarspn/…`, `@bryan2333/…`, `@sycghj/…`) are small copies with a handful to ~2k downloads. Related, not gates: [pasky/pi-amplike](https://github.com/pasky/pi-amplike) (224★, Amp-style permissions skill pack), [DevMortimer/pi-warden](https://github.com/DevMortimer/pi-warden) (169★, guardrails), `y0usaf/pi-jev` (165★, tool-call gate backed by a hosted classifier), [Gentleman-Programming/gentle-shell](https://github.com/Gentleman-Programming/gentle-shell) (1.3k★, a full Pi-native shell with permission modes; a whole product, not an extension). `NicoAvanzDev/pi-permissions` (15★, March) and `rHedBull/pi-permissions` (6★, March) are older and idle. Discovery was via `npm search` (`pi-package` keyword), `gh search repos --topic pi-package`, and the [awesome-pi extensions list](https://awesome-pi.site/extensions/); the pi packages gallery at pi.dev lists the same packages.

Not checked: Discord content (not public in a way I could read) and whether stars exist for the non-GitHub-linked packages.

## Fit against casm's requirements

Casm wants: permission card with **Approve / Deny / Always**, modes **default / acceptEdits / bypass**, correct cancel/timeout behaviour, parallel prompts, no silent approval on error.

| Need | gotgenes as-is | Casm-owned extension |
|---|---|---|
| Card instead of question | No. A 4-option `select` arrives as a question card. Could be special-cased in the adapter by matching option labels (`Yes, allow "…" for this session`), which couples casm to a fast-moving string format | Yes: extension emits a recognisable dialog, adapter maps it to `askPermission` |
| Approve / Deny / Always | Approve and "for this session" (memory only, per extension process), plus "deny with reason" as an extra input round trip | Yes; "Always" is casm's `allowAlways`, stored by casm and applied by the extension on the next call |
| Modes | `yoloMode` only (config-file scalar, project config needs trust). No acceptEdits | `default` asks for write/edit/bash; `acceptEdits` allows write/edit inside cwd; `bypass` allows all; plan-ish modes out of scope |
| Live mode change | Edit config file / reload | Env var at spawn plus a `/casm-mode <m>` extension command (pi runs extension commands immediately, and the adapter already steers with `prompt` + `streamingBehavior`) |
| Fail closed | Yes | Same (block on error or missing UI) |
| Dependency risk | 40 majors in 5 months; fork lineage; very large surface | None; ~100 lines casm tests |
| Rule power (bash patterns, path boundaries, MCP) | Strong, mature | Minimal on purpose |

## Proposed shape (for whoever implements it)

1. Ship `packages/server/assets/pi-casm-permissions.ts` (or similar) and spawn pi with `--extension <path>`. Provider config adds modes `default`, `acceptEdits`, `bypass`; the chosen mode is passed as an env var (`CASM_PI_MODE`) and changeable through a registered `/casm-mode` command.
2. `tool_call` handler: classify the tool (`read`/`grep`/`find`/`ls` read-only; `write`/`edit` file mutation; `bash`; everything else, including MCP tools with `readOnlyHint` false, as "other"). Apply the mode table; for a required ask call `ctx.ui.select(title, ["Approve", "Always", "Deny"])` with a stable machine-readable title prefix, tool name and a compact JSON preview of the input in the message. Return `{ block: true, reason }` on deny, cancel, timeout or missing UI.
3. Adapter: in `dialog()`, recognise that prefix, call `askPermission` with real tool name/input and `canAlwaysAllow: true`, and respond `value: "Approve" | "Always" | "Deny"`. Keep a per-session "always" set keyed by tool plus a command/path pattern in the extension (or in casm if it should survive restarts), with a fixed conservative pattern rule (e.g. exact bash command, directory prefix for edits).
4. Make `bypass` honest in the UI: pi has no sandbox, so say so (pi's own security guidance recommends a container for real boundaries).
5. Tests: unit-test the handler decision table with a fake `ctx`; adapter test with a scripted `extension_ui_request`; a Playwright card test is unnecessary beyond what the Claude permission card already covers.
6. Users who want richer rules can still `pi install npm:@gotgenes/pi-permission-system` themselves. Do not run both gates together by default: two prompts per call. If both are present the casm extension should stay out of the way (an env flag such as `CASM_PI_PERMISSIONS=off`), and its select dialogs will appear as ordinary question cards.

## Risks and open points

- **Pi's `tool_call` is the only gate.** Anything reachable without a tool call (extension-registered shell commands, `!cmd` user bash over RPC, which casm itself uses) is outside it. User shell is the user's own action, so that is acceptable, but document it.
- **Bash is hard to classify.** The community leaders invest heavily in parsing wrappers (`bash -c`, `xargs`, `sudo`, `find -exec`). A small extension should treat every bash command in `default` as "ask" and in `acceptEdits` also as "ask" (only file edits relax), and not claim command-level safety.
- **Timeouts:** pass no `timeout` so the card stays until answered; casm already aborts the dialog on turn abort.
- **If the extension route is declined:** the lowest-effort fallback is installing gotgenes and special-casing its `select` in the adapter, accepting the string coupling, no acceptEdits, and `yoloMode` as bypass.
- **Unverified here:** behaviour of the gotgenes prompt end to end inside casm (not run; analysis is from its source and docs), and RPC behaviour of `@zhushanwen/pi-permission`, `pi-permission-modes`, `pi-verdict`.

## Sources

- pi repo: https://github.com/earendil-works/pi (MIT, 115k★, release v1.2.0, 2026-10-12)
- Extensions docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- RPC extension UI: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md
- Security: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md
- Example gate: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts
- gotgenes: https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system (README, `docs/configuration.md`, `docs/session-approvals.md`, `src/authority/permission-dialog.ts`, `src/authority/permission-prompt-component.ts`)
- picc: https://github.com/Ladbaby/picc-permission-modes (`index.ts`)
- zhushanwen README via `npm view @zhushanwen/pi-permission readme`
- Directory: https://awesome-pi.site/extensions/, https://pi.dev/packages/pi-permission-gate
- Provider context: [agent providers review](2026-10-14-agent-providers.md)
