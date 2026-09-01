import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-pad-mcp-"));
const child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], {
  env: { ...process.env, STICKY_PAD_PROJECTS_DIR: root }, stdio: ["pipe", "pipe", "inherit"]
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

try {
  const initialized = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(initialized.result.serverInfo.name, "sticky-pad");
  assert.equal(initialized.result.serverInfo.version, "1.1.0");
  assert.match(initialized.result.instructions, /Build-Test-Review/);
  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(listed.result.tools.length, 4);
  assert.equal(listed.result.tools.every(tool => tool.title && tool.outputSchema), true);
  const created = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sticky_pad_create_task", arguments: { title: "Daily / Build", markdown: "# Daily Build\n\n## Goal\nShip." } } });
  assert.equal(created.result.isError, false);
  assert.equal(created.result.structuredContent.filename, "Daily - Build.md");
  assert.equal(fs.readdirSync(root)[0], "Daily - Build.md");
  const duplicate = await rpc({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "sticky_pad_create_task", arguments: { title: "Daily / Build", markdown: "# Second Daily Build" } } });
  assert.equal(duplicate.result.isError, false);
  assert.deepEqual(fs.readdirSync(root).sort(), ["Daily - Build-2.md", "Daily - Build.md"]);
  const read = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "sticky_pad_read_task", arguments: { filename: "Daily - Build.md" } } });
  assert.match(read.result.structuredContent.markdown, /# Daily Build/);
  const traversal = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "sticky_pad_read_task", arguments: { filename: "../secret.md" } } });
  assert.equal(traversal.result.isError, true);
  const outside = path.join(root, "..", `sticky-pad-secret-${process.pid}.md`);
  fs.writeFileSync(outside, "secret");
  fs.symlinkSync(outside, path.join(root, "linked.md"));
  const linked = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "sticky_pad_read_task", arguments: { filename: "linked.md" } } });
  assert.equal(linked.result.isError, true);
  fs.rmSync(outside, { force: true });
  console.log("Sticky Pad MCP tests passed");
} finally {
  child.kill();
  fs.rmSync(root, { recursive: true, force: true });
}
