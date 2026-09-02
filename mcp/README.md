# Sticky Pad MCP and Hermes bridge

The local MCP writes finished project plans to `~/Documents/Sticky Pad/Projects`. `sticky_pad_create_and_open_task` also queues an open request and launches or wakes the native app. The blank `Hermes-Task-Template.txt` stays a plain-text input form; completed tasks are Markdown.

## Local MCP

An MCP client can launch the server over stdio:

```json
{
  "mcpServers": {
    "sticky-pad": {
      "command": "/usr/bin/env",
      "args": ["node", "/ABSOLUTE/PATH/TO/mcp/server.mjs"]
    }
  }
}
```

The server exposes create, create-and-open, list, read, open, update, and queue-for-Hermes tools. Local note tools work with no network configuration.

Hermes delivery is opt-in. If no valid local connection config exists, `sticky_pad_queue_for_hermes` fails safely without changing the note. A successful queue writes an atomic receipt under `~/Documents/Sticky Pad/Delivery Receipts` only after the remote helper proves the attachment hash matches and the card remains blocked and unassigned.

## Hermes host

Requirements:

- a trusted Hermes installation with Node.js 20+;
- passwordless, key-based SSH from the Sticky Pad Mac; and
- an SSH hostname containing only letters, numbers, dots, underscores, or hyphens.

Install the bridge:

```sh
./install-hermes-inbox.sh \
  --host your-hermes-ssh-host \
  --install-commander-policy
```

The installer:

1. discovers safe absolute remote paths for Node.js, Hermes, and the remote home;
2. deploys and syntax-checks `hermes-inbox-server.mjs` plus its registration reconciler;
3. removes only the exact `sticky-pad-inbox` registration, then replaces it with the shipped Node.js/helper command;
4. normalizes that registration to one deterministic stdio configuration and runs `hermes mcp test sticky-pad-inbox`;
5. writes the private local connection to `~/Library/Application Support/Sticky Pad/MCP/config.json`;
6. installs `status-sync.mjs` for the native app; and
7. optionally installs the marked quiet-pull policy with an owner-only backup.

If replacement or connection testing fails, the installer restores the exact prior `sticky-pad-inbox` registration (or leaves it absent on a failed first install). Registrations with similar names are never matched or changed.

The Commander-side MCP exposes only:

- `sticky_pad_inbox_list`;
- `sticky_pad_inbox_read`; and
- `sticky_pad_inbox_acknowledge`.

It exposes no claim, assignment, unblock, dispatch, or execution operation. The policy installer does not reload the Hermes gateway; reload only at a verified idle boundary.

## Private ChatGPT connection

OpenAI Secure MCP Tunnel connects this private stdio server to a user-owned developer-mode ChatGPT app. It is not a public plugin distribution system. Every tester needs their own tunnel ID, runtime key, and account permissions.

Create the tunnel and runtime key in the OpenAI Platform first, then run:

```sh
./install-chatgpt-tunnel-service.sh 'tunnel_your_own_32_character_hex_id'
```

The installer asks for the runtime key in a hidden prompt; on a rerun, paste a replacement key or press Return to reuse the saved key. It validates the candidate connection before replacing a saved key, downloads the pinned and tested official `openai/tunnel-client` macOS archive and SHA-256 manifest, verifies the archive, compiles the dedicated Security-framework Keychain helper, stores the runtime key in the login Keychain, and creates a per-user LaunchAgent with private logs. The key is never written to the repository, plist, command line, shell history, or log. If macOS asks for Keychain access during installation, choose the one-time **Allow** button, not **Always Allow**.

Create the tunnel at <https://platform.openai.com/settings/organization/tunnels>, create its runtime key at <https://platform.openai.com/settings/organization/api-keys>, and add the running private MCP server at <https://chatgpt.com/#settings/Connectors>.

`connect-chatgpt.sh tunnel_...` is the deliberate foreground repair path. `install-tunnel-client.sh` installs the pinned supported runtime separately. Set `STICKY_PAD_TUNNEL_CLIENT` only to use a different executable you verified yourself.

Installed service locations:

- MCP files: `~/Library/Application Support/Sticky Pad/MCP`
- LaunchAgent: `~/Library/LaunchAgents/com.richardholguin.stickypad.tunnel.plist`
- logs: `~/Library/Logs/Sticky Pad`

## Local HTTP testing

```sh
export STICKY_PAD_HTTP_TOKEN="$(/usr/bin/openssl rand -hex 32)"
node server.mjs --http 7331
```

Clients must send `Authorization: Bearer $STICKY_PAD_HTTP_TOKEN` and `Content-Type: application/json`. The server requires a token at least 32 characters long, rejects every request with an `Origin` header, and binds to `127.0.0.1`. Never expose it to a LAN or public network.

## Tests

```sh
node test.mjs
node hermes-inbox-test.mjs
node hermes-registration-test.mjs
node hermes-remote-deploy-test.mjs
node hermes-installer-transaction-test.mjs
node status-sync-test.mjs
node supervise-chatgpt-tunnel-test.mjs
node tunnel-status-check-test.mjs
```
