#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform !== "darwin") {
  console.log("performance smoke test skipped (macOS only)");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const api = await import(pathToFileURL(join(root, "index.mjs")).href);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const workDir = mkdtempSync(join(tmpdir(), "screenshotter-performance-"));
const dataDir = join(workDir, "store");
const helperDir = join(dataDir, "helpers");
const imagePath = join(workDir, "input.png");
const helperDelayMs = 300;

try {
  mkdirSync(helperDir, { recursive: true });
  writeLargePngFixture(imagePath);
  installFakeHelper("screen-target-snapshot", "screen-target-snapshot.swift", `
setTimeout(() => console.log(JSON.stringify({
  status: "ready",
  frontmostApp: { name: "Performance Fixture", pid: 42 },
  pointerWindow: { pid: 42, ownerName: "Performance Fixture", windowTitle: "Fixture" }
})), ${helperDelayMs});
`);
  installFakeHelper("macos-accessibility-text", "macos-accessibility-text.swift", `
setTimeout(() => console.log(JSON.stringify({
  status: "ready",
  text: "Direct Accessibility fixture text",
  app: "Performance Fixture",
  windowTitle: "Fixture"
})), ${helperDelayMs});
`);
  installFakeHelper("native-image-optimizer", "native-image-optimizer.swift", `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const input = args.at(-1);
const output = path.join(flag("--out-dir"), flag("--stem") + "-native-max4096-q90.jpg");
setTimeout(() => {
  fs.copyFileSync(input, output);
  console.log(JSON.stringify({ rows: [{
    optimizedPath: output,
    optimizedBytes: 1,
    width: 1,
    height: 1,
    originalWidth: 1,
    originalHeight: 1,
    optimized: true
  }] }));
}, ${helperDelayMs});
`);

  const now = new Date();
  utimesSync(imagePath, now, now);
  const started = performance.now();
  const result = await api.prepareImage(imagePath, {
    target: "performance-smoke",
    dataDir,
    withText: true,
    noOcr: true,
    withTargetContext: true,
  });
  const actualMs = performance.now() - started;
  const timings = result.timings;
  const targetMs = result.screen?.screenTarget?.durationMs ?? 0;
  const stableMs = 100;
  const parallelWorkMs = Math.max(targetMs, stableMs) + (timings?.parallelStageMs ?? 0);
  const unavoidableMs = Math.max(0, actualMs - parallelWorkMs);
  const serialEstimateMs = unavoidableMs
    + targetMs
    + stableMs
    + (timings?.optimizeMs ?? 0)
    + (timings?.parallelTextMs ?? 0);
  const improvementPercent = ((serialEstimateMs - actualMs) / serialEstimateMs) * 100;

  assert(result.screen?.optimizer === "native", "fixture should exercise the native optimizer process");
  assert(result.screen?.textContext?.provider === "macos-accessibility", "fixture should exercise direct Accessibility text");
  assert(timings?.parallelStageMs < timings?.optimizeMs + timings?.parallelTextMs, "optimization and direct text should overlap");
  assert(improvementPercent >= 20, `pipeline improvement should be at least 20%, measured ${improvementPercent.toFixed(1)}%`);

  console.log(`performance smoke test passed (${actualMs.toFixed(1)}ms, ${improvementPercent.toFixed(1)}% faster than serial estimate)`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function installFakeHelper(outputName, sourceName, body) {
  const sourcePath = join(root, "scripts", sourceName);
  const outputPath = join(helperDir, outputName);
  const fingerprint = createHash("sha256")
    .update(readFileSync(sourcePath))
    .update(`\0${process.arch}\0${process.platform}\0${version}`)
    .digest("hex");
  writeFileSync(outputPath, `#!/usr/bin/env node\n${body.trim()}\n`);
  chmodSync(outputPath, 0o755);
  writeFileSync(`${outputPath}.sha256`, `${fingerprint}\n`);
}

function writeLargePngFixture(path) {
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lmV5xwAAAABJRU5ErkJggg==", "base64");
  writeFileSync(path, Buffer.concat([pixel, Buffer.alloc(600 * 1024)]));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
