import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-pad-hermes-helper-"));
const fakeHermes = path.join(root, "fake-hermes.mjs");
fs.writeFileSync(fakeHermes, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("create")) {
  process.stdout.write(JSON.stringify({ id: process.env.FAKE_CREATED_TASK_ID || "t_created" }));
  process.exit(0);
}
if (args.includes("block")) {
  if (process.env.FAKE_HERMES_STATE) fs.writeFileSync(process.env.FAKE_HERMES_STATE, "visibility-gate-added\\n");
  if (process.env.FAKE_HERMES_EVENTS) fs.appendFileSync(process.env.FAKE_HERMES_EVENTS, "block\\n");
  process.stdout.write(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args.includes("attach")) {
  if (process.env.FAKE_HERMES_EVENTS) fs.appendFileSync(process.env.FAKE_HERMES_EVENTS, "attach\\n");
  const attachIndex = args.indexOf("attach");
  const taskId = args[attachIndex + 1];
  const source = args[attachIndex + 2];
  const name = args[args.indexOf("--name") + 1];
  const destination = process.env.HOME + "/.hermes/kanban/boards/sticky-pad-inbox/attachments/" + taskId + "/" + name;
  fs.mkdirSync(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
  if (process.env.FAKE_ATTACH_MODE === "corrupt") fs.writeFileSync(destination, "# Corrupted attachment\\n");
  else if (process.env.FAKE_ATTACH_MODE !== "noop") fs.copyFileSync(source, destination);
  process.stdout.write(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args.includes("comment")) {
  if (process.env.FAKE_HERMES_EVENTS) fs.appendFileSync(process.env.FAKE_HERMES_EVENTS, "comment\\n");
  process.stdout.write(JSON.stringify({ ok: true }));
  process.exit(0);
}
const taskId = process.argv.find(item => /^t_/.test(item));
const base = { id: taskId, title: taskId, assignee: null, status: "blocked", started_at: null, completed_at: null };
let task = base;
let events = [{ kind: "blocked", payload: { kind: "capability", reason: "Sticky Pad visibility gate: test" } }];
if (taskId === "t_othercap" && !(process.env.FAKE_HERMES_STATE && fs.existsSync(process.env.FAKE_HERMES_STATE))) {
  events = [{ kind: "blocked", payload: { kind: "capability", reason: "Unrelated capability is unavailable" } }];
}
if (taskId === "t_started") task = { ...base, status: "running", assignee: "Commander", started_at: 123 };
if (taskId === "t_assigned") task = { ...base, status: "running", assignee: "Commander", started_at: 123 };
if (taskId === "t_stalled") { task = { ...base, status: "blocked", assignee: "Commander", started_at: 123 }; events = [{ kind: "blocked", payload: { kind: "dependency", reason: "Waiting" } }]; }
if (taskId === "t_complete") task = { ...base, status: "done", assignee: "Commander", started_at: 123, completed_at: 456 };
process.stdout.write(JSON.stringify({ task, events, runs: [] }));
`);
fs.chmodSync(fakeHermes, 0o700);

function mcpCall(helper, env, taskId) {
  const result = spawnSync(process.execPath, [helper], {
    env,
    input: `${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "sticky_pad_inbox_read", arguments: { taskId } }
    })}\n`,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  const helper = fileURLToPath(new URL("./hermes-inbox-server.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [helper, "--status-json"], {
    env: { ...process.env, HERMES_BIN: fakeHermes },
    input: JSON.stringify({ taskIds: ["t_queued", "t_started", "t_stalled", "t_complete"] }),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.tasks.map(item => item.displayState), ["queued", "started", "stalled", "completed"]);

  const runtimeConfig = path.join(root, "runtime-config.json");
  fs.writeFileSync(runtimeConfig, `${JSON.stringify({ version: 1, hermesBin: fakeHermes })}\n`, { mode: 0o600 });
  const configEnv = { ...process.env, STICKY_PAD_HERMES_RUNTIME_CONFIG: runtimeConfig };
  delete configEnv.HERMES_BIN;
  const configuredResult = spawnSync(process.execPath, [helper, "--status-json"], {
    env: configEnv,
    input: JSON.stringify({ taskIds: ["t_queued"] }),
    encoding: "utf8"
  });
  assert.equal(configuredResult.status, 0, configuredResult.stderr);
  assert.equal(JSON.parse(configuredResult.stdout).tasks[0].displayState, "queued");

  const gateState = path.join(root, "visibility-gate-state.txt");
  const gatedQueue = spawnSync(process.execPath, [helper, "--queue-json"], {
    env: {
      ...process.env,
      HOME: root,
      HERMES_BIN: fakeHermes,
      FAKE_CREATED_TASK_ID: "t_othercap",
      FAKE_HERMES_STATE: gateState
    },
    input: JSON.stringify({ title: "Other capability", markdown: "# Other capability\n", importance: "medium" }),
    encoding: "utf8"
  });
  assert.equal(gatedQueue.status, 0, gatedQueue.stderr);
  assert.equal(JSON.parse(gatedQueue.stdout).taskId, "t_othercap");
  assert.equal(fs.readFileSync(gateState, "utf8"), "visibility-gate-added\n");

  const unsafeEvents = path.join(root, "unsafe-mutations.txt");
  const assignedQueue = spawnSync(process.execPath, [helper, "--queue-json"], {
    env: {
      ...process.env,
      HOME: root,
      HERMES_BIN: fakeHermes,
      FAKE_CREATED_TASK_ID: "t_assigned",
      FAKE_HERMES_EVENTS: unsafeEvents
    },
    input: JSON.stringify({ title: "Assigned duplicate", markdown: "# Assigned duplicate\n", importance: "high" }),
    encoding: "utf8"
  });
  assert.notEqual(assignedQueue.status, 0);
  assert.match(assignedQueue.stderr, /Safety gate/);
  assert.equal(fs.existsSync(unsafeEvents), false);

  for (const mode of ["noop", "corrupt"]) {
    const lostQueue = spawnSync(process.execPath, [helper, "--queue-json"], {
      env: {
        ...process.env,
        HOME: root,
        HERMES_BIN: fakeHermes,
        FAKE_CREATED_TASK_ID: `t_${mode}`,
        FAKE_ATTACH_MODE: mode
      },
      input: JSON.stringify({ title: `Lost ${mode}`, markdown: `# Lost ${mode}\n`, importance: "medium" }),
      encoding: "utf8"
    });
    assert.notEqual(lostQueue.status, 0);
    assert.match(lostQueue.stderr, /attachment verification failed/);
  }

  const attachmentRoot = path.join(root, ".hermes", "kanban", "boards", "sticky-pad-inbox", "attachments");
  const safeDirectory = path.join(attachmentRoot, "t_safe");
  fs.mkdirSync(safeDirectory, { recursive: true });
  fs.writeFileSync(path.join(safeDirectory, "Task.md"), "# Safe\n");
  const inboxEnv = { ...process.env, HOME: root, HERMES_BIN: fakeHermes };
  const safeRead = mcpCall(helper, inboxEnv, "t_safe");
  assert.equal(safeRead.result.isError, false);
  assert.equal(safeRead.result.structuredContent.attachments[0].markdown, "# Safe\n");

  const oversizedDirectory = path.join(attachmentRoot, "t_oversized");
  fs.mkdirSync(oversizedDirectory, { recursive: true });
  fs.writeFileSync(path.join(oversizedDirectory, "Too-Large.md"), Buffer.alloc(1024 * 1024 + 1, 120));
  const oversizedRead = mcpCall(helper, inboxEnv, "t_oversized");
  assert.equal(oversizedRead.result.isError, true);
  assert.match(oversizedRead.result.content[0].text, /larger than 1 MB/);

  const crowdedDirectory = path.join(attachmentRoot, "t_crowded");
  fs.mkdirSync(crowdedDirectory, { recursive: true });
  for (let index = 0; index <= 100; index += 1) {
    fs.writeFileSync(path.join(crowdedDirectory, `Task-${String(index).padStart(3, "0")}.md`), "# Task\n");
  }
  const crowdedRead = mcpCall(helper, inboxEnv, "t_crowded");
  assert.equal(crowdedRead.result.isError, true);
  assert.match(crowdedRead.result.content[0].text, /more than 100/);

  const outsideDirectory = path.join(root, "outside-attachments");
  fs.mkdirSync(outsideDirectory);
  fs.writeFileSync(path.join(outsideDirectory, "Private.md"), "# Must not be read\n");
  fs.symlinkSync(outsideDirectory, path.join(attachmentRoot, "t_linked"));
  const linkedRead = mcpCall(helper, inboxEnv, "t_linked");
  assert.equal(linkedRead.result.isError, true);
  assert.match(linkedRead.result.content[0].text, /not a regular directory/);
  console.log("Sticky Pad Hermes inbox helper tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
