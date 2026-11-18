#!/bin/zsh
# Performance measurement (D21, plan §13): seeds ~11,500 events across 10
# conversations, then measures tab-switch and enqueue p95 plus typing/scroll
# long tasks under 3 active runs. macOS only, no model quota (Fake harness).
#
#   pnpm e2e:perf
set -euo pipefail
ROOT=${0:A:h:h:h}
export NEXUS_E2E_DIR=${NEXUS_E2E_DIR:-$(mktemp -d -t nexus-perf)}
mkdir -p "$NEXUS_E2E_DIR/data" "$NEXUS_E2E_DIR/project"
echo hello > "$NEXUS_E2E_DIR/project/README.md"
git -C "$NEXUS_E2E_DIR/project" init -q
git -C "$NEXUS_E2E_DIR/project" -c user.name=e2e -c user.email=e2e@nexus.local add README.md
git -C "$NEXUS_E2E_DIR/project" -c user.name=e2e -c user.email=e2e@nexus.local commit -qm init
PORT=9334
APP_PATTERN="$ROOT/node_modules/.pnpm/electron@[^/]*/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

ensure_electron() {
  (cd "$ROOT/packages/desktop" && node -e "require('electron')" >/dev/null 2>&1) || {
    echo "electron binary not available; run 'pnpm --filter @nexus/desktop exec install-electron'" >&2
    return 1
  }
}

launch() {
  ensure_electron || return 1
  (cd "$ROOT/packages/desktop" && NEXUS_VIBRANCY=0 NEXUS_FAKE_HARNESS=1 NEXUS_USER_DATA_DIR="$NEXUS_E2E_DIR/data" \
    npx electron-vite dev --remoteDebuggingPort $PORT >>"$NEXUS_E2E_DIR/dev.log" 2>&1 &)
  for _ in {1..60}; do curl -s localhost:$PORT/json 2>/dev/null | grep -q '"page"' && break; sleep 1; done
  if ! curl -s localhost:$PORT/json 2>/dev/null | grep -q '"page"'; then
    echo "app never exposed a CDP page; last dev.log lines:" >&2
    tail -n 60 "$NEXUS_E2E_DIR/dev.log" >&2 || true
    return 1
  fi
  sleep 4
  curl -s localhost:$PORT/json | python3 -c "import json,sys;print([t for t in json.load(sys.stdin) if t['type']=='page'][0]['webSocketDebuggerUrl'])"
}
stop() {
  pkill "-$1" -f "$APP_PATTERN" 2>/dev/null || true
  pkill -f "electron-vite dev --remoteDebuggingPort $PORT" 2>/dev/null || true
  sleep 3
}
trap 'stop KILL' EXIT

cd "$ROOT/scripts/e2e"
echo "▶ 1/3 create empty database"
node -e "process.exit(0)" "$(launch)" >/dev/null
stop TERM
echo "▶ 2/3 seed fixture"
node perf-seed.mjs "$NEXUS_E2E_DIR/data/nexus.sqlite" "$NEXUS_E2E_DIR/project"
echo "▶ 3/3 measure"
node perf.mjs "$(launch)"
echo "logs: $NEXUS_E2E_DIR"
