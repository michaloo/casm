#!/bin/sh
# Real-input scroll benchmark: opens the synthetic transcript and scrolls it with trackpad-style
# events while the app records display-link frame intervals. Results land in /tmp/casm-app.log.
cd "$(dirname "$0")/.." || exit 1
run() { # label dy events interval
  scripts/casmctl fps; sleep 0.3
  scripts/ui scroll casm transcript "$2" "$3" "$4" >/dev/null
  sleep 0.8; scripts/casmctl fps action=stop; sleep 0.3
  echo "$1: $(grep 'fps:' /tmp/casm-app.log | tail -1 | sed 's/.*fps: //')"
  scripts/casmctl state; sleep 0.3; echo "   $(tail -1 /tmp/casm-app.log | sed "s/.*chat: //")"
}
scripts/casmctl synthetic; sleep 3
scripts/ui front casm >/dev/null
run "flick up 40px/8ms x300 (first render)" 40 300 8
run "flick up 40px/8ms x300 (first render)" 40 300 8
run "slow down 12px/8ms x300" -12 300 8
run "flick down 40px/8ms x300 (rendered)" -40 300 8
run "flick up 40px/8ms x300 (rendered)" 40 300 8
