#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
SERVER="$SCRIPT_DIR/server.mjs"
STATUS_CHECKER="$SCRIPT_DIR/tunnel-status-check.mjs"
PROFILE_DIR="$SCRIPT_DIR/.tunnel-profiles"
PROFILE="sticky-pad"
ALIAS="sticky-pad"
TUNNEL_ID_FILE="$SCRIPT_DIR/tunnel-id"
KEYCHAIN_SERVICE="com.richardholguin.StickyPad.tunnel-runtime.v1"
KEYCHAIN_ACCOUNT="${USER:-sticky-pad-user}"
KEYCHAIN_HELPER="$SCRIPT_DIR/sticky-pad-keychain"
QUIET="${STICKY_PAD_TUNNEL_QUIET:-0}"

if [[ "$QUIET" != 0 && "$QUIET" != 1 ]]; then
  print -u2 "STICKY_PAD_TUNNEL_QUIET must be 0 or 1."
  exit 64
fi

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

NODE_BIN=$(find_node) || {
  print -u2 "Node.js 20 or newer was not found."
  exit 69
}
node_major=$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')
if (( node_major < 20 )); then
  print -u2 "Node.js 20 or newer is required; found $($NODE_BIN --version)."
  exit 69
fi

TUNNEL_CLIENT=$(find_tunnel_client) || {
  print -u2 "OpenAI tunnel-client is not installed. Run ./install-tunnel-client.sh first."
  exit 66
}

saved_tunnel_id=""
if [[ -f "$TUNNEL_ID_FILE" && ! -L "$TUNNEL_ID_FILE" ]]; then
  saved_tunnel_id=$(<"$TUNNEL_ID_FILE")
fi
TUNNEL_ID="${1:-${CONTROL_PLANE_TUNNEL_ID:-$saved_tunnel_id}}"
if [[ $# -gt 1 || ! "$TUNNEL_ID" =~ '^tunnel_[0-9a-f]{32}$' ]]; then
  print -u2 "Usage: ./connect-chatgpt.sh tunnel_..."
  print -u2 "Alternatively set CONTROL_PLANE_TUNNEL_ID or run the service installer once."
  exit 64
fi

if [[ ! -f "$STATUS_CHECKER" || -L "$STATUS_CHECKER" ]]; then
  print -u2 "Sticky Pad tunnel status checker is missing."
  exit 66
fi

if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  if [[ -x "$KEYCHAIN_HELPER" ]]; then
    CONTROL_PLANE_API_KEY="$($KEYCHAIN_HELPER read "$KEYCHAIN_SERVICE" "$KEYCHAIN_ACCOUNT" 2>/dev/null || true)"
  fi
  export CONTROL_PLANE_API_KEY
fi
if [[ "${CONTROL_PLANE_API_KEY:-}" != sk-* || ${#CONTROL_PLANE_API_KEY} -lt 40 || "$CONTROL_PLANE_API_KEY" == *[[:space:]]* ]]; then
  unset CONTROL_PLANE_API_KEY
  print -u2 "A valid tunnel runtime key is neither exported nor available through the Sticky Pad Keychain helper."
  print -u2 "Run ./install-chatgpt-tunnel-service.sh tunnel_... once from the shell containing CONTROL_PLANE_API_KEY."
  exit 65
fi

MCP_COMMAND="$NODE_BIN \"$SERVER\""
/bin/mkdir -p "$PROFILE_DIR"

init_args=(
  init
  --sample sample_mcp_stdio_local
  --profile "$PROFILE"
  --profile-dir "$PROFILE_DIR"
  --tunnel-id "$TUNNEL_ID"
  --mcp-command "$MCP_COMMAND"
  --health-listen-addr 127.0.0.1:0
  --force
)
connect_args=(
  runtimes connect
  --alias "$ALIAS"
  --profile "$PROFILE"
  --profile-dir "$PROFILE_DIR"
  --tunnel-id "$TUNNEL_ID"
  --runtime-api-key env:CONTROL_PLANE_API_KEY
  --mcp-command "$MCP_COMMAND"
)

if (( QUIET == 1 )); then
  "$TUNNEL_CLIENT" "${init_args[@]}" >/dev/null 2>&1 || { print -u2 "Sticky Pad tunnel profile initialization failed."; exit 70; }
  "$TUNNEL_CLIENT" doctor --profile "$PROFILE" --profile-dir "$PROFILE_DIR" >/dev/null 2>&1 || { print -u2 "Sticky Pad tunnel credential or profile validation failed."; exit 70; }
  "$TUNNEL_CLIENT" "${connect_args[@]}" >/dev/null 2>&1 || { print -u2 "Sticky Pad tunnel connection failed."; exit 70; }
else
  "$TUNNEL_CLIENT" "${init_args[@]}" || exit 70
  "$TUNNEL_CLIENT" doctor --profile "$PROFILE" --profile-dir "$PROFILE_DIR" --explain || exit 70
  "$TUNNEL_CLIENT" "${connect_args[@]}" || exit 70
fi

for attempt in {1..30}; do
  runtime_json="$("$TUNNEL_CLIENT" runtimes status "$ALIAS" --json 2>/dev/null || true)"
  if print -rn -- "$runtime_json" | "$NODE_BIN" "$STATUS_CHECKER" "$TUNNEL_ID" --require-remote; then
    print "Sticky Pad's private ChatGPT tunnel is connected and healthy."
    exit 0
  fi
  /bin/sleep 1
done

print -u2 "Sticky Pad tunnel did not become healthy for the requested tunnel."
exit 70
