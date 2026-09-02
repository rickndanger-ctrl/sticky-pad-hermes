#!/bin/zsh
set -euo pipefail
umask 077

SOURCE_DIR=${0:A:h}
INSTALL_DIR="$HOME/Library/Application Support/Sticky Pad/MCP"
PROFILE_DIR="$INSTALL_DIR/.tunnel-profiles"
TUNNEL_CLIENT_DIR="$INSTALL_DIR/tools/tunnel-client"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/Sticky Pad"
PLIST="$LAUNCH_AGENTS_DIR/com.richardholguin.stickypad.tunnel.plist"
LABEL="com.richardholguin.stickypad.tunnel"
KEYCHAIN_SERVICE="com.richardholguin.StickyPad.tunnel-runtime.v1"
KEYCHAIN_ACCOUNT="${USER:-sticky-pad-user}"
KEYCHAIN_HELPER="$INSTALL_DIR/sticky-pad-keychain"
TUNNEL_ID_FILE="$INSTALL_DIR/tunnel-id"
STATUS_CHECKER="$INSTALL_DIR/tunnel-status-check.mjs"
DOMAIN="gui/$(/usr/bin/id -u)"
ALIAS="sticky-pad"

managed_files=(
  server.mjs
  status-sync.mjs
  tunnel-status-check.mjs
  connect-chatgpt.sh
  supervise-chatgpt-tunnel.sh
  install-chatgpt-tunnel-service.sh
  install-tunnel-client.sh
  KeychainCredential.swift
  sticky-pad-keychain
)

valid_tunnel_id() {
  [[ "$1" =~ '^tunnel_[0-9a-f]{32}$' ]]
}

valid_runtime_key() {
  [[ "$1" == sk-* && ${#1} -ge 40 && "$1" != *[[:space:]]* ]]
}

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
  local candidate="$TUNNEL_CLIENT_DIR/tunnel-client"
  local version_file="$TUNNEL_CLIENT_DIR/VERSION"
  if [[ -x "$candidate" && -f "$version_file" && ! -L "$version_file" && "$(<"$version_file")" == "0.0.14" ]]; then
    print -r -- "$candidate"
    return 0
  fi
  return 1
}

refuse_unsafe_path() {
  local path="$1"
  local description="$2"
  if [[ -L "$path" ]]; then
    print -u2 "Refusing to replace a symlink at the $description path: $path"
    return 1
  fi
}

refuse_unsafe_path "$INSTALL_DIR" "installation directory"
refuse_unsafe_path "$INSTALL_DIR/tools" "installation tools directory"
refuse_unsafe_path "$PROFILE_DIR" "tunnel profile"
refuse_unsafe_path "$TUNNEL_CLIENT_DIR" "tunnel client"
refuse_unsafe_path "$LOG_DIR" "log directory"
refuse_unsafe_path "$PLIST" "LaunchAgent"
refuse_unsafe_path "$TUNNEL_ID_FILE" "tunnel ID"
for filename in "${managed_files[@]}"; do
  refuse_unsafe_path "$INSTALL_DIR/$filename" "installed $filename"
done

saved_tunnel_id=""
if [[ -f "$TUNNEL_ID_FILE" ]]; then
  saved_tunnel_id=$(<"$TUNNEL_ID_FILE")
fi
TUNNEL_ID="${1:-${CONTROL_PLANE_TUNNEL_ID:-$saved_tunnel_id}}"
if [[ $# -gt 1 ]] || ! valid_tunnel_id "$TUNNEL_ID"; then
  print -u2 "Usage: ./install-chatgpt-tunnel-service.sh tunnel_<32 lowercase hex characters>"
  print -u2 "Create your own tunnel first, then pass its exact ID or set CONTROL_PLANE_TUNNEL_ID."
  exit 64
fi

NODE_BIN=$(find_node) || {
  print -u2 "Node.js 20 or newer is required."
  exit 69
}
node_major=$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')
if (( node_major < 20 )); then
  print -u2 "Node.js 20 or newer is required; found $($NODE_BIN --version)."
  exit 69
fi

for filename in \
  server.mjs status-sync.mjs tunnel-status-check.mjs connect-chatgpt.sh supervise-chatgpt-tunnel.sh \
  install-chatgpt-tunnel-service.sh install-tunnel-client.sh KeychainCredential.swift; do
  if [[ ! -f "$SOURCE_DIR/$filename" || -L "$SOURCE_DIR/$filename" ]]; then
    print -u2 "Required installer source is missing or unsafe: $SOURCE_DIR/$filename"
    exit 66
  fi
done

backup_root=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/sticky-pad-tunnel-install.XXXXXX")
installed_backup="$backup_root/installed"
profile_backup="$backup_root/tunnel-profiles"
tunnel_client_backup="$backup_root/tunnel-client"
plist_backup="$backup_root/launch-agent.plist"
tunnel_id_backup="$backup_root/tunnel-id"
log_backup="$backup_root/logs"
candidate_keychain_helper="$backup_root/sticky-pad-keychain"
candidate_plist="$backup_root/launch-agent-candidate.plist"
/bin/mkdir -p "$installed_backup" "$log_backup"
/bin/chmod 700 "$backup_root" "$installed_backup" "$log_backup"

cleanup_preflight() {
  local exit_status=$?
  trap - EXIT INT TERM
  unset runtime_key saved_runtime_key
  /bin/rm -rf "$backup_root"
  exit "$exit_status"
}
trap cleanup_preflight EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

had_install_dir=0
had_log_dir=0
had_launch_agents_dir=0
install_dir_mode=""
log_dir_mode=""
had_profile_backup=0
had_tunnel_client_backup=0
had_plist_backup=0
had_tunnel_id_backup=0
had_stdout_log=0
had_stderr_log=0
had_service=0
had_saved_runtime_key=0
had_healthy_runtime=0
transaction_started=0
transaction_committed=0
rollback_running=0
rollback_failed=0
saved_runtime_key=""
runtime_key=""
TUNNEL_CLIENT=""

if [[ -d "$INSTALL_DIR" ]]; then
  had_install_dir=1
  install_dir_mode=$(/usr/bin/stat -f '%Lp' "$INSTALL_DIR")
fi
if [[ -d "$LOG_DIR" ]]; then
  had_log_dir=1
  log_dir_mode=$(/usr/bin/stat -f '%Lp' "$LOG_DIR")
fi
[[ -d "$LAUNCH_AGENTS_DIR" ]] && had_launch_agents_dir=1

for filename in "${managed_files[@]}"; do
  installed_file="$INSTALL_DIR/$filename"
  if [[ -f "$installed_file" ]]; then
    /bin/cp -p "$installed_file" "$installed_backup/$filename"
  elif [[ -e "$installed_file" ]]; then
    print -u2 "Refusing to replace a non-file installation target: $installed_file"
    /bin/rm -rf "$backup_root"
    exit 66
  fi
done

if [[ -d "$PROFILE_DIR" ]]; then
  /usr/bin/ditto "$PROFILE_DIR" "$profile_backup"
  had_profile_backup=1
elif [[ -e "$PROFILE_DIR" ]]; then
  print -u2 "Refusing to replace a non-directory tunnel profile: $PROFILE_DIR"
  /bin/rm -rf "$backup_root"
  exit 66
fi

if [[ -d "$TUNNEL_CLIENT_DIR" ]]; then
  /usr/bin/ditto "$TUNNEL_CLIENT_DIR" "$tunnel_client_backup"
  had_tunnel_client_backup=1
elif [[ -e "$TUNNEL_CLIENT_DIR" ]]; then
  print -u2 "Refusing to replace a non-directory tunnel client: $TUNNEL_CLIENT_DIR"
  /bin/rm -rf "$backup_root"
  exit 66
fi

if [[ -f "$PLIST" ]]; then
  /bin/cp -p "$PLIST" "$plist_backup"
  had_plist_backup=1
elif [[ -e "$PLIST" ]]; then
  print -u2 "Refusing to replace a non-file LaunchAgent: $PLIST"
  /bin/rm -rf "$backup_root"
  exit 66
fi

if [[ -f "$TUNNEL_ID_FILE" ]]; then
  /bin/cp -p "$TUNNEL_ID_FILE" "$tunnel_id_backup"
  had_tunnel_id_backup=1
elif [[ -e "$TUNNEL_ID_FILE" ]]; then
  print -u2 "Refusing to replace a non-file tunnel ID: $TUNNEL_ID_FILE"
  /bin/rm -rf "$backup_root"
  exit 66
fi

if [[ -f "$LOG_DIR/tunnel.stdout.log" && ! -L "$LOG_DIR/tunnel.stdout.log" ]]; then
  /bin/cp -p "$LOG_DIR/tunnel.stdout.log" "$log_backup/tunnel.stdout.log"
  had_stdout_log=1
elif [[ -e "$LOG_DIR/tunnel.stdout.log" ]]; then
  print -u2 "Refusing to replace an unsafe tunnel stdout log."
  /bin/rm -rf "$backup_root"
  exit 66
fi
if [[ -f "$LOG_DIR/tunnel.stderr.log" && ! -L "$LOG_DIR/tunnel.stderr.log" ]]; then
  /bin/cp -p "$LOG_DIR/tunnel.stderr.log" "$log_backup/tunnel.stderr.log"
  had_stderr_log=1
elif [[ -e "$LOG_DIR/tunnel.stderr.log" ]]; then
  print -u2 "Refusing to replace an unsafe tunnel stderr log."
  /bin/rm -rf "$backup_root"
  exit 66
fi

if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  had_service=1
fi

/usr/bin/xcrun swiftc -O -framework Security -o "$candidate_keychain_helper" "$SOURCE_DIR/KeychainCredential.swift"
/bin/chmod 700 "$candidate_keychain_helper"
if saved_runtime_key="$($candidate_keychain_helper read "$KEYCHAIN_SERVICE" "$KEYCHAIN_ACCOUNT" 2>/dev/null)"; then
  had_saved_runtime_key=1
else
  keychain_read_status=$?
  if (( keychain_read_status != 68 )); then
    /bin/rm -rf "$backup_root"
    print -u2 "The existing Sticky Pad Keychain credential could not be inspected safely."
    print -u2 "If macOS asks for Keychain access, choose the one-time Allow button, not Always Allow, then run the installer again."
    exit 77
  fi
fi

previous_tunnel_client="$TUNNEL_CLIENT_DIR/tunnel-client"
if valid_tunnel_id "$saved_tunnel_id" && valid_runtime_key "$saved_runtime_key" \
  && [[ -x "$previous_tunnel_client" ]]; then
  previous_runtime_json="$(CONTROL_PLANE_API_KEY="$saved_runtime_key" \
    "$previous_tunnel_client" runtimes status "$ALIAS" --json 2>/dev/null || true)"
  if print -rn -- "$previous_runtime_json" | "$NODE_BIN" "$SOURCE_DIR/tunnel-status-check.mjs" "$saved_tunnel_id" --require-remote; then
    had_healthy_runtime=1
  fi
  unset previous_runtime_json
fi

provided_runtime_key="${CONTROL_PLANE_API_KEY:-}"
unset CONTROL_PLANE_API_KEY
runtime_key="$provided_runtime_key"
unset provided_runtime_key
if [[ -t 0 && -z "$runtime_key" ]]; then
  if valid_runtime_key "$saved_runtime_key"; then
    print -n "Paste a replacement OpenAI tunnel runtime key, or press Return to reuse the saved key (input hidden): "
  else
    print -n "Paste your OpenAI tunnel runtime key (input hidden): "
  fi
  read -rs runtime_key
  print
  [[ -n "$runtime_key" ]] || runtime_key="$saved_runtime_key"
elif [[ -z "$runtime_key" ]]; then
  runtime_key="$saved_runtime_key"
fi
if ! valid_runtime_key "$runtime_key"; then
  unset runtime_key saved_runtime_key
  /bin/rm -rf "$backup_root"
  print -u2 "No valid OpenAI tunnel runtime key was provided or found in Keychain."
  print -u2 "Run this installer interactively and paste the key at the hidden prompt."
  exit 65
fi

/usr/bin/plutil -create xml1 "$candidate_plist"
/usr/libexec/PlistBuddy -c "Add :Label string $LABEL" "$candidate_plist"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$candidate_plist"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string $INSTALL_DIR/supervise-chatgpt-tunnel.sh" "$candidate_plist"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "$candidate_plist"
/usr/libexec/PlistBuddy -c "Add :KeepAlive dict" "$candidate_plist"
/usr/libexec/PlistBuddy -c "Add :KeepAlive:SuccessfulExit bool false" "$candidate_plist"
/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 15" "$candidate_plist"
/usr/libexec/PlistBuddy -c "Add :ProcessType string Background" "$candidate_plist"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $LOG_DIR/tunnel.stdout.log" "$candidate_plist"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $LOG_DIR/tunnel.stderr.log" "$candidate_plist"
/bin/chmod 600 "$candidate_plist"
/usr/bin/plutil -lint "$candidate_plist" >/dev/null

bootstrap_launch_agent() {
  local attempt
  for attempt in {1..10}; do
    if /bin/launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1; then
      /bin/launchctl kickstart -k "$DOMAIN/$LABEL"
      return 0
    fi
    /bin/sleep 1
  done
  return 1
}

restore_file_or_remove() {
  local backup_file="$1"
  local destination_file="$2"
  if [[ -f "$backup_file" ]]; then
    /bin/cp -p "$backup_file" "$destination_file"
  else
    /bin/rm -f -- "$destination_file"
  fi
}

restore_previous_service() {
  rollback_running=1
  /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  if [[ -n "$TUNNEL_CLIENT" && -x "$TUNNEL_CLIENT" ]]; then
    "$TUNNEL_CLIENT" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
  fi

  if ! /bin/rm -rf -- "$PROFILE_DIR"; then
    print -u2 "Rollback could not remove the replacement tunnel profile."
    rollback_failed=1
  elif (( had_profile_backup == 1 )) && ! /usr/bin/ditto "$profile_backup" "$PROFILE_DIR"; then
    print -u2 "Rollback could not restore the previous tunnel profile."
    rollback_failed=1
  fi

  if ! /bin/rm -rf -- "$TUNNEL_CLIENT_DIR"; then
    print -u2 "Rollback could not remove the replacement tunnel client."
    rollback_failed=1
  elif (( had_tunnel_client_backup == 1 )) && ! /usr/bin/ditto "$tunnel_client_backup" "$TUNNEL_CLIENT_DIR"; then
    print -u2 "Rollback could not restore the previous tunnel client."
    rollback_failed=1
  fi

  for filename in "${managed_files[@]}"; do
    if ! restore_file_or_remove "$installed_backup/$filename" "$INSTALL_DIR/$filename"; then
      print -u2 "Rollback could not restore the previous installed $filename."
      rollback_failed=1
    fi
  done
  if ! restore_file_or_remove "$plist_backup" "$PLIST"; then
    print -u2 "Rollback could not restore the previous LaunchAgent."
    rollback_failed=1
  fi
  if ! restore_file_or_remove "$tunnel_id_backup" "$TUNNEL_ID_FILE"; then
    print -u2 "Rollback could not restore the previous tunnel ID."
    rollback_failed=1
  fi
  if ! restore_file_or_remove "$log_backup/tunnel.stdout.log" "$LOG_DIR/tunnel.stdout.log"; then
    print -u2 "Rollback could not restore the previous tunnel stdout log."
    rollback_failed=1
  fi
  if ! restore_file_or_remove "$log_backup/tunnel.stderr.log" "$LOG_DIR/tunnel.stderr.log"; then
    print -u2 "Rollback could not restore the previous tunnel stderr log."
    rollback_failed=1
  fi

  if (( had_saved_runtime_key == 1 )); then
    if ! print -rn -- "$saved_runtime_key" | "$candidate_keychain_helper" store "$KEYCHAIN_SERVICE" "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1; then
      print -u2 "Rollback could not restore the previous Sticky Pad Keychain credential."
      rollback_failed=1
    fi
  else
    if ! "$candidate_keychain_helper" delete "$KEYCHAIN_SERVICE" "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1; then
      print -u2 "Rollback could not remove the new Sticky Pad Keychain credential."
      rollback_failed=1
    fi
  fi

  previous_tunnel_client="$TUNNEL_CLIENT_DIR/tunnel-client"
  previous_connect_script="$INSTALL_DIR/connect-chatgpt.sh"
  if (( had_service == 1 )) && [[ -f "$PLIST" ]]; then
    if ! bootstrap_launch_agent >/dev/null 2>&1; then
      print -u2 "Rollback could not restart the previous Sticky Pad tunnel LaunchAgent."
      rollback_failed=1
    fi
  elif (( had_healthy_runtime == 1 )); then
    if [[ ! -x "$previous_tunnel_client" || ! -x "$previous_connect_script" ]] \
      || ! CONTROL_PLANE_API_KEY="$saved_runtime_key" \
        STICKY_PAD_TUNNEL_QUIET=1 \
        "$previous_connect_script" "$saved_tunnel_id" >/dev/null 2>&1; then
      print -u2 "Rollback could not reconnect the previously healthy Sticky Pad tunnel."
      rollback_failed=1
    fi
  fi

  if (( had_healthy_runtime == 1 && rollback_failed == 0 )); then
    previous_health_restored=0
    for attempt in {1..45}; do
      previous_runtime_json="$(CONTROL_PLANE_API_KEY="$saved_runtime_key" \
        "$previous_tunnel_client" runtimes status "$ALIAS" --json 2>/dev/null || true)"
      if print -rn -- "$previous_runtime_json" | "$NODE_BIN" "$SOURCE_DIR/tunnel-status-check.mjs" "$saved_tunnel_id" --require-remote; then
        previous_health_restored=1
        break
      fi
      /bin/sleep 1
    done
    unset previous_runtime_json
    if (( previous_health_restored == 0 )); then
      print -u2 "Rollback did not restore the previously healthy Sticky Pad tunnel."
      rollback_failed=1
    fi
  fi

  if (( had_install_dir == 0 )); then
    /bin/rmdir "$INSTALL_DIR/tools" >/dev/null 2>&1 || true
    if ! /bin/rmdir "$INSTALL_DIR" >/dev/null 2>&1; then
      print -u2 "Rollback left unexpected files in the new Sticky Pad installation directory."
      rollback_failed=1
    fi
  elif [[ -n "$install_dir_mode" ]]; then
    if ! /bin/chmod "$install_dir_mode" "$INSTALL_DIR" >/dev/null 2>&1; then
      print -u2 "Rollback could not restore installation directory permissions."
      rollback_failed=1
    fi
  fi
  if (( had_log_dir == 0 )); then
    if ! /bin/rmdir "$LOG_DIR" >/dev/null 2>&1; then
      print -u2 "Rollback left unexpected files in the new Sticky Pad log directory."
      rollback_failed=1
    fi
  elif [[ -n "$log_dir_mode" ]]; then
    if ! /bin/chmod "$log_dir_mode" "$LOG_DIR" >/dev/null 2>&1; then
      print -u2 "Rollback could not restore log directory permissions."
      rollback_failed=1
    fi
  fi
  if (( had_launch_agents_dir == 0 )); then
    /bin/rmdir "$LAUNCH_AGENTS_DIR" >/dev/null 2>&1 || true
  fi
}

finish_install() {
  local exit_status=$?
  trap - EXIT INT TERM
  set +e
  if (( transaction_started == 1 && transaction_committed == 0 && rollback_running == 0 )); then
    restore_previous_service
  fi
  unset runtime_key saved_runtime_key
  if (( rollback_failed == 1 )); then
    print -u2 "Sticky Pad tunnel installation failed and its rollback was incomplete."
    print -u2 "Private recovery files were preserved with mode 0700 at: $backup_root"
    exit 74
  fi
  /bin/rm -rf "$backup_root"
  exit "$exit_status"
}
trap - EXIT INT TERM
trap finish_install EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

transaction_started=1
/bin/mkdir -p "$INSTALL_DIR" "$LAUNCH_AGENTS_DIR" "$LOG_DIR"
/bin/chmod 700 "$INSTALL_DIR" "$LOG_DIR"

for filename in \
  server.mjs status-sync.mjs tunnel-status-check.mjs connect-chatgpt.sh supervise-chatgpt-tunnel.sh \
  install-chatgpt-tunnel-service.sh install-tunnel-client.sh KeychainCredential.swift; do
  source_file="$SOURCE_DIR/$filename"
  destination_file="$INSTALL_DIR/$filename"
  if [[ "$source_file" != "$destination_file" ]]; then
    /bin/cp "$source_file" "$destination_file"
  fi
done
/usr/bin/install -m 700 "$candidate_keychain_helper" "$KEYCHAIN_HELPER"
/bin/chmod 700 \
  "$INSTALL_DIR/connect-chatgpt.sh" \
  "$INSTALL_DIR/supervise-chatgpt-tunnel.sh" \
  "$INSTALL_DIR/install-chatgpt-tunnel-service.sh" \
  "$INSTALL_DIR/install-tunnel-client.sh" \
  "$INSTALL_DIR/status-sync.mjs"
/bin/chmod 600 \
  "$INSTALL_DIR/server.mjs" \
  "$STATUS_CHECKER" \
  "$INSTALL_DIR/KeychainCredential.swift"

if ! TUNNEL_CLIENT=$(find_tunnel_client); then
  "$INSTALL_DIR/install-tunnel-client.sh"
  TUNNEL_CLIENT=$(find_tunnel_client) || {
    print -u2 "Verified tunnel-client 0.0.14 installation failed."
    exit 66
  }
fi

/bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
"$TUNNEL_CLIENT" runtimes stop "$ALIAS" >/dev/null 2>&1 || true

if ! CONTROL_PLANE_API_KEY="$runtime_key" \
  STICKY_PAD_TUNNEL_QUIET=1 \
  "$INSTALL_DIR/connect-chatgpt.sh" "$TUNNEL_ID" >/dev/null 2>&1; then
  print -u2 "The new tunnel ID or runtime key failed validation; the previous working configuration was restored when available."
  exit 70
fi

print -rn -- "$runtime_key" | "$KEYCHAIN_HELPER" store "$KEYCHAIN_SERVICE" "$KEYCHAIN_ACCOUNT"
print -r -- "$TUNNEL_ID" > "$TUNNEL_ID_FILE"
/bin/chmod 600 "$TUNNEL_ID_FILE"

for log_file in "$LOG_DIR/tunnel.stdout.log" "$LOG_DIR/tunnel.stderr.log"; do
  : > "$log_file"
  /bin/chmod 600 "$log_file"
done

/usr/bin/install -m 600 "$candidate_plist" "$PLIST"
/usr/bin/plutil -lint "$PLIST" >/dev/null

"$TUNNEL_CLIENT" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
if ! bootstrap_launch_agent; then
  print -u2 "launchd could not load the Sticky Pad tunnel service; the previous working configuration was restored when available."
  exit 70
fi

for attempt in {1..45}; do
  runtime_json="$(CONTROL_PLANE_API_KEY="$runtime_key" "$TUNNEL_CLIENT" runtimes status "$ALIAS" --json 2>/dev/null || true)"
  if print -rn -- "$runtime_json" | "$NODE_BIN" "$STATUS_CHECKER" "$TUNNEL_ID" --require-remote; then
    transaction_committed=1
    print "Sticky Pad's private ChatGPT tunnel is supervised and healthy."
    exit 0
  fi
  /bin/sleep 1
done

print -u2 "The LaunchAgent did not make the requested tunnel healthy; the previous working configuration was restored when available."
print -u2 "Inspect the private logs in: $LOG_DIR"
exit 70
