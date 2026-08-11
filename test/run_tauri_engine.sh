#!/bin/bash
# Prove the engine works in a *release* Tauri build.
#
#   bash test/run_tauri_engine.sh [output.png]
#
# This is the only automated check of the path a shipped Tauri app actually
# takes: frontend embedded in the binary, served over `tauri://localhost`, wasm
# and every texmf data package fetched from that origin. `tauri dev` serves from
# a local http server instead, so it proves nothing about this.
#
# WebKitGTK has no DevTools protocol, so there is no driver and no way to click
# Compile. Instead it builds a variant whose window opens `engine_check.html`
# with ?autorun=1 — a self-contained page that compiles an inline document and
# prints a verdict — and screenshots the result. The variant is a --config
# override, so no production code carries test scaffolding.
#
# Look for "✓ PASS · 2 PAGES" in the screenshot.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/revery-tex-engine-check.png}"
BIN="$ROOT/tauri/target/release/revery-tex"
TITLE="Revery TeX Engine Check"

if [ -z "${DISPLAY:-}" ]; then
  echo "No DISPLAY. WebKitGTK has no headless path; this needs a real X session." >&2
  exit 2
fi

echo "building the self-check variant…"
npx tauri build --config "$ROOT/tauri/tauri.conf.json" --no-bundle --config \
  "{\"app\":{\"windows\":[{\"label\":\"main\",\"title\":\"$TITLE\",\"url\":\"engine_check.html?autorun=1\",\"width\":1100,\"height\":800}]}}" \
  || { echo "build failed" >&2; exit 1; }

"$BIN" >/tmp/revery-tex-engine-check.log 2>&1 &
APP=$!
# Kill by PID only. A pattern would match this script's own command line.
trap 'kill -9 $APP 2>/dev/null' EXIT

WID=""
for _ in $(seq 1 40); do
  sleep 1
  WID=$(xwininfo -root -tree 2>/dev/null | grep "\"$TITLE\"" | grep -oE '0x[0-9a-f]+' | head -1)
  [ -n "$WID" ] && break
done
[ -z "$WID" ] && { echo "no window appeared" >&2; tail -20 /tmp/revery-tex-engine-check.log >&2; exit 1; }

echo "window $WID — waiting for the engine to boot and compile…"
sleep 45
import -window "$WID" "$OUT" || exit 1
echo "screenshot: $OUT"
echo
echo 'Expect "✓ PASS · 2 PAGES" in the top right. Anything else means the'
echo 'production custom protocol is not serving the engine correctly.'
echo
echo 'NOTE: the release binary is now the self-check variant.'
echo 'Run `npm run build:tauri` to restore the real app.'
