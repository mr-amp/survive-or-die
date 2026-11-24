#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = { groupSize: 6, timeoutMs: 120_000, maxGroups: 0, results: path.join(tmpdir(), "survive-or-die-offline-tests.json"), resume: false };
const options = { ...defaults };
for (const arg of process.argv.slice(2).filter((value) => value !== "--")) {
  if (arg === "--resume") options.resume = true;
  else if (arg.startsWith("--group-size=")) options.groupSize = Number(arg.slice(13));
  else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = Number(arg.slice(13));
  else if (arg.startsWith("--max-groups=")) options.maxGroups = Number(arg.slice(13));
  else if (arg.startsWith("--results=")) options.results = path.resolve(arg.slice(10));
  else throw new Error(`Unknown option: ${arg}`);
}
if (!Number.isInteger(options.groupSize) || options.groupSize < 1 || options.groupSize > 12) throw new Error("--group-size must be from 1 to 12.");
if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 600_000) throw new Error("--timeout-ms must be from 1000 to 600000.");
if (!Number.isInteger(options.maxGroups) || options.maxGroups < 0) throw new Error("--max-groups must be zero or a positive integer.");

function collectTests(directory, base = "") {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(base, entry.name);
    if (entry.isDirectory()) found.push(...collectTests(absolute, relative));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(relative);
  }
  return found.sort();
}

function walkSource(directory, base = "src") {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(base, entry.name);
    if (entry.isDirectory()) found.push(...walkSource(absolute, relative));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(relative);
  }
  return found;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
const tests = collectTests(path.join(root, "src", "__tests__")).map((file) => path.posix.join("src/__tests__", file));
if (!tests.length) throw new Error("No Vitest files found under src/__tests__.");
const fingerprintFiles = [
  "package.json", "pnpm-lock.yaml", "vitest.config.ts", "vitest.offline.config.ts",
  "scripts/offline-test-groups.mjs",
  "src/__tests__/offline-network-guard.ts",
  ...collectTests(path.join(root, "src")).map((file) => path.posix.join("src", file)),
  ...walkSource(path.join(root, "src")),
];
const fingerprint = sha256(fingerprintFiles.sort().map((file) => `${file}\0${readFileSync(path.join(root, file))}`).join("\0"));
const groups = [];
for (let i = 0; i < tests.length; i += options.groupSize) groups.push(tests.slice(i, i + options.groupSize));
const previous = options.resume && existsSync(options.results) ? JSON.parse(readFileSync(options.results, "utf8")) : null;
const priorByKey = new Map((previous?.fingerprint === fingerprint ? previous.groups : []).map((item) => [item.key, item]));
const current = { fingerprint, generatedAt: new Date().toISOString(), groupSize: options.groupSize, timeoutMs: options.timeoutMs, groups: [] };
writeFileSync(options.results, JSON.stringify(current, null, 2));

function save() {
  current.generatedAt = new Date().toISOString();
  writeFileSync(options.results, JSON.stringify(current, null, 2));
}

const vitestCli = path.join(root, "node_modules", "vitest", "vitest.mjs");
if (!existsSync(vitestCli)) throw new Error("Vitest is not installed. Run the frozen pnpm install first.");
let executed = 0;
for (let index = 0; index < groups.length; index += 1) {
  const files = groups[index];
  const key = files.join("|");
  const prior = priorByKey.get(key);
  if (prior?.status === "passed" && prior.fingerprint === fingerprint) {
    current.groups.push({ ...prior, status: "passed", reused: true });
    console.log(`[${index + 1}/${groups.length}] Reusing verified group (${files.length} files): ${files[0]} …`);
    save();
    continue;
  }
  if (options.maxGroups && executed >= options.maxGroups) break;
  executed += 1;
  console.log(`[${index + 1}/${groups.length}] Running ${files.length} offline test files; timeout ${options.timeoutMs}ms.`);
  const startedAt = new Date().toISOString();
  const args = [vitestCli, "run", "--config", "vitest.offline.config.ts", "--pool=forks", "--maxWorkers=1", "--reporter=dot", ...files];
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", env: { ...process.env, CI: "true" } });
    let settled = false;
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5_000);
    }, options.timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      console.error(error);
      resolve({ status: "failed", exitCode: 1 });
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ status: timedOut ? "timed_out" : code === 0 ? "passed" : "failed", exitCode: code, signal });
    });
  });
  current.groups.push({ key, files, fingerprint, startedAt, finishedAt: new Date().toISOString(), ...result });
  save();
  console.log(`[${index + 1}/${groups.length}] ${result.status.toUpperCase()}: ${files.length} files (${files[0]} …)`);
}

const failed = current.groups.filter((item) => item.status === "failed" || item.status === "timed_out");
const remaining = groups.length - current.groups.length;
console.log(`Offline groups: ${current.groups.filter((x) => x.status === "passed" || x.status === "skipped_verified").length} passed/reused, ${failed.length} failed or timed out, ${remaining} pending. Results: ${options.results}`);
if (failed.length) process.exitCode = 1;
