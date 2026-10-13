#!/bin/sh
# Launches the DEBUG macOS build against a local dev server, logging to /tmp/casm-app.log.
cd "$(dirname "$0")/.." || exit 1
pkill -x casm; sleep 1
CASM_DEV_URL=${CASM_DEV_URL:-ws://127.0.0.1:7373} CASM_DEV_TOKEN=${CASM_DEV_TOKEN:-$(cat ~/.casm-ng-dev/mac-app.token)} \
  CASM_EXP=$CASM_EXP CASM_STEP=$CASM_STEP CASM_WINDOW=$CASM_WINDOW nohup ${CASM_BUILD:-build/dd}/Build/Products/Debug/casm.app/Contents/MacOS/casm > /tmp/casm-app.log 2>&1 &
sleep 4
