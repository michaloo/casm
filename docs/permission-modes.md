# Permission modes, presets and defaults

Reviewed on 2026-10-19 against CASM adapters, native catalogs, installed
protocol/type declarations and provider documentation. Versions inspected:
Codex CLI 0.160.1, Claude Code 2.1.292 / Agent SDK 0.3.296, OpenCode 1.19.0,
and pi 1.1.0. Native defaults can change between versions and installations.

## Required behavior

**Provider default means the coding agent's own configuration and defaults.**
CASM-specific sandbox or approval overrides belong to explicitly chosen presets.
**Resume preserves the previously chosen mode.** Resume, reload and reconnect
are not requests to change permissions. Only an explicit selection changes them.
Choosing Provider default explicitly must reset to resolved provider defaults;
it must be distinguishable from resuming without a new selection.

These are the intended semantics. The Codex reset gap below remains deferred.

## Defaults

| Provider | When CASM mode is omitted |
|---|---|
| Codex | Native configuration and trust policy. CASM omits sandbox, approval-policy and reviewer overrides on both start and resume. Native resume can restore saved session permissions. |
| Claude | Loaded native settings and the installed SDK/headless defaults. This differs from explicitly selecting Claude's manual `default` mode. |
| OpenCode | Its configured default primary agent; the stock default is Build. CASM does not inject permission rules. |
| pi | Enabled tools run with the process user's permissions unless an extension or external isolation adds restrictions. CASM adds no permission gate. |

The CLI omits mode unless `--mode` is supplied. The PWA retains composer
settings when entering a new-agent view; a new agent does not necessarily begin
with blank settings. CASM validates explicit modes against the provider catalog.

Codex's sandbox is native behavior, not an extra CASM sandbox under Provider
default. See [Codex security and approvals](https://learn.chatgpt.com/docs/agent-approvals-security).
Claude's defaults are version-sensitive: documentation describing the later
2.1.302 headless change must not be applied to the inspected 2.1.292 installation.
See [Claude mode selection](https://code.claude.com/docs/en/permission-modes#which-mode-a-session-starts-in).

## CASM presets

| Provider / mode ID | Behavior |
|---|---|
| Codex `auto` | Inherits Codex defaults. Does not select the automatic reviewer. |
| Codex `auto-review` | Workspace-write sandbox, on-request approvals and the automatic reviewer; normal coding workflow. |
| Codex `plan` | Plan collaboration instructions, workspace-write sandbox, on-request approvals and a human reviewer. The filesystem is not read-only. |
| Codex `full-access` | Danger-full-access sandbox policy and never-ask approvals; normal workflow. |
| Claude `default` | Manual permission checks. Ordinary reads and recognized read-only commands can proceed; rules can resolve other checks before CASM receives them. |
| Claude `acceptEdits` | Automatically permits normal edits and supported filesystem operations; other permission checks remain. |
| Claude `auto` | Native classifier reviews actions that would otherwise require approval. Does not enable OS sandboxing. |
| Claude `plan` | Read/exploration tools and planning with edit restrictions. Tools still run. |
| Claude `bypassPermissions` | Skips ordinary permission checks; CASM also supplies `allowDangerouslySkipPermissions`. Native mandatory interactions can still apply. |
| OpenCode `build` | Selects the Build agent and its effective allow/ask/deny rules. |
| OpenCode `plan` | Selects the Plan agent. Stock 1.19.0 denies ordinary edits but permits plan-file edits; native user rules can override defaults. |
| pi | No permission modes in the catalog. Extensions can provide their own dialogs. |

Source mappings: [Codex](../packages/server/src/providers/codex.ts),
[Claude](../packages/server/src/providers/claude.ts),
[OpenCode](../packages/server/src/providers/opencode.ts),
[pi](../packages/server/src/providers/pi.ts), and
[PWA labels](../packages/web/src/composer-pickers.tsx).

## Important distinctions

- Sandbox, approval policy and workflow are separate controls. Codex presets
  bundle them. Claude modes are separate from its optional Bash sandbox. CASM
  adds no OS sandbox around pi or OpenCode.
- Codex `auto` means inherited defaults; Claude `auto` invokes a classifier;
  native [OpenCode `--auto`](https://docs.opencode.ai/docs/permissions/#auto-mode)
  approves pending requests while retaining denies. CASM does not expose the
  last option.
- OpenCode Build is permissive. In 1.19.0 most tools are allowed; external
  directories, loop detection and `.env` reads normally ask. The inspected
  [versioned source](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/agent/agent.ts#L111)
  uses ask for `.env`, although general documentation describes deny.
- [pi project trust](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/security.md)
  governs resource loading, not tool access. Its RPC mode cannot show the
  built-in project trust prompt.
- Always allow has native scope: Codex session grants; Claude SDK permission
  suggestions and destinations; OpenCode suggested patterns for the session.
  pi extension confirmation dialogs have approve/deny without Always.

Claude's native semantics are documented under
[permission modes](https://code.claude.com/docs/en/permission-modes) and
[permission rules](https://code.claude.com/docs/en/permissions).

## Known gaps

1. **Codex explicit preset-to-default reset is not implemented.** `agent.update`
   clears the mode and reopens the same native session. The adapter omits policy
   overrides on `thread/resume`, which restores persisted approval policy and
   reviewer. The UI can consequently show Default while the previous policy
   remains active. A fix must distinguish an explicit reset from unchanged
   resume and apply resolved defaults only for the reset. Required regressions:
   full-access to Default, auto-review to Default, and unchanged resume. This
   finding is based on source inspection; no live transition was exercised.
2. Generic inherited Default and Claude's explicit manual `default` share a
   short label. Codex `auto` is shortened to Auto despite meaning native defaults.
   Claude's catalog descriptions “Always ask” and “without executing tools” also
   oversimplify native behavior.
3. Claude's SDK supports `dontAsk`, but CASM's catalog does not expose it. It
   denies actions that need approval unless already permitted, unlike bypass.
4. Codex lacks a separate normal-workflow human-approval or read-only preset.
   Custom permission profiles have no exact preset mapping. Plan selects human
   approvals even when the previous explicit preset used auto-review.
5. OpenCode's picker selects agents, not independent permission policies. pi
   has extension dialogs but no CASM gate covering every tool call.

Future controls should distinguish workflow/agent, permission policy and
isolation where supported, label inheritance Provider default, and display the
effective policy without silently changing it.
