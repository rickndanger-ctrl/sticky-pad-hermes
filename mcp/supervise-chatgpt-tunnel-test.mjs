#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./supervise-chatgpt-tunnel.sh", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-pad-supervisor-"));
const tools = path.join(root, "tools", "tunnel-client");
const events = path.join(root, "events.log");
const syntheticCredential = ["s", "k-test-only-supervisor-credential-", "0".repeat(24)].join("");
fs.mkdirSync(tools, { recursive: true });
fs.copyFileSync(source, path.join(root, "supervise-chatgpt-tunnel.sh"));
fs.chmodSync(path.join(root, "supervise-chatgpt-tunnel.sh"), 0o700);
fs.writeFileSync(path.join(root, "tunnel-id"), `tunnel_${"a".repeat(32)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(root, "connect-chatgpt.sh"), `#!/bin/zsh\nprint 'connect' >> "$FAKE_TUNNEL_EVENTS"\n`, { mode: 0o700 });
fs.writeFileSync(path.join(root, "sticky-pad-keychain"), `#!/bin/zsh\nprint -n '${syntheticCredential}'\n`, { mode: 0o700 });
fs.writeFileSync(path.join(root, "tunnel-status-check.mjs"), `for await (const _ of process.stdin) {}\nprocess.exit(0);\n`, { mode: 0o600 });
fs.writeFileSync(path.join(tools, "tunnel-client"), `#!/bin/zsh\nprint -r -- "$*" >> "$FAKE_TUNNEL_EVENTS"\nif [[ "$1 $2" == 'runtimes status' ]]; then print '{}'; fi\n`, { mode: 0o700 });

function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error("Timed out waiting for supervisor event"));
      setTimeout(check, 25);
    };
    check();
  });
}

try {
  const child = spawn("/bin/zsh", [path.join(root, "supervise-chatgpt-tunnel.sh")], {
    env: { ...process.env, STICKY_PAD_NODE_BIN: process.execPath, FAKE_TUNNEL_EVENTS: events },
    stdio: "ignore"
  });
  await waitFor(() => fs.existsSync(events) && fs.readFileSync(events, "utf8").includes("runtimes status sticky-pad"));
  child.kill("SIGTERM");
  const exit = await Promise.race([
    new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Supervisor ignored SIGTERM")), 3000))
  ]);
  assert.equal(exit.signal, null);
  assert.match(fs.readFileSync(events, "utf8"), /runtimes stop sticky-pad/);
  process.stdout.write("Sticky Pad tunnel supervisor termination test passed\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
