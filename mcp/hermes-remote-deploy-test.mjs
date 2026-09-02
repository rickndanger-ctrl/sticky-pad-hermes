#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const deployerSource = path.join(scriptDir, "hermes-remote-deploy.mjs");
const requiredFiles = [
  "hermes-inbox-server.mjs",
  "reconcile-hermes-registration.mjs",
  "install-commander-policy.mjs",
  "COMMANDER-INSTRUCTIONS.md",
  "hermes-remote-deploy.mjs"
];
const nodeBin = process.execPath;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-pad-hermes-deploy-"));
const fakeHermes = path.join(temporaryRoot, "hermes");

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
  const registration = JSON.parse(values[1]);
  const failOncePath = process.env.FAKE_HERMES_FAIL_RESTORE_ONCE_FILE;
  if (failOncePath && registration.command === "/old/node" && !fs.existsSync(failOncePath)) {
    fs.writeFileSync(failOncePath, "failed once\\n");
    process.stderr.write("synthetic one-shot registration restore failure\\n");
    process.exit(1);
  }
  state["sticky-pad-inbox"] = registration;
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
  state[args[0]] = { command: "/stale/node", args: ["/stale/helper"], enabled: false };
  save();
  event("mcp-add:" + args[0]);
} else if (group === "mcp" && action === "test") {
  event("mcp-test:" + args[0]);
  if (process.env.FAKE_HERMES_FAIL_TEST === "1") {
    process.stderr.write("Connection failed: synthetic deploy test failure\\n");
  } else {
    process.stdout.write("Connected (5ms)\\nTools discovered: 3\\n");
  }
} else {
  process.stderr.write("unsupported fake Hermes command\\n");
  process.exit(2);
}
`, { mode: 0o700 });

const staleRegistration = {
  command: "/old/node",
  args: ["/old/helper.mjs"],
  enabled: true,
  tools: { include: ["old_tool"] }
};
const similarRegistration = { command: "/keep/me", args: ["/keep/me.mjs"], enabled: true };

function makeCase(name, { oldDeployment = true, oldRegistration = true, policy = false } = {}) {
  const caseRoot = path.join(temporaryRoot, name);
  const hermesHome = path.join(caseRoot, ".hermes");
  const root = path.join(hermesHome, "sticky-pad-mcp");
  const staging = path.join(hermesHome, `.sticky-pad-mcp-stage-${name}`);
  const transaction = path.join(hermesHome, `.sticky-pad-mcp-transaction-${name}`);
  const statePath = path.join(caseRoot, "state.json");
  const eventsPath = path.join(caseRoot, "events.txt");
  fs.mkdirSync(hermesHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(staging, { mode: 0o700 });
  for (const filename of requiredFiles) fs.copyFileSync(path.join(scriptDir, filename), path.join(staging, filename));
  if (oldDeployment) {
    fs.mkdirSync(root, { mode: 0o700 });
    fs.writeFileSync(path.join(root, "old-helper.txt"), `old deployment for ${name}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(root, "runtime-config.json"), '{"version":1,"hermesBin":"/old/hermes"}\n', { mode: 0o600 });
  }
  if (policy) fs.writeFileSync(path.join(hermesHome, "SOUL.md"), `original soul for ${name}\n`, { mode: 0o640 });
  fs.writeFileSync(statePath, JSON.stringify({
    ...(oldRegistration ? { "sticky-pad-inbox": staleRegistration } : {}),
    "sticky-pad-inbox-old": similarRegistration
  }));
  fs.writeFileSync(eventsPath, "");
  return { name, caseRoot, hermesHome, root, staging, transaction, statePath, eventsPath, policy };
}

function environment(testCase, { failTest = false, failRestoreOnce = false } = {}) {
  return {
    ...process.env,
    FAKE_HERMES_STATE: testCase.statePath,
    FAKE_HERMES_EVENTS: testCase.eventsPath,
    FAKE_HERMES_FAIL_TEST: failTest ? "1" : "0",
    FAKE_HERMES_FAIL_RESTORE_ONCE_FILE: failRestoreOnce ? path.join(testCase.caseRoot, "restore-failed-once") : ""
  };
}

function runDeployer(script, testCase, mode, { failTest = false, failRestoreOnce = false } = {}) {
  const args = [
    script,
    `--${mode}`,
    "--root", testCase.root,
    "--transaction", testCase.transaction,
    "--hermes-bin", fakeHermes
  ];
  if (mode === "prepare") {
    args.push("--staging", testCase.staging, "--node-bin", nodeBin);
    if (testCase.policy) args.push("--install-policy");
  }
  return spawnSync(nodeBin, args, { encoding: "utf8", env: environment(testCase, { failTest, failRestoreOnce }) });
}

function readState(testCase) {
  return JSON.parse(fs.readFileSync(testCase.statePath, "utf8"));
}

function assertOldDeployment(testCase) {
  assert.equal(fs.readFileSync(path.join(testCase.root, "old-helper.txt"), "utf8"), `old deployment for ${testCase.name}\n`);
  assert.equal(fs.readFileSync(path.join(testCase.root, "runtime-config.json"), "utf8"), '{"version":1,"hermesBin":"/old/hermes"}\n');
  assert.equal(fs.existsSync(path.join(testCase.root, "hermes-inbox-server.mjs")), false);
}

function assertOldRegistration(testCase) {
  const state = readState(testCase);
  assert.deepEqual(state["sticky-pad-inbox"], staleRegistration);
  assert.deepEqual(state["sticky-pad-inbox-old"], similarRegistration);
}

const success = makeCase("success");
let result = runDeployer(deployerSource, success, "prepare");
assert.equal(result.status, 0, result.stderr);
assert.equal(fs.existsSync(path.join(success.root, "old-helper.txt")), false);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(success.root, "runtime-config.json"), "utf8")), {
  version: 1,
  hermesBin: fakeHermes
});
assert.deepEqual(readState(success)["sticky-pad-inbox"], {
  command: nodeBin,
  args: [path.join(success.root, "hermes-inbox-server.mjs")],
  enabled: true
});
assert.deepEqual(readState(success)["sticky-pad-inbox-old"], similarRegistration);
assert.equal(fs.existsSync(path.join(success.transaction, "previous-deployment", "old-helper.txt")), true);

const transactionDeployer = path.join(success.transaction, "deployer.mjs");
result = runDeployer(transactionDeployer, success, "commit");
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(fs.readFileSync(path.join(success.transaction, "transaction.json"), "utf8")).state, "committed");
result = runDeployer(transactionDeployer, success, "cleanup");
assert.equal(result.status, 0, result.stderr);
assert.equal(fs.existsSync(success.transaction), false);
assert.equal(fs.existsSync(success.root), true);

const rollback = makeCase("rollback", { policy: true });
const originalSoul = fs.readFileSync(path.join(rollback.hermesHome, "SOUL.md"), "utf8");
result = runDeployer(deployerSource, rollback, "prepare");
assert.equal(result.status, 0, result.stderr);
assert.match(fs.readFileSync(path.join(rollback.hermesHome, "SOUL.md"), "utf8"), /sticky-pad-quiet-pull:v1/);
result = runDeployer(path.join(rollback.transaction, "deployer.mjs"), rollback, "rollback");
assert.equal(result.status, 0, result.stderr);
assertOldDeployment(rollback);
assertOldRegistration(rollback);
assert.equal(fs.readFileSync(path.join(rollback.hermesHome, "SOUL.md"), "utf8"), originalSoul);
assert.equal(fs.statSync(path.join(rollback.hermesHome, "SOUL.md")).mode & 0o777, 0o640);
assert.equal(fs.existsSync(rollback.transaction), false);
assert.equal(fs.existsSync(rollback.staging), false);

const failedReplacement = makeCase("failed-replacement");
result = runDeployer(deployerSource, failedReplacement, "prepare", { failTest: true });
assert.equal(result.status, 1);
assert.match(result.stderr, /restored the previous remote deployment after failure/i);
assertOldDeployment(failedReplacement);
assertOldRegistration(failedReplacement);
assert.equal(fs.existsSync(failedReplacement.transaction), false);
assert.equal(fs.existsSync(failedReplacement.staging), false);

const failedFirstInstall = makeCase("failed-first-install", { oldDeployment: false, oldRegistration: false });
result = runDeployer(deployerSource, failedFirstInstall, "prepare");
assert.equal(result.status, 0, result.stderr);
assert.equal(fs.existsSync(failedFirstInstall.root), true);
result = runDeployer(path.join(failedFirstInstall.transaction, "deployer.mjs"), failedFirstInstall, "rollback");
assert.equal(result.status, 0, result.stderr);
assert.equal(fs.existsSync(failedFirstInstall.root), false);
assert.equal("sticky-pad-inbox" in readState(failedFirstInstall), false);
assert.deepEqual(readState(failedFirstInstall)["sticky-pad-inbox-old"], similarRegistration);
assert.equal(fs.existsSync(failedFirstInstall.transaction), false);

const retryRollback = makeCase("retry-rollback");
result = runDeployer(deployerSource, retryRollback, "prepare");
assert.equal(result.status, 0, result.stderr);
const retryDeployer = path.join(retryRollback.transaction, "deployer.mjs");
result = runDeployer(retryDeployer, retryRollback, "rollback", { failRestoreOnce: true });
assert.equal(result.status, 1);
assert.match(result.stderr, /one-shot registration restore failure/i);
assertOldDeployment(retryRollback);
assert.equal(fs.existsSync(retryRollback.transaction), true);
assert.deepEqual(readState(retryRollback)["sticky-pad-inbox"], {
  command: nodeBin,
  args: [path.join(retryRollback.root, "hermes-inbox-server.mjs")],
  enabled: true
});
result = runDeployer(retryDeployer, retryRollback, "rollback", { failRestoreOnce: true });
assert.equal(result.status, 0, result.stderr);
assertOldDeployment(retryRollback);
assertOldRegistration(retryRollback);
assert.equal(fs.existsSync(retryRollback.transaction), false);

const concurrentRegistration = makeCase("concurrent-registration");
result = runDeployer(deployerSource, concurrentRegistration, "prepare");
assert.equal(result.status, 0, result.stderr);
const adminRegistration = { command: "/admin/node", args: ["/admin/helper.mjs"], enabled: true };
const concurrentState = readState(concurrentRegistration);
concurrentState["sticky-pad-inbox"] = adminRegistration;
fs.writeFileSync(concurrentRegistration.statePath, JSON.stringify(concurrentState));
const concurrentDeployer = path.join(concurrentRegistration.transaction, "deployer.mjs");
result = runDeployer(concurrentDeployer, concurrentRegistration, "rollback");
assert.equal(result.status, 1);
assert.match(result.stderr, /Refusing to overwrite a concurrent change to the exact sticky-pad-inbox registration/i);
assert.deepEqual(readState(concurrentRegistration)["sticky-pad-inbox"], adminRegistration);
assert.equal(fs.existsSync(path.join(concurrentRegistration.root, "hermes-inbox-server.mjs")), true);
const expectedRegistration = JSON.parse(fs.readFileSync(path.join(concurrentRegistration.transaction, "transaction.json"), "utf8")).expectedRegistration;
const resetState = readState(concurrentRegistration);
resetState["sticky-pad-inbox"] = expectedRegistration;
fs.writeFileSync(concurrentRegistration.statePath, JSON.stringify(resetState));
result = runDeployer(concurrentDeployer, concurrentRegistration, "rollback");
assert.equal(result.status, 0, result.stderr);

const concurrentDeployment = makeCase("concurrent-deployment");
result = runDeployer(deployerSource, concurrentDeployment, "prepare");
assert.equal(result.status, 0, result.stderr);
const deployedHelper = path.join(concurrentDeployment.root, "hermes-inbox-server.mjs");
fs.appendFileSync(deployedHelper, "// admin change\n");
const concurrentDeploymentDeployer = path.join(concurrentDeployment.transaction, "deployer.mjs");
result = runDeployer(concurrentDeploymentDeployer, concurrentDeployment, "rollback");
assert.equal(result.status, 1);
assert.match(result.stderr, /Refusing to overwrite a concurrent change to the Sticky Pad remote deployment/i);
assert.match(fs.readFileSync(deployedHelper, "utf8"), /admin change/);
fs.copyFileSync(path.join(scriptDir, "hermes-inbox-server.mjs"), deployedHelper);
fs.chmodSync(deployedHelper, 0o700);
result = runDeployer(concurrentDeploymentDeployer, concurrentDeployment, "rollback");
assert.equal(result.status, 0, result.stderr);

const concurrentPolicy = makeCase("concurrent-policy", { policy: true });
result = runDeployer(deployerSource, concurrentPolicy, "prepare");
assert.equal(result.status, 0, result.stderr);
const concurrentSoulPath = path.join(concurrentPolicy.hermesHome, "SOUL.md");
const concurrentPolicyDeployer = path.join(concurrentPolicy.transaction, "deployer.mjs");
fs.chmodSync(concurrentSoulPath, 0o644);
result = runDeployer(concurrentPolicyDeployer, concurrentPolicy, "rollback");
assert.equal(result.status, 1);
assert.match(result.stderr, /Refusing to overwrite a concurrent change to .*SOUL\.md/i);
assert.equal(fs.statSync(concurrentSoulPath).mode & 0o777, 0o644);
fs.chmodSync(concurrentSoulPath, 0o600);
fs.writeFileSync(path.join(concurrentPolicy.hermesHome, "SOUL.md"), "admin changed soul\n", { mode: 0o600 });
result = runDeployer(concurrentPolicyDeployer, concurrentPolicy, "rollback");
assert.equal(result.status, 1);
assert.match(result.stderr, /Refusing to overwrite a concurrent change to .*SOUL\.md/i);
assert.equal(fs.readFileSync(path.join(concurrentPolicy.hermesHome, "SOUL.md"), "utf8"), "admin changed soul\n");
assert.equal(fs.existsSync(path.join(concurrentPolicy.root, "hermes-inbox-server.mjs")), true);
fs.copyFileSync(
  path.join(concurrentPolicy.transaction, "installed-SOUL.md"),
  path.join(concurrentPolicy.hermesHome, "SOUL.md")
);
result = runDeployer(concurrentPolicyDeployer, concurrentPolicy, "rollback");
assert.equal(result.status, 0, result.stderr);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
process.stdout.write("Hermes remote deployment transaction tests passed.\n");
