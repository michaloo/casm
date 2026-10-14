# Host settings

The host menu opens a settings dialog, full-screen on phones. Every RPC carries
its host ID, so peer settings are read and saved on the selected peer.

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
- pi: first existing `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`,
  or `CLAUDE.MD` under `PI_CODING_AGENT_DIR` (default `~/.pi/agent`). Verified
  against the installed pi coding agent's `core/resource-loader.js` and `config.js`.

This view covers global instruction files, not project or custom extra rules.
Environment overrides are those inherited by the casm server.

## Memories and agent prompt

Memories reuse `project.memories` for every project on the selected host and load
when that project's section opens. Provider adapters determine available stores;
entries and descriptions are read-only. Claude frontmatter descriptions and
Codex handbook scope descriptions are exposed as subtitles.

The host agent prompt uses `server.agentPrompt` and `server.setAgentPrompt` for
an example-agent preview, editing, enabling/disabling, and resetting to default.
The reset action asks for confirmation inside the dialog.
