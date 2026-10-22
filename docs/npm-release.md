# npm releases

Publish `casm-cli`; its executable is `casm`. The root workspace stays private.
One generated package contains compiled CLI/client/server/protocol code, provider
helpers, the built web app, the README (its links point at GitHub) and the service script. Runtime
dependencies are bundled from the lockfile install (`bundleDependencies`), without
the Claude Agent SDK's optional platform binaries (~250 MB): like Codex, OpenCode
and pi, Claude Code must be on PATH (or set `CASM_CLAUDE_PATH`). Bundling all of
them is deliberate: when only some are bundled, a global install leaves the others
as empty directories. Private `@casm/*` workspace imports are
rewritten to relative JavaScript imports. No TypeScript loader, build tools or
Git checkout is needed on the user's machine.

## Build and verify

Use a clean release checkout, never the checkout serving live agents.
Set the version in the root `package.json` and refresh `package-lock.json`.

```sh
env -u NODE_ENV npm ci
npm run typecheck
npm test
npm run build:npm
npm run test:npm
```

The package test packs and installs the artifact into a temporary prefix outside
the checkout. It starts a disposable server with its own state and random
loopback port, checks CLI authentication and web assets, exercises compiled
provider helpers, and checks service generation with fake system tools. It does
not install a real service or call a model. Real provider and macOS validation
remain separate from these isolated checks.

```sh
mkdir -p dist/tarballs
npm pack ./dist/npm --pack-destination ./dist/tarballs
npm publish ./dist/tarballs/casm-cli-1.0.0.tgz --access public
```

Use the actual release version in the filename. Review `npm pack --dry-run
./dist/npm` before publication. Never publish the development workspace or
remove its `private` flag. npm login/2FA and publish rights are required.

## Install and upgrade

```sh
npm install -g casm-cli
casm --version
casm serve
# Optional, explicitly starts/restarts the background service:
casm service install
```

Before upgrading an existing server, finish active work and stop the service.
After `npm install -g casm-cli@<version>`, run `casm service install` to refresh
the installed package/Node paths and restart it. An npm upgrade does not itself
restart a running server. Preserve `CASM_HOME` (default `~/.casm-ng`).

`casm-cli@0.9.2` is the old SSH/container tool, not the orchestrator. Version 1
does not migrate its configuration or implement its old commands. Existing
source launchers in `~/.local/bin` may shadow the npm binary; inspect
`command -v casm` before removing or changing any launcher.
