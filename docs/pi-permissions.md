# pi permissions

pi has no permission system of its own. casm loads its own gate,
[`pi-permissions.ts`](../packages/server/src/providers/pi-permissions.ts), into
every pi agent (`pi -e`). Its `tool_call` hook is awaited and blocks a call that
isn't allowed; the reason goes back to the model. It is a policy layer, not a
sandbox: allowed commands run with the permissions of the pi process. Research
behind it: [pi permissions review](reviews/2026-10-14-pi-permissions.md).

## Modes

The pi mode picker (`config.mode`) offers:

| Mode | Allows without asking |
|---|---|
| `default` | pi's read-only tools (`read`, `grep`, `find`, `ls`, `tool_search`) and calls an allow rule covers |
| `acceptEdits` | the above, plus `edit` and `write` inside the project folder |
| `bypass` | every tool call |

The mode reaches pi as `CASM_PI_MODE` when the session starts. Changing it in
casm (web picker, `agent.update`) sends `/casm-mode <mode>` to the running pi,
without a reload. `/casm-mode` without an argument reports the current mode.

## Asking

Everything else asks. The extension calls `ctx.ui.select` with a title starting
`casm-permission:` followed by JSON (tool, input, suggested rule); casm's pi
adapter shows it as the normal permission card: **Allow**, **Always allow**,
**Deny**. Deny refuses that one call (an optional message is passed to the
model); there are no deny rules. Dismissing the card or a turn abort blocks the
call. Without a client UI (pi print/JSON mode) every gated call is blocked.

**Always allow** saves the rule shown on the card:

- `bash`: command patterns, one per line, suggested from the command
  (`npm test *`, `git status`). `pattern *` matches the command with or without
  further arguments; `*` elsewhere matches any text; a pattern without `*`
  matches exactly. Compound commands are split at `;`, `&`, `&&`, `||`, `|` and
  newlines, subshell parentheses are opened, and `$(...)`, backtick and
  `<(...)` bodies are checked too: **every** part must match a pattern. The
  card suggests patterns only for parts no rule covers yet, and the pattern is
  editable before confirming (CLI: `casm approve <agent> <request> --always
  --rule 'npm test *\ngit status'`). Redirections stay part of a command, so
  `npm test *` also allows `npm test > out.txt`.
- `edit` and `write`: a path glob relative to the project, suggested as the
  file's folder (`src/lib/**`). `**` crosses folders, `*` and `?` don't. Paths
  outside the project never match a rule.
- Any other tool, including MCP tools (`mcp__<server>__<tool>`) and `codemode`:
  the tool name.

casm stores no rules. User shell commands (`!cmd`, `casm shell`) are the
user's own and don't pass the gate.

## Where rules live

Rules are kept in pi's own settings files, under the `casmPermissions` key:

```json
{
  "casmPermissions": {
    "allow": [{ "tool": "bash", "command": "git status" }],
    "projects": {
      "/home/me/src/app": {
        "allow": [
          { "tool": "bash", "command": "npm test *" },
          { "tool": "edit", "path": "src/**" },
          { "tool": "mcp__casm__list_agents" }
        ]
      }
    }
  }
}
```

- **Project rules, default:** when pi trusts the project and the project
  already has `.pi/settings.json`, "Always" adds the rule to that file's
  `casmPermissions.allow`. Otherwise it goes to pi's agent-directory settings
  (`~/.pi/agent/settings.json`, or `$PI_CODING_AGENT_DIR/settings.json`) under
  `casmPermissions.projects["<project path>"]`. casm never creates
  `.pi/settings.json`: pi asks for project trust as soon as that file exists,
  and in RPC mode it then treats the project as untrusted until you run
  `/trust` in pi (or save a decision in `~/.pi/agent/trust.json`).
- **Global rules:** `casmPermissions.allow` in the agent-directory settings
  applies to every project. casm only writes there under `projects`; add global
  rules by hand.
- An untrusted project's `.pi/settings.json` is ignored, so a repository can't
  grant itself rules.

The extension re-reads a file when it changes, so edits apply to the next tool
call without restarting the agent. To edit or remove a rule, edit or delete its
entry in the file the card named ("Saved in ..."). Other keys in these files
are pi's and are kept as they are; the extension takes pi's own
`<file>.lock` lock while writing.
