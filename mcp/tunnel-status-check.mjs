#!/usr/bin/env node
import process from "node:process";

const expectedTunnelId = process.argv[2] || "";
const requireRemote = process.argv.includes("--require-remote");
if (!/^tunnel_[0-9a-f]{32}$/.test(expectedTunnelId)) process.exit(64);

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(65);
}

let status;
try {
  status = JSON.parse(input);
} catch {
  process.exit(65);
}

const matches = status?.tunnel_id === expectedTunnelId &&
  status?.process_running === true &&
  status?.ready === true &&
  status?.healthy === true &&
  status?.stale === false &&
  (!requireRemote || (
    status?.remote_lookup_attempted === true &&
    status?.remote && typeof status.remote === "object" &&
    !status?.remote_error
  ));

process.exit(matches ? 0 : 1);
