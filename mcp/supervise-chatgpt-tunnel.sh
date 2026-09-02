#!/bin/zsh
set -uo pipefail

SCRIPT_DIR=${0:A:h}
CONNECT_SCRIPT="$SCRIPT_DIR/connect-chatgpt.sh"
STATUS_CHECKER="$SCRIPT_DIR/tunnel-status-check.mjs"
TUNNEL_ID_FILE="$SCRIPT_DIR/tunnel-id"
KEYCHAIN_SERVICE="com.richardholguin.StickyPad.tunnel-runtime.v1"
KEYCHAIN_ACCOUNT="${USER:-sticky-pad-user}"
KEYCHAIN_HELPER="$SCRIPT_DIR/sticky-pad-keychain"
ALIAS="sticky-pad"

find_node() {
  local candidate
  for candidate in \
    "${STICKY_PAD_NODE_BIN:-}" \
    "$HOME/.local/bin/node" \
    /opt/homebrew/bin/node \
    /opt/homebrew/opt/node@20/bin/node \
    /opt/homebrew/opt/node/bin/node \
    /usr/local/bin/node \
    /usr/local/opt/node@20/bin/node \
    /usr/local/opt/node/bin/node \
    /usr/bin/node; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      print -r -- "$candidate"
      return 0
    fi
  done
  command -v node 2>/dev/null || return 1
}

find_tunnel_client() {
  local candidate
  if [[ -n "${STICKY_PAD_TUNNEL_CLIENT:-}" && -x "$STICKY_PAD_TUNNEL_CLIENT" ]]; then
    print -r -- "$STICKY_PAD_TUNNEL_CLIENT"
    return 0
  fi
  candidate="$SCRIPT_DIR/tools/tunnel-client/tunnel-client"
  if [[ -x "$candidate" ]]; then
    print -r -- "$candidate"
    return 0
  fi
  return 1
}

TUNNEL_CLIENT=$(find_tunnel_client) || {
  print -u2 "OpenAI tunnel-client is missing from the Sticky Pad installation."
  exit 66
}

NODE_BIN=$(find_node) || {
  print -u2 "Node.js 20 or newer is missing from the Sticky Pad installation."
  exit 69
}

if [[ ! -x "$CONNECT_SCRIPT" || ! -x "$KEYCHAIN_HELPER" || ! -f "$STATUS_CHECKER" || -L "$STATUS_CHECKER" ]]; then
  print -u2 "Sticky Pad tunnel installation is incomplete."
  exit 66
fi

if [[ ! -f "$TUNNEL_ID_FILE" || -L "$TUNNEL_ID_FILE" ]]; then
  print -u2 "Sticky Pad tunnel ID is missing."
  exit 66
fi
TUNNEL_ID=$(<"$TUNNEL_ID_FILE")
if [[ ! "$TUNNEL_ID" =~ '^tunnel_[0-9a-f]{32}$' ]]; then
  print -u2 "Sticky Pad tunnel ID is malformed."
  exit 66
fi

shutdown_requested=0
sleep_pid=""
stop_runtime() {
  local exit_status=$?
  trap - EXIT INT TERM
  unset CONTROL_PLANE_API_KEY monitor_key runtime_status
  "$TUNNEL_CLIENT" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
  exit "$exit_status"
}
request_shutdown() {
  shutdown_requested=1
  if [[ -n "$sleep_pid" ]]; then
    /bin/kill "$sleep_pid" >/dev/null 2>&1 || true
  fi
}
interruptible_sleep() {
  (( shutdown_requested == 0 )) || return 0
  /bin/sleep "$1" &
  sleep_pid=$!
  wait "$sleep_pid" 2>/dev/null || true
  sleep_pid=""
}
trap stop_runtime EXIT
trap request_shutdown INT TERM

while (( shutdown_requested == 0 )); do
  if ! CONTROL_PLANE_API_KEY="$($KEYCHAIN_HELPER read "$KEYCHAIN_SERVICE" "$KEYCHAIN_ACCOUNT" 2>/dev/null)"; then
    print -u2 "Sticky Pad tunnel credential is unavailable in macOS Keychain."
    exit 78
  fi
  if [[ "$CONTROL_PLANE_API_KEY" != sk-* || ${#CONTROL_PLANE_API_KEY} -lt 40 || "$CONTROL_PLANE_API_KEY" == *[[:space:]]* ]]; then
    unset CONTROL_PLANE_API_KEY
    print -u2 "Sticky Pad tunnel credential in macOS Keychain is malformed."
    exit 78
  fi
  export CONTROL_PLANE_API_KEY

  if ! STICKY_PAD_TUNNEL_QUIET=1 "$CONNECT_SCRIPT"; then
    print -u2 "Sticky Pad tunnel start failed; retrying in 15 seconds."
    unset CONTROL_PLANE_API_KEY
    interruptible_sleep 15
    continue
  fi
  unset CONTROL_PLANE_API_KEY

  while (( shutdown_requested == 0 )); do
    monitor_key="$($KEYCHAIN_HELPER read "$KEYCHAIN_SERVICE" "$KEYCHAIN_ACCOUNT" 2>/dev/null || true)"
    runtime_status="$(CONTROL_PLANE_API_KEY="$monitor_key" "$TUNNEL_CLIENT" runtimes status "$ALIAS" --json 2>/dev/null || true)"
    unset monitor_key
    if ! print -rn -- "$runtime_status" | "$NODE_BIN" "$STATUS_CHECKER" "$TUNNEL_ID" --require-remote; then
      print -u2 "Sticky Pad tunnel is no longer ready; reconnecting."
      break
    fi
    interruptible_sleep 15
  done
done

exit 0
