# Getting started

This takes you from installing casm to a running server, your first agent,
the web client, a background service and a second machine.

## Requirements

- Linux or macOS, **Node.js 24+** and npm.
- At least one provider installed and logged in on the machine:
  [Claude Code](https://code.claude.com/docs) (`claude`),
  [Codex](https://developers.openai.com/codex) (`codex`),
  [OpenCode](https://opencode.ai) (`opencode`) or
  [pi](https://github.com/earendil-works/pi) (`pi`). casm offers only the
  ones it finds on `PATH`.
- To use casm from other machines or a phone: a private network between them
  (a VPN, a tunnel or your LAN), and HTTPS if you want notifications. See
  [network](network.md); set it up first.

## Install

```sh
npm install -g casm-cli
```

The package includes the server, the CLI and the built web client. It does not
start anything by itself. Run `command -v casm` afterwards: an older
`~/.local/bin/casm` launcher from a source install takes precedence over npm's
executable if it comes first on `PATH`. Update later with
`npm install -g casm-cli@latest`.

### From source

```sh
git clone https://github.com/michaloo/casm.git
cd casm
npm ci
npm run build
scripts/install.sh --skip-deps
export PATH="$HOME/.local/bin:$PATH"
```

`npm run build` builds the web client; `scripts/install.sh` writes the `casm`
launcher to `~/.local/bin`, pointing at this checkout's TypeScript sources.
If `npm ci` skipped dev dependencies, see
[troubleshooting](troubleshooting.md#npm-ci-installs-nothing-to-build-with).

## Run the server

```console
$ casm serve
[…] listening on ws://127.0.0.1:7373
[…] agents: claude, codex, pi, opencode
[…] no client tokens for other machines yet: run "casm token create <name>"
```

State lives in `$CASM_HOME` (default `~/.casm-ng`). The CLI on the same
machine finds the server by itself.

## Your first agent

In another terminal:

```sh
casm project create ~/code/acme-api --name acme-api
casm run --project acme-api --provider claude --name reviewer "Read src/orders.js and summarize it in two sentences."
casm wait reviewer
casm history reviewer
```

`casm run` prints the new agent's ID. Agents are addressed by ID, ID prefix or
exact name, so naming them helps.

![the same session, recorded](media/cli-quickstart.svg)

Then try the queue (`casm send` while it works), steering (`--steer`),
schedules and limits; the [CLI reference](cli.md) walks through all of them.

## The web client

```sh
casm token create web
```

Open **http://localhost:7373**, paste the token and connect. See the
[web client guide](web-client.md), including installing it as an app.

## Run it as a service

Stop the foreground server (Ctrl-C), then:

```sh
casm service install
casm service status
casm service logs -f
```

Linux gets a systemd user unit, macOS a launchd agent. `install` captures your
`PATH` so the service finds the provider binaries; run it again after
installing a provider or switching Node versions. (From a source checkout,
`scripts/install.sh --service` does both steps.) A restart ends running turns; queued messages
and schedules survive.

On Linux, a user service stops when you log out unless lingering is enabled:
`sudo loginctl enable-linger $USER` (`casm service install` reminds you).

## Configure

`$CASM_HOME/config.json`:

```json
{
  "listen": "0.0.0.0:7373",
  "name": "studio",
  "peerTimeoutMs": 10000,
  "agentPrompt": true
}
```

- `listen`: the address to bind. The default `127.0.0.1:7373` is reachable
  only from the machine itself. Bind to a VPN address (for example a Tailscale
  IP) rather than to everything when you can.
- `name`: how this host appears to clients and peers (default: hostname).
- `peerTimeoutMs`: how long peers may take to answer.
- `agentPrompt`: `false` turns off the [agent prompt](concepts.md#the-agent-prompt).

casm has no TLS or relay of its own: use your own trusted network or an HTTPS
proxy, and treat every token as a password. [Network](network.md) compares the
options and has HTTPS recipes.

## Add a second machine

On the other machine, install casm, set a reachable `listen` address, run it,
and create a token for this one:

```sh
casm token create studio      # on worker: prints a token
```

Back here, register it as a peer:

```console
$ casm peer add worker ws://worker:7373 '<token-from-worker>'
added peer worker: server "worker" (ed129bd6-…), agents: claude, codex, pi, opencode
$ casm peers --probe
worker	ws://worker:7373  reachable 13 ms
$ casm -H worker projects
```

`worker` must resolve to the other machine (`wss://` through TLS). Now `-H
worker` runs any command there, the web client shows `worker` as a second
host, and agents can start agents on it with `casm -H worker run`.

![peers and -H](media/cli-peers.svg)

A machine with only the CLI and no server can talk to a remote server
directly: `casm host add worker ws://worker:7373 '<token>' --default`.

## Next

- [Concepts](concepts.md): hosts, projects, agents, the queue, schedules, limits.
- [CLI reference](cli.md), including how agents run agents.
- [Troubleshooting](troubleshooting.md).
