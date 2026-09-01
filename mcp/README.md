# Sticky Pad MCP

This local MCP deposits finished task plans into `~/Documents/Sticky Pad/Projects`. Sticky Pad notices new Markdown files within one second.

The input workflow starts with the separate plain-text form `Hermes-Task-Template.txt`. Richard gives that `.txt` file to ChatGPT, ChatGPT fills it out, and only then calls `sticky_pad_create_task` to deposit the completed result as a `.md` task.

## Local MCP configuration

Use this server command in an MCP-capable desktop client:

```json
{
  "mcpServers": {
    "sticky-pad": {
      "command": "/usr/bin/env",
      "args": ["node", "/ABSOLUTE/PATH/TO/server.mjs"]
    }
  }
}
```

The server has four tools: create, list, read, and update. It is dependency-free and writes only inside the Sticky Pad Projects folder. Each tool has a title, explicit input/output schema, structured results, and accurate safety annotations for ChatGPT discovery.

## Private ChatGPT connection

Use OpenAI Secure MCP Tunnel with the server's stdio transport. This keeps the MCP private and avoids exposing an unauthenticated HTTP listener.

Current verified connection:

- ChatGPT app: `Sticky Pad`
- App ID: `asdk_app_6a9749e534ec819181fa2c06d7505f81`
- Tunnel: `Sticky Pad Hermes` (`tunnel_6a97459afd308191aeb61ab9aa32dfde`)
- Authentication: none through the private tunnel
- Live create test passed on September 1, 2026

Prerequisites when starting the tunnel in a new shell:

- Create a tunnel in OpenAI Platform tunnel settings and copy its `tunnel_...` ID.
- Create a runtime API key whose principal has Tunnels Read + Use.
- Export the runtime key as `CONTROL_PLANE_API_KEY` in the shell that starts the tunnel.

Then run:

```sh
./connect-chatgpt.sh
```

This build defaults to the verified `Sticky Pad Hermes` tunnel, `tunnel_6a97459afd308191aeb61ab9aa32dfde`. Pass a different `tunnel_...` ID only when intentionally switching tunnels.

The script writes a local profile that references `env:CONTROL_PLANE_API_KEY`; it never stores the key. It runs `doctor --explain` before starting the managed runtime and verifies its JSON status.

## Loopback HTTP testing

A minimal loopback HTTP mode is available for local protocol testing:

```sh
node server.mjs --http 7331
```

That endpoint is intentionally bound to `127.0.0.1`. ChatGPT web cannot reach a private loopback address directly; use the configured Secure MCP Tunnel. Do not expose this unauthenticated local endpoint to a network.
