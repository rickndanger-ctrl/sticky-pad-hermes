#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import http from "node:http";

const ROOT = process.env.STICKY_PAD_PROJECTS_DIR || path.join(os.homedir(), "Documents", "Sticky Pad", "Projects");
const MAX_MARKDOWN_BYTES = 1024 * 1024;
fs.mkdirSync(ROOT, { recursive: true });

const tools = [
  {
    name: "sticky_pad_create_task",
    title: "Create Sticky Pad task",
    description: "Deposit a complete Markdown task into Richard's Sticky Pad project library. Use after project planning is finished.",
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
  }
];

function safeName(value) {
  const name = String(value ?? "").replace(/[/:\\?%*|\"<>]/g, "-").replace(/^\.+|\.+$/g, "").trim().slice(0, 100);
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
  return target;
}

function atomicWrite(target, markdown, exclusive = false) {
  assertMarkdown(markdown);
  const temporary = path.join(ROOT, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, markdown, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    if (exclusive && fs.existsSync(target)) throw new Error(`task already exists: ${path.basename(target)}`);
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function callTool(name, args = {}) {
  if (name === "sticky_pad_create_task") {
    let stem = safeName(args.title);
    let filename = `${stem}.md`;
    let counter = 2;
    while (fs.existsSync(path.join(ROOT, filename))) filename = `${stem}-${counter++}.md`;
    atomicWrite(path.join(ROOT, filename), args.markdown, true);
    return { filename, message: `Created ${filename}. It is now available in Sticky Pad Projects.` };
  }
  if (name === "sticky_pad_list_projects") {
    const files = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === ".md")
      .map(entry => ({ filename: entry.name, modifiedAt: fs.statSync(path.join(ROOT, entry.name)).mtime.toISOString() }))
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return { projects: files };
  }
  if (name === "sticky_pad_read_task") {
    const target = resolveExisting(args.filename);
    return { filename: path.basename(target), markdown: fs.readFileSync(target, "utf8") };
  }
  if (name === "sticky_pad_update_task") {
    const target = resolveExisting(args.filename);
    atomicWrite(target, args.markdown);
    const filename = path.basename(target);
    return { filename, message: `Updated ${filename}.` };
  }
  throw new Error(`unknown tool: ${name}`);
}

function response(id, result) { return { jsonrpc: "2.0", id, result }; }
function errorResponse(id, error) { return { jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message: error.message || String(error) } }; }

function handle(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") return response(id, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "sticky-pad", version: "1.1.0" },
    instructions: "Richard supplies the blank project-loop form as Hermes-Task-Template.txt. Fill that text form only after project planning is complete, then use sticky_pad_create_task to submit the completed result as a Markdown task. Include the goal, task details, phased Build-Test-Review loops, required tools, verification evidence, and explicit finished criteria. Read before updating an existing task."
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
  http.createServer((request, reply) => {
    if (request.url !== "/mcp" || request.method !== "POST") {
      reply.writeHead(404).end("POST JSON-RPC to /mcp"); return;
    }
    let body = "";
    request.on("data", chunk => {
      body += chunk;
      if (body.length > MAX_MARKDOWN_BYTES * 2) request.destroy();
    });
    request.on("end", () => {
      try {
        const result = handle(JSON.parse(body));
        reply.writeHead(result ? 200 : 202, { "content-type": "application/json" });
        reply.end(result ? JSON.stringify(result) : "");
      } catch (error) {
        reply.writeHead(400, { "content-type": "application/json" });
        reply.end(JSON.stringify(errorResponse(null, error)));
      }
    });
  }).listen(port, "127.0.0.1", () => process.stderr.write(`Sticky Pad MCP listening on http://127.0.0.1:${port}/mcp\n`));
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
