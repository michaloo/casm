# Troubleshooting

## `npm ci` installs nothing to build with

If `NODE_ENV=production` is set in your shell, npm skips dev dependencies:
TypeScript, Vite and Playwright. `npm run build` and `npm run typecheck` then
fail because `tsc`/`vite` are missing. Install with the variable unset or
overridden:

```sh
NODE_ENV=development npm ci
npm run build
```

The server itself doesn't need `NODE_ENV`, and it removes `NODE_ENV` from the
environment of the agents it starts, so a production setting can't change how
your agents build or install their projects' dependencies.

## The CLI can't reach the server

```console
$ casm agents
casm: cannot connect to ws://127.0.0.1:7481: connect ECONNREFUSED 127.0.0.1:7481
(the casm server from /var/tmp/casm-lab/studio/local.json; is it running? "casm service status")
```

The server isn't running, or `local.json` is stale. Check with
`casm service status` / `casm service logs`, or start `casm serve`. If you
set `CASM_URL`, the message names it instead of `local.json` (normally
`~/.casm-ng/local.json`).

A rejected token looks like this:

```console
$ casm agents
casm: unauthorized at ws://127.0.0.1:7481 (check the token)
(the casm server from CASM_URL; is it running? "casm service status")
```

Create a new one with `casm token create <name>` on the server
(`casm token list` shows the names; revoked tokens stop working at once).

## A provider is missing

`casm serve` logs the providers it found (`agents: claude, codex, pi,
opencode`), and `casm info` shows them. casm only offers providers whose binary
is on the server's `PATH`. When running as a service, that's the `PATH`
captured by `casm service install`: run it again after installing a provider
or switching Node versions. `CASM_CLAUDE_PATH`, `CASM_CODEX_PATH`,
`CASM_PI_PATH` or `CASM_OPENCODE_PATH` point at a binary explicitly.

The provider must also be logged in for the user the server runs as: run
`claude`, `codex`, `opencode` or `pi` once by hand as that user.

## Project files are ignored by pi or Codex (project trust)

Both pi and Codex load some of a project's own configuration only for
**trusted** folders, and neither can ask about trust while casm drives it.

- **pi** asks before loading a folder's `.pi/settings.json`, `.pi/mcp.json`,
  `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/SYSTEM.md` and project
  `.agents/skills`. casm runs pi in RPC mode, which can't show that prompt, so
  without a saved decision those resources are **skipped** (`AGENTS.md` and
  `CLAUDE.md` still load). Fix: run `pi` in the folder once and approve
  (or `/trust`), which saves the decision in `~/.pi/agent/trust.json`; or set
  `defaultProjectTrust` to `"always"` in pi's settings. See pi's
  `docs/security.md`, "Understand project trust".
- **Codex** applies a project's `.codex/` configuration only to trusted
  projects. Fix: run `codex` in the folder once and trust it, or add it to
  `~/.codex/config.toml`:

  ```toml
  [projects."/absolute/path/to/project"]
  trust_level = "trusted"
  ```

Trust decides what configuration loads, not what the agent may do; that's the
provider's permission mode.

## Peers

```console
$ casm peers --probe
worker	ws://127.0.0.1:7482  unreachable: host "worker" is unreachable (cannot connect to ws://127.0.0.1:7482: connect ECONNREFUSED 127.0.0.1:7482)
$ casm -H worker agents
casm: host "worker" is unreachable (cannot connect to ws://127.0.0.1:7482: connect ECONNREFUSED 127.0.0.1:7482)
```

- **Unreachable**: is the peer's server running, and does its `listen` address
  accept connections from this machine? The default `127.0.0.1:7373` doesn't.
  Check the name resolves and the port is open over your VPN.
- **Slow**: `--probe` says `slow: … (reachable, but loaded)`. Raise
  `peerTimeoutMs` in `config.json` if a busy peer often times out.
- **Unknown host**: `-H` names this server's peers, not arbitrary machines:

  ```console
  $ casm -H nowhere agents
  casm: unknown host "nowhere": not a peer of studio (peers: worker)
  ```

- **Rejected token**: the peer's token was revoked; create a new one on the
  peer and `casm peer add` the peer again with it.
- **Server-only commands**: `serve`, `token` and `peer` act on this machine:

  ```console
  $ casm -H worker token list
  casm: "casm token" works on this machine's server only, not on host "worker"; run "casm token ..." on worker itself
  ```

- After a peer disconnects, clients get `peer.disconnected` and reload; the web
  client does this by itself.

## An agent doesn't answer

- **`waiting`**: it's blocked on a permission or a question. `casm pending`
  shows which; answer with `casm approve`/`deny`/`answer` or in the web client.
- **Messages stay pending**: `casm pending` gives the reason. `queued` waits
  for the running turn. `limit` waits for the provider's reset time (or
  `casm retry` once you know the limit reset). `failed` holds the queue until
  you `casm retry` or `casm cancel` it.
- **The turn is stuck**: `casm interrupt <agent>` stops it and keeps the queue.
  `casm reload <agent>` reopens the provider process on the same session;
  `casm restart <agent>` starts a fresh session.
- **After a server restart** running turns are gone (queued messages survive);
  send the agent a short follow-up to continue.

## The web client doesn't connect from another device

The default `listen` is `127.0.0.1:7373`, reachable only on the server
machine. Set `listen` in `$CASM_HOME/config.json` to an address the device can
reach (a VPN address), restart the server, and use that address in the browser.
Chrome/Edge only offer installing it as an app over HTTPS; see
[the web client](web-client.md#install-as-an-app-pwa).

## Development instances

Use `npm run dev` with its own `CASM_DEV_HOME`/`CASM_DEV_PORT`, never the
production `$CASM_HOME`; see [development](development.md).
