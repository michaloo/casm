# casm Apple clients

```
CasmKit/   Swift package: protocol models, JSON-RPC WebSocket client, host list + Keychain
App/       SwiftUI app shared by macOS (CasmMac) and iOS (CasmiOS); generated with XcodeGen
scripts/   casmctl (DEBUG command channel), ui + uictl.swift (real input), run-dev.sh, scrollbench.sh,
           record-session.mjs (contract fixture)
```

## Build

```sh
brew install xcodegen
cd apple && xcodegen generate
xcodebuild -project Casm.xcodeproj -scheme CasmMac -derivedDataPath build/dd build
xcodebuild -project Casm.xcodeproj -scheme CasmiOS -destination "id=<simulator udid>" -derivedDataPath build/ios-dd build
(cd CasmKit && swift test)
```

The macOS target signs with the free "Apple Development" identity (team set in `project.yml`); no
capabilities, so no provisioning profile is needed.

CasmKit tests decode a recorded server session and samples generated from `spec/protocol.json`
for every method result, notification, event and item variant. A live test runs with
`CASM_TEST_URL=ws://127.0.0.1:7373 CASM_TEST_TOKEN=… swift test`.

## Driving a DEBUG build

`scripts/run-dev.sh` starts the app against `ws://127.0.0.1:7373` (adds the host on first launch from
`CASM_DEV_URL`/`CASM_DEV_TOKEN`). The DEBUG build shares its bundle id (and saved hosts) with an installed casm.app;
`CASM_DEV_SUITE=<name>` gives it its own host list and Keychain entries instead, so it can run beside the
installed app against a dev server (docs/development.md) without seeing production hosts. `scripts/casmctl` then sends commands that call the same model
methods as the UI and log to `/tmp/casm-app.log`:

```sh
scripts/casmctl select agent=writer
scripts/casmctl select project=scratch                 # its empty new-agent chat
scripts/casmctl select schedules=1                     # the first host's schedules
scripts/casmctl send text="hello"
scripts/casmctl permission decision=allow        # allow | allowAlways | deny
scripts/casmctl answer answers='{"q0":"Blue"}'   # omit answers to dismiss
scripts/casmctl config model=sonnet effort=medium mode=auto
scripts/casmctl retry                             # retries the first failed pending message
scripts/casmctl interrupt | reload | restart | state | questions
scripts/casmctl synthetic                         # 2,000-item transcript; then: bench, scroll to=top
scripts/casmctl snapshot path=/tmp/casm-shots/x.png
scripts/casmctl scroll by=600                      # up 600 pt; wheel steps=20 by=20 scrolls a step per frame
scripts/casmctl stream deltas=30 every=50          # a local turn streaming into the open chat
scripts/casmctl anchor; scripts/casmctl anchor action=report   # how far the top visible row moved (CASM_PROBE=1)
scripts/casmctl geo                               # AppKit's scroll offsets (SwiftUI's can lag after programmatic scrolls)
```

Snapshots render the window offscreen (no screen-recording permission needed, works while the
screen is locked); sidebar rows are composited separately because the macOS 26 glass sidebar isn't
captured by `cacheDisplay`.

## Real input and screenshots

`scripts/ui` runs `uictl` inside Terminal, which needs Accessibility and Screen Recording permission
(System Settings → Privacy & Security). It starts one minimized Terminal window as a server and
refuses to click or type unless casm or the Simulator is frontmost. `<app>` may be `pid:<n>` to pick the DEBUG build
when the installed casm.app is running too. `click` takes global points (the menu bar is above the window).

```sh
scripts/ui clickel casm "Always ask"                 # click an element by its AX title
scripts/ui clickel casm "AXTextField@Project name"   # role-qualified
scripts/ui type "hello"; scripts/ui key return casm
scripts/ui scroll casm transcript 40 300 8           # trackpad-style scrolling
scripts/ui shot casm /tmp/casm-shots/x.png region    # window incl. popovers and sheets
```

`scripts/scrollbench.sh` opens the synthetic transcript and scrolls it with real events while the app
records display-link frame intervals (`casmctl fps` / `fps action=stop`).

## iOS

```sh
xcrun simctl create "casm iPhone 13 mini" com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini \
  com.apple.CoreSimulator.SimRuntime.iOS-26-5
TEST_RUNNER_CASM_TOKEN=$(cat ~/.casm-ng-dev/mac-app.token) xcodebuild -project Casm.xcodeproj \
  -scheme CasmiOS -destination "id=<udid>" test
```

`App/iOSUITests/FlowTests.swift` drives the main flows against the local server (open an agent,
switch mode, send, allow a permission, answer a question) and writes screenshots to /tmp/casm-shots.

## Headless snapshots

`CasmMacSnapshots` is an unhosted unit-test bundle: it renders components with `ImageRenderer` to
`/tmp/casm-shots/snap-*.png` without launching the app or opening a window, so it can run while the Mac
is in use. Toolbars, sheets and popovers need a real window and aren't covered, and AppKit-backed views
(`ProgressView`, `ScrollView`) render as placeholders.

```sh
xcodebuild -project Casm.xcodeproj -scheme CasmMac -derivedDataPath build/dd test
```

## Release install (macOS)

```sh
xcodebuild -project Casm.xcodeproj -scheme CasmMac -configuration Release -derivedDataPath build/rel build
ditto build/rel/Build/Products/Release/casm.app /Applications/casm.app   # quit casm first
# Replacing the bundle in place doesn't tell Finder/Dock the icon changed; re-register it:
touch /Applications/casm.app && /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f /Applications/casm.app
# Optional: pre-configure hosts without opening the app. Replaces the host list; tokens go to the
# Keychain owned by the app, so it won't ask for access later. Delete the file afterwards.
/Applications/casm.app/Contents/MacOS/casm --seed-hosts hosts.json   # [{"name","url","token"}]
```

Debug and Release builds share the bundle id, so they share the host list.

## Keyboard (macOS)

⌘N new agent · ⌘⇧N new project · ⌘K focus the composer · ⌘. interrupt · ⌘R reload agent ·
⌘1…9 switch agents (sidebar order) · Esc closes suggestions, sheets and dialogs.
In the composer: Enter sends, Shift-Enter adds a line, "/" commands, "@" files, a leading "!" runs a
shell command, ⌘V / drop attaches images.

## Live tests

`CasmKit` live tests need a server. A throwaway one:

```sh
export CASM_HOME=/tmp/casm-test-home
node packages/cli/src/main.ts token create test        # → token
node packages/cli/src/main.ts serve --listen 127.0.0.1:7474 &
CASM_TEST_URL=ws://127.0.0.1:7474 CASM_TEST_TOKEN=<token> CASM_TEST_DIR=<dir with a README> swift test
# add CASM_TEST_SHELL=1 once the provider implements agent.shell
```
