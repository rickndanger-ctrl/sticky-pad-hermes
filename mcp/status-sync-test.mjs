import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-pad-status-"));
const receiptsRoot = path.join(root, "Delivery Receipts");
const fakeSSH = path.join(root, "fake-ssh.mjs");
fs.mkdirSync(receiptsRoot, { recursive: true });
fs.writeFileSync(fakeSSH, `#!/usr/bin/env node
import fs from "node:fs";
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => body += chunk);
process.stdin.on("end", () => {
  if (process.env.FAKE_STATUS_MODE === "fail") { process.stderr.write("offline\\n"); process.exit(23); return; }
  const { taskIds } = JSON.parse(body);
  if (taskIds.length > 500) { process.stderr.write("too many task IDs\\n"); process.exit(24); return; }
  if (process.env.FAKE_STATUS_CALLS) fs.appendFileSync(process.env.FAKE_STATUS_CALLS, taskIds.length + "\\n");
  process.stdout.write(JSON.stringify({ board: "sticky-pad-inbox", tasks: taskIds.map(taskId => ({ taskId, board: "sticky-pad-inbox", status: "running", assignee: "Commander", displayState: "started" })) }));
});
`);
fs.chmodSync(fakeSSH, 0o700);

const receiptURL = path.join(receiptsRoot, "receipt.json");
const original = {
  version: 1, filename: "Task.md", taskId: "t_test1234", board: "sticky-pad-inbox",
  sha256: "a".repeat(64), importance: "high", status: "blocked", assignee: null,
  displayState: "queued", queuedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
  lastError: null, consecutiveFailures: 0
};
fs.writeFileSync(receiptURL, JSON.stringify(original));

const script = fileURLToPath(new URL("./status-sync.mjs", import.meta.url));
const baseEnv = {
  ...process.env,
  STICKY_PAD_DELIVERY_RECEIPTS_DIR: receiptsRoot,
  STICKY_PAD_HERMES_SSH_HOST: "test-host",
  STICKY_PAD_HERMES_REMOTE_NODE: "/test/node",
  STICKY_PAD_HERMES_REMOTE_HELPER: "/test/helper",
  STICKY_PAD_SSH_BIN: fakeSSH
};

try {
  const success = spawnSync(process.execPath, [script, "--once"], { env: baseEnv, encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  const started = JSON.parse(fs.readFileSync(receiptURL, "utf8"));
  assert.equal(started.displayState, "started");
  assert.equal(started.assignee, "Commander");
  assert.equal(started.consecutiveFailures, 0);

  const failure = spawnSync(process.execPath, [script, "--once"], { env: { ...baseEnv, FAKE_STATUS_MODE: "fail" }, encoding: "utf8" });
  assert.equal(failure.status, 1);
  const retained = JSON.parse(fs.readFileSync(receiptURL, "utf8"));
  assert.equal(retained.displayState, "started", "transport failure must not invent a stalled task");
  assert.equal(retained.consecutiveFailures, 1);
  assert.match(retained.lastError, /offline/);

  const recovered = spawnSync(process.execPath, [script, "--once"], { env: baseEnv, encoding: "utf8" });
  assert.equal(recovered.status, 0, recovered.stderr);
  const healthy = JSON.parse(fs.readFileSync(receiptURL, "utf8"));
  assert.equal(healthy.consecutiveFailures, 0);
  assert.equal(healthy.lastError, null);

  const oversizedReceipt = path.join(receiptsRoot, "oversized.json");
  fs.writeFileSync(oversizedReceipt, Buffer.alloc(64 * 1024 + 1, 0x78));
  const bounded = spawnSync(process.execPath, [script, "--once"], { env: baseEnv, encoding: "utf8" });
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.deepEqual(JSON.parse(bounded.stdout), { checked: 1, updated: 1 });

  const batchReceiptsRoot = path.join(root, "Batch Delivery Receipts");
  const batchCalls = path.join(root, "batch-calls.txt");
  fs.mkdirSync(batchReceiptsRoot);
  for (let index = 0; index < 501; index += 1) {
    const receipt = {
      ...original,
      filename: `Task-${index}.md`,
      taskId: `t_batch${String(index).padStart(3, "0")}`
    };
    fs.writeFileSync(path.join(batchReceiptsRoot, `receipt-${index}.json`), JSON.stringify(receipt));
  }
  const batched = spawnSync(process.execPath, [script, "--once"], {
    env: {
      ...baseEnv,
      STICKY_PAD_DELIVERY_RECEIPTS_DIR: batchReceiptsRoot,
      FAKE_STATUS_CALLS: batchCalls
    },
    encoding: "utf8"
  });
  assert.equal(batched.status, 0, batched.stderr);
  assert.deepEqual(JSON.parse(batched.stdout), { checked: 501, updated: 501 });
  assert.deepEqual(fs.readFileSync(batchCalls, "utf8").trim().split("\n").map(Number), [500, 1]);
  for (let index = 0; index < 501; index += 1) {
    const receipt = JSON.parse(fs.readFileSync(path.join(batchReceiptsRoot, `receipt-${index}.json`), "utf8"));
    assert.equal(receipt.displayState, "started");
    assert.equal(receipt.consecutiveFailures, 0);
  }
  console.log("Sticky Pad status sync tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
