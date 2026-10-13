# casm Apple clients

```
CasmKit/   Swift package: protocol models, JSON-RPC WebSocket client, host list + Keychain
App/       SwiftUI app shared by macOS (CasmMac) and iOS (CasmiOS); generated with XcodeGen
scripts/   casmctl (drives a DEBUG build), run-dev.sh, record-session.mjs (contract fixture)
```

## Build

```sh
brew install xcodegen
cd apple && xcodegen generate
xcodebuild -project Casm.xcodeproj -scheme CasmMac -derivedDataPath build/dd build
xcodebuild -project Casm.xcodeproj -target CasmiOS -sdk iphonesimulator ARCHS=arm64 SYMROOT=$PWD/build/ios build
(cd CasmKit && swift test)
```

The macOS target signs with the free "Apple Development" identity (team set in `project.yml`); no
capabilities, so no provisioning profile is needed.

CasmKit tests decode a recorded server session and samples generated from `spec/protocol.json`
for every method result, notification, event and item variant. A live test runs with
`CASM_TEST_URL=ws://127.0.0.1:7373 CASM_TEST_TOKEN=… swift test`.

## Driving a DEBUG build

`scripts/run-dev.sh` starts the app against `ws://127.0.0.1:7373` (adds the host on first launch from
`CASM_DEV_URL`/`CASM_DEV_TOKEN`). `scripts/casmctl` then sends commands that call the same model
methods as the UI and log to `/tmp/casm-app.log`:

```sh
scripts/casmctl select agent=writer
scripts/casmctl send text="hello"
scripts/casmctl permission decision=allow        # allow | allowAlways | deny
scripts/casmctl answer answers='{"q0":"Blue"}'   # omit answers to dismiss
scripts/casmctl config model=sonnet effort=medium mode=auto
scripts/casmctl interrupt | reload | restart | state | questions
scripts/casmctl synthetic                         # 2,000-item transcript; then: bench, scroll to=top
scripts/casmctl snapshot path=/tmp/casm-shots/x.png
```

Snapshots render the window offscreen (no screen-recording permission needed, works while the
screen is locked); sidebar rows are composited separately because the macOS 26 glass sidebar isn't
captured by `cacheDisplay`.
