#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const MCP_NAME = "sticky-pad-inbox";
const CONFIG_KEY = `mcp_servers.${MCP_NAME}`;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEPLOYMENT_MARKER = ".sticky-pad-deployment.json";
const METADATA_FILE = "transaction.json";
const DEPLOYER_COPY = "deployer.mjs";
const REQUIRED_FILES = [
  "hermes-inbox-server.mjs",
  "reconcile-hermes-registration.mjs",
  "install-commander-policy.mjs",
  "COMMANDER-INSTRUCTIONS.md",
  "hermes-remote-deploy.mjs"
];

function usage() {
  process.stderr.write(
    "Usage: hermes-remote-deploy.mjs --prepare|--commit|--rollback|--cleanup|--status " +
    "--root PATH --transaction PATH --hermes-bin PATH [--staging PATH --node-bin PATH] [--install-policy]\n"
  );
  process.exit(64);
}

function parseArguments(argv) {
  const options = { installPolicy: false };
  const modes = new Set(["--prepare", "--commit", "--rollback", "--cleanup", "--status"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (modes.has(flag)) {
      if (options.mode) usage();
      options.mode = flag.slice(2);
      continue;
    }
    if (flag === "--install-policy") {
      options.installPolicy = true;
      continue;
    }
    if (!["--root", "--staging", "--transaction", "--hermes-bin", "--node-bin"].includes(flag)) usage();
    const value = argv[index + 1];
    if (!value) usage();
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options.mode || !options.root || !options.transaction || !options["hermes-bin"]) usage();
  if (options.mode === "prepare" && (!options.staging || !options["node-bin"])) usage();
  return options;
}

function requireSafeAbsolutePath(value, label) {
  if (typeof value !== "string" || !/^\/[a-zA-Z0-9._/-]+$/.test(value) || value.includes("/../") || value.endsWith("/..") || path.resolve(value) !== value) {
    throw new Error(`${label} is not a safe absolute path`);
  }
  return value;
}

function requireExecutable(value, label) {
  const target = requireSafeAbsolutePath(value, label);
  const resolved = requireSafeAbsolutePath(fs.realpathSync(target), `${label} target`);
  const status = fs.lstatSync(resolved);
  if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o111) === 0) {
    throw new Error(`${label} does not resolve to a regular executable file`);
  }
  return target;
}

function requireDirectory(value, label) {
  const target = requireSafeAbsolutePath(value, label);
  const status = fs.lstatSync(target);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`${label} is not a regular directory`);
  return target;
}

function validateLayout(root, staging, transaction) {
  const parent = path.dirname(root);
  if (path.basename(root) !== "sticky-pad-mcp") throw new Error("Deployment root must end in sticky-pad-mcp");
  if (path.dirname(transaction) !== parent || !path.basename(transaction).startsWith(".sticky-pad-mcp-transaction-")) {
    throw new Error("Transaction directory must be a dedicated sibling of the deployment root");
  }
  if (staging && (path.dirname(staging) !== parent || !path.basename(staging).startsWith(".sticky-pad-mcp-stage-"))) {
    throw new Error("Staging directory must be a dedicated sibling of the deployment root");
  }
  requireDirectory(parent, "Deployment parent");
}

function atomicWriteJSON(target, value, mode = 0o600) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
  try {
    fs.renameSync(temporary, target);
    fs.chmodSync(target, mode);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function commandFailure(label, result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  return new Error(`${label} failed${output ? `: ${output.slice(-4000)}` : ""}`);
}

function run(command, args, { input = "", allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    env,
    timeout: 120000,
    maxBuffer: MAX_OUTPUT_BYTES
  });
  if (result.error) throw new Error(`${path.basename(command)} could not run: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) throw commandFailure(`${path.basename(command)} ${args.slice(0, 2).join(" ")}`, result);
  return result;
}

function readRegistration(hermesBin) {
  const result = run(hermesBin, ["config", "get", CONFIG_KEY, "--json"], { allowFailure: true });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (/Config key not set:/i.test(output)) return null;
    throw commandFailure("Hermes config get", result);
  }
  let registration;
  try { registration = JSON.parse(result.stdout); }
  catch { throw new Error(`Hermes config get returned invalid JSON for ${MCP_NAME}`); }
  if (!registration || typeof registration !== "object" || Array.isArray(registration)) {
    throw new Error(`Hermes config entry for ${MCP_NAME} is not an object`);
  }
  return registration;
}

function restoreRegistration(hermesBin, previous) {
  const current = readRegistration(hermesBin);
  if (isDeepStrictEqual(current, previous)) return;
  if (previous !== null) {
    const saved = run(hermesBin, ["config", "set", "--force", CONFIG_KEY, JSON.stringify(previous)], { allowFailure: true });
    if (saved.status !== 0 && !isDeepStrictEqual(readRegistration(hermesBin), previous)) {
      throw commandFailure("Hermes registration restore", saved);
    }
  } else if (current !== null) {
    const unset = run(hermesBin, ["config", "unset", CONFIG_KEY], { allowFailure: true });
    if (unset.status !== 0 && readRegistration(hermesBin) !== null) {
      const remove = run(hermesBin, ["mcp", "remove", MCP_NAME], { input: "y\n", allowFailure: true });
      if (remove.status !== 0 && readRegistration(hermesBin) !== null) throw commandFailure("Hermes registration removal", remove);
    }
  }
  if (!isDeepStrictEqual(readRegistration(hermesBin), previous)) {
    throw new Error(`Could not restore the previous ${MCP_NAME} registration`);
  }
}

function assertRegistrationRollbackSafe(hermesBin, previous, expected) {
  const current = readRegistration(hermesBin);
  if (!isDeepStrictEqual(current, previous) && !isDeepStrictEqual(current, expected)) {
    throw new Error(`Refusing to overwrite a concurrent change to the exact ${MCP_NAME} registration`);
  }
}

function readMetadata(transaction) {
  const target = path.join(transaction, METADATA_FILE);
  const status = fs.lstatSync(target);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error("Deployment transaction metadata is not a regular file");
  const metadata = JSON.parse(fs.readFileSync(target, "utf8"));
  if (
    metadata.version !== 1 ||
    metadata.root === undefined ||
    metadata.previousRegistration === undefined ||
    metadata.expectedRegistration === undefined ||
    !metadata.installedManifest ||
    (metadata.policyRequested && !Number.isInteger(metadata.installedSoulMode))
  ) {
    throw new Error("Deployment transaction metadata is invalid");
  }
  return metadata;
}

function writeMetadata(transaction, metadata) {
  atomicWriteJSON(path.join(transaction, METADATA_FILE), metadata);
}

function deploymentMarkerMatches(root, transaction) {
  if (!fs.existsSync(root)) return false;
  const status = fs.lstatSync(root);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("Deployment root became unsafe");
  const markerPath = path.join(root, DEPLOYMENT_MARKER);
  if (!fs.existsSync(markerPath)) return false;
  const markerStatus = fs.lstatSync(markerPath);
  if (!markerStatus.isFile() || markerStatus.isSymbolicLink()) throw new Error("Deployment marker became unsafe");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  return marker.version === 1 && marker.transaction === transaction;
}

function deploymentManifest(root) {
  const allowed = [...REQUIRED_FILES, "runtime-config.json", DEPLOYMENT_MARKER].sort();
  const entries = fs.readdirSync(root).sort();
  if (!isDeepStrictEqual(entries, allowed)) throw new Error("Deployment directory contains unexpected files");
  return Object.fromEntries(allowed.map(filename => {
    const target = path.join(root, filename);
    const status = fs.lstatSync(target);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error(`Deployment file became unsafe: ${filename}`);
    return [filename, {
      sha256: crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
      mode: status.mode & 0o777
    }];
  }));
}

function assertDeploymentRollbackSafe(root, transaction, expectedManifest) {
  if (!deploymentMarkerMatches(root, transaction)) return false;
  if (!isDeepStrictEqual(deploymentManifest(root), expectedManifest)) {
    throw new Error("Refusing to overwrite a concurrent change to the Sticky Pad remote deployment");
  }
  return true;
}

function readOptionalRegularFile(target, label) {
  if (!fs.existsSync(target)) return null;
  const status = fs.lstatSync(target);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  return { content: fs.readFileSync(target), mode: status.mode & 0o777 };
}

function assertRegularFileRollbackSafe(target, backup, existed, previousMode, expected, expectedMode) {
  const current = readOptionalRegularFile(target, "Rollback target");
  const previousSnapshot = existed ? readOptionalRegularFile(backup, "Rollback snapshot") : null;
  const expectedSnapshot = readOptionalRegularFile(expected, "Installed rollback value");
  const previous = previousSnapshot === null ? null : { content: previousSnapshot.content, mode: previousMode };
  const installed = expectedSnapshot === null ? null : { content: expectedSnapshot.content, mode: expectedMode };
  const equals = (left, right) => left === null
    ? right === null
    : right !== null && left.mode === right.mode && left.content.equals(right.content);
  if (!equals(current, previous) && !equals(current, installed)) {
    throw new Error(`Refusing to overwrite a concurrent change to ${target}`);
  }
}

function restoreRegularFile(target, backup, existed, mode, expected, expectedMode) {
  assertRegularFileRollbackSafe(target, backup, existed, mode, expected, expectedMode);
  const current = readOptionalRegularFile(target, "Rollback target");
  const previousSnapshot = existed ? readOptionalRegularFile(backup, "Rollback snapshot") : null;
  if (
    current === null
      ? previousSnapshot === null
      : previousSnapshot !== null && current.mode === mode && current.content.equals(previousSnapshot.content)
  ) return;
  if (!existed) {
    fs.unlinkSync(target);
    return;
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.restore.${process.pid}.${Date.now()}.tmp`);
  fs.copyFileSync(backup, temporary, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(temporary, mode & 0o777);
  fs.renameSync(temporary, target);
}

function removeDirectoryIfSafe(target, expectedPrefix) {
  if (!fs.existsSync(target)) return;
  if (!path.basename(target).startsWith(expectedPrefix)) throw new Error(`Refusing to remove unexpected directory: ${target}`);
  const status = fs.lstatSync(target);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`Refusing to remove unsafe directory: ${target}`);
  fs.rmSync(target, { recursive: true });
}

function expectedCommanderSoul(original, policySource) {
  const startMarker = "<!-- sticky-pad-quiet-pull:v1 -->";
  const endMarker = "<!-- /sticky-pad-quiet-pull:v1 -->";
  const policy = policySource.trim();
  const count = (text, value) => text.split(value).length - 1;
  if (count(policy, startMarker) !== 1 || count(policy, endMarker) !== 1) {
    throw new Error("Staged Commander policy markers are invalid");
  }
  const startCount = count(original, startMarker);
  const endCount = count(original, endMarker);
  if (startCount !== endCount || startCount > 1) {
    throw new Error("Commander SOUL.md contains unmatched or duplicate Sticky Pad policy markers");
  }
  if (startCount === 1) {
    const before = original.slice(0, original.indexOf(startMarker));
    const after = original.slice(original.indexOf(endMarker) + endMarker.length);
    return `${before}${policy}${after}`;
  }
  return `${original.trimEnd()}${original.trim() ? "\n\n" : ""}${policy}\n`;
}

function rollbackTransaction({ root, staging, transaction, hermesBin }, { removeJournal = true } = {}) {
  if (!fs.existsSync(transaction)) {
    if (staging) removeDirectoryIfSafe(staging, ".sticky-pad-mcp-stage-");
    return;
  }
  requireDirectory(transaction, "Transaction directory");
  const metadata = readMetadata(transaction);
  if (metadata.root !== root || metadata.hermesBin !== hermesBin) throw new Error("Deployment transaction does not match the requested rollback");

  assertRegistrationRollbackSafe(hermesBin, metadata.previousRegistration, metadata.expectedRegistration);
  if (metadata.policyRequested) {
    assertRegularFileRollbackSafe(
      metadata.soulPath,
      path.join(transaction, "previous-SOUL.md"),
      metadata.soulExisted,
      metadata.soulMode,
      path.join(transaction, "installed-SOUL.md"),
      metadata.installedSoulMode
    );
  }

  const previousRoot = path.join(transaction, "previous-deployment");
  const failedRoot = path.join(transaction, "failed-deployment");
  if (assertDeploymentRollbackSafe(root, transaction, metadata.installedManifest)) {
    if (fs.existsSync(failedRoot)) removeDirectoryIfSafe(failedRoot, "failed-deployment");
    fs.renameSync(root, failedRoot);
  }
  if (metadata.previousRootExisted) {
    if (fs.existsSync(previousRoot)) {
      if (fs.existsSync(root)) throw new Error("Refusing to overwrite an unexpected deployment during rollback");
      fs.renameSync(previousRoot, root);
    } else if (!fs.existsSync(root) || deploymentMarkerMatches(root, transaction)) {
      throw new Error("Previous deployment snapshot is missing");
    }
  } else if (fs.existsSync(root)) {
    throw new Error("Refusing to remove an unrecognized deployment during first-install rollback");
  }

  restoreRegistration(hermesBin, metadata.previousRegistration);
  if (metadata.policyRequested) {
    restoreRegularFile(
      metadata.soulPath,
      path.join(transaction, "previous-SOUL.md"),
      metadata.soulExisted,
      metadata.soulMode,
      path.join(transaction, "installed-SOUL.md"),
      metadata.installedSoulMode
    );
  }
  if (staging) removeDirectoryIfSafe(staging, ".sticky-pad-mcp-stage-");
  removeDirectoryIfSafe(failedRoot, "failed-deployment");
  if (removeJournal) removeDirectoryIfSafe(transaction, ".sticky-pad-mcp-transaction-");
}

function prepare(options) {
  const root = requireSafeAbsolutePath(options.root, "Deployment root");
  const staging = requireDirectory(options.staging, "Staging directory");
  const transaction = requireSafeAbsolutePath(options.transaction, "Transaction directory");
  const hermesBin = requireExecutable(options["hermes-bin"], "Hermes executable");
  const nodeBin = requireExecutable(options["node-bin"], "Node.js executable");
  validateLayout(root, staging, transaction);
  if (fs.existsSync(transaction)) throw new Error("Deployment transaction already exists");
  if (fs.existsSync(root)) requireDirectory(root, "Existing deployment root");

  for (const filename of REQUIRED_FILES) {
    const target = path.join(staging, filename);
    const status = fs.lstatSync(target);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error(`Staged file is missing or unsafe: ${filename}`);
  }
  for (const filename of REQUIRED_FILES.filter(name => name.endsWith(".mjs"))) {
    run(nodeBin, ["--check", path.join(staging, filename)]);
  }

  const soulPath = path.join(path.dirname(root), "SOUL.md");
  let soulExisted = false;
  let soulMode = 0o600;
  let originalSoul = "";
  let installedSoul = null;
  let installedSoulMode = 0o600;
  if (options.installPolicy && fs.existsSync(soulPath)) {
    const soulStatus = fs.lstatSync(soulPath);
    if (!soulStatus.isFile() || soulStatus.isSymbolicLink()) throw new Error("Commander SOUL.md is not a regular file");
    soulExisted = true;
    soulMode = soulStatus.mode & 0o777;
    originalSoul = fs.readFileSync(soulPath, "utf8");
  }
  if (options.installPolicy) {
    installedSoul = expectedCommanderSoul(
      originalSoul,
      fs.readFileSync(path.join(staging, "COMMANDER-INSTRUCTIONS.md"), "utf8")
    );
    if (soulExisted && originalSoul === installedSoul) installedSoulMode = soulMode;
  }

  const expectedRegistration = {
    command: nodeBin,
    args: [path.join(root, "hermes-inbox-server.mjs")],
    enabled: true
  };
  const metadata = {
    version: 1,
    state: "snapshot",
    root,
    staging,
    hermesBin,
    nodeBin,
    previousRootExisted: fs.existsSync(root),
    previousRegistration: readRegistration(hermesBin),
    expectedRegistration,
    policyRequested: options.installPolicy,
    soulPath,
    soulExisted,
    soulMode,
    installedSoulMode
  };

  let transactionCreated = false;
  let metadataWritten = false;
  try {
    for (const filename of REQUIRED_FILES) {
      fs.chmodSync(path.join(staging, filename), filename.endsWith(".md") ? 0o600 : 0o700);
    }
    atomicWriteJSON(path.join(staging, "runtime-config.json"), { version: 1, hermesBin });
    atomicWriteJSON(path.join(staging, DEPLOYMENT_MARKER), { version: 1, transaction });
    fs.chmodSync(staging, 0o700);
    metadata.installedManifest = deploymentManifest(staging);

    fs.mkdirSync(transaction, { mode: 0o700 });
    transactionCreated = true;
    fs.copyFileSync(path.join(staging, "hermes-remote-deploy.mjs"), path.join(transaction, DEPLOYER_COPY), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(transaction, DEPLOYER_COPY), 0o700);
    if (soulExisted) {
      fs.copyFileSync(soulPath, path.join(transaction, "previous-SOUL.md"), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(transaction, "previous-SOUL.md"), 0o600);
    }
    if (installedSoul !== null) {
      fs.writeFileSync(path.join(transaction, "installed-SOUL.md"), installedSoul, { mode: 0o600, flag: "wx" });
    }
    writeMetadata(transaction, metadata);
    metadataWritten = true;

    if (metadata.previousRootExisted) fs.renameSync(root, path.join(transaction, "previous-deployment"));
    fs.renameSync(staging, root);

    run(nodeBin, [
      path.join(root, "reconcile-hermes-registration.mjs"),
      "--hermes-bin", hermesBin,
      "--node-bin", nodeBin,
      "--helper", path.join(root, "hermes-inbox-server.mjs")
    ]);

    if (options.installPolicy) {
      run(nodeBin, [path.join(root, "install-commander-policy.mjs"), "--install"], {
        env: { ...process.env, HERMES_HOME: path.dirname(root) }
      });
      run(nodeBin, [path.join(root, "install-commander-policy.mjs"), "--check"], {
        env: { ...process.env, HERMES_HOME: path.dirname(root) }
      });
    }

    metadata.state = "prepared";
    writeMetadata(transaction, metadata);
    process.stdout.write(`Sticky Pad prepared remote deployment transaction ${path.basename(transaction)}.\n`);
  } catch (error) {
    try {
      if (metadataWritten) {
        rollbackTransaction({ root, staging, transaction, hermesBin });
        process.stderr.write("Sticky Pad restored the previous remote deployment after failure.\n");
      } else {
        removeDirectoryIfSafe(staging, ".sticky-pad-mcp-stage-");
        if (transactionCreated) removeDirectoryIfSafe(transaction, ".sticky-pad-mcp-transaction-");
        process.stderr.write("Sticky Pad removed its incomplete remote deployment staging after failure.\n");
      }
    } catch (rollbackError) {
      process.stderr.write(`Sticky Pad remote rollback failed: ${rollbackError.message || String(rollbackError)}\n`);
    }
    throw error;
  }
}

function commit(options) {
  const root = requireSafeAbsolutePath(options.root, "Deployment root");
  const transaction = requireDirectory(options.transaction, "Transaction directory");
  const hermesBin = requireExecutable(options["hermes-bin"], "Hermes executable");
  validateLayout(root, null, transaction);
  const metadata = readMetadata(transaction);
  if (metadata.root !== root || metadata.hermesBin !== hermesBin || !new Set(["prepared", "committed"]).has(metadata.state)) {
    throw new Error("Deployment transaction is not ready to commit");
  }
  if (!assertDeploymentRollbackSafe(root, transaction, metadata.installedManifest)) {
    throw new Error("Prepared deployment marker is missing");
  }
  if (!isDeepStrictEqual(readRegistration(hermesBin), metadata.expectedRegistration)) {
    throw new Error("Sticky Pad registration changed before commit");
  }
  if (metadata.policyRequested) {
    run(metadata.nodeBin, [path.join(root, "install-commander-policy.mjs"), "--check"], {
      env: { ...process.env, HERMES_HOME: path.dirname(root) }
    });
  }
  metadata.state = "committed";
  writeMetadata(transaction, metadata);
  process.stdout.write(`Sticky Pad committed remote deployment transaction ${path.basename(transaction)}.\n`);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  options.root = requireSafeAbsolutePath(options.root, "Deployment root");
  options.transaction = requireSafeAbsolutePath(options.transaction, "Transaction directory");
  options["hermes-bin"] = requireSafeAbsolutePath(options["hermes-bin"], "Hermes executable");
  if (options.staging) options.staging = requireSafeAbsolutePath(options.staging, "Staging directory");
  if (options["node-bin"]) options["node-bin"] = requireSafeAbsolutePath(options["node-bin"], "Node.js executable");

  if (options.mode === "prepare") return prepare(options);
  validateLayout(options.root, null, options.transaction);
  if (options.mode === "rollback") {
    rollbackTransaction({ root: options.root, transaction: options.transaction, hermesBin: options["hermes-bin"] });
    process.stdout.write("Sticky Pad restored the previous remote deployment transaction.\n");
    return;
  }
  if (options.mode === "commit") return commit(options);
  if (options.mode === "status") {
    process.stdout.write(`${readMetadata(requireDirectory(options.transaction, "Transaction directory")).state}\n`);
    return;
  }
  if (options.mode === "cleanup") {
    const transaction = requireDirectory(options.transaction, "Transaction directory");
    const metadata = readMetadata(transaction);
    if (metadata.state !== "committed" || metadata.root !== options.root || metadata.hermesBin !== options["hermes-bin"]) {
      throw new Error("Only a matching committed deployment transaction can be cleaned up");
    }
    removeDirectoryIfSafe(transaction, ".sticky-pad-mcp-transaction-");
    process.stdout.write("Sticky Pad cleaned up the committed remote deployment transaction.\n");
    return;
  }
  usage();
}

try { main(); }
catch (error) {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exitCode = 1;
}
