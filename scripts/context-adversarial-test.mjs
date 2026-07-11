#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { formatScreenContextMarkdown } from "../bin/screenshotter.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const cli = join(root, "bin", "screenshotter.mjs");
const mcp = join(root, "bin", "screenshotter-mcp.mjs");
const benchmark = join(root, "scripts", "text-source-benchmark.mjs");
const accessibilityHelperSource = join(root, "scripts", "macos-accessibility-text.swift");
const workDir = mkdtempSync(join(tmpdir(), "screenshotter-adversarial-"));
const store = join(workDir, "store");
const image = join(workDir, "screen.png");

try {
  writeFileSync(image, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lmV5xwAAAABJRU5ErkJggg==",
    "base64",
  ));

  const targetJson = JSON.stringify({
    collectedAt: "2026-07-10T10:00:00.000Z",
    frontmostApp: { name: "Frontmost App", pid: 111, bundleId: "com.example.front" },
    pointerWindow: {
      pid: 222,
      ownerName: "Pointer App",
      windowTitle: "Pointer Window",
      app: { name: "Pointer App", pid: 222, bundleId: "com.example.pointer" },
    },
  });

  const enriched = runCli([
    "prepare", image,
    "--target", "opt-in",
    "--with-text",
    "--no-ocr",
    "--with-target-context",
  ], {
    SCREENSHOTTER_ACCESSIBILITY_TEXT: "private direct context",
    SCREENSHOTTER_SCREEN_TARGET_JSON: targetJson,
  });
  assert(enriched.screen.textContext?.text === "private direct context", "opted-in prepare should expose direct text");
  assert(enriched.screen.screenTarget?.pointerWindow?.pid === 222, "opted-in prepare should expose target metadata");

  const imageOnly = runCli(["prepare", image, "--target", "opt-in"]);
  assert(imageOnly.prepared === false, "image-only prepare should reuse the cached artifact");
  assert(imageOnly.screen.textContext === null, "image-only prepare must redact cached text");
  assert(imageOnly.screen.ocrText === null, "image-only prepare must redact cached OCR");
  assert(imageOnly.screen.screenTarget === null, "image-only prepare must redact cached target metadata");
  const imageOnlyList = runCli(["list", "--target", "opt-in"]);
  assert(imageOnlyList.screens[0]?.textContext === null, "image-only list must redact cached text");

  const ocrPrepared = runCli([
    "prepare", image,
    "--target", "stale-ocr",
    "--ocr",
  ], { SCREENSHOTTER_OCR_TEXT: "stale OCR payload" });
  assert(ocrPrepared.screen.ocrText === "stale OCR payload", "OCR test hook should seed compatibility text");
  const directOnly = runCli([
    "prepare", image,
    "--target", "stale-ocr",
    "--with-text",
    "--no-ocr",
  ], { SCREENSHOTTER_ACCESSIBILITY_TEXT: "" });
  assert(directOnly.screen.textContext === null, "empty direct provider should return no context");
  assert(directOnly.screen.ocrText === null, "--no-ocr must clear stale OCR compatibility text");
  assert(directOnly.screen.ocr === null, "--no-ocr must clear stale OCR metadata");

  const bounded = runCli([
    "prepare", image,
    "--target", "bounded",
    "--with-text",
    "--no-ocr",
    "--text-max-chars", "128",
  ], { SCREENSHOTTER_ACCESSIBILITY_TEXT: "x".repeat(20_000) });
  assert(bounded.screen.textContext?.text.length === 128, "provider text must be capped before persistence and return");
  const defaultBounded = runCli([
    "prepare", image,
    "--target", "default-bounded",
    "--with-text",
    "--no-ocr",
  ], { SCREENSHOTTER_ACCESSIBILITY_TEXT: "y".repeat(20_000) });
  assert(defaultBounded.screen.textContext?.text.length === 4000, "default provider text must be capped at 4000 characters");

  const pointerPreferred = runCli([
    "prepare", image,
    "--target", "pointer",
    "--with-text",
    "--no-ocr",
    "--with-target-context",
  ], {
    SCREENSHOTTER_ACCESSIBILITY_TEXT: "pointer-owned text",
    SCREENSHOTTER_SCREEN_TARGET_JSON: targetJson,
  });
  assert(pointerPreferred.screen.textContext?.app === "Pointer App", "pointer window should win target selection when available");

  const sharedA = runCli(["prepare", image, "--target", "shared-a"]);
  const sharedB = runCli(["prepare", image, "--target", "shared-b"]);
  assert(sharedA.screen.optimizedPath === sharedB.screen.optimizedPath, "test requires a shared optimized artifact");
  runCli(["clear", "--target", "shared-a", "--files"]);
  assert(existsSync(sharedB.screen.optimizedPath), "clearing one target must not delete another target's active artifact");

  const concurrentStore = join(workDir, "concurrent-store");
  const sameTarget = await Promise.all(Array.from({ length: 5 }, () => runCliAsync([
    "prepare", image,
    "--target", "same-target",
    "--profile", "token",
  ], {}, concurrentStore)));
  assert(sameTarget.every((result) => result.screen?.optimizedPath), "all concurrent same-target prepares should succeed");
  const sameTargetList = runCli(["list", "--target", "same-target"], {}, concurrentStore);
  assert(sameTargetList.screens.length === 1, "concurrent same-target prepares must commit one record");

  await Promise.all(Array.from({ length: 6 }, (_, index) => runCliAsync([
    "prepare", image,
    "--target", `parallel-${index}`,
    "--profile", "token",
  ], {}, concurrentStore)));
  const concurrentDb = JSON.parse(readFileSync(join(concurrentStore, "screens.json"), "utf8"));
  assert(concurrentDb.screens.length === 7, "concurrent distinct targets must all survive database commits");
  const nativeFingerprintPath = join(concurrentStore, "helpers", "native-image-optimizer.sha256");
  assert(existsSync(nativeFingerprintPath), "Swift helper cache must persist a source fingerprint");
  const expectedFingerprint = createHash("sha256")
    .update(readFileSync(join(root, "scripts", "native-image-optimizer.swift")))
    .update(`\0${process.arch}\0${process.platform}\0${packageVersion}`)
    .digest("hex");
  assert(readFileSync(nativeFingerprintPath, "utf8").trim() === expectedFingerprint, "Swift helper cache key must include source contents");
  assert((statSync(join(concurrentStore, "screens.json")).mode & 0o777) === 0o600, "screen metadata must be user-readable only");
  assert((statSync(join(concurrentStore, "stats.json")).mode & 0o777) === 0o600, "historical stats must be user-readable only");
  assert((statSync(concurrentStore).mode & 0o777) === 0o700, "the store directory must be owner-only");

  const oldTimestamp = "2000-01-01T00:00:00.000Z";
  for (const screen of concurrentDb.screens) {
    screen.preparedAt = oldTimestamp;
    screen.status = "cleared";
    screen.clearedAt = oldTimestamp;
  }
  writeFileSync(join(concurrentStore, "screens.json"), `${JSON.stringify(concurrentDb, null, 2)}\n`);
  const orphan = join(concurrentStore, "optimized", "orphan.jpg");
  writeFileSync(orphan, "orphan");
  const gc = runCli(["gc"], {
    SCREENSHOTTER_READY_RETENTION_MS: "1",
    SCREENSHOTTER_RECORD_RETENTION_MS: "1",
    SCREENSHOTTER_MAX_SCREEN_RECORDS: "3",
  }, concurrentStore);
  assert(gc.retainedRecords === 0, "GC must remove records outside retention");
  assert(!existsSync(orphan), "explicit GC must remove unreferenced optimized files");

  const corruptStore = join(workDir, "corrupt-store");
  runCli(["status"], {}, corruptStore);
  const corruptDb = join(corruptStore, "screens.json");
  writeFileSync(corruptDb, "{broken\n");
  const corruptResult = runCliResult(["status"], {}, corruptStore);
  assert(corruptResult.status !== 0, "corrupt metadata must fail closed");
  assert(readFileSync(corruptDb, "utf8") === "{broken\n", "corrupt metadata must not be overwritten with an empty store");

  const corruptStatsStore = join(workDir, "corrupt-stats-store");
  runCli(["status"], {}, corruptStatsStore);
  const corruptStats = join(corruptStatsStore, "stats.json");
  writeFileSync(corruptStats, "{broken-stats\n");
  const corruptStatsResult = runCliResult(["stats"], {}, corruptStatsStore);
  assert(corruptStatsResult.status !== 0, "corrupt historical stats must fail closed");
  assert(readFileSync(corruptStats, "utf8") === "{broken-stats\n", "corrupt historical stats must not be overwritten");

  const syntheticBenchmark = runProcessSync(process.execPath, [
    benchmark,
    "--skip-vision",
    "--fixtures", "settings-panel",
    "--json",
  ]);
  assert(syntheticBenchmark.status === 0, "dependency-free synthetic benchmark should run without Sharp");
  const syntheticResult = JSON.parse(syntheticBenchmark.stdout);
  assert(syntheticResult.summaries.fixtureSource?.evaluated === 1, "synthetic source baseline should be labeled separately");
  assert(!("dom" in syntheticResult.summaries), "synthetic baseline must not masquerade as live DOM validation");

  const failedProvider = runProcessSync(process.execPath, [
    benchmark,
    "--vision-binary", "/usr/bin/false",
    "--fixtures", "settings-panel",
    "--json",
  ]);
  assert(failedProvider.status !== 0, "requested OCR with zero successful rows must fail the quality gate");
  const failedProviderResult = JSON.parse(failedProvider.stdout);
  assert(failedProviderResult.summaries.visionScreenshotOcr?.evaluated === 0, "forced provider failure should evaluate zero rows");

  assertAccessibilityCleaners(workDir);
  assertMarkdownFencePreservesExtractedCode();
  await assertMcpRemainsResponsive(workDir);

  console.log("context adversarial test passed");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function runCli(args, env = {}, dataDir = store) {
  const result = runCliResult(args, env, dataDir);
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout || "{}");
}

function runCliResult(args, env = {}, dataDir = store) {
  return runProcessSync(process.execPath, [cli, ...args, "--data-dir", dataDir, "--json"], env);
}

async function runCliAsync(args, env = {}, dataDir = store) {
  const result = await runProcess(process.execPath, [cli, ...args, "--data-dir", dataDir, "--json"], env);
  if (result.code !== 0) throw new Error(`${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout || "{}");
}

function runProcessSync(executable, args, env = {}) {
  return spawnSync(executable, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 50 * 1024 * 1024,
  });
}

function assertAccessibilityCleaners(baseDir) {
  const moduleCache = join(baseDir, "swift-module-cache");
  const binary = join(baseDir, "macos-accessibility-text");
  mkdirSync(moduleCache, { recursive: true });
  const compiled = spawnSync("xcrun", [
    "swiftc",
    "-module-cache-path", moduleCache,
    accessibilityHelperSource,
    "-o", binary,
  ], {
    encoding: "utf8",
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache },
    maxBuffer: 20 * 1024 * 1024,
  });
  assert(compiled.status === 0, `Accessibility helper fixture build failed: ${compiled.stderr || compiled.stdout}`);

  const terminal = runCleaner(binary, "terminal", "\u2595 \u2502 first line \u2595 \u2502 second line\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");
  assert(terminal === "first line\nsecond line", "terminal cleaner must repair exposed border separators into line breaks");

  const multiPane = runCleaner(binary, "terminal", [
    "spaces \u2502 be fe terminal +",
    "\u25cf motion \u2502\u2502 \u2595\u2502\u2502cosmic-summit:$ gh run view \\ \u2502",
    "left result \u2595\u2502\u2502right result \u2502",
    "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2502\u2502 useful output",
    "foo | grep ERROR",
  ].join("\n"));
  assert(!/[\u2502\u2503\u2551\u2595\u2590\u2506\u250a\u254e\u254f]/u.test(multiPane), "terminal cleaner must remove Unicode pane dividers");
  assert(multiPane.includes("cosmic-summit:$ gh run view \\"), "terminal cleaner must preserve pane content");
  assert(multiPane.includes("left result\nright result"), "terminal cleaner must split adjacent pane text into separate lines");
  assert(!multiPane.includes("\n\n"), "terminal cleaner must not turn trailing pane borders into blank lines");
  assert(multiPane.includes("foo | grep ERROR"), "terminal cleaner must preserve ASCII shell pipes");

  const browser = runCleaner(binary, "browser", "Back\nReload\nHacker News\nStory title\nWork\n");
  assert(browser === "Hacker News\nStory title", "browser cleaner must remove common browser chrome without dropping page text");

  const assistant = runCleaner(binary, "assistant", [
    "New chat",
    "Worked for 1m",
    "old answer",
    "Jump to assistant message 1",
    "Worked for 2m",
    "latest answer",
    "Copy message",
  ].join("\n"));
  assert(assistant === "Worked for 2m\nlatest answer", "assistant cleaner must retain only the latest transcript block and drop action rows");

  const longAssistant = runCleaner(binary, "assistant", [
    "Worked for 1m",
    "npm run check",
    "old answer",
    "x".repeat(12_000),
    "Worked for 3m",
    "npm run check",
    "npm run check",
    "latest visible answer",
  ].join("\n"));
  assert(longAssistant === "Worked for 3m\nnpm run check\nlatest visible answer", "assistant cleaner must retain repeated code from the latest transcript and deduplicate it locally");

  const workingAssistant = runCleaner(binary, "assistant", [
    "Worked for 3m",
    "completed answer",
    "Working for 4s",
    "Create pull request",
    "current operation",
    "Attach files or connect apps",
  ].join("\n"));
  assert(workingAssistant === "Working for 4s\ncurrent operation", "assistant cleaner must prefer current work and drop composer actions");

  const quotedMarkerAssistant = runCleaner(binary, "assistant", [
    "__SCREENSHOTTER_TURN_MARKER__:Worked for 5m",
    "current answer",
    "Worked for 2m 54s",
    "is quoted inline code, not a turn header",
  ].join("\n"));
  assert(quotedMarkerAssistant === [
    "Worked for 5m",
    "current answer",
    "Worked for 2m 54s",
    "is quoted inline code, not a turn header",
  ].join("\n"), "assistant cleaner must not mistake a quoted duration for a structural turn marker");

  const structuralWorkingAssistant = runCleaner(binary, "assistant", [
    "__SCREENSHOTTER_TURN_MARKER__:Worked for 6m",
    "completed answer",
    "Worked for 2m 54s",
    "__SCREENSHOTTER_TURN_MARKER__:Working for 7s",
    "current operation",
    "Working for 5m 34s",
    "Continue in new task from here",
  ].join("\n"));
  assert(structuralWorkingAssistant === "Working for 7s\ncurrent operation\nWorking for 5m 34s", "assistant cleaner must prefer the structural active marker and retain quoted durations as content");

  const markerlessAssistant = runCleaner(binary, "assistant", [
    "__SCREENSHOTTER_TURN_MARKER__:Worked for 19m 54s",
    "older remote answer",
    "__SCREENSHOTTER_USER_TURN_MARKER__:Edit user message",
    "Edit message",
    "For local Codex, omit all remote handling:",
    "screenshotter toolbar --clipboard-mode attachments",
    "Copy message",
  ].join("\n"));
  assert(markerlessAssistant === [
    "For local Codex, omit all remote handling:",
    "screenshotter toolbar --clipboard-mode attachments",
  ].join("\n"), "assistant cleaner must use the latest structural user boundary when a fast reply has no duration marker");
}

function runCleaner(binary, family, input) {
  const result = spawnSync(binary, ["--clean-fixture", family], {
    input,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  assert(result.status === 0, `${family} cleaner failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function assertMarkdownFencePreservesExtractedCode() {
  const extracted = [
    "Run:",
    "```bash",
    "foo | grep ERROR",
    "```",
  ].join("\n");
  const markdown = formatScreenContextMarkdown({
    id: "fixture",
    optimizedPath: "/tmp/fixture.jpg",
    textSources: [],
  }, extracted);
  assert(markdown.includes("````text\n"), "markdown context must use a longer outer fence around embedded backticks");
  assert(markdown.includes(extracted), "markdown context must preserve extracted code fences exactly");
  assert(!markdown.includes("'''bash"), "markdown context must not rewrite backticks as apostrophes");

}

function runProcess(executable, args, env = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function assertMcpRemainsResponsive(baseDir) {
  const fakeCli = join(baseDir, "slow-cli.mjs");
  writeFileSync(fakeCli, `#!/usr/bin/env node
const delay = process.argv[2] === "status" ? 600 : 0;
setTimeout(() => process.stdout.write(JSON.stringify({ ready: 0 }) + "\\n"), delay);
`);
  const child = spawn(process.execPath, [mcp], {
    env: { ...process.env, SCREENSHOTTER_CLI: fakeCli },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  const order = [];
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) {
      responses.set(message.id, message);
      order.push(message.id);
    }
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  await waitFor(() => responses.has(1), "MCP initialize");
  order.length = 0;
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "screenshotter_status", arguments: { tokens: false } },
  })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: {} })}\n`);
  await waitFor(() => responses.has(2) && responses.has(3), "concurrent MCP responses", 3000);
  assert(order[0] === 3, "MCP ping must remain responsive while a CLI child process is running");
  child.stdin.end();
  await new Promise((resolvePromise) => child.once("close", resolvePromise));
}

async function waitFor(predicate, label, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
