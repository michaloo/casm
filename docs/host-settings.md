# Host settings

The ⋯ button on a host row (Host options) opens the host modal: Usage,
Resources, AGENTS.md, System Prompt and Notifications. The ⋯ on a project
row (Project options) opens the project modal: AGENTS.md, Memories and
Schedules (see [web client: schedules](web-client.md#schedules)), with
the project's path (Copy), host and group under its title and **New agent** in
its header. They share one layout (a tab rail on wide
screens, scrolling tabs and a full-screen sheet on phones) and ask before
closing with unsaved edits. The + on a host row adds a project; the two mini bars
beside the host's chevron (CPU, RAM) open its Resources tab. Every RPC
carries its host ID, so peer settings are read and saved on the selected peer.

## Global instructions

`host.agentsMd` returns effective global instruction files, resolved to their
real paths and grouped by the providers using them. Missing files have null
content and SHA. `host.setAgentsMd` accepts only a currently discovered path and
requires `expectedSha256` (null when creating). Saves use the same serialized,
atomic sibling-file replacement as project instructions, preserve permissions
and symlinks, and reject stale hashes. The editor keeps conflicting drafts and
lets users review the current version before retrying.

Discovery follows these provider conventions:

- Claude: `CLAUDE_CONFIG_DIR/CLAUDE.md`, default `~/.claude/CLAUDE.md`.
  [Claude memory documentation](https://code.claude.com/docs/en/memory).
- Codex: first nonempty `AGENTS.override.md`, then `AGENTS.md` in `CODEX_HOME`
  (default `~/.codex`).
  [Codex instructions documentation](https://developers.openai.com/codex/guides/agents-md).
- OpenCode: `$XDG_CONFIG_HOME/opencode/AGENTS.md`, default
  `~/.config/opencode/AGENTS.md`; otherwise `~/.claude/CLAUDE.md` unless
  `OPENCODE_DISABLE_CLAUDE_CODE` or `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` is enabled.
  [OpenCode rules documentation](https://opencode.ai/docs/rules/).
- pi: first existing `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`,
  or `CLAUDE.MD` under `PI_CODING_AGENT_DIR` (default `~/.pi/agent`). Verified
  against the installed pi coding agent's `core/resource-loader.js` and `config.js`.

This view covers global instruction files, not project or custom extra rules.
Environment overrides are those inherited by the casm server.

## System Prompt and project memories

The System Prompt tab holds casm's agent prompt (`casm agent-prompt` on the CLI). It uses `server.agentPrompt` and `server.setAgentPrompt` for
an example-agent preview, editing, enabling/disabling, and resetting to default.
The reset action asks for confirmation inside the dialog.

The project modal's Memories tab lists `project.memories` for that project only,
grouped by provider store. Entries and descriptions are read-only; Claude
frontmatter descriptions and Codex handbook scope descriptions are subtitles.
