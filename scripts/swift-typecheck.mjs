#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = [
  "scripts/accessibility-fixture-app.swift",
  "scripts/apple-vision-batch-ocr.swift",
  "scripts/apple-vision-ocr.swift",
  "scripts/macos-accessibility-text.swift",
  "scripts/menu-bar-controller.swift",
  "scripts/native-image-optimizer.swift",
  "scripts/screen-target-snapshot.swift",
  "scripts/text-fixture-renderer.swift",
];
const workDir = mkdtempSync(join(tmpdir(), "screenshotter-swift-check-"));
const moduleCache = join(workDir, "module-cache");

try {
  for (const source of sources) {
    const result = spawnSync("xcrun", [
      "swiftc",
      "-module-cache-path", moduleCache,
      "-typecheck",
      join(root, source),
    ], {
      encoding: "utf8",
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache },
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`${source} failed Swift type-check\n${result.stderr || result.stdout}`);
    }
  }
  console.log(`swift type-check passed (${sources.length} files)`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
