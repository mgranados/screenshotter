#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin", "screenshotter.mjs");
const workDir = mkdtempSync(join(tmpdir(), "screenshotter-smoke-"));
const dataDir = join(workDir, "store");
const imagePath = join(workDir, "input.png");

try {
  writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lmV5xwAAAABJRU5ErkJggg==", "base64"));

  const doctor = run(["doctor", "--data-dir", dataDir, "--json"]);
  assert(doctor.ok === true, "doctor should pass required checks");
  assert(doctor.defaultProfile?.profile === "readability", "doctor should report readability as the default profile");
  assert(doctor.autoWatch?.clipboard === true, "watch should copy optimized screenshots to clipboard by default");

  const originalProcessList = process.env.SCREENSHOTTER_PROCESS_LIST;
  process.env.SCREENSHOTTER_PROCESS_LIST = "100 /Applications/Codex.app/Contents/Resources/codex /Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://";
  const codexDoctor = run(["doctor", "--data-dir", dataDir, "--json"]);
  assert(codexDoctor.autoWatch?.target === "codex-app", "doctor should auto-detect Codex app for watch");
  assert(codexDoctor.autoWatch?.clipboard === true, "Codex app auto-detect should enable clipboard handoff");
  process.env.SCREENSHOTTER_PROCESS_LIST = "101 /usr/local/bin/codex codex exec review";
  const codexCliDoctor = run(["doctor", "--data-dir", dataDir, "--json"]);
  assert(codexCliDoctor.autoWatch?.target === "codex", "doctor should auto-detect Codex CLI for watch");
  assert(codexCliDoctor.autoWatch?.clipboard === true, "Codex CLI auto-detect should still copy to clipboard by default");
  if (originalProcessList === undefined) delete process.env.SCREENSHOTTER_PROCESS_LIST;
  else process.env.SCREENSHOTTER_PROCESS_LIST = originalProcessList;

  run(["status", "--data-dir", dataDir, "--json"]);
  const prepared = run(["prepare", imagePath, "--target", "smoke", "--data-dir", dataDir, "--json"]);
  assert(prepared.screen?.optimizedPath, "prepare should return optimizedPath");
  assert(prepared.screen?.status === "ready", "prepare should return ready status");
  assert(prepared.screen?.profile === "readability", "prepare should default to readability profile");

  const listed = run(["list", "--target", "smoke", "--state", "ready", "--data-dir", dataDir, "--json"]);
  assert(listed.screens?.length === 1, "list should return one ready screenshot");

  const tokenPrepared = run(["prepare", imagePath, "--target", "smoke-token", "--profile", "token", "--max-patches", "256", "--data-dir", dataDir, "--json"]);
  assert(tokenPrepared.screen?.profile === "token", "token profile should be recorded");
  assert(tokenPrepared.screen?.maxPatches === 256, "max-patches override should be recorded");

  const status = run(["status", "--target", "smoke-token", "--tokens", "--data-dir", dataDir, "--json"]);
  assert(status.tokenEstimates?.modes?.openaiLowDetail?.original === 85, "status should include token estimates");

  const bench = run(["bench", "--dir", workDir, "--latest", "1", "--profile", "token", "--tokens", "--data-dir", join(workDir, "bench-store"), "--json"]);
  assert(bench.profile === "token", "bench should report the requested profile");
  assert(bench.tokenEstimates?.modes?.openaiLowDetail?.original === 85, "bench should include token estimates");

  const claimed = run(["claim", "--target", "smoke", "--data-dir", dataDir, "--json"]);
  assert(claimed.screens?.length === 1, "claim should return one screenshot");
  assert(claimed.screens[0]?.status === "claimed", "claim should return claimed status");

  const cleared = run(["clear", "--target", "smoke", "--data-dir", dataDir, "--json"]);
  assert(cleared.cleared === 1, "clear should mark one screenshot cleared");

  console.log("smoke test passed");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout || "{}");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
