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
  "scripts/clipboard-image-reader.swift",
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
  const clipboardSource = join(root, "scripts/clipboard-image-reader.swift");
  const clipboardBinary = join(workDir, "clipboard-image-reader");
  const compiled = spawnSync("xcrun", [
    "swiftc",
    "-module-cache-path", moduleCache,
    clipboardSource,
    "-o", clipboardBinary,
  ], {
    encoding: "utf8",
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (compiled.status !== 0) {
    throw new Error(`clipboard image helper failed Swift compilation\n${compiled.stderr || compiled.stdout}`);
  }
  assertClipboardClassification(clipboardBinary, ["public.png", "public.tiff"], true);
  assertClipboardClassification(clipboardBinary, ["public.tiff", "public.file-url", "com.apple.finder.node"], false);
  assertClipboardClassification(clipboardBinary, ["public.png", "public.html", "public.utf8-plain-text"], false);
  assertClipboardClassification(clipboardBinary, ["public.tiff", "com.apple.webarchive", "public.url"], false);
  console.log(`swift type-check passed (${sources.length} files)`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function assertClipboardClassification(binary, types, expected) {
  const result = spawnSync(binary, ["--classify-types", ...types], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`clipboard classification failed for ${types.join(", ")}\n${result.stderr || result.stdout}`);
  }
  const classified = JSON.parse(result.stdout);
  if (classified.screenshotLike !== expected) {
    throw new Error(`clipboard classification expected ${expected} for ${types.join(", ")}`);
  }
}
