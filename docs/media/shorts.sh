#!/usr/bin/env bash
# Turn a recorded scene into a YouTube Shorts / Reels / TikTok clip: 1080x1920,
# H.264, vertical.
#
#   ./docs/media/shorts.sh container-social
#
# The terminal recording is landscape, so it is scaled to the full width and
# centred on a vertical canvas rather than cropped - cropping a terminal cuts
# text, which is the one thing a demo cannot afford. The padding uses the
# theme's own background so the letterboxing reads as part of the frame.
#
# Needs ffmpeg (brew install ffmpeg). Everything else comes from record.sh.
set -euo pipefail

MEDIA="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${1:-container-social}"
SRC="$MEDIA/$NAME.gif"
OUT="$MEDIA/$NAME-shorts.mp4"

BG="${BG:-#272822}"     # agg's monokai background
W=1080
H=1920

command -v ffmpeg >/dev/null || { echo "ffmpeg not found - brew install ffmpeg" >&2; exit 1; }
[ -f "$SRC" ] || { echo "no $SRC - record it first: ./docs/media/record.sh $NAME" >&2; exit 1; }

# -r 30: GIF frame delays are uneven, and a fixed rate keeps players honest.
# yuv420p + even dimensions: anything else fails to decode on most phones.
ffmpeg -y -loglevel error -i "$SRC" \
  -vf "scale=${W}:-2:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${BG},format=yuv420p" \
  -r 30 -c:v libx264 -preset slow -crf 20 -movflags +faststart \
  "$OUT"

echo "  -> $OUT ($(du -h "$OUT" | cut -f1))"
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration \
  -of default=noprint_wrappers=1 "$OUT" 2>/dev/null | sed 's/^/     /'
