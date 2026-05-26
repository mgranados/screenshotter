#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const VERSION = "0.0.1";
const SCHEMA_VERSION = 1;
const LEGACY_BALANCED_MAX_LONG_EDGE_PX = 3000;
const DEFAULT_MAX_LONG_EDGE_PX = 2200;
const RETINA_DPI_THRESHOLD = 120;
const RETINA_DOWNSCALE_FACTOR = 0.5;
const MIN_RETINA_DOWNSCALE_LONG_EDGE_PX = 3000;
const JPEG_QUALITY = 50;
const SMALL_DIRECT_SEND_BYTES = 256 * 1024;
const FILE_STABLE_INTERVAL_MS = 150;
const FILE_STABLE_TIMEOUT_MS = 5000;
const DEFAULT_FRESH_MS = 10 * 60_000;
const DEFAULT_CLAIM_MAX = 4;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;

const SCREENSHOT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".tif", ".tiff"]);
const DIRECT_SEND_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const JPEG_DERIVATIVE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".tif", ".tiff"]);
const OPTIMIZATION_PROFILES = {
  balanced: {
    profile: "balanced",
    maxLongEdge: DEFAULT_MAX_LONG_EDGE_PX,
    jpegQuality: JPEG_QUALITY,
    smallDirectBytes: SMALL_DIRECT_SEND_BYTES,
    retinaDownscale: true,
  },
  token: {
    profile: "token",
    maxLongEdge: 1024,
    jpegQuality: 45,
    smallDirectBytes: 128 * 1024,
    retinaDownscale: false,
  },
  readability: {
    profile: "readability",
    maxLongEdge: 4096,
    jpegQuality: 78,
    smallDirectBytes: 512 * 1024,
    retinaDownscale: false,
  },
};
const LEGACY_BALANCED_OPTIMIZE_KEY = optimizationKey({
  ...OPTIMIZATION_PROFILES.balanced,
  maxLongEdge: LEGACY_BALANCED_MAX_LONG_EDGE_PX,
});

main().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);

  switch (command) {
    case "codex":
      return codexCommand(argv);
    case "claude":
      return claudeCommand(argv);
    case "codex-app":
      return codexAppCommand(args);
    case "claude-app":
      return claudeAppCommand(args);
    case "clip":
    case "paste":
      return clipboardCommand(args);
    case "prepare":
    case "stage":
      return prepareCommand(args);
    case "prepare-latest":
    case "stage-latest":
      return prepareLatestCommand(args);
    case "watch":
      return watchCommand(args);
    case "list":
      return listCommand(args);
    case "claim":
    case "drain":
      return claimCommand(args);
    case "clear":
      return clearCommand(args);
    case "status":
      return statusCommand(args);
    case "copy":
      return copyCommand(args);
    case "reveal":
      return revealCommand(args);
    case "screenshot-dir":
      return screenshotDirCommand(args);
    case "data-dir":
      return dataDirCommand(args);
    case "bench":
      return benchCommand(args);
    case "version":
    case "--version":
    case "-v":
      return writeText(`${VERSION}\n`);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return writeText(usage());
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

async function prepareCommand(args) {
  const input = args._[0];
  if (!input) throw new Error("prepare requires an image path");

  const sourcePath = resolve(expandHome(input));
  const sourceStat = await waitForStableFile(sourcePath);
  if (!sourceStat) throw new Error(`File did not become stable: ${sourcePath}`);
  if (!isSupportedScreenshotPath(sourcePath)) throw new Error(`Unsupported screenshot type: ${sourcePath}`);

  const store = storePaths(args);
  await ensureStore(store);
  const result = await prepareOne(store, sourcePath, sourceStat, args.target ?? null, optimizationOptions(args));
  return writeResult(args, result);
}

async function prepareLatestCommand(args) {
  return writeResult(args, await prepareLatest(args));
}

async function prepareLatest(args) {
  const screenshotDir = resolve(expandHome(args.dir ?? macScreenshotDir()));
  const [sourcePath] = await latestImages(screenshotDir, 1);
  if (!sourcePath) throw new Error(`No screenshots found in ${screenshotDir}`);

  const sourceStat = await waitForStableFile(sourcePath);
  if (!sourceStat) throw new Error(`File did not become stable: ${sourcePath}`);

  const store = storePaths(args);
  await ensureStore(store);
  return prepareOne(store, sourcePath, sourceStat, args.target ?? null, optimizationOptions(args));
}

async function watchCommand(args) {
  if (process.platform !== "darwin") throw new Error("watch currently supports native macOS screenshots only");

  const target = args.target ?? "default";
  const options = optimizationOptions(args);
  const watchDir = resolve(expandHome(args.dir ?? macScreenshotDir()));
  const watchStat = await safeStat(watchDir);
  if (!watchStat?.isDirectory()) throw new Error(`screenshot folder is not available: ${watchDir}`);

  const store = storePaths(args);
  await ensureStore(store);
  const sinceMs = Date.now();
  const processingPaths = new Set();
  const processingTasks = new Set();

  writeText(`agent-screens watching ${watchDir} for target ${target}\n`);
  writeText(`store: ${store.dataDir}\n`);

  const prepareCandidate = async (candidatePath) => {
    if (!isSupportedScreenshotPath(candidatePath)) return;
    const key = resolve(candidatePath);
    if (processingPaths.has(key)) return;
    processingPaths.add(key);

    try {
      const fileStat = await waitForStableFile(candidatePath);
      if (!fileStat) return;
      if (Math.max(fileStat.birthtimeMs, fileStat.ctimeMs, fileStat.mtimeMs) < sinceMs - 1000) return;
      const started = performance.now();
      const result = await prepareOne(store, key, fileStat, target, options);
      const screen = result.screen;
      writeText(`${result.prepared ? "ready" : "seen"} ${screen.id} ${formatBytes(screen.originalBytes)} -> ${formatBytes(screen.optimizedBytes)} in ${round(performance.now() - started, 1)}ms\n`);
    } catch (error) {
      console.error(`failed to prepare ${candidatePath}: ${formatError(error)}`);
    } finally {
      processingPaths.delete(key);
    }
  };

  const scanRecent = async () => {
    const entries = await readdir(watchDir).catch(() => []);
    for (const entry of entries) await prepareCandidate(join(watchDir, entry));
  };

  const track = (task) => {
    processingTasks.add(task);
    task.finally(() => processingTasks.delete(task));
  };

  const watcher = fs.watch(watchDir, (eventType, fileName) => {
    if (eventType !== "rename" && eventType !== "change") return;
    const name = normalizeWatchFileName(fileName);
    track(name ? prepareCandidate(join(watchDir, name)) : scanRecent());
  });

  await new Promise((resolvePromise, rejectPromise) => {
    watcher.on("error", rejectPromise);
    process.once("SIGINT", resolvePromise);
    process.once("SIGTERM", resolvePromise);
  }).finally(async () => {
    watcher.close();
    await Promise.allSettled([...processingTasks]);
  });
}

async function prepareOne(store, sourcePath, sourceStat, target, rawOptions = {}) {
  const options = normalizeOptimizationOptions(rawOptions);
  const source = await inspectSourceFile(sourcePath);
  const hash = source.hash;
  const now = new Date().toISOString();
  const optimizeKey = optimizationKey(options);

  return withStoreLock(store, async () => {
    const db = await readDb(store);
    const existing = db.screens.find((screen) => (
      screen.hash === hash
      && screenState(screen) === "ready"
      && (!screen.target || screen.target === target)
      && screenOptimizationKey(screen) === optimizeKey
    ));
    if (existing) {
      if (target && !existing.target) {
        existing.target = target;
        await writeDb(store, db);
      }
      return { screen: existing, prepared: false };
    }

    const optimized = await optimizeForPrompt(store, sourcePath, hash, sourceStat, source.metadata, options);
    const screen = {
      id: `scr_${hash.slice(0, 12)}_${Date.now().toString(36)}`,
      hash,
      sourcePath,
      optimizedPath: optimized.path,
      mimeType: optimized.mimeType,
      createdAt: new Date(Math.max(sourceStat.birthtimeMs, sourceStat.ctimeMs, sourceStat.mtimeMs)).toISOString(),
      preparedAt: now,
      claimedAt: null,
      clearedAt: null,
      status: "ready",
      target,
      originalBytes: sourceStat.size,
      optimizedBytes: optimized.bytes,
      width: optimized.width,
      height: optimized.height,
      originalWidth: optimized.originalWidth,
      originalHeight: optimized.originalHeight,
      optimized: optimized.optimized,
      profile: options.profile,
      optimizeKey,
      maxLongEdge: options.maxLongEdge,
      maxPatches: options.maxPatches ?? null,
      jpegQuality: options.jpegQuality,
    };
    db.screens.push(screen);
    await writeDb(store, db);
    return { screen, prepared: true };
  });
}

async function listCommand(args) {
  const store = storePaths(args);
  await ensureStore(store);
  const db = await readDb(store);
  const screens = filterScreens(db.screens, args);
  return writeResult(args, { screens });
}

async function claimCommand(args) {
  return writeResult(args, await claimScreens(args));
}

async function claimScreens(args) {
  const store = storePaths(args);
  await ensureStore(store);
  const target = args.target ?? "default";
  const max = parsePositiveInteger(args.max, DEFAULT_CLAIM_MAX);
  const freshMs = parseNonNegativeInteger(args["fresh-ms"], DEFAULT_FRESH_MS);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  return withStoreLock(store, async () => {
    const db = await readDb(store);
    const screens = db.screens
      .filter((screen) => screenState(screen) === "ready")
      .filter((screen) => !screen.target || screen.target === target)
      .filter((screen) => nowMs - screenPreparedAtMs(screen) <= freshMs)
      .sort((a, b) => screenPreparedAtMs(a) - screenPreparedAtMs(b))
      .slice(0, max);

    for (const screen of screens) {
      screen.status = "claimed";
      screen.target = target;
      screen.claimedAt = now;
    }

    await writeDb(store, db);
    return { screens };
  });
}

async function clearCommand(args) {
  const store = storePaths(args);
  await ensureStore(store);
  const now = new Date().toISOString();
  const removeFiles = Boolean(args.files);

  const result = await withStoreLock(store, async () => {
    const db = await readDb(store);
    const screens = filterScreens(db.screens, { ...args, status: args.status ?? undefined })
      .filter((screen) => screenState(screen) !== "cleared");

    for (const screen of screens) {
      screen.status = "cleared";
      screen.clearedAt = now;
      if (removeFiles) await rm(screen.optimizedPath, { force: true });
    }

    await writeDb(store, db);
    return { cleared: screens.length };
  });

  return writeResult(args, result);
}

async function statusCommand(args) {
  const store = storePaths(args);
  await ensureStore(store);
  const db = await readDb(store);
  const screens = filterScreens(db.screens, args);
  const ready = screens.filter((screen) => screenState(screen) === "ready").length;
  const claimed = screens.filter((screen) => screenState(screen) === "claimed").length;
  const cleared = screens.filter((screen) => screenState(screen) === "cleared").length;
  const activeScreens = screens.filter((screen) => screenState(screen) !== "cleared");
  const originalBytes = activeScreens.reduce((sum, screen) => sum + (screen.originalBytes ?? 0), 0);
  const optimizedBytes = activeScreens.reduce((sum, screen) => sum + (screen.optimizedBytes ?? 0), 0);
  const result = {
    version: VERSION,
    dataDir: store.dataDir,
    screenshotDir: macScreenshotDir(),
    ready,
    claimed,
    cleared,
    total: screens.length,
    bytes: {
      original: originalBytes,
      optimized: optimizedBytes,
      saved: Math.max(0, originalBytes - optimizedBytes),
      savedPercent: originalBytes > 0 ? round((1 - optimizedBytes / originalBytes) * 100, 1) : 0,
    },
    latest: activeScreens.at(-1) ? publicScreen(activeScreens.at(-1)) : null,
  };
  if (args.tokens || args["token-estimates"]) result.tokenEstimates = summarizeTokenEstimates(activeScreens);
  return writeResult(args, result);
}

async function copyCommand(args) {
  const store = storePaths(args);
  await ensureStore(store);
  const db = await readDb(store);
  const screens = filterScreens(db.screens, defaultReadyFilter(args));
  const format = args.format ?? "markdown";
  let text = "";

  if (format === "paths") {
    text = screens.map((screen) => screen.optimizedPath).join("\n");
  } else if (format === "json") {
    text = JSON.stringify({ screens }, null, 2);
  } else if (format === "markdown") {
    text = screens.map((screen) => `![${screen.id}](${screen.optimizedPath})`).join("\n");
  } else {
    throw new Error(`Unknown copy format: ${format}`);
  }

  if (args.clipboard) {
    await pbcopy(text);
    return writeResult(args, { copied: true, count: screens.length, format });
  }

  return writeText(text ? `${text}\n` : "");
}

async function revealCommand(args) {
  const store = storePaths(args);
  await ensureStore(store);
  const db = await readDb(store);
  const screens = filterScreens(db.screens, defaultReadyFilter(args));
  const screen = screens.at(-1);
  if (!screen) throw new Error("No matching screenshots to reveal");

  if (args.json || args["dry-run"]) {
    return writeResult({ json: true }, { path: screen.optimizedPath, screen });
  }

  const result = run("open", ["-R", screen.optimizedPath], { timeoutMs: 5000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `open exited with ${result.status}`);
}

async function screenshotDirCommand(args) {
  return writeResult(args, { path: macScreenshotDir() });
}

async function dataDirCommand(args) {
  return writeResult(args, { path: storePaths(args).dataDir });
}

async function codexCommand(argv) {
  const { args, appArgv, result } = await claimForWrapper(argv, "codex");

  const codexArgs = [];
  for (const screen of result.screens) {
    if (screen.optimizedPath) codexArgs.push("--image", screen.optimizedPath);
  }
  codexArgs.push(...appArgv);

  if (args["dry-run"] || args.json) {
    return writeText(`${JSON.stringify({
      command: "codex",
      args: codexArgs,
      screens: result.screens.map(publicScreen),
    }, null, 2)}\n`);
  }

  await spawnPassthrough("codex", codexArgs);
}

async function claudeCommand(argv) {
  const { args, appArgv, result } = await claimForWrapper(argv, "claude-code");
  const claudeArgs = appendClaudeImagePrompt(appArgv, result.screens);

  if (args["dry-run"] || args.json) {
    return writeText(`${JSON.stringify({
      command: "claude",
      args: claudeArgs,
      screens: result.screens.map(publicScreen),
    }, null, 2)}\n`);
  }

  await spawnPassthrough("claude", claudeArgs);
}

async function claimForWrapper(argv, defaultTarget) {
  const { wrapperArgv, appArgv } = splitWrapperArgs(argv);
  const args = parseArgs(wrapperArgv);
  const target = args.target ?? defaultTarget;
  const result = await claimScreens({
    ...args,
    target,
    max: args.max ?? DEFAULT_CLAIM_MAX,
    "fresh-ms": args["fresh-ms"] ?? DEFAULT_FRESH_MS,
  });
  return { args, appArgv, result };
}

async function spawnPassthrough(command, args) {
  const child = spawn(command, args, { stdio: "inherit" });

  await new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 1;
      resolvePromise();
    });
  });
}

function appendClaudeImagePrompt(claudeArgv, screens) {
  const paths = screens.map((screen) => screen.optimizedPath).filter(Boolean);
  if (paths.length === 0) return [...claudeArgv];

  const imagePrompt = [
    "Use these screenshot image files as visual context:",
    ...paths.map((path, index) => `${index + 1}. ${path}`),
  ].join("\n");

  const claudeArgs = [...claudeArgv];
  const promptIndex = findLastClaudePromptIndex(claudeArgs);
  if (promptIndex === -1) {
    claudeArgs.push(imagePrompt);
  } else {
    claudeArgs[promptIndex] = `${claudeArgs[promptIndex]}\n\n${imagePrompt}`;
  }

  return claudeArgs;
}

function findLastClaudePromptIndex(args) {
  const valueFlags = new Set([
    "--agent",
    "--agents",
    "--append-system-prompt",
    "--debug-file",
    "--effort",
    "--fallback-model",
    "--from-pr",
    "--input-format",
    "--json-schema",
    "--max-budget-usd",
    "--model",
    "--name",
    "--output-format",
    "--permission-mode",
    "--remote-control",
    "--remote-control-session-name-prefix",
    "--resume",
    "--session-id",
    "--setting-sources",
    "--settings",
    "--system-prompt",
    "-n",
    "-r",
  ]);
  const variadicValueFlags = new Set([
    "--add-dir",
    "--allowedTools",
    "--allowed-tools",
    "--betas",
    "--disallowedTools",
    "--disallowed-tools",
    "--file",
    "--mcp-config",
    "--plugin-dir",
    "--plugin-url",
    "--tools",
  ]);

  let lastPromptIndex = -1;
  let skipNext = false;
  let consumingVariadic = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (token === "--") {
      consumingVariadic = false;
      continue;
    }

    if (token.startsWith("-")) {
      consumingVariadic = false;
      const [flag] = token.split("=", 1);
      if (token.includes("=")) continue;
      if (valueFlags.has(flag)) skipNext = true;
      if (variadicValueFlags.has(flag)) consumingVariadic = true;
      continue;
    }

    if (consumingVariadic) continue;
    lastPromptIndex = index;
  }

  return lastPromptIndex;
}

async function clipboardCommand(args, options = {}) {
  const target = args.target ?? options.target ?? "clipboard";
  const appLabel = options.appLabel ?? (target === "clipboard" ? "the active app" : target);
  const result = await prepareLatest({ ...args, target });
  const screen = result.screen;
  const shouldReveal = Boolean(args.reveal);
  const shouldCopyImage = !shouldReveal && !args["dry-run"];

  if (shouldCopyImage) await copyImageToClipboard(screen.optimizedPath);

  if (args.json || args["dry-run"]) {
    return writeResult({ json: true }, {
      path: screen.optimizedPath,
      prepared: result.prepared,
      target,
      clipboard: shouldReveal ? null : (shouldCopyImage ? "image" : "image-dry-run"),
      attach: shouldReveal
        ? "Use the app's file picker or drag this file into the prompt."
        : `Paste into ${appLabel} with Cmd+V.`,
      screen,
    });
  }

  if (shouldReveal) {
    const revealResult = run("open", ["-R", screen.optimizedPath], { timeoutMs: 5000 });
    if (revealResult.status !== 0) throw new Error(revealResult.stderr || revealResult.stdout || `open exited with ${revealResult.status}`);
  }

  return writeText([
    `Prepared: ${screen.optimizedPath}`,
    shouldReveal
      ? "Attach it with the app's file picker, or drag the revealed file into the prompt."
      : `The optimized image is on the clipboard. Paste it into ${appLabel} with Cmd+V.`,
  ].filter(Boolean).join("\n") + "\n");
}

async function codexAppCommand(args) {
  return clipboardCommand(args, {
    target: "codex-app",
    appLabel: "the Codex prompt",
  });
}

async function claudeAppCommand(args) {
  return clipboardCommand(args, {
    target: "claude-app",
    appLabel: "Claude",
  });
}

async function benchCommand(args) {
  const limit = parsePositiveInteger(args.latest ?? args.limit, 10);
  const screenshotDir = resolve(expandHome(args.dir ?? macScreenshotDir()));
  const files = await latestImages(screenshotDir, limit);
  const options = optimizationOptions(args);
  const dataDir = args["data-dir"]
    ? resolve(expandHome(args["data-dir"]))
    : await mkdtemp(join(tmpdir(), "agent-screens-bench-"));
  const store = storePaths({ ...args, "data-dir": dataDir });
  await ensureStore(store);

  const rows = [];
  for (const file of files) {
    const sourceStat = await waitForStableFile(file);
    if (!sourceStat) continue;
    const started = performance.now();
    const result = await prepareOne(store, file, sourceStat, args.target ?? "bench", options);
    const durationMs = performance.now() - started;
    const screen = result.screen;
    const row = {
      path: file,
      ext: extname(file).toLowerCase(),
      originalBytes: screen.originalBytes,
      optimizedBytes: screen.optimizedBytes,
      savedPercent: round((1 - screen.optimizedBytes / screen.originalBytes) * 100, 1),
      width: screen.width,
      height: screen.height,
      originalWidth: screen.originalWidth,
      originalHeight: screen.originalHeight,
      mimeType: screen.mimeType,
      profile: screen.profile ?? options.profile,
      maxLongEdge: screen.maxLongEdge ?? options.maxLongEdge,
      maxPatches: screen.maxPatches ?? options.maxPatches ?? null,
      durationMs: round(durationMs, 1),
      prepared: result.prepared,
    };
    if (args.tokens || args["token-estimates"]) row.tokenEstimates = tokenEstimatesForDimensions(row);
    rows.push(row);
  }

  const durations = rows.map((row) => row.durationMs).sort((a, b) => a - b);
  const originalBytes = rows.reduce((sum, row) => sum + row.originalBytes, 0);
  const optimizedBytes = rows.reduce((sum, row) => sum + row.optimizedBytes, 0);
  const timing = {
    min: durations[0] ?? 0,
    median: durations[Math.floor(durations.length / 2)] ?? 0,
    max: durations.at(-1) ?? 0,
    avg: round(durations.reduce((sum, value) => sum + value, 0) / Math.max(durations.length, 1), 1),
  };
  const result = {
    screenshotDir,
    dataDir,
    profile: options.profile,
    options: {
      maxLongEdge: options.maxLongEdge,
      maxPatches: options.maxPatches ?? null,
      jpegQuality: options.jpegQuality,
    },
    sampleCount: rows.length,
    prepareMs: timing,
    originalBytes,
    optimizedBytes,
    savedPercent: originalBytes > 0 ? round((1 - optimizedBytes / originalBytes) * 100, 1) : 0,
    rows,
  };
  if (args.tokens || args["token-estimates"]) result.tokenEstimates = summarizeTokenEstimates(rows);
  return writeResult(args, result);
}

function filterScreens(screens, args) {
  const state = requestedState(args);
  return screens
    .filter((screen) => !args.target || !screen.target || screen.target === args.target)
    .filter((screen) => !state || screenState(screen) === state)
    .sort((a, b) => screenPreparedAtMs(a) - screenPreparedAtMs(b));
}

function defaultReadyFilter(args) {
  if (args.state || args.status) return args;
  return { ...args, state: "ready" };
}

function screenState(screen) {
  return stateForStatus(screen.status) ?? stateForStatus(screen.state) ?? screen.status ?? screen.state;
}

function stateForStatus(status) {
  if (!status) return undefined;
  switch (status) {
    case "ready":
    case "staged":
      return "ready";
    case "claimed":
    case "drained":
      return "claimed";
    case "cleared":
      return "cleared";
    default:
      return undefined;
  }
}

function requestedState(args) {
  return stateForStatus(args.state) ?? stateForStatus(args.status) ?? args.state ?? args.status;
}

function screenPreparedAt(screen) {
  return screen.preparedAt ?? screen.stagedAt ?? screen.createdAt ?? null;
}

function screenClaimedAt(screen) {
  return screen.claimedAt ?? screen.drainedAt ?? null;
}

function screenPreparedAtMs(screen) {
  const timestamp = Date.parse(screenPreparedAt(screen) ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function optimizeForPrompt(store, inputPath, hash, sourceStat, sourceMetadata, rawOptions = {}) {
  const options = normalizeOptimizationOptions(rawOptions);
  const sourceExt = extname(inputPath).toLowerCase();
  const metadata = sourceMetadata ?? imageMetadata(inputPath);
  const resizeLongEdge = getResizeLongEdge(metadata, options);
  const needsResize = resizeLongEdge !== undefined;
  const cacheResizeLabel = resizeLongEdge ?? options.maxLongEdge;
  const stem = hash.slice(0, 24);

  if (!needsResize && sourceStat.size <= options.smallDirectBytes && DIRECT_SEND_EXTENSIONS.has(sourceExt)) {
    return createFallbackCandidate(inputPath, store.optimizedDir, stem, sourceExt, metadata);
  }

  if (JPEG_DERIVATIVE_EXTENSIONS.has(sourceExt)) {
    const jpeg = await createSipsCandidate(inputPath, join(store.optimizedDir, `${stem}-max${cacheResizeLabel}-q${options.jpegQuality}.jpg`), ".jpg", resizeLongEdge, metadata, true, options);
    if (jpeg && (needsResize || jpeg.bytes < sourceStat.size)) return jpeg;
  }

  const fallback = await createFallbackCandidate(inputPath, store.optimizedDir, stem, sourceExt, metadata);
  if (!fallback) throw new Error(`Could not optimize ${inputPath}`);
  return fallback;
}

async function createSipsCandidate(inputPath, outputPath, outputExt, resizeLongEdge, originalMetadata, optimized, rawOptions = {}) {
  const options = normalizeOptimizationOptions(rawOptions);
  const mimeType = mimeTypeForExtension(outputExt);
  if (!mimeType) return undefined;
  if (await existingFile(outputPath)) return candidateFromPath(outputPath, outputExt, mimeType, originalMetadata, optimized);

  const args = [];
  if (outputExt === ".png") args.push("-s", "format", "png");
  if (outputExt === ".jpg") args.push("-s", "format", "jpeg", "-s", "formatOptions", String(options.jpegQuality));
  if (resizeLongEdge !== undefined) args.push("--resampleHeightWidthMax", String(resizeLongEdge));
  args.push(inputPath, "--out", outputPath);

  const result = run("sips", args, { timeoutMs: 15_000 });
  if (result.status !== 0) return undefined;
  return candidateFromPath(outputPath, outputExt, mimeType, originalMetadata, optimized);
}

async function createFallbackCandidate(inputPath, outputDir, stem, sourceExt, originalMetadata) {
  const fallbackExt = normalizeDirectExtension(sourceExt);
  const fallbackMime = mimeTypeForExtension(fallbackExt);
  if (!fallbackMime) return undefined;

  const fallbackPath = join(outputDir, `${stem}${fallbackExt}`);
  if (!(await existingFile(fallbackPath))) await copyFile(inputPath, fallbackPath);
  return candidateFromPath(fallbackPath, fallbackExt, fallbackMime, originalMetadata, false);
}

async function candidateFromPath(path, ext, mimeType, originalMetadata, optimized) {
  const file = await stat(path);
  if (!file.isFile() || file.size === 0) return undefined;
  const metadata = dimensionsAfterResize(originalMetadata, path);
  return {
    path,
    ext,
    mimeType,
    bytes: file.size,
    width: metadata.width,
    height: metadata.height,
    originalWidth: originalMetadata.width,
    originalHeight: originalMetadata.height,
    optimized,
  };
}

function getResizeLongEdge(metadata, rawOptions = {}) {
  const options = normalizeOptimizationOptions(rawOptions);
  const maxLongEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0);
  if (maxLongEdge <= 0) return undefined;

  const patchTarget = options.maxPatches ? maxLongEdgeForPatchBudget(metadata, options.maxPatches) : maxLongEdge;
  const isLikelyRetina = options.retinaDownscale && Math.max(metadata.dpiWidth ?? 0, metadata.dpiHeight ?? 0) >= RETINA_DPI_THRESHOLD;
  const retinaTarget = isLikelyRetina && maxLongEdge >= MIN_RETINA_DOWNSCALE_LONG_EDGE_PX
    ? Math.round(maxLongEdge * RETINA_DOWNSCALE_FACTOR)
    : maxLongEdge;
  const target = Math.min(options.maxLongEdge, patchTarget, retinaTarget);
  return target < maxLongEdge ? target : undefined;
}

function dimensionsAfterResize(originalMetadata, outputPath) {
  const width = originalMetadata.width;
  const height = originalMetadata.height;
  if (!width || !height) return {};

  const match = /-max(\d+)-q\d+\.jpg$/.exec(outputPath);
  const maxEdge = match ? Number(match[1]) : undefined;
  const originalLongEdge = Math.max(width, height);
  if (!maxEdge || maxEdge >= originalLongEdge) return { width, height };

  const scale = maxEdge / originalLongEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function optimizationOptions(args = {}) {
  const requestedProfile = args.profile ?? "balanced";
  if (!OPTIMIZATION_PROFILES[requestedProfile]) {
    throw new Error(`Unknown profile: ${requestedProfile}. Use token, balanced, or readability.`);
  }

  const base = OPTIMIZATION_PROFILES[requestedProfile];
  return normalizeOptimizationOptions({
    ...base,
    maxLongEdge: args["max-long-edge"] ?? args.maxLongEdge ?? base.maxLongEdge,
    maxPatches: args["max-patches"] ?? args.maxPatches ?? base.maxPatches,
    jpegQuality: args["jpeg-quality"] ?? args.jpegQuality ?? base.jpegQuality,
  });
}

function normalizeOptimizationOptions(rawOptions = {}) {
  const profile = rawOptions.profile ?? "balanced";
  const fallback = OPTIMIZATION_PROFILES[profile] ?? OPTIMIZATION_PROFILES.balanced;
  const maxLongEdge = parsePositiveInteger(rawOptions.maxLongEdge ?? fallback.maxLongEdge, fallback.maxLongEdge);
  const maxPatches = rawOptions.maxPatches === undefined || rawOptions.maxPatches === null
    ? undefined
    : parsePositiveInteger(rawOptions.maxPatches, undefined);
  const jpegQuality = clamp(parsePositiveInteger(rawOptions.jpegQuality ?? fallback.jpegQuality, fallback.jpegQuality), 1, 100);
  const smallDirectBytes = parseNonNegativeInteger(rawOptions.smallDirectBytes ?? fallback.smallDirectBytes, fallback.smallDirectBytes);

  return {
    profile,
    maxLongEdge,
    maxPatches,
    jpegQuality,
    smallDirectBytes,
    retinaDownscale: Boolean(rawOptions.retinaDownscale ?? fallback.retinaDownscale),
  };
}

function optimizationKey(rawOptions = {}) {
  const options = normalizeOptimizationOptions(rawOptions);
  return [
    `profile=${options.profile}`,
    `maxLongEdge=${options.maxLongEdge}`,
    `maxPatches=${options.maxPatches ?? "none"}`,
    `jpegQuality=${options.jpegQuality}`,
    `smallDirectBytes=${options.smallDirectBytes}`,
    `retinaDownscale=${options.retinaDownscale ? 1 : 0}`,
  ].join(";");
}

function screenOptimizationKey(screen) {
  return screen.optimizeKey ?? LEGACY_BALANCED_OPTIMIZE_KEY;
}

function maxLongEdgeForPatchBudget(metadata, maxPatches) {
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) return Number.POSITIVE_INFINITY;
  if (patchCount(width, height) <= maxPatches) return Math.max(width, height);

  const targetPixels = maxPatches * 32 * 32;
  const scale = Math.sqrt(targetPixels / (width * height));
  let targetLongEdge = Math.max(1, Math.floor(Math.max(width, height) * scale));
  while (targetLongEdge > 1) {
    const resized = dimensionsForLongEdge(width, height, targetLongEdge);
    if (patchCount(resized.width, resized.height) <= maxPatches) return targetLongEdge;
    targetLongEdge -= 1;
  }
  return targetLongEdge;
}

function dimensionsForLongEdge(width, height, maxLongEdge) {
  const originalLongEdge = Math.max(width, height);
  if (maxLongEdge >= originalLongEdge) return { width, height };
  const scale = maxLongEdge / originalLongEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function tokenEstimatesForScreen(screen) {
  return tokenEstimatesForDimensions({
    originalWidth: screen.originalWidth,
    originalHeight: screen.originalHeight,
    width: screen.width,
    height: screen.height,
  });
}

function tokenEstimatesForDimensions(dimensions) {
  const originalWidth = dimensions.originalWidth;
  const originalHeight = dimensions.originalHeight;
  const width = dimensions.width;
  const height = dimensions.height;

  return {
    openaiLowDetail: tokenEstimatePair(originalWidth, originalHeight, width, height, () => 85, "tokens"),
    gpt5HighDetailTiles: tokenEstimatePair(originalWidth, originalHeight, width, height, (w, h) => highDetailTileTokens(w, h, 70, 140), "tokens"),
    gpt4oHighDetailTiles: tokenEstimatePair(originalWidth, originalHeight, width, height, (w, h) => highDetailTileTokens(w, h, 85, 170), "tokens"),
    patchBudget1536: tokenEstimatePair(originalWidth, originalHeight, width, height, (w, h) => patchCount(w, h, 1536), "patches"),
    patchBudget2500: tokenEstimatePair(originalWidth, originalHeight, width, height, (w, h) => patchCount(w, h, 2500), "patches"),
    patchBudget10000: tokenEstimatePair(originalWidth, originalHeight, width, height, (w, h) => patchCount(w, h, 10000), "patches"),
  };
}

function summarizeTokenEstimates(rows) {
  const totals = {};
  for (const row of rows) {
    const estimates = row.tokenEstimates ?? tokenEstimatesForDimensions(row);
    for (const [name, estimate] of Object.entries(estimates)) {
      totals[name] ??= { unit: estimate.unit, original: 0, optimized: 0, saved: 0 };
      totals[name].original += estimate.original;
      totals[name].optimized += estimate.optimized;
      totals[name].saved += estimate.saved;
    }
  }

  for (const estimate of Object.values(totals)) {
    estimate.savedPercent = estimate.original > 0 ? round((1 - estimate.optimized / estimate.original) * 100, 1) : 0;
  }

  return {
    note: "Estimates use image dimensions. JPEG byte compression alone does not reduce image-token cost unless dimensions change.",
    modes: totals,
  };
}

function tokenEstimatePair(originalWidth, originalHeight, width, height, estimator, unit) {
  const original = estimator(originalWidth, originalHeight);
  const optimized = estimator(width, height);
  return {
    unit,
    original,
    optimized,
    saved: original - optimized,
    savedPercent: original > 0 ? round((1 - optimized / original) * 100, 1) : 0,
  };
}

function highDetailTileTokens(width, height, baseTokens, tileTokens) {
  if (!width || !height) return 0;
  const scaled = scaleForHighDetail(width, height);
  return baseTokens + Math.ceil(scaled.width / 512) * Math.ceil(scaled.height / 512) * tileTokens;
}

function scaleForHighDetail(width, height) {
  let scaledWidth = width;
  let scaledHeight = height;
  const maxEdge = Math.max(scaledWidth, scaledHeight);
  if (maxEdge > 2048) {
    const scale = 2048 / maxEdge;
    scaledWidth *= scale;
    scaledHeight *= scale;
  }

  const minEdge = Math.min(scaledWidth, scaledHeight);
  if (minEdge > 768) {
    const scale = 768 / minEdge;
    scaledWidth *= scale;
    scaledHeight *= scale;
  }

  return { width: scaledWidth, height: scaledHeight };
}

function patchCount(width, height, budget) {
  if (!width || !height) return 0;
  const raw = Math.ceil(width / 32) * Math.ceil(height / 32);
  return budget ? Math.min(raw, budget) : raw;
}

function imageMetadata(path) {
  const result = run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "dpiWidth", "-g", "dpiHeight", path], { timeoutMs: 10_000 });
  if (result.status !== 0) return {};
  return {
    width: parseSipsProperty(result.stdout, "pixelWidth"),
    height: parseSipsProperty(result.stdout, "pixelHeight"),
    dpiWidth: parseSipsProperty(result.stdout, "dpiWidth"),
    dpiHeight: parseSipsProperty(result.stdout, "dpiHeight"),
  };
}

async function inspectSourceFile(path) {
  const bytes = await readFile(path);
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    metadata: parseImageMetadata(bytes, extname(path).toLowerCase()) ?? imageMetadata(path),
  };
}

function parseImageMetadata(bytes, ext) {
  if (ext === ".png") return parsePngMetadata(bytes);
  if (ext === ".jpg" || ext === ".jpeg") return parseJpegMetadata(bytes);
  if (ext === ".gif") return parseGifMetadata(bytes);
  if (ext === ".webp") return parseWebpMetadata(bytes);
  return undefined;
}

function parsePngMetadata(bytes) {
  if (bytes.length < 33) return undefined;
  if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return undefined;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;

  const metadata = {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };

  let offset = 33;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataOffset = offset + 8;
    if (dataOffset + length + 4 > bytes.length) break;
    if (type === "pHYs" && length >= 9 && bytes[dataOffset + 8] === 1) {
      metadata.dpiWidth = Math.round(bytes.readUInt32BE(dataOffset) * 0.0254);
      metadata.dpiHeight = Math.round(bytes.readUInt32BE(dataOffset + 4) * 0.0254);
      break;
    }
    if (type === "IDAT" || type === "IEND") break;
    offset = dataOffset + length + 4;
  }

  return validDimensions(metadata) ? metadata : undefined;
}

function parseJpegMetadata(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const metadata = {};
  let offset = 2;

  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;

    const length = bytes.readUInt16BE(offset);
    const dataOffset = offset + 2;
    if (length < 2 || dataOffset + length - 2 > bytes.length) break;

    if (marker === 0xe0) parseJfifDensity(bytes, dataOffset, length - 2, metadata);
    if (isJpegStartOfFrame(marker) && length >= 7) {
      metadata.height = bytes.readUInt16BE(dataOffset + 1);
      metadata.width = bytes.readUInt16BE(dataOffset + 3);
      return validDimensions(metadata) ? metadata : undefined;
    }

    offset = dataOffset + length - 2;
  }

  return undefined;
}

function parseJfifDensity(bytes, offset, length, metadata) {
  if (length < 12 || bytes.toString("ascii", offset, offset + 5) !== "JFIF\u0000") return;
  const units = bytes[offset + 7];
  const xDensity = bytes.readUInt16BE(offset + 8);
  const yDensity = bytes.readUInt16BE(offset + 10);
  if (units === 1) {
    metadata.dpiWidth = xDensity;
    metadata.dpiHeight = yDensity;
  } else if (units === 2) {
    metadata.dpiWidth = Math.round(xDensity * 2.54);
    metadata.dpiHeight = Math.round(yDensity * 2.54);
  }
}

function isJpegStartOfFrame(marker) {
  return (marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function parseGifMetadata(bytes) {
  if (bytes.length < 10) return undefined;
  const signature = bytes.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  const metadata = {
    width: bytes.readUInt16LE(6),
    height: bytes.readUInt16LE(8),
  };
  return validDimensions(metadata) ? metadata : undefined;
}

function parseWebpMetadata(bytes) {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const chunk = bytes.toString("ascii", 12, 16);

  if (chunk === "VP8X" && bytes.length >= 30) {
    const metadata = {
      width: 1 + readUInt24LE(bytes, 24),
      height: 1 + readUInt24LE(bytes, 27),
    };
    return validDimensions(metadata) ? metadata : undefined;
  }

  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    const metadata = {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
    return validDimensions(metadata) ? metadata : undefined;
  }

  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    const metadata = {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
    };
    return validDimensions(metadata) ? metadata : undefined;
  }

  return undefined;
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function validDimensions(metadata) {
  return Number.isFinite(metadata.width) && metadata.width > 0 && Number.isFinite(metadata.height) && metadata.height > 0;
}

function parseSipsProperty(output, key) {
  const match = new RegExp(`${key}:\\s*(\\d+)`).exec(output);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function macScreenshotDir() {
  const fallback = join(homedir(), "Desktop");
  const result = run("defaults", ["read", "com.apple.screencapture", "location"], { timeoutMs: 3000 });
  const configured = result.status === 0 ? expandHome(result.stdout.trim()) : "";
  return configured && isDirectorySync(configured) ? configured : fallback;
}

async function waitForStableFile(filePath) {
  const deadline = Date.now() + FILE_STABLE_TIMEOUT_MS;
  let previousSize = -1;
  let stableReads = 0;

  while (Date.now() < deadline) {
    const current = await safeStat(filePath);
    if (current?.isFile() && current.size > 0) {
      if (current.size === previousSize) {
        stableReads += 1;
        if (stableReads >= 2) return current;
      } else {
        stableReads = 0;
        previousSize = current.size;
      }
    }
    await delay(FILE_STABLE_INTERVAL_MS);
  }

  return undefined;
}

async function withStoreLock(store, fn) {
  const started = Date.now();
  while (true) {
    try {
      await mkdir(store.lockDir);
      break;
    } catch {
      const lockStat = await safeStat(store.lockDir);
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await rm(store.lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for store lock: ${store.lockDir}`);
      await delay(50);
    }
  }

  try {
    return await fn();
  } finally {
    await rmdir(store.lockDir).catch(() => {});
  }
}

async function ensureStore(store) {
  await mkdir(store.dataDir, { recursive: true });
  await mkdir(store.originalsDir, { recursive: true });
  await mkdir(store.optimizedDir, { recursive: true });
  await mkdir(dirname(store.dbPath), { recursive: true });
  if (!(await existingFile(store.dbPath))) await writeDb(store, emptyDb());
}

async function readDb(store) {
  try {
    const parsed = JSON.parse(await readFile(store.dbPath, "utf8"));
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.screens)) return emptyDb();
    return parsed;
  } catch {
    return emptyDb();
  }
}

async function writeDb(store, db) {
  const tmpPath = `${store.dbPath}.tmp-${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(db, null, 2)}\n`);
  await rename(tmpPath, store.dbPath);
}

function emptyDb() {
  return { schemaVersion: SCHEMA_VERSION, screens: [] };
}

function storePaths(args) {
  const dataDir = resolve(expandHome(args["data-dir"] ?? process.env.AGENT_SCREENS_DATA_DIR ?? defaultDataDir()));
  return {
    dataDir,
    dbPath: join(dataDir, "screens.json"),
    lockDir: join(dataDir, ".screens.lock"),
    originalsDir: join(dataDir, "originals"),
    optimizedDir: resolve(expandHome(args["optimized-dir"] ?? process.env.AGENT_SCREENS_OPTIMIZED_DIR ?? join(dataDir, "optimized"))),
  };
}

function defaultDataDir() {
  return join(homedir(), "Library", "Application Support", "agent-screens");
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") args.json = true;
    else if (token === "--clipboard") args.clipboard = true;
    else if (token === "--files") args.files = true;
    else if (token === "--dry-run") args["dry-run"] = true;
    else if (token === "--reveal") args.reveal = true;
    else if (token === "--tokens") args.tokens = true;
    else if (token === "--token-estimates") args["token-estimates"] = true;
    else if (token.startsWith("--")) {
      const [key, inlineValue] = token.slice(2).split("=", 2);
      args[key] = inlineValue ?? argv[++index];
    } else {
      args._.push(token);
    }
  }
  return args;
}

function splitWrapperArgs(argv) {
  const wrapperArgv = [];
  const appArgv = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough) {
      appArgv.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (token === "--dry-run" || token === "--json") {
      wrapperArgv.push(token);
      continue;
    }

    if (["--target", "--max", "--fresh-ms", "--data-dir", "--optimized-dir", "--profile", "--max-long-edge", "--max-patches"].includes(token)) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${token} requires a value`);
      wrapperArgv.push(token, value);
      continue;
    }

    const assignment = /^--(target|max|fresh-ms|data-dir|optimized-dir|profile|max-long-edge|max-patches)=/.exec(token);
    if (assignment) {
      wrapperArgv.push(token);
      continue;
    }

    appArgv.push(token);
  }

  return { wrapperArgv, appArgv };
}

function writeResult(args, value) {
  const result = publicResult(value);
  if (args.json) return writeText(`${JSON.stringify(result, null, 2)}\n`);
  if ("screens" in result) return writeText(formatScreens(result.screens));
  return writeText(`${JSON.stringify(result, null, 2)}\n`);
}

function formatScreens(screens) {
  if (screens.length === 0) return "No screenshots\n";
  return `${screens.map((screen) => `${screen.id} ${screen.status} ${screen.optimizedPath}`).join("\n")}\n`;
}

function publicResult(value) {
  if (!value || typeof value !== "object") return value;
  const result = { ...value };
  if (result.screen) result.screen = publicScreen(result.screen);
  if (Array.isArray(result.screens)) result.screens = result.screens.map(publicScreen);
  return result;
}

function publicScreen(screen) {
  const status = screenState(screen);
  return {
    id: screen.id,
    hash: screen.hash,
    sourcePath: screen.sourcePath,
    optimizedPath: screen.optimizedPath,
    mimeType: screen.mimeType,
    createdAt: screen.createdAt,
    preparedAt: screenPreparedAt(screen),
    claimedAt: screenClaimedAt(screen),
    clearedAt: screen.clearedAt ?? null,
    status,
    target: screen.target,
    originalBytes: screen.originalBytes,
    optimizedBytes: screen.optimizedBytes,
    width: screen.width,
    height: screen.height,
    originalWidth: screen.originalWidth,
    originalHeight: screen.originalHeight,
    optimized: screen.optimized,
    profile: screen.profile ?? "balanced",
    maxLongEdge: screen.maxLongEdge ?? null,
    maxPatches: screen.maxPatches ?? null,
    jpegQuality: screen.jpegQuality ?? null,
  };
}

function writeText(text) {
  process.stdout.write(text);
}

function usage() {
  return `agent-screens ${VERSION}

Usage:
  agent-screens codex [wrapper options] -- [codex args...]
  agent-screens claude [wrapper options] -- [claude args...]
  agent-screens clip [--target app] [--json]
  agent-screens paste [--target app] [--json]
  agent-screens codex-app [--json] [--reveal]
  agent-screens claude-app [--json] [--reveal]
  agent-screens watch [--target codex]
  agent-screens prepare <image> [--target pi] [--profile token|balanced|readability] [--json]
  agent-screens prepare-latest [--target codex-app] [--profile token|balanced|readability] [--json]
  agent-screens list [--target pi] [--state ready] [--json]
  agent-screens claim [--target pi] [--max 4] [--json]
  agent-screens clear [--target pi] [--files] [--json]
  agent-screens status [--target pi] [--tokens] [--json]
  agent-screens copy [--format markdown|paths|json] [--clipboard]
  agent-screens reveal [--target codex-app]
  agent-screens bench [--latest 10] [--profile token|balanced|readability] [--max-long-edge px] [--max-patches n] [--tokens] [--json]
  agent-screens screenshot-dir [--json]
  agent-screens data-dir [--json]

Environment:
  AGENT_SCREENS_DATA_DIR       Override the store directory.
  AGENT_SCREENS_OPTIMIZED_DIR  Override optimized image output directory.

Profiles:
  balanced     Fast default: max long edge 2200 px, JPEG quality 50.
  token        Token-aware: max long edge 1024 px, JPEG quality 45.
  readability  Higher fidelity: max long edge 4096 px, JPEG quality 78.

Compatibility:
  stage, stage-latest, drain, and --status staged/drained/cleared still work.
`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

async function pbcopy(text) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("pbcopy", []);
    child.on("error", rejectPromise);
    child.on("close", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`pbcopy exited with ${code}`)));
    child.stdin.end(text);
  });
}

async function copyImageToClipboard(path) {
  const script = `
ObjC.import("AppKit");

function run(argv) {
  const path = argv[0];
  const image = $.NSImage.alloc.initWithContentsOfFile(path);
  if (!image) throw new Error("Could not read image: " + path);

  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  if (!pasteboard.writeObjects($.NSArray.arrayWithObject(image))) throw new Error("Could not write image to clipboard");
}
`;
  const result = run("osascript", ["-l", "JavaScript", "-e", script, path], { timeoutMs: 5000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `osascript exited with ${result.status}`);
}

function normalizeDirectExtension(ext) {
  return ext === ".jpeg" ? ".jpg" : ext;
}

function mimeTypeForExtension(ext) {
  switch (normalizeDirectExtension(ext)) {
    case ".png":
      return "image/png";
    case ".jpg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return undefined;
  }
}

function isSupportedScreenshotPath(filePath) {
  return SCREENSHOT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function normalizeWatchFileName(fileName) {
  if (!fileName) return undefined;
  return typeof fileName === "string" ? fileName : fileName.toString("utf8");
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

async function existingFile(path) {
  const current = await safeStat(path);
  return Boolean(current?.isFile() && current.size > 0);
}

async function safeStat(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

function isDirectorySync(path) {
  try {
    const result = spawnSync("/bin/test", ["-d", path]);
    return result.status === 0;
  } catch {
    return false;
  }
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) throw new Error(`Expected positive integer, got ${value}`);
  return Math.floor(numeric);
}

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new Error(`Expected non-negative integer, got ${value}`);
  return Math.floor(numeric);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function latestImages(dir, limit) {
  const entries = await readdir(dir, { withFileTypes: true });
  const images = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = join(dir, entry.name);
    if (!isSupportedScreenshotPath(filePath)) continue;
    const fileStat = await stat(filePath);
    images.push({ path: filePath, mtimeMs: fileStat.mtimeMs });
  }
  return images
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.path);
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
