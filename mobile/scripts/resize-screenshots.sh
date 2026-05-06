#!/bin/bash
# Resize iPhone simulator screenshots for App Store Connect.
#
# Apple requires either 1290x2796 (6.7" Display) or 1320x2868 (6.9"
# Display) — most simulator captures land at non-standard sizes that
# App Store Connect rejects on upload. This script normalises any
# PNG you pass it to 1290x2796 (the more widely-accepted of the two).
#
# Uses macOS's built-in `sips` so you don't need to install anything.
# Pass the PNGs as args; outputs go next to them with `-appstore` in
# the filename.
#
# Usage:
#   bash scripts/resize-screenshots.sh ~/Desktop/Simulator*.png
#   bash scripts/resize-screenshots.sh /path/to/img1.png /path/to/img2.png

set -e

TARGET_W=1290
TARGET_H=2796

if [ $# -eq 0 ]; then
  echo "Usage: $0 <input1.png> [input2.png] ..."
  echo "Outputs <input>-appstore.png next to each input."
  exit 1
fi

for input in "$@"; do
  if [ ! -f "$input" ]; then
    echo "Skipping $input — not a file"
    continue
  fi
  output="${input%.*}-appstore.png"
  # sips: resample to target dimensions. -z does H W (height first).
  # Aspect ratio of 1196x2600 vs 1290x2796 differs by 0.3% so
  # we accept the trivial stretch rather than padding.
  sips --resampleHeightWidth $TARGET_H $TARGET_W "$input" --out "$output" >/dev/null
  echo "$input -> $output ($(sips -g pixelWidth -g pixelHeight "$output" | tail -2 | awk '{print $2}' | paste -sd 'x' -))"
done

echo
echo "Done. Upload the *-appstore.png files to App Store Connect"
echo "under '6.7\" Display' (or '6.9\" Display' — both accept 1290x2796)."
