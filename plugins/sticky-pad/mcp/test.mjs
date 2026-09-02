import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-pad-mcp-"));
const projectsRoot = path.join(root, "Projects");
const openRequestsRoot = path.join(root, "Open Requests");
const receiptsRoot = path.join(root, "Delivery Receipts");
const configFile = path.join(root, "config.json");
const fakeSSH = path.join(root, "fake-ssh.mjs");
fs.writeFileSync(fakeSSH, `#!/usr/bin/env node
import crypto from "node:crypto";
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => body += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(body);
  const sha256 = crypto.createHash("sha256").update(payload.markdown, "utf8").digest("hex");
  process.stdout.write(JSON.stringify({ board: "sticky-pad-inbox", taskId: "t_test1234", filename: payload.title + ".md", sha256, importance: payload.importance, status: "blocked", assignee: null, duplicate: false }));
});
`);
fs.chmodSync(fakeSSH, 0o700);
const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    STICKY_PAD_PROJECTS_DIR: projectsRoot,
    STICKY_PAD_OPEN_REQUESTS_DIR: openRequestsRoot,
    STICKY_PAD_DISABLE_APP_LAUNCH: "1",
    STICKY_PAD_CONFIG_FILE: configFile,
    STICKY_PAD_SSH_BIN: fakeSSH
  },
  stdio: ["pipe", "pipe", "inherit"]
});
let buffer = "";
const pending = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (line) pending.shift()?.(JSON.parse(line));
  }
});
function rpc(message) { return new Promise(resolve => { pending.push(resolve); child.stdin.write(`${JSON.stringify(message)}\n`); }); }

function createThroughIndependentServer(projectsDirectory, index) {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        STICKY_PAD_PROJECTS_DIR: projectsDirectory,
        STICKY_PAD_DISABLE_APP_LAUNCH: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      worker.kill();
      reject(new Error(`Concurrent create ${index} timed out: ${stderr}`));
    }, 5000);
    worker.stdout.setEncoding("utf8");
    worker.stderr.setEncoding("utf8");
    worker.stderr.on("data", chunk => stderr += chunk);
    worker.stdout.on("data", chunk => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      worker.kill();
      try { resolve(JSON.parse(stdout.slice(0, newline))); }
      catch (error) { reject(error); }
    });
    worker.once("exit", status => {
      if (stdout.includes("\n")) return;
      clearTimeout(timer);
      reject(new Error(`Concurrent create ${index} exited ${status}: ${stderr}`));
    });
    worker.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0", id: index, method: "tools/call",
      params: { name: "sticky_pad_create_task", arguments: { title: "Same", markdown: `# Concurrent ${index}` } }
    })}\n`);
  });
}

function waitForHTTPPort(server) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`HTTP server did not start: ${stderr}`)), 5000);
    const onData = chunk => {
      stderr += chunk;
      const match = stderr.match(/127\.0\.0\.1:(\d+)\/mcp/);
      if (!match) return;
      clearTimeout(timer);
      server.stderr.off("data", onData);
      resolve(Number(match[1]));
    };
    server.stderr.setEncoding("utf8");
    server.stderr.on("data", onData);
    server.once("exit", status => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited ${status}: ${stderr}`));
    });
  });
}

function postHTTPRPC(port, headers) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 101, method: "initialize", params: {} });
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: { ...headers, "content-length": Buffer.byteLength(body) }
    }, reply => {
      let responseBody = "";
      reply.setEncoding("utf8");
      reply.on("data", chunk => responseBody += chunk);
      reply.on("end", () => resolve({ status: reply.statusCode, body: responseBody }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

let httpChild;
try {
  const initialized = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(initialized.result.serverInfo.name, "sticky-pad");
  assert.equal(initialized.result.serverInfo.version, "1.3.0");
  assert.match(initialized.result.instructions, /Build-Test-Review/);
  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(listed.result.tools.length, 7);
  assert.equal(listed.result.tools.every(tool => tool.title && tool.outputSchema), true);
  const created = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sticky_pad_create_task", arguments: { title: "Daily / Build", markdown: "# Daily Build\n\n## Goal\nShip." } } });
  assert.equal(created.result.isError, false);
  assert.equal(created.result.structuredContent.filename, "Daily - Build.md");
  assert.equal(fs.readdirSync(projectsRoot)[0], "Daily - Build.md");
  const duplicate = await rpc({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "sticky_pad_create_task", arguments: { title: "Daily / Build", markdown: "# Second Daily Build" } } });
  assert.equal(duplicate.result.isError, false);
  assert.deepEqual(fs.readdirSync(projectsRoot).sort(), ["Daily - Build-2.md", "Daily - Build.md"]);
  const visibleName = await rpc({ jsonrpc: "2.0", id: 311, method: "tools/call", params: { name: "sticky_pad_create_task", arguments: { title: " .Visible", markdown: "# Visible filename" } } });
  assert.equal(visibleName.result.isError, false);
  assert.equal(visibleName.result.structuredContent.filename, "Visible.md");
  assert.equal(fs.readdirSync(projectsRoot).some(filename => filename.startsWith(".")), false);
  const concurrentRoot = path.join(root, "Concurrent Projects");
  const concurrentResults = await Promise.all(Array.from({ length: 16 }, (_, index) => createThroughIndependentServer(concurrentRoot, index + 1)));
  assert.equal(concurrentResults.every(result => result.result?.isError === false), true);
  const concurrentFiles = fs.readdirSync(concurrentRoot).filter(filename => filename.endsWith(".md"));
  assert.equal(concurrentFiles.length, 16);
  assert.equal(new Set(concurrentResults.map(result => result.result.structuredContent.filename)).size, 16);
  assert.equal(new Set(concurrentFiles.map(filename => fs.readFileSync(path.join(concurrentRoot, filename), "utf8"))).size, 16);
  const opened = await rpc({ jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "sticky_pad_create_and_open_task", arguments: { title: "Visible Task", markdown: "# Visible Task\n\nOpen me." } } });
  assert.equal(opened.result.isError, false);
  assert.equal(opened.result.structuredContent.openRequested, true);
  assert.equal(opened.result.structuredContent.filename, "Visible Task.md");
  const requestFiles = fs.readdirSync(openRequestsRoot);
  assert.equal(requestFiles.length, 1);
  assert.equal(fs.readFileSync(path.join(openRequestsRoot, requestFiles[0]), "utf8"), "Visible Task.md\n");
  const reopen = await rpc({ jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "sticky_pad_open_task", arguments: { filename: "Daily - Build.md" } } });
  assert.equal(reopen.result.isError, false);
  assert.equal(reopen.result.structuredContent.openRequested, true);
  const allRequests = fs.readdirSync(openRequestsRoot);
  assert.equal(allRequests.length, 2);
  assert.equal(allRequests.some(file => fs.readFileSync(path.join(openRequestsRoot, file), "utf8") === "Daily - Build.md\n"), true);
  const read = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "sticky_pad_read_task", arguments: { filename: "Daily - Build.md" } } });
  assert.match(read.result.structuredContent.markdown, /# Daily Build/);
  const unconfiguredQueue = await rpc({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "sticky_pad_queue_for_hermes", arguments: { filename: "Daily - Build.md", importance: "high" } } });
  assert.equal(unconfiguredQueue.result.isError, true);
  assert.match(unconfiguredQueue.result.content[0].text, /not configured/);
  fs.writeFileSync(configFile, JSON.stringify({
    version: 1,
    hermes: { sshHost: "test-host", remoteNode: "/test/node", remoteHelper: "/test/helper.mjs" }
  }));
  const queued = await rpc({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "sticky_pad_queue_for_hermes", arguments: { filename: "Daily - Build.md", importance: "high" } } });
  assert.equal(queued.result.isError, false);
  assert.equal(queued.result.structuredContent.status, "blocked");
  assert.equal(queued.result.structuredContent.assignee, null);
  assert.equal(queued.result.structuredContent.taskId, "t_test1234");
  assert.match(queued.result.structuredContent.message, /remains blocked and unassigned/);
  const receiptFiles = fs.readdirSync(receiptsRoot);
  assert.deepEqual(receiptFiles, [`${Buffer.from("Daily - Build.md").toString("base64url")}.json`]);
  const receipt = JSON.parse(fs.readFileSync(path.join(receiptsRoot, receiptFiles[0]), "utf8"));
  assert.equal(receipt.filename, "Daily - Build.md");
  assert.equal(receipt.taskId, "t_test1234");
  assert.equal(receipt.displayState, "queued");
  assert.equal(receipt.consecutiveFailures, 0);
  const receiptPath = path.join(receiptsRoot, receiptFiles[0]);
  const preservedQueuedAt = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, queuedAt: preservedQueuedAt }));
  const repeatedQueue = await rpc({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "sticky_pad_queue_for_hermes", arguments: { filename: "Daily - Build.md", importance: "high" } } });
  assert.equal(repeatedQueue.result.isError, false);
  assert.equal(JSON.parse(fs.readFileSync(receiptPath, "utf8")).queuedAt, preservedQueuedAt);
  fs.writeFileSync(path.join(projectsRoot, "Daily - Build.md"), "# Revised before requeue");
  const changedQueue = await rpc({ jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "sticky_pad_queue_for_hermes", arguments: { filename: "Daily - Build.md", importance: "high" } } });
  assert.equal(changedQueue.result.isError, false);
  const changedReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.notEqual(changedReceipt.sha256, receipt.sha256);
  assert.notEqual(changedReceipt.queuedAt, preservedQueuedAt);
  const updated = await rpc({ jsonrpc: "2.0", id: 44, method: "tools/call", params: { name: "sticky_pad_update_task", arguments: { filename: "Daily - Build.md", markdown: "# Updated through MCP" } } });
  assert.equal(updated.result.isError, false);
  assert.match(updated.result.structuredContent.message, /delivery status was invalidated/);
  assert.equal(fs.existsSync(receiptPath), false);
  assert.equal(fs.readFileSync(path.join(projectsRoot, "Daily - Build.md"), "utf8"), "# Updated through MCP");
  const traversal = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "sticky_pad_read_task", arguments: { filename: "../secret.md" } } });
  assert.equal(traversal.result.isError, true);
  const outside = path.join(root, `sticky-pad-secret-${process.pid}.md`);
  fs.writeFileSync(outside, "secret");
  fs.symlinkSync(outside, path.join(projectsRoot, "linked.md"));
  const linked = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "sticky_pad_read_task", arguments: { filename: "linked.md" } } });
  assert.equal(linked.result.isError, true);
  fs.rmSync(outside, { force: true });
  const oversizedPath = path.join(projectsRoot, "Oversized.md");
  fs.writeFileSync(oversizedPath, Buffer.alloc(1024 * 1024 + 1, 0x61));
  const oversized = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "sticky_pad_read_task", arguments: { filename: "Oversized.md" } } });
  assert.equal(oversized.result.isError, true);
  assert.match(oversized.result.content[0].text, /larger than 1 MB/);
  const boundedList = await rpc({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "sticky_pad_list_projects", arguments: {} } });
  assert.equal(boundedList.result.isError, false);
  assert.equal(boundedList.result.structuredContent.projects.some(project => project.filename === "Oversized.md"), false);

  const shortToken = spawnSync(process.execPath, [serverPath, "--http", "0"], {
    env: { ...process.env, STICKY_PAD_PROJECTS_DIR: projectsRoot, STICKY_PAD_HTTP_TOKEN: "x".repeat(31) },
    encoding: "utf8",
    timeout: 5000
  });
  assert.notEqual(shortToken.status, 0);
  assert.match(shortToken.stderr, /at least 32 characters/);

  const httpToken = "test-only-sticky-pad-http-token-32";
  httpChild = spawn(process.execPath, [serverPath, "--http", "0"], {
    env: { ...process.env, STICKY_PAD_PROJECTS_DIR: projectsRoot, STICKY_PAD_HTTP_TOKEN: httpToken },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const httpPort = await waitForHTTPPort(httpChild);
  const missingAuthorization = await postHTTPRPC(httpPort, { "content-type": "application/json" });
  assert.equal(missingAuthorization.status, 401);
  const wrongAuthorization = await postHTTPRPC(httpPort, { "content-type": "application/json", authorization: "Bearer wrong-token" });
  assert.equal(wrongAuthorization.status, 401);
  const browserOrigin = await postHTTPRPC(httpPort, { "content-type": "application/json", authorization: `Bearer ${httpToken}`, origin: "https://example.test" });
  assert.equal(browserOrigin.status, 403);
  const wrongContentType = await postHTTPRPC(httpPort, { "content-type": "text/plain", authorization: `Bearer ${httpToken}` });
  assert.equal(wrongContentType.status, 415);
  const authenticated = await postHTTPRPC(httpPort, { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${httpToken}` });
  assert.equal(authenticated.status, 200);
  assert.equal(JSON.parse(authenticated.body).result.serverInfo.name, "sticky-pad");
  console.log("Sticky Pad MCP tests passed");
} finally {
  child.kill();
  httpChild?.kill();
  fs.rmSync(root, { recursive: true, force: true });
}
