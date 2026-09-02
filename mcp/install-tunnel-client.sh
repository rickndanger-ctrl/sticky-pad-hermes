#!/bin/zsh
set -euo pipefail
umask 077

SCRIPT_DIR=${0:A:h}
TOOLS_DIR="$SCRIPT_DIR/tools"
TARGET_DIR="$TOOLS_DIR/tunnel-client"
TARGET_BIN="$TARGET_DIR/tunnel-client"
TUNNEL_CLIENT_VERSION="0.0.14"

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

NODE_BIN=$(find_node) || {
  print -u2 "Node.js 20 or newer is required before tunnel-client can be installed."
  exit 69
}

node_major=$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')
if (( node_major < 20 )); then
  print -u2 "Node.js 20 or newer is required; found $($NODE_BIN --version)."
  exit 69
fi

case "$(/usr/bin/uname -m)" in
  arm64) platform_arch=arm64 ;;
  x86_64) platform_arch=amd64 ;;
  *) print -u2 "Unsupported macOS architecture: $(/usr/bin/uname -m)"; exit 69 ;;
esac

temporary_root=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/sticky-pad-tunnel.XXXXXX")
cleanup() {
  /bin/rm -rf "$temporary_root"
}
trap cleanup EXIT INT TERM

checksums="$temporary_root/SHA256SUMS.txt"
archive="$temporary_root/tunnel-client.zip"
asset_name="tunnel-client-v${TUNNEL_CLIENT_VERSION}-darwin-${platform_arch}.zip"
release_base="https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_CLIENT_VERSION}"
asset_url="$release_base/$asset_name"
checksums_url="$release_base/SHA256SUMS.txt"

/usr/bin/curl --fail --location --silent --show-error "$asset_url" --output "$archive"
/usr/bin/curl --fail --location --silent --show-error "$checksums_url" --output "$checksums"

expected_hash=$(/usr/bin/awk -v asset="$asset_name" '$2 == asset || $2 == "*" asset { print $1; exit }' "$checksums")
if [[ ! "$expected_hash" =~ '^[a-fA-F0-9]{64}$' ]]; then
  print -u2 "No valid SHA-256 entry was found for $asset_name."
  exit 70
fi
actual_hash=$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{ print $1 }')
if [[ "${actual_hash:l}" != "${expected_hash:l}" ]]; then
  print -u2 "SHA-256 verification failed for $asset_name."
  exit 70
fi

unpacked="$temporary_root/unpacked"
/bin/mkdir -p "$unpacked" "$TARGET_DIR"
/bin/chmod 700 "$TOOLS_DIR" "$TARGET_DIR"
/usr/bin/ditto -x -k "$archive" "$unpacked"
source_binary=$(/usr/bin/find "$unpacked" -type f -name tunnel-client -perm -111 -print -quit)
if [[ -z "$source_binary" ]]; then
  print -u2 "The verified archive did not contain an executable tunnel-client."
  exit 70
fi

/usr/bin/install -m 700 "$source_binary" "$TARGET_BIN.new"
/bin/mv -f "$TARGET_BIN.new" "$TARGET_BIN"
print -r -- "$TUNNEL_CLIENT_VERSION" > "$TARGET_DIR/VERSION"
/bin/chmod 600 "$TARGET_DIR/VERSION"
print "Installed verified OpenAI tunnel-client $TUNNEL_CLIENT_VERSION at $TARGET_BIN"
