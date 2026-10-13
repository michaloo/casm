# Developing casm through casm

Use two server instances: a stable server to host your coding agents, and a
development server to exercise the code they change. They must have separate
checkouts, dependencies, state directories, and listening ports.

| | Stable server | Development server |
|---|---|---|
| Source | Pinned release checkout | Working checkout |
| State | Existing production `CASM_HOME` | `<checkout>/.casm-dev` |
| Port | Existing production port (normally 7373) | Loopback 7474 |
| Lifecycle | Existing systemd/launchd service | Foreground terminal |
| Agents | Agents doing the development | Disposable test agents |

Changing a source file does not reload the running Node server. Client rebuilds
and reconnects leave its agents running. Applying server or provider-adapter code
changes requires restarting that server; keep those restarts on the dev instance.

## Start an isolated development instance

From the working checkout, with dependencies installed:

```sh
npm run dev -- init
npm run dev:server
```

The first command creates a fresh database and a private client credential. It
does not copy production agents, native session IDs, peers, or tokens. The second
command runs `casm-dev` on `127.0.0.1:7474`. Ctrl-C stops that instance and its test
agents. Run it again after changing backend code; there is no automatic watcher.

In another terminal, target it with the same wrapper:

```sh
npm run dev -- project create /absolute/path/to/a/scratch-project --name scratch
npm run dev -- run --project scratch --provider claude "Inspect this project"
npm run dev -- --json agents
```

The wrapper replaces inherited `CASM_URL`, `CASM_TOKEN`, and host selection, and
clears parent-agent identity. This matters when commands are issued by an agent
on the stable server. Plain `casm ...` still uses your installed launcher and
normal host configuration; use `npm run dev -- ...` for development commands.

The dev launcher refuses the default production home, the inherited `CASM_HOME`,
and an existing database without its development credential. It never installs,
restarts, or stops a system service. Keep `.casm-dev/development.json` private;
it contains the development client token and the whole directory is gitignored.

Use `CASM_DEV_HOME` and `CASM_DEV_PORT` for additional instances, setting the same
values for init, serve, and client commands. A used port fails normally; the
launcher does not stop the process occupying it. Use an empty directory for init.

To connect an Apple client, create a dedicated token:

```sh
npm run dev -- token create apple-dev
```

Add a host named `casm-dev` pointing at `ws://127.0.0.1:7474` with that token.
For an app on another machine, forward its local port 7474 to the development
machine's loopback port over SSH, then use the same URL. Keep the stable host
configured too so you can switch between them.

The isolation covers casm's database, routing, and server process. Providers still
use your installed agent binaries, credentials, and native transcript stores.
Test agents can modify their project folders and make real model calls. Use a
scratch project and fresh agents; do not import a live production native session.

## Keep the stable server on a pinned checkout

The installed service and `casm` launcher point directly into their source
checkout. If that is currently your development checkout, plan a one-time move
between work sessions. Do not run `npm ci` or upgrade dependencies in a checkout
hosting live agents. A running server may still spawn providers from those files.

Prepare a separate checkout at a reviewed commit, for example:

```sh
git worktree add --detach ../casm-ng-stable <reviewed-commit>
cd ../casm-ng-stable
npm ci
npm run typecheck
npm test
```

Your agents can continue editing the original working checkout; their project
directory need not be the same directory as the server's source code.

When all production work is finished, install from the stable checkout using the
existing production `CASM_HOME` (omit it below if you use the default):

```sh
CASM_HOME=/absolute/path/to/production-state scripts/install.sh --skip-deps --service
```

**This command restarts the production server.** It rewrites the installed
launcher and service to use the stable checkout. Keeping the same production
state directory preserves agent records and saved session references, but active
work does not survive the restart.

Before promotion, inspect running agents, pending questions/permissions, queued
messages, and provider background tasks. The current `idle` status describes the
foreground turn; it does not prove background work has finished. Queued prompts
and pending requests are in memory. There is no automatic drain/restart guard yet.

For later promotions, finish production work first, update the stable checkout to
the tested commit, install any changed dependencies, validate, and explicitly
restart the service. Do not update or migrate the stable checkout automatically
as part of development tests. Provider task notices and transcript replay do not
make live SDK processes survive a server restart.
