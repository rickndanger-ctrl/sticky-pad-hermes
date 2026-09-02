# Security Policy

Sticky Pad is a local-first sample project. It has not received an independent security audit.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or an exposed secret.

Use GitHub's private vulnerability reporting or a private security advisory for this repository. If that option is unavailable, contact the maintainer through the GitHub profile linked from the repository and ask for a private reporting channel. Include:

- the affected version or commit;
- the macOS, Node.js, Codex, ChatGPT, or Hermes environment involved;
- clear reproduction steps;
- the impact and the smallest proof needed to demonstrate it; and
- any temporary mitigation you found.

Do not include real task documents, API keys, tunnel IDs, SSH configuration, Hermes configuration, usernames, hostnames, access tokens, Keychain contents, or private logs in the first report.

The maintainer will acknowledge a usable report, investigate it, and coordinate a fix and disclosure. No response-time guarantee is currently offered.

## Supported versions

Security fixes target the current `main` branch. Older commits and locally modified copies are not maintained as separate supported releases.

## Credentials and private data

- This repository must never contain an OpenAI API key, a Secure MCP Tunnel control-plane key, a tunnel ID tied to a private account, a Telegram token, an SSH private key, or a Hermes credential.
- Each user must create and use their own tunnel and credentials. Publisher credentials are not part of the plugin or app.
- Keep secrets in macOS Keychain or a short-lived environment variable. Do not put them in `.mcp.json`, plist files, shell history, screenshots, issues, test fixtures, or committed `.env` files.
- If a secret is exposed, revoke or rotate it immediately. Removing it from the latest commit is not enough because Git history and forks may retain it.
- Review task Markdown before sharing diagnostics. A task can contain private project details even when the software itself contains no secret.

## Security boundaries

- The native app reads and writes user-owned files under `~/Documents/Sticky Pad`. It does not add encryption at rest; use FileVault and normal macOS account security when the contents are sensitive.
- The bundled MCP is intended for local stdio use. Its loopback HTTP test mode requires a 32-character-or-longer bearer token, JSON content type, rejects browser-origin requests, and remains bound to `127.0.0.1`; do not expose it to a LAN or the public internet.
- The optional Secure MCP Tunnel authenticates a user's local runtime to that user's OpenAI control plane. It does not make a publisher's credentials safe to share.
- The optional Hermes bridge sends selected task Markdown over SSH to a separate Hermes host and stores it there as a board attachment. That host becomes another copy of the data and must be secured independently.
- The narrow Commander-side MCP can list, read, and acknowledge inbox visibility. It is not an authorization boundary for the rest of Hermes, SSH, or the host account.
- Sticky Pad is designed for one macOS user account. It is not a hardened multi-tenant service.

See [docs/INSTALL.md](docs/INSTALL.md) for the complete data flow and safe setup boundaries.
