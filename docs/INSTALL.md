# Install and Integration Guide

Sticky Pad has three separate pieces. Install only what you need:

1. The native macOS app displays and edits local notes.
2. The Codex plugin turns a finished plan into Markdown through a local MCP server.
3. The optional Hermes bridge queues a selected task for an agent without waking or assigning that agent.

ChatGPT web access is a fourth, optional connection. It uses a private Secure MCP Tunnel that every user must create for their own OpenAI account. Installing the Codex plugin does not create that tunnel.

## Requirements

- macOS 14 or newer
- Xcode with the Swift 6 toolchain (Xcode 16 or newer)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen)
- Node.js 20 or newer
- Git
- Codex desktop or CLI for the repository plugin
- Optional: an OpenAI Secure MCP Tunnel runtime and a user-owned control-plane credential for ChatGPT web
- Optional: a separate Hermes installation, passwordless key-based SSH to that host, and Node.js 20 or newer on the Hermes host

With Homebrew installed, the local build prerequisites are:

```sh
brew install xcodegen node
```

Make sure `node --version` reports version 20 or newer before testing the MCP servers.

## Build the native app from source

```sh
git clone https://github.com/rickndanger-ctrl/sticky-pad-hermes.git
cd sticky-pad-hermes
xcodegen generate --spec project.yml
xcodebuild test \
  -project StickyPad.xcodeproj \
  -scheme StickyPad \
  -destination 'platform=macOS' \
  -derivedDataPath .test-derived \
  CODE_SIGNING_ALLOWED=NO
```

For normal local use, open `StickyPad.xcodeproj` in Xcode, select the `StickyPad` scheme, and run it. Xcode handles local signing. You can also make a Release build from Terminal:

```sh
xcodebuild build \
  -project StickyPad.xcodeproj \
  -scheme StickyPad \
  -configuration Release \
  -derivedDataPath .release-derived
open .release-derived/Build/Products/Release/StickyPad.app
```

The app creates these user-owned folders when needed:

```text
~/Documents/Sticky Pad/Notes
~/Documents/Sticky Pad/Projects
~/Documents/Sticky Pad/Templates
~/Documents/Sticky Pad/Open Requests
~/Documents/Sticky Pad/Delivery Receipts
```

The blank project-loop form remains a `.txt` file. Completed agent tasks are `.md` files in `Projects`.

On first launch, the app asks for folder access. Select exactly `~/Documents/Sticky Pad`. The app rejects other folders because every local MCP entry point deliberately uses that same library.

## Test the local MCP servers

The tests use temporary folders and fake Hermes commands. They do not require a live agent or tunnel.

```sh
node --check mcp/server.mjs
node --check mcp/hermes-inbox-server.mjs
node --check mcp/status-sync.mjs
node mcp/test.mjs
node mcp/hermes-inbox-test.mjs
node mcp/hermes-registration-test.mjs
node mcp/hermes-remote-deploy-test.mjs
node mcp/hermes-installer-transaction-test.mjs
node mcp/status-sync-test.mjs
node mcp/supervise-chatgpt-tunnel-test.mjs
node mcp/tunnel-status-check-test.mjs
node plugins/sticky-pad/mcp/test.mjs
```

## Install the Codex plugin from GitHub

The repository includes a Codex marketplace at `.agents/plugins/marketplace.json`. Add that Git marketplace, then install the plugin declared by it:

```sh
codex plugin marketplace add rickndanger-ctrl/sticky-pad-hermes --ref main
codex plugin add sticky-pad@sticky-pad-samples
```

Start a new Codex task after installation so the new skill and MCP tools load. The native app must run on the same Mac as the plugin's local MCP server.

The repository marketplace is a Codex plugin distribution mechanism. It is not a ChatGPT Store listing and it does not automatically add an app to ChatGPT web. The plugin bundles instructions, a plain-text template, and a local stdio MCP server. It does not bundle an API key, tunnel credential, Hermes credential, or publisher access to anyone's computer.

## Connect ChatGPT web with a private Secure MCP Tunnel

This path is optional and separate from the Codex marketplace install.

Each person testing the project must:

1. Create their own private MCP app/tunnel in their own OpenAI account or organization.
2. Create a control-plane runtime credential with only the permissions required to read and use that tunnel.
3. Run the repository installer, which downloads the pinned supported tunnel runtime for the Mac's architecture and verifies it against OpenAI's published SHA-256 manifest.
4. Paste the runtime credential into the installer's hidden prompt so it can be stored in their own login Keychain.

Use the OpenAI Platform's [Tunnels](https://platform.openai.com/settings/organization/tunnels) and [runtime API keys](https://platform.openai.com/settings/organization/api-keys) pages to create your private tunnel and narrowly scoped runtime key. Then run:

```sh
./mcp/install-chatgpt-tunnel-service.sh 'tunnel_your_own_32_character_hex_id'
```

Paste the runtime key only into the installer's hidden prompt. On a rerun, paste a replacement key or press Return to reuse the saved key. Never put it in an `export` command, shell history, screenshot, or shared shell profile. If macOS asks for Keychain access during installation, choose the one-time **Allow** button, not **Always Allow**. Never copy the maintainer's tunnel ID or key. A normal OpenAI API key is not automatically a tunnel runtime credential; the credential must have the required tunnel scopes. Set `STICKY_PAD_TUNNEL_CLIENT` only when intentionally using an already-installed verified runtime.

The installer validates the candidate connection before replacing a saved credential, stores it through the macOS Security framework, and installs a per-user LaunchAgent with private logs. The key must not appear in the repository, a plist, command-line arguments, logs, screenshots, or a shared shell profile. Add the resulting private MCP server from [ChatGPT connector settings](https://chatgpt.com/#settings/Connectors) while the tunnel is running. Use `mcp/connect-chatgpt.sh` only for a deliberate foreground diagnosis.

The server's loopback HTTP mode is for local protocol testing only:

```sh
export STICKY_PAD_HTTP_TOKEN="$(/usr/bin/openssl rand -hex 32)"
node mcp/server.mjs --http 7331
```

Clients must send `Authorization: Bearer $STICKY_PAD_HTTP_TOKEN` and `Content-Type: application/json`. The server requires a token at least 32 characters long, rejects every request with an `Origin` header, and stays on `127.0.0.1`. Do not port-forward or expose it as a substitute for Secure MCP Tunnel.

## Optional Hermes connection

Hermes is not required for local notes or the Codex plugin. The bridge is useful only when you already operate a Hermes agent on a separate trusted host.

From the Sticky Pad Mac, install and verify the narrow inbox helper:

```sh
./mcp/install-hermes-inbox.sh \
  --host your-hermes-ssh-host \
  --install-commander-policy
```

The installer requires existing key-based SSH access plus Node.js and Hermes on the remote host. It discovers the remote paths, deploys the helper, replaces only the exact `sticky-pad-inbox` registration with the shipped Node.js/helper command, tests that connection, writes a private local `config.json`, and installs the local status worker. A failed replacement restores the exact prior registration, while similarly named MCP entries are left alone. With `--install-commander-policy`, it also backs up and idempotently updates the default Hermes profile's `SOUL.md` with the marked quiet-pull contract.

The installer deliberately does not restart the Hermes gateway. Confirm there is no active turn, back up live state, and reload only the default gateway supervisor before expecting a long-running Commander session to see the new MCP or policy.

The safety contract is intentionally narrow:

- queueing creates or reuses a card on `sticky-pad-inbox`;
- the card must remain blocked and unassigned;
- queueing does not wake, interrupt, claim, assign, unblock, dispatch, or execute Commander;
- Commander receives only list, read, and visibility-acknowledgement tools through this helper; and
- a human or separately authorized agent policy decides when work actually begins.

Do not treat a successful MCP connection, list operation, or acknowledgement as proof that an agent accepted or completed a task.

## Data flow and privacy

1. The text you give ChatGPT or Codex is processed by that service under your account settings.
2. The local MCP writes the completed Markdown to `~/Documents/Sticky Pad/Projects`.
3. The native app reads that file and displays it as a desktop note.
4. Only when you call the Hermes queue tool does the bridge send that Markdown over SSH and store another copy as a Hermes board attachment.
5. Delivery receipts and status snapshots are stored locally under `~/Documents/Sticky Pad/Delivery Receipts`.

Sticky Pad adds no encryption at rest and no redaction layer. Do not put passwords, private keys, access tokens, regulated data, or other secrets in a task. Secure the Mac and any Hermes host with separate user accounts, disk encryption, current software, and restrictive SSH keys.

## What is not included

- No notarized downloadable macOS binary is promised by the source repository.
- No OpenAI, ChatGPT, Telegram, SSH, or Hermes credential is included.
- No tunnel runtime binary is included.
- No public network endpoint is included.
- No automatic agent execution or task claiming is included.
- No compatibility guarantee is made for untested Hermes versions or modified Kanban schemas.

Run the repository tests and inspect the configuration before using this sample with important work.
