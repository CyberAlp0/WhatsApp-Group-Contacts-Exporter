#!/usr/bin/env bash
# Builds dist/wa-group-exporter-<version>.zip ready for "Load unpacked" or the Chrome Web Store.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(grep -oP '"version":\s*"\K[^"]+' manifest.json)
mkdir -p dist
OUT="dist/wa-group-exporter-${VERSION}.zip"
rm -f "$OUT"
zip -r "$OUT" manifest.json src popup icons LICENSE README.md >/dev/null
echo "Created $OUT"
