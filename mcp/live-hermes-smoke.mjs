#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const taskIndex = process.argv.indexOf("--task-id");
if (taskIndex < 0 || !/^t_[a-zA-Z0-9]+$/.test(process.argv[taskIndex + 1] || "")) {
  process.stderr.write("Usage: live-hermes-smoke.mjs --task-id t_...\n");
  process.exit(64);
}
const taskId = process.argv[taskIndex + 1];
const configPath = process.env.STICKY_PAD_CONFIG_FILE || path.join(os.homedir(), "Library", "Application Support", "Sticky Pad", "MCP", "config.json");
const status = fs.lstatSync(configPath);
if (!status.isFile() || status.isSymbolicLink()) throw new Error("Sticky Pad config must be a regular file");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const { sshHost, remoteNode, remoteHelper } = config.hermes || {};
const safeRemotePath = value => typeof value === "string" && /^\/[a-zA-Z0-9._/-]+$/.test(value) && !value.split("/").includes("..");
if (!/^[a-zA-Z0-9._-]+$/.test(sshHost || "") || !safeRemotePath(remoteNode) || !safeRemotePath(remoteHelper)) {
  throw new Error("Sticky Pad Hermes connection is missing or unsafe");
}

const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sticky_pad_inbox_list", arguments: {} } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "sticky_pad_inbox_read", arguments: { taskId } } }
];
const result = spawnSync("/usr/bin/ssh", [
  "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
  sshHost, remoteNode, remoteHelper
], {
  input: `${requests.map(item => JSON.stringify(item)).join("\n")}\n`,
  encoding: "utf8",
  timeout: 30000,
  maxBuffer: 4 * 1024 * 1024
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error((result.stderr || `SSH exited ${result.status}`).trim());

const responses = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
assert.equal(responses.length, 4, "expected one response for each read-only request");
assert.equal(responses[0].result.serverInfo.name, "sticky-pad-hermes-inbox");
assert.deepEqual(
  responses[1].result.tools.map(tool => tool.name).sort(),
  ["sticky_pad_inbox_acknowledge", "sticky_pad_inbox_list", "sticky_pad_inbox_read"]
);
assert.equal(responses[2].result.isError, false, "inbox list failed");
assert.equal(responses[3].result.isError, false, "inbox read failed");

const read = responses[3].result.structuredContent;
const taskEnvelope = read.task || {};
const task = taskEnvelope.task || taskEnvelope;
assert.equal(task.status, "blocked", "task must remain blocked");
assert.equal(task.assignee ?? null, null, "task must remain unassigned");
assert.ok(Array.isArray(read.attachments) && read.attachments.length > 0, "task must have a Markdown attachment");
for (const attachment of read.attachments) {
  const hash = crypto.createHash("sha256").update(attachment.markdown, "utf8").digest("hex");
  assert.equal(hash, attachment.sha256, "attachment SHA-256 is invalid");
}
const sourceHash = JSON.stringify(taskEnvelope).match(/Source SHA-256:\s*([a-f0-9]{64})/i)?.[1];
assert.ok(sourceHash, "task does not record a source SHA-256");
assert.ok(read.attachments.some(item => item.sha256 === sourceHash), "attachment does not match the task's source SHA-256");

process.stdout.write(`Read-only Hermes smoke test passed: 3 tools, ${read.attachments.length} verified attachment(s), task blocked and unassigned.\n`);
