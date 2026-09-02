#!/bin/zsh
set -euo pipefail
umask 077

SCRIPT_DIR=${0:A:h}
SSH_HOST="${STICKY_PAD_HERMES_SSH_HOST:-}"
INSTALL_POLICY=0
LOCAL_INSTALL_DIR="$HOME/Library/Application Support/Sticky Pad/MCP"

if [[ -L "$LOCAL_INSTALL_DIR" || ( -e "$LOCAL_INSTALL_DIR" && ! -d "$LOCAL_INSTALL_DIR" ) ]]; then
  print -u2 "Refusing an unsafe Sticky Pad MCP installation directory: $LOCAL_INSTALL_DIR"
  exit 66
fi
for local_target in "$LOCAL_INSTALL_DIR/status-sync.mjs" "$LOCAL_INSTALL_DIR/config.json"; do
  if [[ -L "$local_target" || ( -e "$local_target" && ! -f "$local_target" ) ]]; then
    print -u2 "Refusing an unsafe Sticky Pad MCP installation target: $local_target"
    exit 66
  fi
done

while (( $# > 0 )); do
  case "$1" in
    --host)
      (( $# >= 2 )) || { print -u2 "--host requires an SSH host"; exit 64; }
      SSH_HOST="$2"
      shift 2
      ;;
    --install-commander-policy)
      INSTALL_POLICY=1
      shift
      ;;
    *)
      print -u2 "Usage: ./install-hermes-inbox.sh --host SSH_HOST [--install-commander-policy]"
      exit 64
      ;;
  esac
done

[[ "$SSH_HOST" =~ '^[a-zA-Z0-9._-]+$' ]] || {
  print -u2 "A safe SSH host is required. Use --host or STICKY_PAD_HERMES_SSH_HOST."
  exit 64
}

SSH_BIN="${STICKY_PAD_INSTALL_SSH_BIN:-/usr/bin/ssh}"
SCP_BIN="${STICKY_PAD_INSTALL_SCP_BIN:-/usr/bin/scp}"
for transport_bin in "$SSH_BIN" "$SCP_BIN"; do
  [[ "$transport_bin" =~ '^/[a-zA-Z0-9._/-]+$' && -f "$transport_bin" && ! -L "$transport_bin" && -x "$transport_bin" ]] || {
    print -u2 "Refusing an unsafe SSH transport executable: $transport_bin"
    exit 69
  }
done

SSH=("$SSH_BIN" -T -o BatchMode=yes -o ConnectTimeout=8 "$SSH_HOST")
REMOTE_ROOT_REL=".hermes/sticky-pad-mcp"
REMOTE_HOME=$("${SSH[@]}" 'printf %s "$HOME"')
REMOTE_NODE=$("${SSH[@]}" 'command -v node || { test -x "$HOME/.local/bin/node" && printf %s "$HOME/.local/bin/node"; }')
REMOTE_HERMES=$("${SSH[@]}" 'command -v hermes || { test -x "$HOME/.local/bin/hermes" && printf %s "$HOME/.local/bin/hermes"; }')

safe_remote_path() {
  [[ "$1" =~ '^/[a-zA-Z0-9._/-]+$' && "$1" != *'/../'* && "$1" != */.. ]]
}

safe_remote_path "$REMOTE_HOME" || { print -u2 "Remote home path is not shell-safe"; exit 64; }
safe_remote_path "$REMOTE_NODE" || { print -u2 "Remote Node.js path is missing or not shell-safe"; exit 69; }
safe_remote_path "$REMOTE_HERMES" || { print -u2 "Remote Hermes path is missing or not shell-safe"; exit 69; }

REMOTE_ROOT="$REMOTE_HOME/$REMOTE_ROOT_REL"
REMOTE_HELPER="$REMOTE_ROOT/hermes-inbox-server.mjs"
REMOTE_TOKEN="$(/bin/date +%s)-${$}-${RANDOM}"
REMOTE_PARENT="$REMOTE_HOME/.hermes"
REMOTE_STAGE="$REMOTE_PARENT/.sticky-pad-mcp-stage-$REMOTE_TOKEN"
REMOTE_TRANSACTION="$REMOTE_PARENT/.sticky-pad-mcp-transaction-$REMOTE_TOKEN"
REMOTE_TRANSACTION_DEPLOYER="$REMOTE_TRANSACTION/deployer.mjs"

safe_remote_path "$REMOTE_ROOT" || { print -u2 "Remote deployment root is not shell-safe"; exit 64; }
safe_remote_path "$REMOTE_STAGE" || { print -u2 "Remote staging path is not shell-safe"; exit 64; }
safe_remote_path "$REMOTE_TRANSACTION" || { print -u2 "Remote transaction path is not shell-safe"; exit 64; }

LOCAL_BACKUP_DIR=""
LOCAL_STATUS_TEMP=""
LOCAL_STATUS_EXISTED=0
LOCAL_CONFIG_EXISTED=0
INSTALL_COMPLETE=0

restore_local_target() {
  local target="$1"
  local backup="$2"
  local existed="$3"
  local temporary
  if (( existed == 1 )); then
    temporary=$(/usr/bin/mktemp "$LOCAL_INSTALL_DIR/.restore.XXXXXX") || return 1
    /bin/cp -p "$backup" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
    /bin/mv -f "$temporary" "$target" || { /bin/rm -f "$temporary"; return 1; }
  else
    /bin/rm -f "$target"
  fi
}

rollback_install() {
  local original_status=$?
  local rollback_failed=0
  trap - EXIT INT TERM HUP
  set +e
  if (( INSTALL_COMPLETE == 1 )); then
    exit "$original_status"
  fi
  (( original_status == 0 )) && original_status=1

  if [[ -n "$LOCAL_BACKUP_DIR" && -d "$LOCAL_BACKUP_DIR" && ! -L "$LOCAL_BACKUP_DIR" ]]; then
    restore_local_target \
      "$LOCAL_INSTALL_DIR/status-sync.mjs" \
      "$LOCAL_BACKUP_DIR/status-sync.mjs" \
      "$LOCAL_STATUS_EXISTED" || rollback_failed=1
    restore_local_target \
      "$LOCAL_INSTALL_DIR/config.json" \
      "$LOCAL_BACKUP_DIR/config.json" \
      "$LOCAL_CONFIG_EXISTED" || rollback_failed=1
  fi

  if "${SSH[@]}" /bin/test -f "$REMOTE_TRANSACTION_DEPLOYER"; then
    "${SSH[@]}" "$REMOTE_NODE" "$REMOTE_TRANSACTION_DEPLOYER" \
      --rollback \
      --root "$REMOTE_ROOT" \
      --transaction "$REMOTE_TRANSACTION" \
      --hermes-bin "$REMOTE_HERMES" || rollback_failed=1
  fi
  "${SSH[@]}" /bin/rm -rf "$REMOTE_STAGE" >/dev/null 2>&1 || rollback_failed=1

  if [[ -n "$LOCAL_STATUS_TEMP" && "$LOCAL_STATUS_TEMP" == "$LOCAL_INSTALL_DIR"/.status-sync.* ]]; then
    /bin/rm -f "$LOCAL_STATUS_TEMP" || rollback_failed=1
  fi
  if (( rollback_failed == 0 )) && [[ -n "$LOCAL_BACKUP_DIR" && "$LOCAL_BACKUP_DIR" == "$LOCAL_INSTALL_DIR"/.hermes-install-backup.* ]]; then
    /bin/rm -rf "$LOCAL_BACKUP_DIR" || rollback_failed=1
  fi
  if (( rollback_failed == 1 )); then
    if [[ -n "$LOCAL_BACKUP_DIR" && -d "$LOCAL_BACKUP_DIR" && ! -L "$LOCAL_BACKUP_DIR" ]]; then
      print -u2 "Sticky Pad installation failed and at least one rollback step also failed. Local recovery backup: $LOCAL_BACKUP_DIR"
    else
      print -u2 "Sticky Pad installation failed and at least one rollback step also failed. No local recovery backup was created."
    fi
  else
    print -u2 "Sticky Pad restored the previous Hermes deployment and local connection files after failure."
  fi
  exit "$original_status"
}

trap rollback_install EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

find_local_node() {
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

LOCAL_NODE=$(find_local_node || true)
if [[ -z "$LOCAL_NODE" || ! -x "$LOCAL_NODE" ]]; then
  print -u2 "Local Node.js is required to write Sticky Pad's local Hermes connection config."
  exit 69
fi
/bin/mkdir -p "$LOCAL_INSTALL_DIR"
/bin/chmod 700 "$LOCAL_INSTALL_DIR"

LOCAL_BACKUP_DIR=$(/usr/bin/mktemp -d "$LOCAL_INSTALL_DIR/.hermes-install-backup.XXXXXX")
/bin/chmod 700 "$LOCAL_BACKUP_DIR"
if [[ -f "$LOCAL_INSTALL_DIR/status-sync.mjs" && ! -L "$LOCAL_INSTALL_DIR/status-sync.mjs" ]]; then
  /bin/cp -p "$LOCAL_INSTALL_DIR/status-sync.mjs" "$LOCAL_BACKUP_DIR/status-sync.mjs"
  LOCAL_STATUS_EXISTED=1
fi
if [[ -f "$LOCAL_INSTALL_DIR/config.json" && ! -L "$LOCAL_INSTALL_DIR/config.json" ]]; then
  /bin/cp -p "$LOCAL_INSTALL_DIR/config.json" "$LOCAL_BACKUP_DIR/config.json"
  LOCAL_CONFIG_EXISTED=1
fi

for filename in \
  hermes-inbox-server.mjs \
  reconcile-hermes-registration.mjs \
  install-commander-policy.mjs \
  COMMANDER-INSTRUCTIONS.md \
  hermes-remote-deploy.mjs; do
  [[ -f "$SCRIPT_DIR/$filename" && ! -L "$SCRIPT_DIR/$filename" ]] || {
    print -u2 "Required Hermes deployment file is missing or unsafe: $filename"
    exit 66
  }
done

"${SSH[@]}" /bin/mkdir -p "$REMOTE_PARENT"
"${SSH[@]}" /bin/mkdir "$REMOTE_STAGE"
"${SSH[@]}" /bin/chmod 700 "$REMOTE_STAGE"
for filename in \
  hermes-inbox-server.mjs \
  reconcile-hermes-registration.mjs \
  install-commander-policy.mjs \
  COMMANDER-INSTRUCTIONS.md \
  hermes-remote-deploy.mjs; do
  "$SCP_BIN" -q -o BatchMode=yes -o ConnectTimeout=8 "$SCRIPT_DIR/$filename" "$SSH_HOST:$REMOTE_STAGE/$filename"
done

REMOTE_PREPARE_ARGS=(
  --prepare
  --root "$REMOTE_ROOT"
  --staging "$REMOTE_STAGE"
  --transaction "$REMOTE_TRANSACTION"
  --hermes-bin "$REMOTE_HERMES"
  --node-bin "$REMOTE_NODE"
)
if (( INSTALL_POLICY == 1 )); then
  REMOTE_PREPARE_ARGS+=(--install-policy)
fi
"${SSH[@]}" "$REMOTE_NODE" "$REMOTE_STAGE/hermes-remote-deploy.mjs" "${REMOTE_PREPARE_ARGS[@]}"

if [[ "$SCRIPT_DIR/status-sync.mjs" != "$LOCAL_INSTALL_DIR/status-sync.mjs" ]]; then
  LOCAL_STATUS_TEMP=$(/usr/bin/mktemp "$LOCAL_INSTALL_DIR/.status-sync.XXXXXX")
  /bin/cp "$SCRIPT_DIR/status-sync.mjs" "$LOCAL_STATUS_TEMP"
  /bin/chmod 700 "$LOCAL_STATUS_TEMP"
  /bin/mv -f "$LOCAL_STATUS_TEMP" "$LOCAL_INSTALL_DIR/status-sync.mjs"
  LOCAL_STATUS_TEMP=""
fi
/bin/chmod 700 "$LOCAL_INSTALL_DIR/status-sync.mjs"

"$LOCAL_NODE" - "$LOCAL_INSTALL_DIR/config.json" "$SSH_HOST" "$REMOTE_NODE" "$REMOTE_HELPER" <<'NODE'
const fs = require("fs");
const path = require("path");
const [target, sshHost, remoteNode, remoteHelper] = process.argv.slice(2);
let config = { version: 1 };
if (fs.existsSync(target)) {
  const status = fs.lstatSync(target);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error("Refusing non-regular Sticky Pad config");
  config = JSON.parse(fs.readFileSync(target, "utf8"));
}
config.version = 1;
config.hermes = { sshHost, remoteNode, remoteHelper };
const temporary = path.join(path.dirname(target), `.config.${process.pid}.${Date.now()}.tmp`);
fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
try {
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
} catch (error) {
  try { fs.unlinkSync(temporary); } catch {}
  throw error;
}
NODE

"${SSH[@]}" "$REMOTE_NODE" "$REMOTE_TRANSACTION_DEPLOYER" \
  --commit \
  --root "$REMOTE_ROOT" \
  --transaction "$REMOTE_TRANSACTION" \
  --hermes-bin "$REMOTE_HERMES"

INSTALL_COMPLETE=1
trap - EXIT INT TERM HUP
if ! /bin/rm -rf "$LOCAL_BACKUP_DIR"; then
  print -u2 "Sticky Pad was installed successfully, but its private local transaction backup could not be cleaned up."
fi
LOCAL_BACKUP_DIR=""
if ! "${SSH[@]}" "$REMOTE_NODE" "$REMOTE_TRANSACTION_DEPLOYER" \
  --cleanup \
  --root "$REMOTE_ROOT" \
  --transaction "$REMOTE_TRANSACTION" \
  --hermes-bin "$REMOTE_HERMES"; then
  print -u2 "Sticky Pad was installed successfully, but its committed remote transaction backup could not be cleaned up."
fi

print "Sticky Pad Hermes Inbox is installed and verified on $SSH_HOST."
if (( INSTALL_POLICY == 0 )); then
  print "Commander policy was not changed. Re-run with --install-commander-policy when the gateway is idle."
else
  print "Commander policy is installed. Reload the Hermes gateway only at a confirmed idle boundary."
fi
