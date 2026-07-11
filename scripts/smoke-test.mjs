#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin", "screenshotter.mjs");
const api = await import(pathToFileURL(join(root, "index.mjs")).href);
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
  const statsAfterPrepare = run(["stats", "--data-dir", dataDir, "--json"]);
  assert(statsAfterPrepare.stats?.screensPrepared === 1, "stats should count newly prepared screenshots");
  assert(statsAfterPrepare.stats?.bytes?.original === prepared.screen.originalBytes, "stats should track historical original bytes");
  assert(statsAfterPrepare.stats?.bytes?.optimized === prepared.screen.optimizedBytes, "stats should track historical optimized bytes");
  run(["prepare", imagePath, "--target", "smoke", "--data-dir", dataDir, "--json"]);
  const statsAfterCachedPrepare = run(["stats", "--data-dir", dataDir, "--json"]);
  assert(statsAfterCachedPrepare.stats?.screensPrepared === 1, "stats should not double-count cached prepares");
  const statusAfterPrepare = run(["status", "--data-dir", dataDir, "--json"]);
  assert(statusAfterPrepare.historical?.screensPrepared === 1, "status should include historical stats");

  const textPrepared = run(["prepare", imagePath, "--target", "smoke-text", "--ocr", "--data-dir", dataDir, "--json"]);
  assert(textPrepared.screen?.ocr, "prepare --ocr should return OCR metadata");
  assert(typeof textPrepared.screen?.ocrTextLength === "number", "prepare --ocr should report OCR text length");

  const textClip = run(["clip", "--dir", workDir, "--target", "smoke-clip", "--with-text", "--dry-run", "--data-dir", dataDir, "--json"]);
  assert(textClip.clipboard === "both-dry-run", "clip --with-text --dry-run should plan a combined clipboard payload");
  assert(textClip.screen?.textSources?.[0]?.provider === "macos-accessibility", "clip --with-text should use direct Accessibility text by default");
  assert(!textClip.screen?.ocr, "clip --with-text should not run OCR by default");

  const textFileClip = run(["clip", "--dir", workDir, "--target", "smoke-clip-files", "--with-text", "--clipboard-mode", "files", "--dry-run", "--data-dir", dataDir, "--json"]);
  assert(textFileClip.clipboard === "files-dry-run", "clip --clipboard-mode files --dry-run should plan file URL clipboard payload");

  const markdownClip = run(["clip", "--dir", workDir, "--target", "smoke-clip-markdown", "--with-text", "--clipboard-mode", "markdown", "--dry-run", "--data-dir", dataDir, "--json"]);
  assert(markdownClip.clipboard === "markdown-dry-run", "clip --clipboard-mode markdown --dry-run should plan markdown clipboard payload");

  const attachmentClip = run(["clip", "--dir", workDir, "--target", "smoke-clip-attachments", "--with-text", "--clipboard-mode", "attachments", "--dry-run", "--data-dir", dataDir, "--json"]);
  assert(attachmentClip.clipboard === "attachments-dry-run", "clip --clipboard-mode attachments --dry-run should plan app attachment delivery");

  const remoteAttachmentClip = run(["clip", "--dir", workDir, "--target", "smoke-clip-remote", "--with-text", "--clipboard-mode", "attachments", "--remote-target", "devbox-test", "--dry-run", "--data-dir", dataDir, "--json"]);
  assert(remoteAttachmentClip.clipboard === "remote-attachments-dry-run", "clip --remote-target --dry-run should plan remote attachment delivery");

  const directAttachmentClip = run(["clip", "--dir", workDir, "--target", "smoke-clip-direct-attachments", "--with-text", "--no-ocr", "--with-target-context", "--clipboard-mode", "attachments", "--dry-run", "--data-dir", dataDir, "--json"]);
  assert(directAttachmentClip.clipboard === "attachments-dry-run", "clip --clipboard-mode attachments --no-ocr --dry-run should plan direct-source app attachment delivery");

  const codexInlineClip = run(["clip", "--dir", workDir, "--target", "smoke-clip-codex-inline", "--with-text", "--clipboard-mode", "codex-inline", "--dry-run", "--data-dir", dataDir, "--json"]);
  assert(codexInlineClip.clipboard === "codex-inline-dry-run", "clip --clipboard-mode codex-inline --dry-run should plan Codex app inline delivery");

  const originalBrowserText = process.env.SCREENSHOTTER_BROWSER_DOM_TEXT;
  const originalBrowserTitle = process.env.SCREENSHOTTER_BROWSER_DOM_TITLE;
  const originalBrowserUrl = process.env.SCREENSHOTTER_BROWSER_DOM_URL;
  process.env.SCREENSHOTTER_BROWSER_DOM_TEXT = "Direct DOM text from the active tab";
  process.env.SCREENSHOTTER_BROWSER_DOM_TITLE = "Mock browser tab";
  process.env.SCREENSHOTTER_BROWSER_DOM_URL = "https://example.test/context";
  const directTextPrepared = run(["prepare", imagePath, "--target", "smoke-direct-text", "--with-text", "--text-provider", "browser-dom", "--data-dir", dataDir, "--json"]);
  assert(directTextPrepared.screen?.textContext?.provider === "browser-dom", "browser DOM text provider should return direct browser text when available");
  assert(directTextPrepared.screen?.textContext?.text === "Direct DOM text from the active tab", "browser DOM text should be stored as textContext");
  assert(Array.isArray(directTextPrepared.screen?.textSources) && directTextPrepared.screen.textSources[0]?.provider === "browser-dom", "textSources should record provider attempts");
  restoreEnv("SCREENSHOTTER_BROWSER_DOM_TEXT", originalBrowserText);
  restoreEnv("SCREENSHOTTER_BROWSER_DOM_TITLE", originalBrowserTitle);
  restoreEnv("SCREENSHOTTER_BROWSER_DOM_URL", originalBrowserUrl);

  const originalAccessibilityText = process.env.SCREENSHOTTER_ACCESSIBILITY_TEXT;
  const originalAccessibilityApp = process.env.SCREENSHOTTER_ACCESSIBILITY_APP;
  const originalAccessibilityTitle = process.env.SCREENSHOTTER_ACCESSIBILITY_TITLE;
  process.env.SCREENSHOTTER_ACCESSIBILITY_TEXT = "Accessibility tree text from the active app";
  process.env.SCREENSHOTTER_ACCESSIBILITY_APP = "Mock Native App";
  process.env.SCREENSHOTTER_ACCESSIBILITY_TITLE = "Mock Native Window";
  const accessibilityTextPrepared = run(["prepare", imagePath, "--target", "smoke-accessibility-text", "--with-text", "--text-provider", "accessibility", "--data-dir", dataDir, "--json"]);
  assert(accessibilityTextPrepared.screen?.textContext?.provider === "macos-accessibility", "accessibility text provider should return macOS Accessibility context");
  assert(accessibilityTextPrepared.screen?.textContext?.text === "Accessibility tree text from the active app", "accessibility text should be stored as textContext");
  const originalAutoScreenTargetJson = process.env.SCREENSHOTTER_SCREEN_TARGET_JSON;
  process.env.SCREENSHOTTER_SCREEN_TARGET_JSON = JSON.stringify({
    frontmostApp: { name: "Mock Native App", pid: 222, bundleId: "com.example.MockNativeApp" },
    pointerWindow: { pid: 222, ownerName: "Mock Native App", windowTitle: "Mock Native Window", layer: 0 },
  });
  const autoTextTargetPrepared = run(["prepare", imagePath, "--target", "smoke-auto-text-target", "--with-text", "--with-target-context", "--data-dir", dataDir, "--json"]);
  assert(autoTextTargetPrepared.screen?.screenTarget?.frontmostApp?.name === "Mock Native App", "--with-target-context should work without --no-ocr");
  assert(autoTextTargetPrepared.screen?.textContext?.provider === "macos-accessibility", "default text should use Accessibility");
  assert(autoTextTargetPrepared.screen?.textSources?.[0]?.provider === "macos-accessibility", "default text source should be Accessibility");
  assert(!autoTextTargetPrepared.screen?.textSources?.some((source) => source.provider === "apple-vision-ocr"), "default text should not run OCR");
  assert(typeof autoTextTargetPrepared.timings?.optimizeMs === "number", "prepare should report image optimization timing");
  assert(typeof autoTextTargetPrepared.timings?.parallelTextMs === "number", "prepare should report parallel direct-text timing");
  restoreEnv("SCREENSHOTTER_SCREEN_TARGET_JSON", originalAutoScreenTargetJson);

  const originalOcrText = process.env.SCREENSHOTTER_OCR_TEXT;
  process.env.SCREENSHOTTER_ACCESSIBILITY_TEXT = "";
  process.env.SCREENSHOTTER_OCR_TEXT = "Deterministic OCR fallback text";
  const fallbackTextPrepared = run(["prepare", imagePath, "--target", "smoke-auto-text-fallback", "--with-text", "--text-provider", "auto", "--data-dir", dataDir, "--json"]);
  assert(fallbackTextPrepared.screen?.textContext?.provider === "apple-vision-ocr", "auto text should fall back to OCR when direct text is empty");
  assert(fallbackTextPrepared.screen?.textSources?.[0]?.provider === "macos-accessibility", "OCR fallback should preserve the direct provider attempt");
  assert(fallbackTextPrepared.screen?.textSources?.[1]?.provider === "apple-vision-ocr", "OCR fallback should preserve provider order");
  process.env.SCREENSHOTTER_ACCESSIBILITY_TEXT = "Accessibility tree text from the active app";
  restoreEnv("SCREENSHOTTER_OCR_TEXT", originalOcrText);

  const apiPrepared = await api.prepareImage(imagePath, { target: "smoke-api", withText: true, textProvider: "accessibility", dataDir });
  assert(apiPrepared.screen?.textContext?.text === "Accessibility tree text from the active app", "prepareImage API should use direct text options");
  const apiClipboard = await api.prepareLatestForClipboard({ dir: workDir, target: "smoke-api-clip", withText: true, noOcr: true, clipboardMode: "attachments", dryRun: true, dataDir });
  assert(apiClipboard.clipboard?.status === "attachments-dry-run", "prepareLatestForClipboard API should support dry-run attachment mode");
  restoreEnv("SCREENSHOTTER_ACCESSIBILITY_TEXT", originalAccessibilityText);
  restoreEnv("SCREENSHOTTER_ACCESSIBILITY_APP", originalAccessibilityApp);
  restoreEnv("SCREENSHOTTER_ACCESSIBILITY_TITLE", originalAccessibilityTitle);

  const originalScreenTargetJson = process.env.SCREENSHOTTER_SCREEN_TARGET_JSON;
  process.env.SCREENSHOTTER_SCREEN_TARGET_JSON = JSON.stringify({
    collectedAt: "2026-07-07T12:00:00.000Z",
    frontmostApp: {
      name: "Mock Browser",
      pid: 111,
      bundleId: "com.example.MockBrowser",
    },
    pointer: {
      x: 10,
      y: 20,
    },
    pointerWindow: {
      pid: 111,
      ownerName: "Mock Browser",
      windowTitle: "Mock Window",
      windowNumber: 7,
      layer: 0,
      bounds: {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
    },
  });
  const targetContextPrepared = run(["prepare", imagePath, "--target", "smoke-target-context", "--with-target-context", "--data-dir", dataDir, "--json"]);
  assert(targetContextPrepared.screen?.screenTarget?.status === "ready", "prepare --with-target-context should store target context");
  assert(targetContextPrepared.screen?.screenTarget?.frontmostApp?.name === "Mock Browser", "screenTarget should include the frontmost app");
  assert(targetContextPrepared.screen?.screenTarget?.pointerWindow?.windowTitle === "Mock Window", "screenTarget should include the pointer window");
  restoreEnv("SCREENSHOTTER_SCREEN_TARGET_JSON", originalScreenTargetJson);

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

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
