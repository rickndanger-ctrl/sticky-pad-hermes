#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RECEIPTS_ROOT = process.env.STICKY_PAD_DELIVERY_RECEIPTS_DIR || path.join(os.homedir(), "Documents", "Sticky Pad", "Delivery Receipts");
const CONFIG_FILE = process.env.STICKY_PAD_CONFIG_FILE || path.join(os.homedir(), "Library", "Application Support", "Sticky Pad", "MCP", "config.json");
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;

function readBoundedRegularUTF8(target, maximumBytes, label) {
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const status = fs.fstatSync(descriptor);
    if (!status.isFile()) throw new Error(`${label} must be a regular file`);
    if (status.size > maximumBytes) throw new Error(`${label} is too large`);
    const content = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < content.length) {
      const count = fs.readSync(descriptor, content, offset, content.length - offset, offset);
      if (count === 0) throw new Error(`${label} changed while being read`);
      offset += count;
    }
    if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) throw new Error(`${label} changed while being read`);
    return content.toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readLocalConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { config: {}, error: null };
  try {
    const config = JSON.parse(readBoundedRegularUTF8(CONFIG_FILE, MAX_CONFIG_BYTES, "config"));
    if (config.version !== 1 || (config.hermes !== undefined && (typeof config.hermes !== "object" || config.hermes === null))) {
      throw new Error("config must use version 1 and an optional hermes object");
    }
    return { config, error: null };
  } catch (error) {
    return { config: {}, error: `Sticky Pad config is invalid: ${error.message || String(error)}` };
  }
}

const localConfig = readLocalConfig();
const HERMES_SSH_HOST = process.env.STICKY_PAD_HERMES_SSH_HOST || localConfig.config.hermes?.sshHost || "";
const HERMES_REMOTE_NODE = process.env.STICKY_PAD_HERMES_REMOTE_NODE || localConfig.config.hermes?.remoteNode || "";
const HERMES_REMOTE_HELPER = process.env.STICKY_PAD_HERMES_REMOTE_HELPER || localConfig.config.hermes?.remoteHelper || "";
const SSH_BIN = process.env.STICKY_PAD_SSH_BIN || "/usr/bin/ssh";
const TASK_ID_PATTERN = /^t_[a-zA-Z0-9]+$/;
const VALID_STATES = new Set(["queued", "started", "stalled", "completed"]);
const MAX_TASK_IDS_PER_REQUEST = 500;

function atomicWriteJSON(target, value) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.renameSync(temporary, target); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
}

function readReceipts() {
  fs.mkdirSync(RECEIPTS_ROOT, { recursive: true });
  return fs.readdirSync(RECEIPTS_ROOT, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") return [];
    const target = path.join(RECEIPTS_ROOT, entry.name);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) return [];
    try {
      const receipt = JSON.parse(readBoundedRegularUTF8(target, MAX_RECEIPT_BYTES, "delivery receipt"));
      if (receipt.version !== 1 || !TASK_ID_PATTERN.test(receipt.taskId) || typeof receipt.filename !== "string") return [];
      return [{ target, receipt }];
    } catch { return []; }
  });
}

function recordFailure(entries, message) {
  const updatedAt = new Date().toISOString();
  for (const { target, receipt } of entries) {
    atomicWriteJSON(target, {
      ...receipt,
      updatedAt,
      lastError: String(message).slice(0, 500),
      consecutiveFailures: Number(receipt.consecutiveFailures || 0) + 1
    });
  }
}

function fetchStatuses(taskIds) {
  if (taskIds.length < 1 || taskIds.length > MAX_TASK_IDS_PER_REQUEST) {
    throw new Error(`Hermes status requests must contain 1 to ${MAX_TASK_IDS_PER_REQUEST} task IDs`);
  }
  const safeRemotePath = value => typeof value === "string" && /^\/[a-zA-Z0-9._/-]+$/.test(value) && !value.split("/").includes("..");
  if (localConfig.error) throw new Error(localConfig.error);
  if (!/^[a-zA-Z0-9._-]+$/.test(HERMES_SSH_HOST) || !safeRemotePath(HERMES_REMOTE_NODE) || !safeRemotePath(HERMES_REMOTE_HELPER)) {
    throw new Error("Hermes status connection is not safely configured");
  }
  const result = spawnSync(SSH_BIN, [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
    HERMES_SSH_HOST, HERMES_REMOTE_NODE, HERMES_REMOTE_HELPER, "--status-json"
  ], {
    input: JSON.stringify({ taskIds }), encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw new Error(`Hermes status check failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `Hermes status check exited ${result.status}`).trim());
  let payload;
  try { payload = JSON.parse(result.stdout); }
  catch { throw new Error("Hermes status check returned invalid JSON"); }
  if (!Array.isArray(payload.tasks)) throw new Error("Hermes status check did not return tasks");
  const statuses = new Map();
  for (const item of payload.tasks) {
    if (!TASK_ID_PATTERN.test(item.taskId) || !VALID_STATES.has(item.displayState)) throw new Error("Hermes status check returned an invalid task state");
    statuses.set(item.taskId, item);
  }
  if (statuses.size !== new Set(taskIds).size) throw new Error("Hermes status check returned an incomplete task set");
  return statuses;
}

function syncOnce() {
  const entries = readReceipts();
  if (entries.length === 0) return { checked: 0, updated: 0 };
  const taskIds = [...new Set(entries.map(item => item.receipt.taskId))];
  const statuses = new Map();
  try {
    for (let index = 0; index < taskIds.length; index += MAX_TASK_IDS_PER_REQUEST) {
      const batch = taskIds.slice(index, index + MAX_TASK_IDS_PER_REQUEST);
      for (const [taskId, status] of fetchStatuses(batch)) statuses.set(taskId, status);
    }
  } catch (error) {
    recordFailure(entries, error.message || String(error));
    throw error;
  }
  const updatedAt = new Date().toISOString();
  for (const { target, receipt } of entries) {
    const status = statuses.get(receipt.taskId);
    atomicWriteJSON(target, {
      ...receipt,
      board: status.board || receipt.board,
      status: status.status,
      assignee: status.assignee ?? null,
      displayState: status.displayState,
      updatedAt,
      lastError: null,
      consecutiveFailures: 0
    });
  }
  return { checked: entries.length, updated: entries.length };
}

if (process.argv.length > 2 && !process.argv.includes("--once")) {
  process.stderr.write("Usage: status-sync.mjs [--once]\n");
  process.exitCode = 64;
} else {
  try { process.stdout.write(`${JSON.stringify(syncOnce())}\n`); }
  catch (error) { process.stderr.write(`${error.message || String(error)}\n`); process.exitCode = 1; }
}
