#!/bin/zsh
# UI smoke test: drives the real desktop app over Chrome DevTools Protocol with
# the scripted Fake harness (no model quota). Covers create → stream → tool →
# permission → queue → stop, graceful restart (tabs/history/draft), and crash
# recovery (interrupted run marked failed, never re-run).
#
#   pnpm e2e:smoke
#
# Uses an isolated data dir; your real Nexus data is untouched. macOS only.
set -euo pipefail
ROOT=${0:A:h:h:h}
# CI passes a directory under $RUNNER_TEMP so the logs survive as an artifact;
# locally a throwaway temp dir keeps your real Nexus data untouched.
export NEXUS_E2E_DIR=${NEXUS_E2E_DIR:-$(mktemp -d -t nexus-e2e)}
mkdir -p "$NEXUS_E2E_DIR/data" "$NEXUS_E2E_DIR/project"
echo hello > "$NEXUS_E2E_DIR/project/README.md"
# The project is a git repo so the worktree-isolation path can be exercised.
git -C "$NEXUS_E2E_DIR/project" init -q
git -C "$NEXUS_E2E_DIR/project" -c user.name=e2e -c user.email=e2e@nexus.local add README.md
git -C "$NEXUS_E2E_DIR/project" -c user.name=e2e -c user.email=e2e@nexus.local commit -qm init
PORT=9333
# Regex (pkill -f), scoped to this repo's Electron so other Electron apps are never touched.
APP_PATTERN="$ROOT/node_modules/.pnpm/electron@[^/]*/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

# Electron ships without its binary and downloads it on the first
# `require('electron')`; electron-vite only reads `path.txt` and gives up with
# "Electron uninstall" when it is missing, so a fresh CI checkout must warm it.
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
stop() { # $1 = signal
  pkill "-$1" -f "$APP_PATTERN" 2>/dev/null || true
  pkill -f "electron-vite dev --remoteDebuggingPort $PORT" 2>/dev/null || true
  sleep 3
}
trap 'stop KILL' EXIT

cd "$ROOT/scripts/e2e"
echo "▶ 1/3 conversation flow"; node step1.mjs "$(launch)"
sleep 1; stop TERM
echo "▶ 2/3 restart persistence"; node step2.mjs "$(launch)"
stop KILL   # simulated crash while a run waits for permission
echo "▶ 3/3 crash recovery"; node step3.mjs "$(launch)"
echo "screenshots and logs: $NEXUS_E2E_DIR"
