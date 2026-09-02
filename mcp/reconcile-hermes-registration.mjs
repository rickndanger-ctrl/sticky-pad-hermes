#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const MCP_NAME = "sticky-pad-inbox";
const CONFIG_KEY = `mcp_servers.${MCP_NAME}`;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function usage() {
  process.stderr.write("Usage: reconcile-hermes-registration.mjs --hermes-bin PATH --node-bin PATH --helper PATH\n");
  process.exit(64);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--hermes-bin", "--node-bin", "--helper"].includes(flag)) usage();
    options[flag.slice(2)] = value;
  }
  if (Object.keys(options).length !== 3) usage();
  return options;
}

function requireSafeExecutable(value, label) {
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(value) || value.includes("/../") || value.endsWith("/..")) {
    throw new Error(`${label} is not a safe absolute path`);
  }
  const status = fs.statSync(value);
  if (!status.isFile() || (status.mode & 0o111) === 0) throw new Error(`${label} is not executable`);
  return value;
}

function requireSafeFile(value, label) {
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(value) || value.includes("/../") || value.endsWith("/..")) {
    throw new Error(`${label} is not a safe absolute path`);
  }
  const status = fs.lstatSync(value);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  return value;
}

const options = parseArguments(process.argv.slice(2));
const hermesBin = requireSafeExecutable(options["hermes-bin"], "Hermes executable");
const nodeBin = requireSafeExecutable(options["node-bin"], "Node.js executable");
const helper = requireSafeFile(options.helper, "Sticky Pad Hermes helper");
const expectedRegistration = { command: nodeBin, args: [helper], enabled: true };

function commandFailure(args, result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const detail = output ? `: ${output.slice(-4000)}` : "";
  return new Error(`Hermes ${args.slice(0, 2).join(" ")} failed${detail}`);
}

function runHermes(args, { input = "", allowFailure = false } = {}) {
  const result = spawnSync(hermesBin, args, {
    encoding: "utf8",
    input,
    timeout: 120000,
    maxBuffer: MAX_OUTPUT_BYTES
  });
  if (result.error) throw new Error(`Hermes ${args.slice(0, 2).join(" ")} could not run: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) throw commandFailure(args, result);
  return result;
}

function readRegistration() {
  const result = runHermes(["config", "get", CONFIG_KEY, "--json"], { allowFailure: true });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (/Config key not set:/i.test(output)) return null;
    throw commandFailure(["config", "get"], result);
  }
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Hermes config get returned invalid JSON for ${MCP_NAME}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Hermes config entry for ${MCP_NAME} is not an object`);
  }
  return value;
}

function registrationsEqual(left, right) {
  return isDeepStrictEqual(left, right);
}

function setRegistration(registration) {
  runHermes(["config", "set", "--force", CONFIG_KEY, JSON.stringify(registration)]);
  const saved = readRegistration();
  if (!registrationsEqual(saved, registration)) throw new Error(`Hermes did not save the exact ${MCP_NAME} registration`);
}

function removeRegistration() {
  if (readRegistration() === null) return;
  runHermes(["mcp", "remove", MCP_NAME], { input: "y\n" });
  if (readRegistration() !== null) {
    runHermes(["config", "unset", CONFIG_KEY]);
  }
  if (readRegistration() !== null) throw new Error(`Hermes did not remove the exact ${MCP_NAME} registration`);
}

function verifyHermesTest() {
  const result = runHermes(["mcp", "test", MCP_NAME], { allowFailure: true });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const positiveToolCount = /Tools discovered:\s*[1-9]\d*/i.test(output) ||
    /(?:Found|Discovered)\s+[1-9]\d*\s+tools?/i.test(output) ||
    /[1-9]\d*\s+tools?\s+(?:available|discovered)/i.test(output);
  const explicitFailure = /not found|connection failed|failed to connect/i.test(output);
  if (result.status !== 0 || explicitFailure || !/\bConnected\b/i.test(output) || !positiveToolCount) {
    throw commandFailure(["mcp", "test"], result);
  }
}

function restoreRegistration(previous) {
  const current = readRegistration();
  if (current !== null) {
    const unset = runHermes(["config", "unset", CONFIG_KEY], { allowFailure: true });
    if (unset.status !== 0 && readRegistration() !== null) throw commandFailure(["config", "unset"], unset);
  }
  if (previous !== null) setRegistration(previous);
  const restored = readRegistration();
  if (!registrationsEqual(restored, previous)) throw new Error(`Could not restore the previous ${MCP_NAME} registration`);
}

const previousRegistration = readRegistration();

try {
  removeRegistration();

  const add = runHermes(
    ["mcp", "add", MCP_NAME, "--command", nodeBin, "--args", helper],
    { input: "y\n", allowFailure: true }
  );
  if (add.status !== 0) throw commandFailure(["mcp", "add"], add);

  // Hermes versions differ in what discovery metadata `mcp add` persists.
  // Replace that result with one narrow, deterministic stdio registration.
  setRegistration(expectedRegistration);
  verifyHermesTest();
  process.stdout.write(`Sticky Pad replaced and verified the exact ${MCP_NAME} registration.\n`);
} catch (error) {
  try {
    restoreRegistration(previousRegistration);
    process.stderr.write(`Sticky Pad restored the previous ${MCP_NAME} registration after failure.\n`);
  } catch (rollbackError) {
    process.stderr.write(`Sticky Pad could not restore the previous ${MCP_NAME} registration: ${rollbackError.message || String(rollbackError)}\n`);
  }
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exit(1);
}
