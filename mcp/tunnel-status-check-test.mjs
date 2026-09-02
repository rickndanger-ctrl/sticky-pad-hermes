import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./tunnel-status-check.mjs", import.meta.url));
const tunnelId = `tunnel_${"a".repeat(32)}`;
const base = { tunnel_id: tunnelId, process_running: true, ready: true, healthy: true, stale: false };

function check(payload, expected = tunnelId) {
  return spawnSync(process.execPath, [checker, expected], {
    input: JSON.stringify(payload),
    encoding: "utf8"
  }).status;
}

function checkRemote(payload) {
  return spawnSync(process.execPath, [checker, tunnelId, "--require-remote"], {
    input: JSON.stringify(payload),
    encoding: "utf8"
  }).status;
}

assert.equal(check(base), 0);
assert.notEqual(check({ ...base, tunnel_id: `tunnel_${"b".repeat(32)}` }), 0);
assert.notEqual(check({ ...base, process_running: false }), 0);
assert.notEqual(check({ ...base, ready: false }), 0);
assert.notEqual(check({ ...base, healthy: false }), 0);
assert.notEqual(check({ ...base, stale: true }), 0);
assert.notEqual(check(base, "tunnel_id"), 0);
assert.notEqual(spawnSync(process.execPath, [checker, tunnelId], { input: "not-json", encoding: "utf8" }).status, 0);
assert.equal(checkRemote({ ...base, remote_lookup_attempted: true, remote: { id: tunnelId }, remote_error: "" }), 0);
assert.notEqual(checkRemote({ ...base, remote_lookup_attempted: false, remote: null, remote_error: "" }), 0);
assert.notEqual(checkRemote({ ...base, remote_lookup_attempted: true, remote: null, remote_error: "unauthorized" }), 0);

console.log("Sticky Pad tunnel status checker tests passed");
