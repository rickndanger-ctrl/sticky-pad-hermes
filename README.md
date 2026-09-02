# Sticky Pad for Hermes

Sticky Pad is a native macOS menu-bar app for planning work with ChatGPT or Codex and quietly handing finished Markdown tasks to a Hermes agent.

It has four deliberately separate parts:

- a yellow desktop sticky-note app;
- a reusable plain-text project-loop template;
- a Codex plugin backed by a local MCP server;
- an optional, pull-only Hermes Inbox bridge.

Regular notes stay local and never become Hermes tasks. Queued Hermes cards remain blocked and unassigned until a human separately releases them.

## What works

- Create as many regular or project notes as needed.
- Switch each note between always-on-top Hover mode and true Desktop mode.
- Render Markdown, edit and explicitly save project source, auto-save regular notes, minimize, close, and delete projects through the macOS Trash.
- Reopen project notes from the Projects window; closed regular notes remain available as plain text in the Notes folder.
- Copy the complete ChatGPT-ready `Hermes-Task-Template.txt` from the menu-bar app.
- Let the bundled MCP create, list, read, update, and open finished plans.
- Optionally queue one selected project through SSH to the isolated `sticky-pad-inbox` Hermes board.
- Let Commander list, read, and acknowledge visibility without exposing claim, assign, unblock, dispatch, or execution tools.
- Track queued, started, stalled, and completed delivery states without inventing a failure state during an outage.

## Install from source

Requirements: macOS 14+, Xcode with Swift 6, XcodeGen, and Node.js 20+.

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
open StickyPad.xcodeproj
```

Run the `StickyPad` scheme from Xcode for a locally signed app. This repository currently distributes source, not a notarized binary.

On first launch, approve exactly `~/Documents/Sticky Pad` in the folder picker. The app rejects any other selection so the native windows and MCP tools cannot silently use different libraries.

## Install the plugin from GitHub

```sh
codex plugin marketplace add rickndanger-ctrl/sticky-pad-hermes --ref main
codex plugin add sticky-pad@sticky-pad-samples
```

Start a new Codex task after installation. The plugin's local MCP works without Hermes; queueing fails safely with a clear configuration error until the optional bridge is installed.

This GitHub marketplace installs into Codex desktop or CLI. It is not a universal public ChatGPT listing and does not add anything to ChatGPT web.

## Optional Hermes bridge

First configure passwordless, key-based SSH to a trusted Hermes host. Then run:

```sh
./mcp/install-hermes-inbox.sh \
  --host your-hermes-ssh-host \
  --install-commander-policy
```

The installer discovers remote Node.js and Hermes paths, deploys the narrow inbox helper, registers and tests the MCP, writes the local connection config, installs the local status worker, and optionally installs the marked quiet-pull policy into the default Hermes profile. It does not restart the Hermes gateway because that could interrupt active work. Reload the gateway only after confirming Commander is idle.

## Optional private ChatGPT connection

Each tester must create their own OpenAI Secure MCP Tunnel and runtime key. The repository contains no tunnel ID, app ID, API key, or shared credential.

```sh
./mcp/install-chatgpt-tunnel-service.sh 'tunnel_your_own_32_character_hex_id'
```

The installer asks for the runtime key in a hidden prompt; on a rerun, paste a replacement key or press Return to reuse the saved key. It validates the connection before replacing a working credential, downloads the pinned and tested official OpenAI `tunnel-client` release for the Mac's architecture, verifies it against the release SHA-256 manifest, stores the key in the user's login Keychain, and installs a supervised LaunchAgent. Do not put the key in a shell command or shell profile. If macOS asks for Keychain access during installation, choose the one-time **Allow** button, not **Always Allow**.

Secure MCP Tunnel is for private and developer connections. A universal public ChatGPT plugin would require a stable public HTTPS MCP service plus OpenAI submission; this local-first project does not pretend otherwise.

## Data and safety boundary

- Local files live under `~/Documents/Sticky Pad`.
- Text supplied to ChatGPT or Codex is processed under that service and account's data controls.
- Only the explicit Hermes queue tool sends a selected Markdown task over SSH to the Hermes host.
- Sticky Pad does not encrypt task files at rest. Never place passwords, private keys, API tokens, or regulated data in a note.
- The loopback HTTP test server requires a 32-character-or-longer bearer token, rejects browser-origin requests, and binds only to `127.0.0.1`; never expose or port-forward it.

See [the full installation and integration guide](docs/INSTALL.md), [the MCP guide](mcp/README.md), and [the security policy](SECURITY.md).

## Development

```sh
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

CI regenerates the Xcode project, runs the native suite, checks every Node and Zsh entry point, runs all MCP suites, and validates the plugin marketplace.

Licensed under the [MIT License](LICENSE).
