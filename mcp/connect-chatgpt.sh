#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
SOURCE_CLIENT="$SCRIPT_DIR/../tools/tunnel-client-v0.0.14/tunnel-client"
INSTALLED_CLIENT="$SCRIPT_DIR/tools/tunnel-client-v0.0.14/tunnel-client"
if [[ -x "$SOURCE_CLIENT" ]]; then
  TUNNEL_CLIENT="$SOURCE_CLIENT"
else
  TUNNEL_CLIENT="$INSTALLED_CLIENT"
fi
SERVER="$SCRIPT_DIR/server.mjs"
NODE_BIN="/Users/richardholguin/.local/bin/node"
MCP_COMMAND="$NODE_BIN \"$SERVER\""
PROFILE_DIR="$SCRIPT_DIR/.tunnel-profiles"
PROFILE="sticky-pad"
ALIAS="sticky-pad"
DEFAULT_TUNNEL_ID="tunnel_6a97459afd308191aeb61ab9aa32dfde"
TUNNEL_ID="${1:-${CONTROL_PLANE_TUNNEL_ID:-$DEFAULT_TUNNEL_ID}}"

if [[ $# -gt 1 || "$TUNNEL_ID" != tunnel_* ]]; then
  print -u2 "Usage: ./connect-chatgpt.sh [tunnel_...]"
  exit 64
fi

if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  print -u2 "CONTROL_PLANE_API_KEY is not set in this shell."
  print -u2 "If you previously exported OPENAI_API_KEY, run:"
  print -u2 '  export CONTROL_PLANE_API_KEY="$OPENAI_API_KEY"'
  exit 65
fi

if [[ ! -x "$TUNNEL_CLIENT" ]]; then
  print -u2 "Verified tunnel-client is missing: $TUNNEL_CLIENT"
  exit 66
fi

mkdir -p "$PROFILE_DIR"

"$TUNNEL_CLIENT" init \
  --sample sample_mcp_stdio_local \
  --profile "$PROFILE" \
  --profile-dir "$PROFILE_DIR" \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-command "$MCP_COMMAND" \
  --health-listen-addr 127.0.0.1:8080 \
  --force

"$TUNNEL_CLIENT" doctor --profile "$PROFILE" --profile-dir "$PROFILE_DIR" --explain

"$TUNNEL_CLIENT" runtimes connect \
  --alias "$ALIAS" \
  --profile "$PROFILE" \
  --profile-dir "$PROFILE_DIR" \
  --tunnel-id "$TUNNEL_ID" \
  --runtime-api-key env:CONTROL_PLANE_API_KEY \
  --mcp-command "$MCP_COMMAND"

"$TUNNEL_CLIENT" runtimes status "$ALIAS" --json
