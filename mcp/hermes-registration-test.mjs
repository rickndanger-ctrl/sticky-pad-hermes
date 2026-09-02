#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const reconciler = path.join(scriptDir, "reconcile-hermes-registration.mjs");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-pad-hermes-registration-"));
const fakeHermes = path.join(temporaryRoot, "hermes");
const fakeHelper = path.join(temporaryRoot, "hermes-inbox-server.mjs");
const nodeBin = process.execPath;

fs.writeFileSync(fakeHelper, "// test helper\n", { mode: 0o700 });
fs.writeFileSync(fakeHermes, `#!/usr/bin/env node
import fs from "node:fs";

const statePath = process.env.FAKE_HERMES_STATE;
const eventsPath = process.env.FAKE_HERMES_EVENTS;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const [group, action, ...args] = process.argv.slice(2);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const event = value => fs.appendFileSync(eventsPath, value + "\\n");
const missing = () => { process.stderr.write("Config key not set: mcp_servers.sticky-pad-inbox\\n"); process.exit(1); };

if (group === "config" && action === "get") {
  if (!("sticky-pad-inbox" in state)) missing();
  process.stdout.write(JSON.stringify(state["sticky-pad-inbox"]) + "\\n");
} else if (group === "config" && action === "set") {
  const values = args.filter(value => value !== "--force");
  state["sticky-pad-inbox"] = JSON.parse(values[1]);
  save();
  event("config-set");
} else if (group === "config" && action === "unset") {
  if (!("sticky-pad-inbox" in state)) missing();
  delete state["sticky-pad-inbox"];
  save();
  event("config-unset");
} else if (group === "mcp" && action === "remove") {
  delete state[args[0]];
  save();
  event("mcp-remove:" + args[0]);
} else if (group === "mcp" && action === "add") {
  const name = args[0];
  state[name] = { command: "/stale/node", args: ["/stale/helper"], enabled: false, tools: { include: ["old"] } };
  save();
  event("mcp-add:" + name);
} else if (group === "mcp" && action === "test") {
  event("mcp-test:" + args[0]);
  if (process.env.FAKE_HERMES_FAIL_TEST === "1") {
    process.stderr.write("Connection failed: synthetic test failure\\n");
  } else {
    process.stdout.write("Connected (5ms)\\nTools discovered: 3\\n");
  }
} else {
  process.stderr.write("unsupported fake Hermes command\\n");
  process.exit(2);
}
`, { mode: 0o700 });

function runCase(name, initialState, { failTest = false } = {}) {
  const statePath = path.join(temporaryRoot, `${name}-state.json`);
  const eventsPath = path.join(temporaryRoot, `${name}-events.txt`);
  fs.writeFileSync(statePath, JSON.stringify(initialState));
  fs.writeFileSync(eventsPath, "");
  const result = spawnSync(nodeBin, [
    reconciler,
    "--hermes-bin", fakeHermes,
    "--node-bin", nodeBin,
    "--helper", fakeHelper
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_HERMES_STATE: statePath,
      FAKE_HERMES_EVENTS: eventsPath,
      FAKE_HERMES_FAIL_TEST: failTest ? "1" : "0"
    }
  });
  return {
    result,
    state: JSON.parse(fs.readFileSync(statePath, "utf8")),
    events: fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean)
  };
}

const expected = { command: nodeBin, args: [fakeHelper], enabled: true };
const nearMatch = { command: "/keep/me", args: ["/keep/me.mjs"], enabled: true };

const firstInstall = runCase("first-install", { "sticky-pad-inbox-old": nearMatch });
assert.equal(firstInstall.result.status, 0, firstInstall.result.stderr);
assert.deepEqual(firstInstall.state["sticky-pad-inbox"], expected);
assert.deepEqual(firstInstall.state["sticky-pad-inbox-old"], nearMatch);
assert.deepEqual(firstInstall.events.filter(value => value.startsWith("mcp-")), [
  "mcp-add:sticky-pad-inbox",
  "mcp-test:sticky-pad-inbox"
]);

const stale = { command: "/old/node", args: ["/old/helper.mjs"], enabled: true, tools: { include: ["old_tool"] } };
const replacement = runCase("replacement", { "sticky-pad-inbox": stale, "sticky-pad-inbox-old": nearMatch });
assert.equal(replacement.result.status, 0, replacement.result.stderr);
assert.deepEqual(replacement.state["sticky-pad-inbox"], expected);
assert.deepEqual(replacement.state["sticky-pad-inbox-old"], nearMatch);
assert.deepEqual(replacement.events.filter(value => value.startsWith("mcp-")), [
  "mcp-remove:sticky-pad-inbox",
  "mcp-add:sticky-pad-inbox",
  "mcp-test:sticky-pad-inbox"
]);

const rollback = runCase("rollback", { "sticky-pad-inbox": stale, "sticky-pad-inbox-old": nearMatch }, { failTest: true });
assert.equal(rollback.result.status, 1);
assert.match(rollback.result.stderr, /restored the previous sticky-pad-inbox registration/i);
assert.deepEqual(rollback.state["sticky-pad-inbox"], stale);
assert.deepEqual(rollback.state["sticky-pad-inbox-old"], nearMatch);

const failedFirstInstall = runCase("failed-first-install", { "sticky-pad-inbox-old": nearMatch }, { failTest: true });
assert.equal(failedFirstInstall.result.status, 1);
assert.equal("sticky-pad-inbox" in failedFirstInstall.state, false);
assert.deepEqual(failedFirstInstall.state["sticky-pad-inbox-old"], nearMatch);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
process.stdout.write("Hermes registration reconciliation tests passed.\n");
