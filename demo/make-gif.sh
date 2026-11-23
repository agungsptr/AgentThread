#!/usr/bin/env bash
# Turns a recording into README-ready media in demo/out/.
#
#   demo/make-gif.sh cast <file.cast> [speed]   asciinema recording → GIF (agg)          default speed 4
#   demo/make-gif.sh mov  <file.mov>  [speed]   screen recording    → MP4 + GIF (ffmpeg) default speed 6
#
# Keep the README GIF under ~10 MB: raise the speed, or trim the recording.
set -euo pipefail

mode="${1:-}"; in="${2:-}"
[ -n "$mode" ] && [ -f "$in" ] || { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
out="$(cd "$(dirname "$0")" && pwd)/out"; mkdir -p "$out"
name="$(basename "${in%.*}")"
need() { command -v "$1" >/dev/null || { echo "missing $1: brew install $1" >&2; exit 1; }; }

case "$mode" in
  cast)
    need agg
    speed="${3:-4}"
    agg --speed "$speed" --font-size 16 --theme monokai --idle-time-limit 2 "$in" "$out/$name.gif"
    ls -lh "$out/$name.gif"
    ;;
  mov)
    need ffmpeg
    speed="${3:-6}"
    ffmpeg -loglevel error -y -i "$in" -vf "setpts=PTS/$speed,fps=30,scale='min(1600,iw)':-2" -an -c:v libx264 -pix_fmt yuv420p -crf 26 "$out/$name.mp4"
    ffmpeg -loglevel error -y -i "$out/$name.mp4" \
      -vf "fps=12,scale='min(1200,iw)':-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer" \
      "$out/$name.gif"
    ls -lh "$out/$name.mp4" "$out/$name.gif"
    ;;
  *) echo "mode must be cast or mov" >&2; exit 1 ;;
esac
