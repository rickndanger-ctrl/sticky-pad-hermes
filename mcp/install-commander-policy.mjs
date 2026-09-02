#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] || "--check";
if (!new Set(["--check", "--install"]).has(mode)) {
  process.stderr.write("Usage: install-commander-policy.mjs [--check|--install]\n");
  process.exit(64);
}

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const policyPath = path.join(scriptRoot, "COMMANDER-INSTRUCTIONS.md");
const hermesRoot = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const soulPath = path.join(hermesRoot, "SOUL.md");
const startMarker = "<!-- sticky-pad-quiet-pull:v1 -->";
const endMarker = "<!-- /sticky-pad-quiet-pull:v1 -->";

function readRegularFile(target, allowMissing = false) {
  if (!fs.existsSync(target)) {
    if (allowMissing) return "";
    throw new Error(`Required file is missing: ${target}`);
  }
  const status = fs.lstatSync(target);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`Refusing non-regular file: ${target}`);
  return fs.readFileSync(target, "utf8");
}

function count(text, value) {
  return text.split(value).length - 1;
}

const policy = readRegularFile(policyPath).trim();
if (count(policy, startMarker) !== 1 || count(policy, endMarker) !== 1) throw new Error("Commander policy markers are invalid");

fs.mkdirSync(hermesRoot, { recursive: true, mode: 0o700 });
const original = readRegularFile(soulPath, true);
const startCount = count(original, startMarker);
const endCount = count(original, endMarker);
if (startCount !== endCount || startCount > 1) throw new Error("SOUL.md contains unmatched or duplicate Sticky Pad policy markers");

let updated;
if (startCount === 1) {
  const before = original.slice(0, original.indexOf(startMarker));
  const after = original.slice(original.indexOf(endMarker) + endMarker.length);
  updated = `${before}${policy}${after}`;
} else {
  updated = `${original.trimEnd()}${original.trim() ? "\n\n" : ""}${policy}\n`;
}

if (mode === "--check") {
  if (original !== updated) {
    process.stderr.write("Sticky Pad quiet-pull policy is missing or outdated.\n");
    process.exit(1);
  }
  process.stdout.write("Sticky Pad quiet-pull policy is current.\n");
  process.exit(0);
}

if (original === updated) {
  process.stdout.write("Sticky Pad quiet-pull policy was already current.\n");
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
const backupRoot = path.join(hermesRoot, "backups", `sticky-pad-protocol-${timestamp}`);
fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
if (fs.existsSync(soulPath)) fs.writeFileSync(path.join(backupRoot, "SOUL.md"), original, { mode: 0o600, flag: "wx" });

const temporary = path.join(hermesRoot, `.SOUL.md.${process.pid}.${Date.now()}.tmp`);
fs.writeFileSync(temporary, updated, { encoding: "utf8", mode: 0o600, flag: "wx" });
fs.renameSync(temporary, soulPath);
fs.chmodSync(soulPath, 0o600);
process.stdout.write(`Installed Sticky Pad quiet-pull policy; backup directory: ${backupRoot}\n`);
