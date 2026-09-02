#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_CONFIG = process.env.STICKY_PAD_HERMES_RUNTIME_CONFIG || path.join(SCRIPT_DIR, "runtime-config.json");
const BOARD = process.env.STICKY_PAD_HERMES_BOARD || "sticky-pad-inbox";
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 100;
const MAX_ATTACHMENT_TOTAL_BYTES = 4 * 1024 * 1024;
const TASK_ID_PATTERN = /^t_[a-zA-Z0-9]+$/;
const BOARD_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

if (!BOARD_PATTERN.test(BOARD)) throw new Error("STICKY_PAD_HERMES_BOARD must be a kebab-case board slug");

function safeExecutablePath(value) {
  const candidate = String(value || "");
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(candidate) || candidate.includes("/../") || candidate.endsWith("/..")) return null;
  try {
    const status = fs.statSync(candidate);
    return status.isFile() && (status.mode & 0o111) !== 0 ? candidate : null;
  } catch {
    return null;
  }
}

function configuredHermesBinary() {
  if (process.env.HERMES_BIN) return safeExecutablePath(process.env.HERMES_BIN);
  try {
    const status = fs.lstatSync(RUNTIME_CONFIG);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error("runtime config is not a regular file");
    const config = JSON.parse(fs.readFileSync(RUNTIME_CONFIG, "utf8"));
    return safeExecutablePath(config.hermesBin);
  } catch (error) {
    if (error?.code !== "ENOENT") process.stderr.write(`Sticky Pad Hermes runtime config is invalid: ${error.message || String(error)}\n`);
  }
  return safeExecutablePath(path.join(os.homedir(), ".local", "bin", "hermes"));
}

const HERMES_BIN = configuredHermesBinary();
if (!HERMES_BIN) throw new Error("Hermes executable is missing or unsafe; rerun install-hermes-inbox.sh");

const tools = [
  {
    name: "sticky_pad_inbox_list",
    title: "List Sticky Pad Inbox tasks",
    description: "List tasks waiting in the isolated Sticky Pad Inbox. This does not claim, assign, unblock, or execute anything.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "sticky_pad_inbox_read",
    title: "Read Sticky Pad Inbox task",
    description: "Read one queued task and its Markdown attachment without changing its state.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", description: "Hermes Kanban task id, for example t_example123." } },
      required: ["taskId"], additionalProperties: false
    }
  },
  {
    name: "sticky_pad_inbox_acknowledge",
    title: "Acknowledge Sticky Pad Inbox task",
    description: "Record BUSY, READY-SEEN, or READY-MISMATCH on a queued task while leaving it blocked and unassigned. This never claims or executes the task.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        result: { type: "string", enum: ["BUSY", "READY-SEEN", "READY-MISMATCH"] },
        detail: { type: "string", maxLength: 500 }
      },
      required: ["taskId", "result"], additionalProperties: false
    }
  }
];

function validateTaskId(value) {
  const taskId = String(value || "");
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error("taskId must be a Hermes task id such as t_example123");
  return taskId;
}

function validateMarkdown(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("markdown must be a non-empty string");
  if (Buffer.byteLength(value, "utf8") > MAX_MARKDOWN_BYTES) throw new Error("markdown is larger than 1 MB");
  return value;
}

function safeFileName(value) {
  const name = String(value || "Untitled Hermes Task")
    .replace(/[/:\\?%*|\"<>]/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 100);
  return `${name || "Untitled Hermes Task"}.md`;
}

function runHermes(args) {
  const result = spawnSync(HERMES_BIN, args, { encoding: "utf8", timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw new Error(`Hermes command failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `Hermes exited ${result.status}`).trim());
  return result.stdout;
}

function parseJSONOutput(output, label) {
  try { return JSON.parse(output); }
  catch { throw new Error(`${label} returned invalid JSON`); }
}

function showTask(taskId) {
  return parseJSONOutput(runHermes(["kanban", "--board", BOARD, "show", validateTaskId(taskId), "--json"]), "Hermes Kanban show");
}

function ensureVisibilityGate(taskId) {
  let state = showTask(taskId);
  let status = state.task?.status;
  let assignee = state.task?.assignee ?? null;
  const hasCapabilityGate = Array.isArray(state.events) && state.events.some(isVisibilityGate);
  if (assignee !== null || !["blocked", "ready", "todo", "triage"].includes(status)) {
    throw new Error(`Safety gate: cannot queue task in state ${status || "unknown"} with assignee ${assignee || "none"}`);
  }
  if (status !== "blocked" || !hasCapabilityGate) {
    runHermes([
      "kanban", "--board", BOARD, "block", "--kind", "capability", taskId,
      "Sticky Pad visibility gate: inspect and acknowledge through MCP only; explicit human release is required before assignment or execution."
    ]);
    state = showTask(taskId);
    status = state.task?.status;
    assignee = state.task?.assignee ?? null;
  }
  if (status !== "blocked" || assignee !== null) throw new Error("Safety gate failed: task is not blocked and unassigned");
  return state;
}

function isVisibilityGate(event) {
  return event?.kind === "blocked" && event?.payload?.kind === "capability" &&
    String(event?.payload?.reason || "").startsWith("Sticky Pad visibility gate:");
}

function statusPayload(taskId) {
  const state = showTask(taskId);
  const task = state.task || state;
  const status = String(task.status || "unknown").toLowerCase();
  const assignee = task.assignee ?? null;
  const events = Array.isArray(state.events) ? state.events : [];
  const latestBlock = [...events].reverse().find(event => event?.kind === "blocked");
  const completed = task.completed_at != null || ["done", "completed", "archived"].includes(status);
  const started = task.started_at != null || assignee !== null || ["running", "review", "in_progress", "in-progress"].includes(status);
  let displayState = "queued";
  if (completed) displayState = "completed";
  else if (status === "blocked" && (!isVisibilityGate(latestBlock) || started)) displayState = "stalled";
  else if (started) displayState = "started";
  return {
    taskId: validateTaskId(task.id || taskId),
    board: BOARD,
    status,
    assignee,
    displayState,
    startedAt: task.started_at ?? null,
    completedAt: task.completed_at ?? null
  };
}

function attachmentDirectory(taskId) {
  return path.join(os.homedir(), ".hermes", "kanban", "boards", BOARD, "attachments", validateTaskId(taskId));
}

function markdownAttachments(taskId) {
  const root = attachmentDirectory(taskId);
  if (!fs.existsSync(root)) return [];
  const rootStatus = fs.lstatSync(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("task attachment directory is not a regular directory");
  }
  const attachments = [];
  let totalBytes = 0;
  const directory = fs.opendirSync(root);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
      if (attachments.length >= MAX_ATTACHMENT_COUNT) {
        throw new Error(`task has more than ${MAX_ATTACHMENT_COUNT} Markdown attachments`);
      }
      const target = path.join(root, entry.name);
      const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_MARKDOWN_BYTES) throw new Error(`attachment is larger than 1 MB: ${entry.name}`);
        totalBytes += stat.size;
        if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
          throw new Error("Markdown attachments exceed the 4 MB total limit");
        }
        const content = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < content.length) {
          const count = fs.readSync(descriptor, content, offset, content.length - offset, offset);
          if (count === 0) throw new Error(`attachment changed while being read: ${entry.name}`);
          offset += count;
        }
        if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) {
          throw new Error(`attachment changed or exceeded its size limit while being read: ${entry.name}`);
        }
        const markdown = content.toString("utf8");
        attachments.push({
          filename: entry.name,
          bytes: content.length,
          sha256: crypto.createHash("sha256").update(content).digest("hex"),
          markdown
        });
      } finally {
        fs.closeSync(descriptor);
      }
    }
  } finally {
    directory.closeSync();
  }
  return attachments;
}

function callTool(name, args = {}) {
  if (name === "sticky_pad_inbox_list") {
    const tasks = parseJSONOutput(
      runHermes(["kanban", "--board", BOARD, "list", "--archived", "--sort", "priority-desc", "--json"]),
      "Hermes Kanban list"
    );
    return { board: BOARD, tasks };
  }
  if (name === "sticky_pad_inbox_read") {
    const taskId = validateTaskId(args.taskId);
    return { board: BOARD, task: showTask(taskId), attachments: markdownAttachments(taskId) };
  }
  if (name === "sticky_pad_inbox_acknowledge") {
    const taskId = validateTaskId(args.taskId);
    const allowed = new Set(["BUSY", "READY-SEEN", "READY-MISMATCH"]);
    if (!allowed.has(args.result)) throw new Error("result must be BUSY, READY-SEEN, or READY-MISMATCH");
    const before = showTask(taskId);
    const assignee = before.assignee ?? before.task?.assignee ?? null;
    const status = before.status ?? before.task?.status;
    if (status !== "blocked" || assignee !== null) throw new Error("Safety gate: acknowledgements require the task to remain blocked and unassigned");
    const detail = typeof args.detail === "string" ? args.detail.trim().slice(0, 500) : "";
    const text = `[Sticky Pad visibility] ${args.result}${detail ? ` — ${detail}` : ""}`;
    runHermes(["kanban", "--board", BOARD, "comment", "--author", "Commander", taskId, text]);
    const after = showTask(taskId);
    const afterAssignee = after.assignee ?? after.task?.assignee ?? null;
    const afterStatus = after.status ?? after.task?.status;
    if (afterStatus !== "blocked" || afterAssignee !== null) throw new Error("Safety gate failed: acknowledgement changed task dispatch state");
    return { board: BOARD, taskId, result: args.result, status: afterStatus, assignee: afterAssignee, message: "Visibility acknowledgement recorded; task remains blocked and unassigned." };
  }
  throw new Error(`unknown tool: ${name}`);
}

function queuePayload(payload) {
  const title = String(payload.title || "Untitled Hermes Task").trim().slice(0, 100) || "Untitled Hermes Task";
  const markdown = validateMarkdown(payload.markdown);
  const filename = safeFileName(title);
  const sha256 = crypto.createHash("sha256").update(markdown, "utf8").digest("hex");
  const priorityMap = { critical: 100, high: 80, medium: 60, low: 40, backlog: 20 };
  const importance = String(payload.importance || "medium").toLowerCase();
  if (!(importance in priorityMap)) throw new Error("importance must be critical, high, medium, low, or backlog");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-pad-hermes-"));
  const temporaryFile = path.join(temporaryRoot, filename);
  try {
    fs.writeFileSync(temporaryFile, markdown, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const created = parseJSONOutput(runHermes([
      "kanban", "--board", BOARD, "create", title,
      "--body", `Queued quietly from Sticky Pad. Visibility and acknowledgement only until explicitly released. Source SHA-256: ${sha256}`,
      "--priority", String(priorityMap[importance]),
      "--idempotency-key", `sticky-pad:${sha256}`,
      "--created-by", "Sticky Pad MCP",
      "--initial-status", "blocked",
      "--json"
    ]), "Hermes Kanban create");
    const taskId = validateTaskId(created.id || created.task?.id);
    let task = ensureVisibilityGate(taskId);
    const existing = markdownAttachments(taskId).find(item => item.filename === filename && item.sha256 === sha256);
    if (!existing) runHermes(["kanban", "--board", BOARD, "attach", taskId, temporaryFile, "--content-type", "text/markdown", "--name", filename, "--author", "Sticky Pad MCP"]);
    task = ensureVisibilityGate(taskId);
    const persisted = markdownAttachments(taskId).find(item => item.filename === filename && item.sha256 === sha256);
    if (!persisted) throw new Error("Hermes attachment verification failed: the saved Markdown filename or SHA-256 did not match");
    const status = task.task?.status;
    const assignee = task.task?.assignee ?? null;
    return { board: BOARD, taskId, filename: persisted.filename, sha256: persisted.sha256, importance, status, assignee, duplicate: Boolean(existing) };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function response(id, result) { return { jsonrpc: "2.0", id, result }; }
function errorResponse(id, error) { return { jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message: error.message || String(error) } }; }

function handle(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") return response(id, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "sticky-pad-hermes-inbox", version: "1.0.0" },
    instructions: "Use these tools to inspect and acknowledge Sticky Pad Inbox tasks. Never claim, assign, unblock, dispatch, or execute a task through this MCP. Acknowledge only after reading the attachment, and preserve blocked/unassigned state."
  });
  if (method === "ping") return response(id, {});
  if (method === "tools/list") return response(id, { tools });
  if (method === "tools/call") {
    try {
      const result = callTool(params.name, params.arguments || {});
      return response(id, { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
    } catch (error) {
      return response(id, { content: [{ type: "text", text: error.message || String(error) }], isError: true });
    }
  }
  if (method?.startsWith("notifications/")) return null;
  return errorResponse(id, new Error(`method not found: ${method}`));
}

if (process.argv.includes("--queue-json")) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    input += chunk;
    if (input.length > MAX_MARKDOWN_BYTES * 2) process.stdin.destroy(new Error("queue payload is too large"));
  });
  process.stdin.on("end", () => {
    try { process.stdout.write(`${JSON.stringify(queuePayload(JSON.parse(input)))}\n`); }
    catch (error) { process.stderr.write(`${error.message || String(error)}\n`); process.exitCode = 1; }
  });
} else if (process.argv.includes("--status-json")) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    input += chunk;
    if (input.length > 128 * 1024) process.stdin.destroy(new Error("status payload is too large"));
  });
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(input);
      const taskIds = Array.isArray(payload.taskIds) ? payload.taskIds : [payload.taskId];
      if (taskIds.length < 1 || taskIds.length > 500) throw new Error("taskIds must contain 1 to 500 ids");
      process.stdout.write(`${JSON.stringify({ board: BOARD, tasks: taskIds.map(statusPayload) })}\n`);
    } catch (error) { process.stderr.write(`${error.message || String(error)}\n`); process.exitCode = 1; }
  });
} else {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", line => {
    if (!line.trim()) return;
    try {
      const result = handle(JSON.parse(line));
      if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify(errorResponse(null, error))}\n`);
    }
  });
}
