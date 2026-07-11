#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSource = join(root, "scripts", "accessibility-fixture-app.swift");
const providerSource = join(root, "scripts", "macos-accessibility-text.swift");
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

const minF1 = threshold(args["min-f1"] ?? 0.95, "min-f1");
const maxChars = positiveInteger(args["max-chars"] ?? 4000, "max-chars");
const maxMs = positiveNumber(args["max-ms"] ?? 250, "max-ms");
const workDir = args["work-dir"]
  ? resolve(expandHome(args["work-dir"]))
  : mkdtempSync(join(tmpdir(), "screenshotter-accessibility-eval-"));
const keep = Boolean(args.keep || args["work-dir"]);
let fixtureProcess;

try {
  mkdirSync(workDir, { recursive: true });
  const moduleCache = join(workDir, "swift-module-cache");
  const fixtureBinary = compileSwift(fixtureSource, join(workDir, "accessibility-fixture-app"), moduleCache);
  const providerBinary = compileSwift(providerSource, join(workDir, "macos-accessibility-text"), moduleCache);

  const permission = runJson(providerBinary, [
    "--check",
    ...(args["prompt-permissions"] ? ["--prompt"] : []),
  ]);
  if (!permission.trusted) {
    finish({
      evaluation: "macos-accessibility-provider",
      status: "unavailable",
      passed: false,
      reason: permission.error ?? "Accessibility permission is unavailable",
      prompted: Boolean(permission.prompted),
      workDir,
      keptArtifacts: keep,
    }, 2);
  }

  if (permission.trusted) {
    const fixture = {
      title: "Screenshotter Accessibility Fixture",
      labels: [
        "Build status: failed",
        "Error code: AX-417",
        "Retry after reviewing logs",
      ],
      textField: "release/quality-gate",
      button: "Open diagnostics",
    };
    const fixturePath = join(workDir, "fixture.json");
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });

    fixtureProcess = spawn(fixtureBinary, [fixturePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = await waitForJsonLine(fixtureProcess, 5000);
    if (ready.status !== "ready" || !Number.isInteger(ready.pid)) {
      throw new Error(`Fixture app did not report a valid PID: ${JSON.stringify(ready)}`);
    }

    const expected = [fixture.title, ...fixture.labels, fixture.textField, fixture.button].join("\n");
    const started = performance.now();
    const provider = runJson(providerBinary, [
      "--pid", String(ready.pid),
      "--max-chars", String(maxChars),
    ]);
    const durationMs = round(performance.now() - started, 1);
    const metrics = compareText(expected, provider.text ?? "");
    const passed = provider.status === "ready"
      && metrics.f1 >= minF1
      && durationMs <= maxMs
      && String(provider.text ?? "").length <= maxChars;

    finish({
      evaluation: "macos-accessibility-provider",
      status: passed ? "passed" : "failed",
      passed,
      provider: {
        status: provider.status ?? "failed",
        source: provider.source ?? null,
        app: provider.app ?? null,
        pid: provider.pid ?? ready.pid,
        textLength: String(provider.text ?? "").length,
        error: provider.error ?? null,
      },
      thresholds: { minF1, maxChars, maxMs },
      metrics: { ...metrics, durationMs },
      expectedText: args.rows ? expected : undefined,
      actualText: args.rows ? (provider.text ?? "") : undefined,
      workDir,
      keptArtifacts: keep,
    }, passed ? 0 : 1);
  }
} catch (error) {
  finish({
    evaluation: "macos-accessibility-provider",
    status: "failed",
    passed: false,
    reason: error instanceof Error ? error.message : String(error),
    workDir,
    keptArtifacts: keep,
  }, 1);
} finally {
  if (fixtureProcess && fixtureProcess.exitCode === null) fixtureProcess.kill("SIGTERM");
  if (!keep) rmSync(workDir, { recursive: true, force: true });
}

function compileSwift(source, output, moduleCache) {
  if (!existsSync(source)) throw new Error(`Missing Swift source: ${source}`);
  mkdirSync(moduleCache, { recursive: true });
  const result = spawnSync("xcrun", [
    "swiftc",
    "-module-cache-path", moduleCache,
    source,
    "-o", output,
  ], {
    encoding: "utf8",
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `swiftc exited with ${result.status}`).trim());
  }
  return output;
}

function runJson(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited with ${result.status}`).trim());
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Expected JSON from ${command}, received: ${result.stdout.trim()}`);
  }
}

function waitForJsonLine(child, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`Timed out waiting for fixture app${stderr ? `: ${stderr.trim()}` : ""}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      lines.removeAllListeners();
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const onError = (error) => {
      cleanup();
      rejectPromise(error);
    };
    const onExit = (code) => {
      cleanup();
      rejectPromise(new Error(`Fixture app exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    };

    child.once("error", onError);
    child.once("exit", onExit);
    lines.once("line", (line) => {
      cleanup();
      try {
        resolvePromise(JSON.parse(line));
      } catch {
        rejectPromise(new Error(`Fixture app emitted invalid JSON: ${line}`));
      }
    });
  });
}

function compareText(expected, actual) {
  const expectedTokens = tokenCounts(expected);
  const actualTokens = tokenCounts(actual);
  const expectedCount = countTokens(expectedTokens);
  const actualCount = countTokens(actualTokens);
  let overlap = 0;
  for (const [token, count] of expectedTokens) {
    overlap += Math.min(count, actualTokens.get(token) ?? 0);
  }
  const recall = expectedCount > 0 ? overlap / expectedCount : 1;
  const precision = actualCount > 0 ? overlap / actualCount : expectedCount === 0 ? 1 : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    tokenRecall: round(recall, 4),
    tokenPrecision: round(precision, 4),
    f1: round(f1, 4),
    expectedTokens: expectedCount,
    actualTokens: actualCount,
  };
}

function tokenCounts(text) {
  const counts = new Map();
  for (const token of String(text ?? "").toLowerCase().split(/[^a-z0-9_.$@/-]+/i).filter(Boolean)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function countTokens(counts) {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (["help", "json", "keep", "rows", "prompt-permissions"].includes(key)) {
      result[key] = true;
    } else if (index + 1 < values.length) {
      result[key] = values[index + 1];
      index += 1;
    }
  }
  return result;
}

function threshold(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`--${name} must be between 0 and 1`);
  }
  return parsed;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive number`);
  return parsed;
}

function expandHome(value) {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) return join(process.env.HOME ?? "~", value.slice(2));
  return value;
}

function round(value, places) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function finish(result, code) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.status}: ${result.evaluation}\n`);
    if (result.metrics) {
      process.stdout.write(`F1 ${result.metrics.f1}, recall ${result.metrics.tokenRecall}, ${result.metrics.durationMs} ms\n`);
    }
    if (result.reason) process.stdout.write(`${result.reason}\n`);
  }
  process.exitCode = code;
}

function printUsage() {
  console.log(`Usage: node scripts/accessibility-provider-eval.mjs [options]

Options:
  --min-f1 n             Minimum token F1 (default: 0.95)
  --max-chars n          Provider output cap (default: 4000)
  --max-ms n             End-to-end provider latency ceiling (default: 250)
  --prompt-permissions   Ask macOS to grant Accessibility permission
  --rows                 Include expected and actual text in JSON
  --work-dir path        Keep artifacts in this directory
  --keep                 Keep a temporary work directory
  --json                 Print JSON
  --help                 Show help`);
}
