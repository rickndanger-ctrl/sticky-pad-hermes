#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(scriptDir, "install-hermes-inbox.sh");
const statusSyncSource = path.join(scriptDir, "status-sync.mjs");
const nodeBin = process.execPath;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-pad-hermes-installer-"));
const fakeSSH = path.join(temporaryRoot, "ssh");
const fakeSCP = path.join(temporaryRoot, "scp");
const fakeHermes = path.join(temporaryRoot, "hermes");

fs.writeFileSync(fakeSSH, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const hostIndex = args.indexOf("test-host");
if (hostIndex < 0) process.exit(64);
const command = args.slice(hostIndex + 1);
if (command.length === 1 && command[0].startsWith("printf %s")) {
  process.stdout.write(process.env.FAKE_REMOTE_HOME);
  process.exit(0);
}
if (command.length === 1 && command[0].startsWith("command -v node")) {
  process.stdout.write(process.env.FAKE_REMOTE_NODE);
  process.exit(0);
}
if (command.length === 1 && command[0].startsWith("command -v hermes")) {
  process.stdout.write(process.env.FAKE_REMOTE_HERMES);
  process.exit(0);
}
if (command.length === 0) process.exit(64);
const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", env: process.env });
if (result.error) {
  process.stderr.write(result.error.message + "\\n");
  process.exit(1);
}
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`, { mode: 0o700 });

fs.writeFileSync(fakeSCP, `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const source = args.at(-2);
const destination = args.at(-1);
const separator = (destination || "").indexOf(":");
const target = separator >= 0 ? destination.slice(separator + 1) : "";
if (!source || !target.startsWith("/")) process.exit(64);
fs.copyFileSync(source, target);
`, { mode: 0o700 });

fs.writeFileSync(fakeHermes, `#!/usr/bin/env node
import fs from "node:fs";

const statePath = process.env.FAKE_HERMES_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const [group, action, ...args] = process.argv.slice(2);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const missing = () => { process.stderr.write("Config key not set: mcp_servers.sticky-pad-inbox\\n"); process.exit(1); };

if (group === "config" && action === "get") {
  if (!("sticky-pad-inbox" in state)) missing();
  process.stdout.write(JSON.stringify(state["sticky-pad-inbox"]) + "\\n");
} else if (group === "config" && action === "set") {
  const values = args.filter(value => value !== "--force");
  state["sticky-pad-inbox"] = JSON.parse(values[1]);
  save();
} else if (group === "config" && action === "unset") {
  if (!("sticky-pad-inbox" in state)) missing();
  delete state["sticky-pad-inbox"];
  save();
} else if (group === "mcp" && action === "remove") {
  delete state[args[0]];
  save();
} else if (group === "mcp" && action === "add") {
  state[args[0]] = { command: "/stale/node", args: ["/stale/helper"], enabled: false };
  save();
} else if (group === "mcp" && action === "test") {
  process.stdout.write("Connected (4ms)\\nTools discovered: 3\\n");
  if (process.env.FAKE_HERMES_MUTATE_AFTER_TEST === "1") {
    state["sticky-pad-inbox"] = { command: "/admin/node", args: ["/admin/helper.mjs"], enabled: true };
    save();
  }
} else {
  process.stderr.write("unsupported fake Hermes command\\n");
  process.exit(2);
}
`, { mode: 0o700 });

const staleRegistration = { command: "/old/node", args: ["/old/helper.mjs"], enabled: true, tools: { include: ["old"] } };
const similarRegistration = { command: "/keep/me", args: ["/keep/me.mjs"], enabled: true };

function makeCase(name, configText) {
  const caseRoot = path.join(temporaryRoot, name);
  const localHome = path.join(caseRoot, "local-home");
  const remoteHome = path.join(caseRoot, "remote-home");
  const remoteRoot = path.join(remoteHome, ".hermes", "sticky-pad-mcp");
  const localInstall = path.join(localHome, "Library", "Application Support", "Sticky Pad", "MCP");
  const statePath = path.join(caseRoot, "state.json");
  fs.mkdirSync(remoteRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(localInstall, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(remoteRoot, "old-helper.txt"), `old remote ${name}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(remoteRoot, "runtime-config.json"), '{"version":1,"hermesBin":"/old/hermes"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(localInstall, "status-sync.mjs"), `old local status ${name}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(localInstall, "config.json"), configText, { mode: 0o600 });
  fs.writeFileSync(statePath, JSON.stringify({
    "sticky-pad-inbox": staleRegistration,
    "sticky-pad-inbox-old": similarRegistration
  }));
  return { name, caseRoot, localHome, remoteHome, remoteRoot, localInstall, statePath, configText };
}

function runInstaller(testCase, { mutateAfterTest = false } = {}) {
  return spawnSync("/bin/zsh", [installer, "--host", "test-host"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: testCase.localHome,
      STICKY_PAD_INSTALL_SSH_BIN: fakeSSH,
      STICKY_PAD_INSTALL_SCP_BIN: fakeSCP,
      STICKY_PAD_NODE_BIN: nodeBin,
      FAKE_REMOTE_HOME: testCase.remoteHome,
      FAKE_REMOTE_NODE: nodeBin,
      FAKE_REMOTE_HERMES: fakeHermes,
      FAKE_HERMES_STATE: testCase.statePath,
      FAKE_HERMES_MUTATE_AFTER_TEST: mutateAfterTest ? "1" : "0"
    }
  });
}

function transactionArtifacts(testCase) {
  return fs.readdirSync(path.join(testCase.remoteHome, ".hermes")).filter(name =>
    name.startsWith(".sticky-pad-mcp-stage-") || name.startsWith(".sticky-pad-mcp-transaction-")
  );
}

const success = makeCase("success", '{"version":1,"preserved":"yes"}\n');
let result = runInstaller(success);
assert.equal(result.status, 0, result.stderr);
assert.equal(fs.existsSync(path.join(success.remoteRoot, "old-helper.txt")), false);
assert.equal(fs.existsSync(path.join(success.remoteRoot, "hermes-inbox-server.mjs")), true);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(success.remoteRoot, "runtime-config.json"), "utf8")), {
  version: 1,
  hermesBin: fakeHermes
});
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(success.localInstall, "config.json"), "utf8")), {
  version: 1,
  preserved: "yes",
  hermes: {
    sshHost: "test-host",
    remoteNode: nodeBin,
    remoteHelper: path.join(success.remoteRoot, "hermes-inbox-server.mjs")
  }
});
assert.deepEqual(fs.readFileSync(path.join(success.localInstall, "status-sync.mjs")), fs.readFileSync(statusSyncSource));
assert.equal(fs.statSync(path.join(success.localInstall, "status-sync.mjs")).mode & 0o777, 0o700);
assert.deepEqual(JSON.parse(fs.readFileSync(success.statePath, "utf8"))["sticky-pad-inbox"], {
  command: nodeBin,
  args: [path.join(success.remoteRoot, "hermes-inbox-server.mjs")],
  enabled: true
});
assert.deepEqual(JSON.parse(fs.readFileSync(success.statePath, "utf8"))["sticky-pad-inbox-old"], similarRegistration);
assert.deepEqual(transactionArtifacts(success), []);
assert.deepEqual(fs.readdirSync(success.localInstall).filter(name => name.startsWith(".hermes-install-backup.")), []);

const rollback = makeCase("rollback", "this is not json\n");
const oldStatus = fs.readFileSync(path.join(rollback.localInstall, "status-sync.mjs"));
result = runInstaller(rollback);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /restored the previous Hermes deployment and local connection files/i);
assert.deepEqual(fs.readFileSync(path.join(rollback.localInstall, "status-sync.mjs")), oldStatus);
assert.equal(fs.readFileSync(path.join(rollback.localInstall, "config.json"), "utf8"), rollback.configText);
assert.equal(fs.readFileSync(path.join(rollback.remoteRoot, "old-helper.txt"), "utf8"), "old remote rollback\n");
assert.equal(fs.readFileSync(path.join(rollback.remoteRoot, "runtime-config.json"), "utf8"), '{"version":1,"hermesBin":"/old/hermes"}\n');
assert.equal(fs.existsSync(path.join(rollback.remoteRoot, "hermes-inbox-server.mjs")), false);
assert.deepEqual(JSON.parse(fs.readFileSync(rollback.statePath, "utf8"))["sticky-pad-inbox"], staleRegistration);
assert.deepEqual(JSON.parse(fs.readFileSync(rollback.statePath, "utf8"))["sticky-pad-inbox-old"], similarRegistration);
assert.deepEqual(transactionArtifacts(rollback), []);
assert.deepEqual(fs.readdirSync(rollback.localInstall).filter(name => name.startsWith(".hermes-install-backup.")), []);

const preservedBackup = makeCase("preserved-backup", "also not json\n");
const preservedOldStatus = fs.readFileSync(path.join(preservedBackup.localInstall, "status-sync.mjs"));
result = runInstaller(preservedBackup, { mutateAfterTest: true });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /at least one rollback step also failed/i);
assert.match(result.stderr, /Local recovery backup:/i);
assert.deepEqual(fs.readFileSync(path.join(preservedBackup.localInstall, "status-sync.mjs")), preservedOldStatus);
assert.equal(fs.readFileSync(path.join(preservedBackup.localInstall, "config.json"), "utf8"), preservedBackup.configText);
const preservedBackupDirectories = fs.readdirSync(preservedBackup.localInstall).filter(name => name.startsWith(".hermes-install-backup."));
assert.equal(preservedBackupDirectories.length, 1);
const recoveryRoot = path.join(preservedBackup.localInstall, preservedBackupDirectories[0]);
assert.deepEqual(fs.readFileSync(path.join(recoveryRoot, "status-sync.mjs")), preservedOldStatus);
assert.equal(fs.readFileSync(path.join(recoveryRoot, "config.json"), "utf8"), preservedBackup.configText);
assert.equal(fs.existsSync(path.join(preservedBackup.remoteRoot, "hermes-inbox-server.mjs")), true);
assert.deepEqual(JSON.parse(fs.readFileSync(preservedBackup.statePath, "utf8"))["sticky-pad-inbox"], {
  command: "/admin/node",
  args: ["/admin/helper.mjs"],
  enabled: true
});
assert.equal(transactionArtifacts(preservedBackup).filter(name => name.startsWith(".sticky-pad-mcp-transaction-")).length, 1);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
process.stdout.write("Hermes installer local and remote transaction tests passed.\n");
