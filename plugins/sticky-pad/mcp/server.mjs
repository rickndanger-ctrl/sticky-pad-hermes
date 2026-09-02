#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import http from "node:http";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const ROOT = process.env.STICKY_PAD_PROJECTS_DIR || path.join(os.homedir(), "Documents", "Sticky Pad", "Projects");
const OPEN_REQUESTS_ROOT = process.env.STICKY_PAD_OPEN_REQUESTS_DIR || path.join(ROOT, "..", "Open Requests");
const RECEIPTS_ROOT = process.env.STICKY_PAD_DELIVERY_RECEIPTS_DIR || path.join(ROOT, "..", "Delivery Receipts");
const CONFIG_FILE = process.env.STICKY_PAD_CONFIG_FILE || path.join(os.homedir(), "Library", "Application Support", "Sticky Pad", "MCP", "config.json");
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

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
    const config = JSON.parse(readBoundedRegularUTF8(CONFIG_FILE, MAX_METADATA_BYTES, "config"));
    if (config.version !== 1 || (config.hermes !== undefined && (typeof config.hermes !== "object" || config.hermes === null))) {
      throw new Error("config must use version 1 and an optional hermes object");
    }
    return { config, error: null };
  } catch (error) {
    return { config: {}, error: `Sticky Pad config is invalid: ${error.message || String(error)}` };
  }
}

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(OPEN_REQUESTS_ROOT, { recursive: true });
fs.mkdirSync(RECEIPTS_ROOT, { recursive: true });

const tools = [
  {
    name: "sticky_pad_create_task",
    title: "Create Sticky Pad task",
    description: "Deposit a complete Markdown task into the user's Sticky Pad project library. Use after project planning is finished.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short project title used for the Markdown filename." },
        markdown: { type: "string", description: "The fully filled Hermes task Markdown, including goal, phases, tools, tests, review gates, and finished criteria." }
      },
      required: ["title", "markdown"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: { filename: { type: "string" }, message: { type: "string" } },
      required: ["filename", "message"],
      additionalProperties: false
    }
  },
  {
    name: "sticky_pad_create_and_open_task",
    title: "Create and open Sticky Pad task",
    description: "Create a complete Markdown task and immediately request that the native Sticky Pad app display it as a desktop note. Use after project planning is finished when the user wants the note visible.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short project title used for the Markdown filename." },
        markdown: { type: "string", description: "The fully filled Hermes task Markdown, including goal, phases, tools, tests, review gates, and finished criteria." }
      },
      required: ["title", "markdown"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {
        filename: { type: "string" },
        openRequested: { type: "boolean" },
        message: { type: "string" }
      },
      required: ["filename", "openRequested", "message"],
      additionalProperties: false
    }
  },
  {
    name: "sticky_pad_list_projects",
    title: "List Sticky Pad projects",
    description: "List all Markdown tasks currently in Sticky Pad.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        projects: {
          type: "array",
          items: {
            type: "object",
            properties: { filename: { type: "string" }, modifiedAt: { type: "string" } },
            required: ["filename", "modifiedAt"],
            additionalProperties: false
          }
        }
      },
      required: ["projects"],
      additionalProperties: false
    }
  },
  {
    name: "sticky_pad_read_task",
    title: "Read Sticky Pad task",
    description: "Read one Sticky Pad Markdown task by filename.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { filename: { type: "string" } },
      required: ["filename"], additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: { filename: { type: "string" }, markdown: { type: "string" } },
      required: ["filename", "markdown"],
      additionalProperties: false
    }
  },
  {
    name: "sticky_pad_open_task",
    title: "Open Sticky Pad task",
    description: "Request that the native Sticky Pad app display an existing Markdown task on the desktop.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { filename: { type: "string" } },
      required: ["filename"], additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: { filename: { type: "string" }, openRequested: { type: "boolean" }, message: { type: "string" } },
      required: ["filename", "openRequested", "message"],
      additionalProperties: false
    }
  },
  {
    name: "sticky_pad_update_task",
    title: "Update Sticky Pad task",
    description: "Replace an existing Sticky Pad Markdown task after revising its plan.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { filename: { type: "string" }, markdown: { type: "string" } },
      required: ["filename", "markdown"], additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: { filename: { type: "string" }, message: { type: "string" } },
      required: ["filename", "message"],
      additionalProperties: false
    }
  },
  {
    name: "sticky_pad_queue_for_hermes",
    title: "Queue Sticky Pad task for Hermes",
    description: "Queue an existing Markdown task in the isolated Hermes Inbox. The task remains blocked and unassigned; this does not wake, assign, claim, or execute it.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Existing Sticky Pad Markdown filename." },
        importance: { type: "string", enum: ["critical", "high", "medium", "low", "backlog"] }
      },
      required: ["filename", "importance"], additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {
        board: { type: "string" }, taskId: { type: "string" }, filename: { type: "string" },
        sha256: { type: "string" }, importance: { type: "string" }, status: { type: "string" },
        assignee: { type: ["string", "null"] }, duplicate: { type: "boolean" }, message: { type: "string" }
      },
      required: ["board", "taskId", "filename", "sha256", "importance", "status", "assignee", "duplicate", "message"],
      additionalProperties: false
    }
  }
];

function safeName(value) {
  const cleaned = String(value ?? "")
    .replace(/[/:\\?%*|\"<>\u0000-\u001f\u007f]/g, "-")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
  const name = cleaned.slice(0, 100).replace(/\.+$/g, "").trim();
  return name || "Untitled Hermes Task";
}

function assertMarkdown(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) throw new Error("markdown must be a non-empty string");
  if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) throw new Error("markdown is larger than 1 MB");
}

function resolveExisting(filename) {
  const base = path.basename(String(filename ?? ""));
  if (!base || base !== filename || path.extname(base).toLowerCase() !== ".md") throw new Error("filename must be one Markdown filename, with no path");
  const target = path.join(ROOT, base);
  if (!fs.existsSync(target)) throw new Error(`task not found: ${base}`);
  const status = fs.lstatSync(target);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`task is not a regular Markdown file: ${base}`);
  if (status.size > MAX_MARKDOWN_BYTES) throw new Error(`task is larger than 1 MB: ${base}`);
  return target;
}

function readExistingMarkdown(target) {
  const base = path.basename(target);
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch {
    throw new Error(`task could not be opened safely: ${base}`);
  }
  try {
    const status = fs.fstatSync(descriptor);
    if (!status.isFile()) throw new Error(`task is not a regular Markdown file: ${base}`);
    if (status.size > MAX_MARKDOWN_BYTES) throw new Error(`task is larger than 1 MB: ${base}`);
    const content = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < content.length) {
      const count = fs.readSync(descriptor, content, offset, content.length - offset, offset);
      if (count === 0) throw new Error(`task changed while being read: ${base}`);
      offset += count;
    }
    if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) {
      throw new Error(`task changed or exceeded its size limit while being read: ${base}`);
    }
    return content.toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicWrite(target, markdown, exclusive = false) {
  assertMarkdown(markdown);
  const temporary = path.join(ROOT, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, markdown, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    if (exclusive) {
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, target);
    }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function receiptFileName(filename) {
  return `${Buffer.from(filename, "utf8").toString("base64url")}.json`;
}

function atomicWriteJSON(target, value) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.renameSync(temporary, target); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
}

function writeQueuedReceipt(filename, queued) {
  const now = new Date().toISOString();
  const target = path.join(RECEIPTS_ROOT, receiptFileName(filename));
  let queuedAt = now;
  if (fs.existsSync(target)) {
    try {
      const existing = JSON.parse(readBoundedRegularUTF8(target, MAX_METADATA_BYTES, "delivery receipt"));
      if (existing.taskId === queued.taskId && existing.sha256 === queued.sha256) queuedAt = existing.queuedAt || now;
    } catch {}
  }
  atomicWriteJSON(target, {
    version: 1,
    filename,
    taskId: queued.taskId,
    board: queued.board,
    sha256: queued.sha256,
    importance: queued.importance,
    status: queued.status,
    assignee: queued.assignee,
    displayState: "queued",
    queuedAt,
    updatedAt: now,
    lastError: null,
    consecutiveFailures: 0
  });
}

function invalidateQueuedReceipt(filename) {
  const target = path.join(RECEIPTS_ROOT, receiptFileName(filename));
  if (!fs.existsSync(target)) return { invalidated: false, warning: "" };
  try {
    const status = fs.lstatSync(target);
    if (!status.isFile() && !status.isSymbolicLink()) throw new Error("delivery receipt is not a file");
    fs.unlinkSync(target);
    return { invalidated: true, warning: "" };
  } catch (error) {
    return { invalidated: false, warning: ` Previous Hermes delivery status could not be removed and will be ignored because the source changed: ${error.message || String(error)}` };
  }
}

function createTask(args) {
  const stem = safeName(args.title);
  for (let counter = 1; counter <= 10000; counter += 1) {
    const filename = counter === 1 ? `${stem}.md` : `${stem}-${counter}.md`;
    try {
      atomicWrite(path.join(ROOT, filename), args.markdown, true);
      return filename;
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`Could not allocate a unique Sticky Pad filename for ${stem}`);
}

function queueOpenRequest(filename) {
  const requestName = `${Date.now()}-${randomUUID()}.request`;
  const target = path.join(OPEN_REQUESTS_ROOT, requestName);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${filename}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, target);
}

function wakeStickyPad() {
  if (process.env.STICKY_PAD_DISABLE_APP_LAUNCH === "1" || process.platform !== "darwin") return false;
  const result = spawnSync("/usr/bin/open", ["-b", "com.richardholguin.StickyPad"], {
    stdio: "ignore",
    timeout: 5000
  });
  return !result.error && result.status === 0;
}

function queueForHermes(filename, importance) {
  const target = resolveExisting(filename);
  const allowedImportance = new Set(["critical", "high", "medium", "low", "backlog"]);
  if (!allowedImportance.has(importance)) throw new Error("importance must be critical, high, medium, low, or backlog");
  const safeRemotePath = value => typeof value === "string" && /^\/[a-zA-Z0-9._/-]+$/.test(value) && !value.split("/").includes("..");
  const localConfig = readLocalConfig();
  const hermesSSHHost = process.env.STICKY_PAD_HERMES_SSH_HOST || localConfig.config.hermes?.sshHost || "";
  const hermesRemoteNode = process.env.STICKY_PAD_HERMES_REMOTE_NODE || localConfig.config.hermes?.remoteNode || "";
  const hermesRemoteHelper = process.env.STICKY_PAD_HERMES_REMOTE_HELPER || localConfig.config.hermes?.remoteHelper || "";
  const sshBin = process.env.STICKY_PAD_SSH_BIN || "/usr/bin/ssh";
  if (localConfig.error) throw new Error(localConfig.error);
  if (!/^[a-zA-Z0-9._-]+$/.test(hermesSSHHost) || !safeRemotePath(hermesRemoteNode) || !safeRemotePath(hermesRemoteHelper)) {
    throw new Error("Hermes Inbox delivery is not configured. Set STICKY_PAD_HERMES_SSH_HOST, STICKY_PAD_HERMES_REMOTE_NODE, and STICKY_PAD_HERMES_REMOTE_HELPER.");
  }
  const markdown = readExistingMarkdown(target);
  assertMarkdown(markdown);
  const payload = {
    title: path.basename(target, path.extname(target)),
    markdown,
    importance
  };
  const result = spawnSync(sshBin, [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
    hermesSSHHost, hermesRemoteNode, hermesRemoteHelper, "--queue-json"
  ], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 30000, maxBuffer: MAX_MARKDOWN_BYTES * 3
  });
  if (result.error) throw new Error(`Hermes Inbox delivery failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `Hermes Inbox delivery exited ${result.status}`).trim());
  let queued;
  try { queued = JSON.parse(result.stdout); }
  catch { throw new Error("Hermes Inbox delivery returned invalid JSON"); }
  const localHash = crypto.createHash("sha256").update(markdown, "utf8").digest("hex");
  if (queued.sha256 !== localHash || queued.status !== "blocked" || queued.assignee !== null) {
    throw new Error("Hermes Inbox safety verification failed: hash/state did not match blocked and unassigned delivery");
  }
  writeQueuedReceipt(path.basename(target), queued);
  return {
    ...queued,
    message: `${queued.duplicate ? "Already queued" : "Queued"} ${path.basename(target)} as ${queued.taskId}; it remains blocked and unassigned.`
  };
}

function callTool(name, args = {}) {
  if (name === "sticky_pad_create_task") {
    const filename = createTask(args);
    return { filename, message: `Created ${filename}. It is now available in Sticky Pad Projects.` };
  }
  if (name === "sticky_pad_create_and_open_task") {
    const filename = createTask(args);
    try {
      queueOpenRequest(filename);
      const appLaunchRequested = wakeStickyPad();
      const launchDetail = appLaunchRequested ? " The native app was launched or awakened." : " The request will be consumed when the native app is running.";
      return { filename, openRequested: true, message: `Created ${filename} and requested that Sticky Pad open it on the desktop.${launchDetail}` };
    } catch (error) {
      return { filename, openRequested: false, message: `Created ${filename}, but could not request that the app open it: ${error.message || String(error)}` };
    }
  }
  if (name === "sticky_pad_list_projects") {
    const files = fs.readdirSync(ROOT, { withFileTypes: true })
      .flatMap(entry => {
        if (!entry.isFile() || entry.name.startsWith(".") || path.extname(entry.name).toLowerCase() !== ".md") return [];
        try {
          const status = fs.lstatSync(path.join(ROOT, entry.name));
          if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_MARKDOWN_BYTES) return [];
          return [{ filename: entry.name, modifiedAt: status.mtime.toISOString() }];
        } catch { return []; }
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return { projects: files };
  }
  if (name === "sticky_pad_read_task") {
    const target = resolveExisting(args.filename);
    return { filename: path.basename(target), markdown: readExistingMarkdown(target) };
  }
  if (name === "sticky_pad_open_task") {
    const target = resolveExisting(args.filename);
    const filename = path.basename(target);
    queueOpenRequest(filename);
    const appLaunchRequested = wakeStickyPad();
    const launchDetail = appLaunchRequested ? " The native app was launched or awakened." : " The request will be consumed when the native app is running.";
    return { filename, openRequested: true, message: `Requested that Sticky Pad open ${filename} on the desktop.${launchDetail}` };
  }
  if (name === "sticky_pad_update_task") {
    const target = resolveExisting(args.filename);
    atomicWrite(target, args.markdown);
    const filename = path.basename(target);
    const receipt = invalidateQueuedReceipt(filename);
    const statusDetail = receipt.invalidated ? " Its previous Hermes delivery status was invalidated; requeue the revised task when ready." : "";
    return { filename, message: `Updated ${filename}.${statusDetail}${receipt.warning}` };
  }
  if (name === "sticky_pad_queue_for_hermes") return queueForHermes(args.filename, args.importance);
  throw new Error(`unknown tool: ${name}`);
}

function response(id, result) { return { jsonrpc: "2.0", id, result }; }
function errorResponse(id, error) { return { jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message: error.message || String(error) } }; }

function bearerMatches(authorization, expectedTokenDigest) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const suppliedDigest = crypto.createHash("sha256").update(authorization.slice(7), "utf8").digest();
  return crypto.timingSafeEqual(suppliedDigest, expectedTokenDigest);
}

function isJSONContentType(contentType) {
  return typeof contentType === "string" && contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function handle(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") return response(id, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "sticky-pad", version: "1.3.0" },
    instructions: "The user supplies the blank project-loop form as Hermes-Task-Template.txt. Fill that text form only after project planning is complete. When the user wants the note visible, use sticky_pad_create_and_open_task. Queue an existing note with sticky_pad_queue_for_hermes only when the user asks; queueing leaves it blocked and unassigned and never wakes or executes Commander. Include the goal, phased Build-Test-Review loops, tools, evidence, and finished criteria."
  });
  if (method === "ping") return response(id, {});
  if (method === "tools/list") return response(id, { tools });
  if (method === "tools/call") {
    try {
      const result = callTool(params.name, params.arguments || {});
      const text = typeof result.message === "string" ? result.message : JSON.stringify(result, null, 2);
      return response(id, { structuredContent: result, content: [{ type: "text", text }], isError: false });
    } catch (error) {
      return response(id, { content: [{ type: "text", text: error.message || String(error) }], isError: true });
    }
  }
  if (method?.startsWith("notifications/")) return null;
  return errorResponse(id, new Error(`method not found: ${method}`));
}

if (process.argv[2] === "--http") {
  const port = Number(process.argv[3] || 7331);
  const httpToken = process.env.STICKY_PAD_HTTP_TOKEN || "";
  if (httpToken.length < 32) {
    process.stderr.write("STICKY_PAD_HTTP_TOKEN must be set to at least 32 characters when --http is used.\n");
    process.exitCode = 1;
  } else {
    const expectedTokenDigest = crypto.createHash("sha256").update(httpToken, "utf8").digest();
    const server = http.createServer((request, reply) => {
      if (Object.hasOwn(request.headers, "origin")) {
        reply.writeHead(403).end("Browser-origin requests are forbidden"); return;
      }
      if (request.url !== "/mcp" || request.method !== "POST") {
        reply.writeHead(404).end("POST JSON-RPC to /mcp"); return;
      }
      if (!isJSONContentType(request.headers["content-type"])) {
        reply.writeHead(415).end("Content-Type must be application/json"); return;
      }
      if (!bearerMatches(request.headers.authorization, expectedTokenDigest)) {
        reply.writeHead(401, { "www-authenticate": "Bearer" }).end("Unauthorized"); return;
      }
      let body = "";
      let bodyBytes = 0;
      let rejected = false;
      request.setEncoding("utf8");
      request.on("data", chunk => {
        if (rejected) return;
        bodyBytes += Buffer.byteLength(chunk, "utf8");
        if (bodyBytes > MAX_MARKDOWN_BYTES * 2) {
          rejected = true;
          reply.writeHead(413).end("Request body is too large");
          request.destroy();
          return;
        }
        body += chunk;
      });
      request.on("end", () => {
        if (rejected) return;
        try {
          const result = handle(JSON.parse(body));
          reply.writeHead(result ? 200 : 202, { "content-type": "application/json" });
          reply.end(result ? JSON.stringify(result) : "");
        } catch (error) {
          reply.writeHead(400, { "content-type": "application/json" });
          reply.end(JSON.stringify(errorResponse(null, error)));
        }
      });
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const listeningPort = typeof address === "object" && address ? address.port : port;
      process.stderr.write(`Sticky Pad MCP listening on http://127.0.0.1:${listeningPort}/mcp\n`);
    });
  }
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
