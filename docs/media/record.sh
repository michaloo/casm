#!/usr/bin/env bash
# Re-records the README demos.
#
#   ./docs/media/record.sh            record and render everything
#   ./docs/media/record.sh continue   just one
#   RENDER_ONLY=1 ./docs/media/record.sh   re-render existing casts (theme/font work)
#
# Recording and rendering are separate on purpose: a cast is expensive to make
# and cheap to re-render, so changing the theme or the font never means driving
# the terminal again.
#
# Needs: asciinema, agg, expect. The demos run against ~/casm-demo/home, a
# throwaway HOME holding synthetic sessions, so nothing real is ever on screen.
set -euo pipefail

CASM_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MEDIA="$CASM_REPO/docs/media"
CASTS="$MEDIA/casts"
DEMO_HOME="${DEMO_HOME:-$HOME/casm-demo/home}"
PRISTINE="${PRISTINE:-$HOME/casm-demo/pristine}"
export CASM_REPO

# Look. agg's default is a 16-colour palette in whatever monospace font it finds
# first, which reads like a raw console; these are the levers that don't need a
# font installed.
THEME="${THEME:-monokai}"
FONT="${FONT:-SF Mono,Menlo,Monaco}"
FONT_SIZE="${FONT_SIZE:-17}"
LINE_HEIGHT="${LINE_HEIGHT:-1.45}"

# Longer than the longest deliberate pause in any .steps file. agg applies this
# BEFORE everything else, including --select, so setting it below a scenario's
# reading pause silently compresses the exact frames the demo exists to show.
IDLE_LIMIT="${IDLE_LIMIT:-9}"

# name:cols:rows[:font-size]
SCENES=(
  "continue:104:16"
  "search:152:16"
  "container:92:20"
  "container-social:84:18"
  # 72x52 at font-size 24 renders to 1066x1909 - a 9:16 frame with no letterbox
  "container-vertical:72:52:24"
)

[ -d "$DEMO_HOME" ] || { echo "no demo home at $DEMO_HOME - see docs/media/README.md" >&2; exit 1; }
for t in asciinema agg expect; do command -v "$t" >/dev/null || { echo "missing $t" >&2; exit 1; }; done
mkdir -p "$CASTS"

for scene in "${SCENES[@]}"; do
  IFS=: read -r name cols rows fontsize <<<"$scene"
  fontsize="${fontsize:-$FONT_SIZE}"
  [ $# -eq 0 ] || [[ " $* " == *" $name "* ]] || continue

  if [ -z "${RENDER_ONLY:-}" ]; then
    echo "recording $name (${cols}x${rows})"
    # every take starts from the same sessions, or the picker reorders under it
    "$MEDIA/seed.sh" "$DEMO_HOME" "$PRISTINE"
    HOME="$DEMO_HOME" expect -f "$MEDIA/drive.exp" \
      "$cols" "$rows" "$CASTS/$name.cast" "$MEDIA/$name.steps"
  fi

  # Trim the teardown the driver had to record in order to exit cleanly. The
  # mark is wall-clock, but a cast ends at its last *event*, and a scenario that
  # finishes on a silent pause has no event to carry it that far - so clamp, or
  # agg rejects a position past the end.
  select=""
  if [ -f "$CASTS/$name.cast.end" ]; then
    end=$(python3 - "$CASTS/$name.cast" "$(cat "$CASTS/$name.cast.end")" "$IDLE_LIMIT" <<'CLAMP'
import json, sys
# agg caps every idle gap at --idle-time-limit *before* --select is applied, so
# the timeline it measures is shorter than wall clock by whatever it trimmed.
# Summing raw intervals overshoots and agg rejects the position outright.
limit = float(sys.argv[3])
total = 0.0
with open(sys.argv[1]) as f:
    next(f, None)                      # header
    for line in f:
        line = line.strip()
        if line.startswith("["):
            try: total += min(json.loads(line)[0], limit)
            except Exception: pass
print(f"{min(float(sys.argv[2]), max(total - 0.05, 0)):.2f}")
CLAMP
)
    select="--select ..$end"
  fi

  echo "rendering $name"
  # shellcheck disable=SC2086
  agg --theme "$THEME" --font-family "$FONT" --font-size "$fontsize" \
      --line-height "$LINE_HEIGHT" --idle-time-limit "$IDLE_LIMIT" --last-frame-duration 4 \
      $select "$CASTS/$name.cast" "$MEDIA/$name.gif"
  echo "  -> $MEDIA/$name.gif ($(du -h "$MEDIA/$name.gif" | cut -f1))"
done
