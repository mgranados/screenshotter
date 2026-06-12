#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const VERSION = "0.0.1";
const SCHEMA_VERSION = 1;
const BALANCED_MAX_LONG_EDGE_PX = 3000;
const BALANCED_JPEG_QUALITY = 85;
const TOKEN_MAX_LONG_EDGE_PX = 2200;
const TOKEN_JPEG_QUALITY = 50;
const TOKEN_NO_RESIZE_JPEG_QUALITY = 75;
const RETINA_DPI_THRESHOLD = 120;
const RETINA_DOWNSCALE_FACTOR = 0.5;
const MIN_RETINA_DOWNSCALE_LONG_EDGE_PX = 3000;
const SMALL_DIRECT_SEND_BYTES = 256 * 1024;
const FILE_STABLE_INTERVAL_MS = 150;
const FILE_STABLE_TIMEOUT_MS = 5000;
const DEFAULT_FRESH_MS = 10 * 60_000;
const DEFAULT_CLAIM_MAX = 4;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_OPTIMIZER_SOURCE = join(ROOT_DIR, "scripts", "native-image-optimizer.swift");
const MENU_BAR_CONTROLLER_SOURCE = join(ROOT_DIR, "scripts", "menu-bar-controller.swift");
const DEFAULT_PROFILE = "readability";
const DEFAULT_OPTIMIZER = "sharp";
const READABILITY_MAX_OUTPUT_BYTES = 1_000_000;
const SHARP_JPEG_MIN_QUALITY = 85;
const SHARP_JPEG_CHROMA_SUBSAMPLING = "4:4:4";
const SHARP_JPEG_QUANTISATION_TABLE = 3;

const SCREENSHOT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".tif", ".tiff"]);
const DIRECT_SEND_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const JPEG_DERIVATIVE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".tif", ".tiff"]);
const WRAPPER_BOOLEAN_FLAGS = new Set(["--dry-run", "--json", "--verbose", "--log", "--no-log", "--no-clipboard"]);
const WRAPPER_VALUE_FLAGS = new Set([
  "--target",
  "--max",
  "--fresh-ms",
  "--data-dir",
  "--optimized-dir",
  "--profile",
  "--optimizer",
  "--max-long-edge",
  "--long-edge-percent",
  "--min-long-edge",
  "--jpeg-quality",
  "--max-output-bytes",
  "--max-patches",
]);
const OPTIMIZATION_PROFILES = {
  balanced: {
    profile: "balanced",
    maxLongEdge: BALANCED_MAX_LONG_EDGE_PX,
    jpegQuality: BALANCED_JPEG_QUALITY,
    smallDirectBytes: SMALL_DIRECT_SEND_BYTES,
    retinaDownscale: false,
    optimizer: DEFAULT_OPTIMIZER,
  },
  token: {
    profile: "token",
    maxLongEdge: TOKEN_MAX_LONG_EDGE_PX,
    jpegQuality: TOKEN_JPEG_QUALITY,
    noResizeJpegQuality: TOKEN_NO_RESIZE_JPEG_QUALITY,
    smallDirectBytes: 0,
    retinaDownscale: false,
    optimizer: DEFAULT_OPTIMIZER,
  },
  readability: {
    profile: "readability",
    maxLongEdge: 4096,
    jpegQuality: 90,
    maxOutputBytes: READABILITY_MAX_OUTPUT_BYTES,
    smallDirectBytes: 512 * 1024,
    retinaDownscale: false,
    optimizer: DEFAULT_OPTIMIZER,
  },
};
const nativeOptimizerBinaries = new Map();
const menuBarControllerBinaries = new Map();
let sharpModulePromise;

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
      return prepareCommand(args);
    case "prepare-latest":
      return prepareLatestCommand(args);
    case "watch":
      return watchCommand(args);
    case "toolbar":
    case "menubar":
    case "menu-bar":
      return watchCommand({ ...args, toolbar: true });
    case "list":
      return listCommand(args);
    case "claim":
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
    case "doctor":
      return doctorCommand(args);
    case "bench":
      return benchCommand(args);
    case "mcp-server":
      return mcpServerCommand(argv);
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

  const { store, result } = await preparePath(args, input);
  await reportScreenEvent(args, store, "prepare", result.screen, { prepared: result.prepared });
  return writeResult(args, result);
}

async function prepareLatestCommand(args) {
  const { store, result } = await prepareLatestWithStore(args);
  await reportScreenEvent(args, store, "prepare-latest", result.screen, { prepared: result.prepared });
  return writeResult(args, result);
}

async function prepareLatest(args) {
  return (await prepareLatestWithStore(args)).result;
}

async function prepareLatestWithStore(args) {
  const screenshotDir = resolve(expandHome(args.dir ?? macScreenshotDir()));
  const [sourcePath] = await latestImages(screenshotDir, 1);
  if (!sourcePath) throw new Error(`No screenshots found in ${screenshotDir}`);

  return preparePath(args, sourcePath);
}

async function preparePath(args, input) {
  const sourcePath = resolve(expandHome(input));
  const sourceStat = await waitForStableFile(sourcePath);
  if (!sourceStat) throw new Error(`File did not become stable: ${sourcePath}`);
  if (!isSupportedScreenshotPath(sourcePath)) throw new Error(`Unsupported screenshot type: ${sourcePath}`);

  const store = storePaths(args);
  await ensureStore(store);
  const result = await prepareOne(store, sourcePath, sourceStat, args.target ?? null, optimizationOptions(args));
  return { store, result };
}

async function watchCommand(args) {
  if (process.platform !== "darwin") throw new Error("watch currently supports native macOS screenshots only");

  const watchTarget = resolveWatchTarget(args);
  const target = watchTarget.target;
  const watchArgs = { ...args, target, clipboard: watchTarget.clipboard };
  const watchState = {
    enabled: true,
    profile: args.profile ?? DEFAULT_PROFILE,
    options: optimizationOptions(args),
    ready: 0,
    history: [],
  };
  const watchDir = resolve(expandHome(args.dir ?? macScreenshotDir()));
  const watchStat = await safeStat(watchDir);
  if (!watchStat?.isDirectory()) throw new Error(`screenshot folder is not available: ${watchDir}`);

  const store = storePaths(args);
  await ensureStore(store);
  await prewarmOptimizer(watchState.options);
  let sinceMs = Date.now();
  const pollIntervalMs = parsePositiveInteger(args["poll-ms"], DEFAULT_POLL_INTERVAL_MS);
  const processingPaths = new Set();
  const processingTasks = new Set();
  const fileSignatures = new Map();
  const toolbarMode = Boolean(args.toolbar || args.menubar);
  let menuBar;
  let watcher;
  let pollTimer;
  let controlTimer;
  let stopWatch;

  writeText(`screenshotter ${toolbarMode ? "toolbar" : "watch"}\n`);
  writeText(`watching: ${watchDir}\n`);
  if (args.target && args.target !== "auto") writeText(`target: ${target}\n`);
  writeText(`store: ${store.dataDir}\n`);
  writeText(`profile: ${formatProfileSummary(watchState.options, { concise: true, includeProfileId: false })}\n`);
  writeText(`clipboard: ${formatWatchDelivery(watchArgs)}\n`);

  const countReady = async () => {
    const db = await readDb(store);
    return filterScreens(db.screens, { target, state: "ready" }).length;
  };

  const pushControlState = async () => {
    if (!menuBar) return;
    watchState.ready = await countReady().catch(() => 0);
    menuBar.sendState({
      enabled: watchState.enabled,
      profile: watchState.profile,
      ready: watchState.ready,
      target,
      history: watchState.history,
    });
  };

  const snapshotFileSignatures = async () => {
    fileSignatures.clear();
    const entries = await readdir(watchDir).catch(() => []);
    for (const entry of entries) {
      const candidatePath = join(watchDir, entry);
      if (!isSupportedScreenshotPath(candidatePath)) continue;
      const fileStat = await safeStat(candidatePath);
      if (fileStat?.isFile()) fileSignatures.set(resolve(candidatePath), fileSignature(fileStat));
    }
  };

  const setCaptureEnabled = async (enabled) => {
    if (watchState.enabled === enabled) return;
    watchState.enabled = enabled;
    if (enabled) {
      sinceMs = Date.now();
      await snapshotFileSignatures();
    }
    writeText(`capture ${watchState.enabled ? "on" : "off"}\n`);
    await pushControlState();
  };

  const setWatchProfile = async (profile) => {
    if (!Object.hasOwn(OPTIMIZATION_PROFILES, profile)) return;
    watchState.profile = profile;
    watchState.options = optimizationOptions({ ...args, profile });
    await prewarmOptimizer(watchState.options);
    writeText(`profile: ${formatProfileSummary(watchState.options, { concise: true, includeProfileId: false })}\n`);
    await pushControlState();
  };

  const handleControlCommand = async (command) => {
    switch (command?.type) {
      case "toggle":
        await setCaptureEnabled(!watchState.enabled);
        return;
      case "profile":
        if (!watchState.enabled) await setCaptureEnabled(true);
        await setWatchProfile(command.profile);
        return;
      case "quit":
        stopWatch?.();
        return;
      default:
        return;
    }
  };

  if (toolbarMode) {
    menuBar = await startMenuBarController(store, handleControlCommand, watchArgs);
    if (menuBar) {
      writeText("menu bar: ready\n");
      await pushControlState();
      controlTimer = setInterval(() => {
        pushControlState().catch(() => undefined);
      }, 5000);
      controlTimer.unref?.();
    } else {
      writeText("menu bar: unavailable; continuing without menu bar controls\n");
    }
  }

  const prepareCandidate = async (candidatePath) => {
    if (!watchState.enabled) return;
    if (!isSupportedScreenshotPath(candidatePath)) return;
    const key = resolve(candidatePath);
    if (processingPaths.has(key)) return;
    processingPaths.add(key);

    try {
      const fileStat = await waitForStableFile(candidatePath);
      if (!fileStat) return;
      const signature = fileSignature(fileStat);
      if (fileSignatures.get(key) === signature) return;
      if (Math.max(fileStat.birthtimeMs, fileStat.ctimeMs, fileStat.mtimeMs) < sinceMs - 1000) {
        fileSignatures.set(key, signature);
        return;
      }
      const started = performance.now();
      const result = await prepareOne(store, key, fileStat, target, watchState.options);
      const screen = result.screen;
      const clipboard = await maybeCopyWatchImage(watchArgs, screen);
      const durationMs = round(performance.now() - started, 1);
      if (result.prepared && menuBar) {
        watchState.history = [
          compressionHistoryEntry(screen),
          ...watchState.history,
        ].slice(0, 3);
      }
      fileSignatures.set(key, signature);
      await reportScreenEvent(watchArgs, store, "watch.prepare", screen, {
        prepared: result.prepared,
        durationMs,
        clipboard: clipboard.status,
        clipboardError: clipboard.error,
        targetSource: watchTarget.source,
      });
      writeText(formatWatchPrepareLine(result, screen, durationMs, clipboard.label, watchArgs));
      await pushControlState();
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

  const startPolling = (reason) => {
    if (pollTimer) return;
    if (reason) writeText(`native watcher unavailable; polling every ${pollIntervalMs}ms (${formatError(reason)})\n`);
    pollTimer = setInterval(() => track(scanRecent()), pollIntervalMs);
    track(scanRecent());
  };

  try {
    watcher = fs.watch(watchDir, (eventType, fileName) => {
      if (eventType !== "rename" && eventType !== "change") return;
      const name = normalizeWatchFileName(fileName);
      track(name ? prepareCandidate(join(watchDir, name)) : scanRecent());
    });
    watcher.on("error", (error) => {
      watcher?.close();
      watcher = undefined;
      startPolling(error);
    });
  } catch (error) {
    startPolling(error);
  }

  await new Promise((resolvePromise) => {
    stopWatch = resolvePromise;
    process.once("SIGINT", stopWatch);
    process.once("SIGTERM", stopWatch);
  }).finally(async () => {
    watcher?.close();
    clearInterval(pollTimer);
    clearInterval(controlTimer);
    menuBar?.stop();
    await Promise.allSettled([...processingTasks]);
  });
}

async function maybeCopyWatchImage(args, screen) {
  if (!args.clipboard) return { status: null, label: "" };
  if (args["dry-run"]) return { status: "image-dry-run", label: "clipboard dry-run" };
  try {
    await copyImageToClipboard(screen.optimizedPath);
    return { status: "image", label: "copied" };
  } catch (error) {
    return { status: "failed", label: "clipboard failed", error: formatError(error) };
  }
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
      && screen.optimizeKey === optimizeKey
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
      longEdgePercent: options.longEdgePercent ?? null,
      minLongEdge: options.minLongEdge ?? null,
      maxPatches: options.maxPatches ?? null,
      jpegQuality: optimized.jpegQuality ?? options.jpegQuality,
      maxOutputBytes: options.maxOutputBytes ?? null,
      optimizer: optimized.optimizer ?? "unknown",
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

async function doctorCommand(args) {
  const store = storePaths(args);
  const screenshotDir = macScreenshotDir();
  const checks = [];

  const add = (name, status, message, details = {}) => {
    checks.push({ name, status, message, ...details });
  };

  add(
    "platform",
    process.platform === "darwin" ? "pass" : "fail",
    process.platform === "darwin" ? "macOS detected" : `unsupported platform: ${process.platform}`,
  );

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add(
    "node",
    nodeMajor >= 20 ? "pass" : "fail",
    `Node ${process.versions.node}`,
  );

  const screenshotDirStat = await safeStat(screenshotDir);
  add(
    "screenshot directory",
    screenshotDirStat?.isDirectory() ? "pass" : "fail",
    screenshotDirStat?.isDirectory() ? screenshotDir : `not found: ${screenshotDir}`,
    { path: screenshotDir },
  );

  try {
    await ensureStore(store);
    add("data store", "pass", store.dataDir, { path: store.dataDir });
  } catch (error) {
    add("data store", "fail", formatError(error), { path: store.dataDir });
  }

  addToolCheck(checks, "sips", "fallback optimizer");
  addToolCheck(checks, "osascript", "image clipboard helper");
  addToolCheck(checks, "pbcopy", "text clipboard helper");
  addToolCheck(checks, "defaults", "macOS screenshot location lookup");

  const sharp = await loadSharpModule();
  add(
    "sharp optimizer",
    sharp ? "pass" : "warn",
    sharp ? `sharp ${sharp.versions?.sharp ?? "available"}` : "sharp not available; will fall back to native ImageIO",
  );

  const hasXcrun = commandExists("xcrun");
  const hasNativeSource = await existingFile(NATIVE_OPTIMIZER_SOURCE);
  if (!hasNativeSource) {
    add("native optimizer", "warn", `missing helper source: ${NATIVE_OPTIMIZER_SOURCE}`);
  } else if (!hasXcrun) {
    add("native optimizer", "warn", "xcrun not found; will fall back to sips");
  } else {
    const swiftc = run("xcrun", ["-find", "swiftc"], { timeoutMs: 5000 });
    add(
      "native optimizer",
      swiftc.status === 0 ? "pass" : "warn",
      swiftc.status === 0 ? "Swift compiler available" : "Swift compiler not found; will fall back to sips",
    );
  }

  const defaultOptions = optimizationOptions(args);
  const autoWatch = resolveWatchTarget({});
  const failed = checks.some((check) => check.status === "fail");
  const warned = checks.some((check) => check.status === "warn");
  const result = {
    ok: !failed,
    status: failed ? "fail" : warned ? "warn" : "pass",
    version: VERSION,
    screenshotDir,
    dataDir: store.dataDir,
    defaultProfile: {
      profile: defaultOptions.profile,
      maxLongEdge: defaultOptions.maxLongEdge,
      longEdgePercent: defaultOptions.longEdgePercent ?? null,
      minLongEdge: defaultOptions.minLongEdge ?? null,
      jpegQuality: defaultOptions.jpegQuality,
      maxOutputBytes: defaultOptions.maxOutputBytes ?? null,
      optimizer: defaultOptions.optimizer,
    },
    autoWatch,
    checks,
  };

  if (failed) process.exitCode = 1;
  if (args.json) return writeResult(args, result);

  return writeText(formatDoctor(result));
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

async function mcpServerCommand(argv) {
  await spawnPassthrough(process.execPath, [join(ROOT_DIR, "bin", "screenshotter-mcp.mjs"), ...argv]);
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
  await reportScreenEvent(args, storePaths(args), "clipboard", screen, {
    prepared: result.prepared,
    clipboard: shouldReveal ? null : (shouldCopyImage ? "image" : "image-dry-run"),
    appLabel,
  });

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
  if (args.watch) throw new Error("Use `screenshotter watch --verbose`; watch auto-detects Codex app.");

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
  const requestedOptimizer = normalizeOptimizer(args.optimizer ?? options.optimizer ?? "native");
  const dataDir = args["data-dir"]
    ? resolve(expandHome(args["data-dir"]))
    : await mkdtemp(join(tmpdir(), "screenshotter-bench-"));
  const store = storePaths({ ...args, "data-dir": dataDir });
  await ensureStore(store);
  await prewarmOptimizer(options);

  let effectiveOptimizer = requestedOptimizer;
  let rows;
  if (requestedOptimizer === "native") {
    rows = await benchNativeBatch(store, files, args, { ...options, optimizer: "native" });
  } else {
    rows = await benchPrepareRows(store, files, args, { ...options, optimizer: requestedOptimizer });
  }
  if (!rows && requestedOptimizer === "native") {
    effectiveOptimizer = "sips";
    rows = await benchPrepareRows(store, files, args, { ...options, optimizer: "sips" });
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
      longEdgePercent: options.longEdgePercent ?? null,
      minLongEdge: options.minLongEdge ?? null,
      maxPatches: options.maxPatches ?? null,
      jpegQuality: options.jpegQuality,
      maxOutputBytes: options.maxOutputBytes ?? null,
      optimizer: effectiveOptimizer,
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

async function benchPrepareRows(store, files, args, options) {
  const rows = [];
  for (const file of files) {
    const sourceStat = await waitForStableFile(file);
    if (!sourceStat) continue;
    const started = performance.now();
    const result = await prepareOne(store, file, sourceStat, args.target ?? "bench", options);
    const durationMs = performance.now() - started;
    const row = benchRowFromScreen(file, result.screen, options, durationMs, result.prepared);
    if (args.tokens || args["token-estimates"]) row.tokenEstimates = tokenEstimatesForDimensions(row);
    rows.push(row);
  }
  return rows;
}

async function benchNativeBatch(store, files, args, rawOptions = {}) {
  const binary = await nativeOptimizerBinary(store);
  if (!binary) return undefined;

  const options = normalizeOptimizationOptions(rawOptions);
  const groups = new Map();
  const sourceStats = new Map();
  const targetEdges = new Map();
  for (const file of files) {
    const sourceStat = await waitForStableFile(file);
    if (!sourceStat) continue;
    sourceStats.set(file, sourceStat);
    const metadata = imageMetadata(file);
    const maxLongEdge = getResizeLongEdge(metadata, options) ?? options.maxLongEdge;
    targetEdges.set(file, maxLongEdge);
    if (!groups.has(maxLongEdge)) groups.set(maxLongEdge, []);
    groups.get(maxLongEdge).push(file);
  }

  const nativeRows = new Map();
  for (const [maxLongEdge, groupFiles] of groups) {
    const result = run(binary, [
      "--out-dir", store.optimizedDir,
      "--max-long-edge", String(maxLongEdge),
      "--quality", String(options.jpegQuality),
      "--small-direct-bytes", String(options.smallDirectBytes),
      ...groupFiles,
    ], { timeoutMs: Math.max(60_000, groupFiles.length * 15_000) });
    if (result.status !== 0) return undefined;

    const parsed = parseJsonish(result.stdout);
    if (!Array.isArray(parsed.rows)) return undefined;
    for (const row of parsed.rows) nativeRows.set(row.path, row);
  }

  const rows = [];
  for (const file of files) {
    const nativeRow = nativeRows.get(file);
    if (!nativeRow) continue;
    let row = benchRowFromNative(nativeRow, options, targetEdges.get(file));
    if (!row || nativeRow.error) {
      const sourceStat = sourceStats.get(file) ?? await waitForStableFile(file);
      if (!sourceStat) continue;
      const started = performance.now();
      const fallback = await prepareOne(store, file, sourceStat, args.target ?? "bench", { ...options, optimizer: "sips" });
      row = benchRowFromScreen(file, fallback.screen, options, performance.now() - started, fallback.prepared);
    }
    if (args.tokens || args["token-estimates"]) row.tokenEstimates = tokenEstimatesForDimensions(row);
    rows.push(row);
  }
  return rows;
}

function benchRowFromScreen(file, screen, options, durationMs, prepared) {
  return {
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
    longEdgePercent: screen.longEdgePercent ?? options.longEdgePercent ?? null,
    minLongEdge: screen.minLongEdge ?? options.minLongEdge ?? null,
    maxPatches: screen.maxPatches ?? options.maxPatches ?? null,
    jpegQuality: screen.jpegQuality ?? options.jpegQuality,
    maxOutputBytes: screen.maxOutputBytes ?? options.maxOutputBytes ?? null,
    durationMs: round(durationMs, 1),
    prepared,
    optimizer: screen.optimizer ?? options.optimizer ?? "sips",
  };
}

function compressionHistoryEntry(screen) {
  const originalBytes = screen.originalBytes ?? 0;
  const optimizedBytes = screen.optimizedBytes ?? 0;
  const savedPercent = originalBytes > 0
    ? Math.max(0, round((1 - optimizedBytes / originalBytes) * 100, 1))
    : 0;

  return {
    name: basename(screen.sourcePath ?? screen.optimizedPath ?? screen.id ?? "screenshot"),
    savedPercent,
    originalBytes,
    optimizedBytes,
    optimized: Boolean(screen.optimized),
    optimizer: screen.optimizer ?? "unknown",
    profile: screen.profile ?? null,
  };
}

function formatCompressionSummary(screen) {
  const originalBytes = screen.originalBytes ?? 0;
  const optimizedBytes = screen.optimizedBytes ?? 0;
  if (!screen.optimized) return `${formatBytes(originalBytes)} unchanged`;
  const savedPercent = originalBytes > 0
    ? Math.max(0, round((1 - optimizedBytes / originalBytes) * 100, 1))
    : 0;
  return `${formatBytes(originalBytes)} -> ${formatBytes(optimizedBytes)} (${formatPercent(savedPercent)} saved)`;
}

function formatWatchPrepareLine(result, screen, durationMs, clipboardLabel, args) {
  const verbose = shouldVerbose(args);
  return [
    result.prepared ? "ready" : "seen",
    profileDisplayName(screen.profile ?? DEFAULT_PROFILE),
    verbose ? screen.id : undefined,
    formatCompressionSummary(screen),
    formatOptimizerSummary(screen, { verbose }),
    `in ${durationMs}ms`,
    clipboardLabel,
  ].filter(Boolean).join(" ") + "\n";
}

function formatOptimizerSummary(screen, { verbose = false } = {}) {
  if (!screen.optimized) return undefined;
  if (!verbose && screen.jpegQuality) return `q${screen.jpegQuality}`;
  if (!verbose) return undefined;
  return [
    screen.optimizer,
    screen.jpegQuality ? `q${screen.jpegQuality}` : undefined,
  ].filter(Boolean).join("/");
}

function benchRowFromNative(row, options, maxLongEdge) {
  if (row.error || !row.optimizedPath || !row.optimizedBytes) return undefined;
  const optimizedExt = extname(row.optimizedPath).toLowerCase();
  const mimeType = mimeTypeForExtension(optimizedExt);
  if (!mimeType) return undefined;
  return {
    path: row.path,
    ext: extname(row.path).toLowerCase(),
    originalBytes: row.originalBytes,
    optimizedBytes: row.optimizedBytes,
    savedPercent: row.savedPercent,
    width: row.width,
    height: row.height,
    originalWidth: row.originalWidth,
    originalHeight: row.originalHeight,
    mimeType,
    profile: options.profile,
    maxLongEdge: maxLongEdge ?? options.maxLongEdge,
    longEdgePercent: options.longEdgePercent ?? null,
    minLongEdge: options.minLongEdge ?? null,
    maxPatches: options.maxPatches ?? null,
    jpegQuality: options.jpegQuality,
    maxOutputBytes: options.maxOutputBytes ?? null,
    durationMs: row.durationMs,
    prepared: true,
    optimizer: row.optimized ? "native" : "copy",
  };
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
      return "ready";
    case "claimed":
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
  return screen.preparedAt ?? screen.createdAt ?? null;
}

function screenClaimedAt(screen) {
  return screen.claimedAt ?? null;
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
  const candidateOptions = {
    ...options,
    jpegQuality: effectiveJpegQuality(options, needsResize),
  };
  const cacheResizeLabel = resizeLongEdge ?? options.maxLongEdge;
  const stem = hash.slice(0, 24);

  if (!needsResize && sourceStat.size <= options.smallDirectBytes && DIRECT_SEND_EXTENSIONS.has(sourceExt)) {
    return createFallbackCandidate(inputPath, store.optimizedDir, stem, sourceExt, metadata);
  }

  if (JPEG_DERIVATIVE_EXTENSIONS.has(sourceExt)) {
    if (options.optimizer === "sharp") {
      const sharp = await createSharpCandidate(store, inputPath, stem, resizeLongEdge, metadata, candidateOptions);
      if (sharp && (needsResize || sharp.bytes < sourceStat.size)) return sharp;
    }
    if (options.optimizer !== "sips") {
      const native = await createNativeCandidate(store, inputPath, stem, resizeLongEdge, metadata, candidateOptions);
      if (native && (needsResize || native.bytes < sourceStat.size)) return native;
    }
    const jpeg = await createSipsCandidate(inputPath, join(store.optimizedDir, `${stem}-max${cacheResizeLabel}-q${candidateOptions.jpegQuality}.jpg`), ".jpg", resizeLongEdge, metadata, true, candidateOptions);
    if (jpeg && (needsResize || jpeg.bytes < sourceStat.size)) return jpeg;
  }

  const fallback = await createFallbackCandidate(inputPath, store.optimizedDir, stem, sourceExt, metadata);
  if (!fallback) throw new Error(`Could not optimize ${inputPath}`);
  return fallback;
}

function effectiveJpegQuality(options, needsResize) {
  if (needsResize || options.noResizeJpegQuality === undefined || options.noResizeJpegQuality === null) {
    return options.jpegQuality;
  }
  return Math.max(options.jpegQuality, options.noResizeJpegQuality);
}

async function createSharpCandidate(store, inputPath, stem, resizeLongEdge, originalMetadata, rawOptions = {}) {
  const sharp = await loadSharpModule();
  if (!sharp) return undefined;

  const options = normalizeOptimizationOptions(rawOptions);
  const maxLongEdge = resizeLongEdge ?? options.maxLongEdge;
  const outputExt = ".jpg";
  const mimeType = mimeTypeForExtension(outputExt);
  let lastCandidate;

  for (const quality of sharpQualityCandidates(options)) {
    const outputPath = join(store.optimizedDir, `${stem}-sharp-max${maxLongEdge}-q${quality}.jpg`);
    if (await existingFile(outputPath)) {
      const existing = await candidateFromPath(outputPath, outputExt, mimeType, originalMetadata, true, "sharp");
      if (!existing) continue;
      existing.jpegQuality = quality;
      lastCandidate = existing;
      if (!options.maxOutputBytes || existing.bytes <= options.maxOutputBytes) return existing;
      continue;
    }

    try {
      let pipeline = sharp(inputPath, { failOn: "none" }).rotate();
      if (resizeLongEdge !== undefined) {
        pipeline = pipeline.resize({
          width: maxLongEdge,
          height: maxLongEdge,
          fit: "inside",
          withoutEnlargement: true,
        });
      }

      await pipeline
        .jpeg({
          quality,
          chromaSubsampling: SHARP_JPEG_CHROMA_SUBSAMPLING,
          quantisationTable: SHARP_JPEG_QUANTISATION_TABLE,
          optimiseCoding: true,
        })
        .toFile(outputPath);
    } catch {
      continue;
    }

    const candidate = await candidateFromPath(outputPath, outputExt, mimeType, originalMetadata, true, "sharp");
    if (!candidate) continue;
    candidate.jpegQuality = quality;
    lastCandidate = candidate;
    if (!options.maxOutputBytes || candidate.bytes <= options.maxOutputBytes) return candidate;
  }

  return lastCandidate;
}

async function createNativeCandidate(store, inputPath, stem, resizeLongEdge, originalMetadata, rawOptions = {}) {
  const binary = await nativeOptimizerBinary(store);
  if (!binary) return undefined;

  const options = normalizeOptimizationOptions(rawOptions);
  const maxLongEdge = resizeLongEdge ?? options.maxLongEdge;
  const result = run(binary, [
    "--out-dir", store.optimizedDir,
    "--stem", stem,
    "--max-long-edge", String(maxLongEdge),
    "--quality", String(options.jpegQuality),
    "--small-direct-bytes", String(options.smallDirectBytes),
    inputPath,
  ], { timeoutMs: 15_000 });
  if (result.status !== 0) return undefined;

  const parsed = parseJsonish(result.stdout);
  const row = Array.isArray(parsed.rows) ? parsed.rows[0] : undefined;
  return candidateFromNativeRow(row, originalMetadata);
}

function sharpQualityCandidates(options) {
  const requested = options.jpegQuality;
  if (!options.maxOutputBytes) return [requested];

  const qualities = [
    requested,
    ...[88, 85].filter((quality) => quality < requested && quality >= SHARP_JPEG_MIN_QUALITY),
  ];
  return [...new Set(qualities)];
}

async function createSipsCandidate(inputPath, outputPath, outputExt, resizeLongEdge, originalMetadata, optimized, rawOptions = {}) {
  const options = normalizeOptimizationOptions(rawOptions);
  const mimeType = mimeTypeForExtension(outputExt);
  if (!mimeType) return undefined;
  if (await existingFile(outputPath)) return candidateFromPath(outputPath, outputExt, mimeType, originalMetadata, optimized, "sips");

  const args = [];
  if (outputExt === ".png") args.push("-s", "format", "png");
  if (outputExt === ".jpg") args.push("-s", "format", "jpeg", "-s", "formatOptions", String(options.jpegQuality));
  if (resizeLongEdge !== undefined) args.push("--resampleHeightWidthMax", String(resizeLongEdge));
  args.push(inputPath, "--out", outputPath);

  const result = run("sips", args, { timeoutMs: 15_000 });
  if (result.status !== 0) return undefined;
  return candidateFromPath(outputPath, outputExt, mimeType, originalMetadata, optimized, "sips");
}

async function createFallbackCandidate(inputPath, outputDir, stem, sourceExt, originalMetadata) {
  const fallbackExt = normalizeDirectExtension(sourceExt);
  const fallbackMime = mimeTypeForExtension(fallbackExt);
  if (!fallbackMime) return undefined;

  const fallbackPath = join(outputDir, `${stem}${fallbackExt}`);
  if (!(await existingFile(fallbackPath))) await copyFile(inputPath, fallbackPath);
  return candidateFromPath(fallbackPath, fallbackExt, fallbackMime, originalMetadata, false, "copy");
}

async function candidateFromPath(path, ext, mimeType, originalMetadata, optimized, optimizer) {
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
    optimizer,
  };
}

function candidateFromNativeRow(row, originalMetadata) {
  if (!row || row.error || !row.optimizedPath || !row.optimizedBytes) return undefined;
  const outputExt = extname(row.optimizedPath).toLowerCase();
  const mimeType = mimeTypeForExtension(outputExt);
  if (!mimeType) return undefined;
  return {
    path: row.optimizedPath,
    ext: normalizeDirectExtension(outputExt),
    mimeType,
    bytes: row.optimizedBytes,
    width: row.width ?? originalMetadata.width,
    height: row.height ?? originalMetadata.height,
    originalWidth: row.originalWidth ?? originalMetadata.width,
    originalHeight: row.originalHeight ?? originalMetadata.height,
    optimized: Boolean(row.optimized),
    optimizer: row.optimized ? "native" : "copy",
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
  const percentTarget = options.longEdgePercent
    ? Math.round(maxLongEdge * (options.longEdgePercent / 100))
    : options.maxLongEdge;
  const minTarget = options.minLongEdge
    ? Math.max(percentTarget, Math.min(options.minLongEdge, maxLongEdge))
    : percentTarget;
  const sizeTarget = Math.min(options.maxLongEdge, minTarget, maxLongEdge);
  const target = Math.min(sizeTarget, patchTarget, retinaTarget);
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
  const requestedProfile = args.profile ?? DEFAULT_PROFILE;
  if (!OPTIMIZATION_PROFILES[requestedProfile]) {
    throw new Error(`Unknown profile: ${requestedProfile}. Use token, balanced, or readability.`);
  }

  const base = OPTIMIZATION_PROFILES[requestedProfile];
  return normalizeOptimizationOptions({
    ...base,
    maxLongEdge: args["max-long-edge"] ?? args.maxLongEdge ?? base.maxLongEdge,
    longEdgePercent: args["long-edge-percent"] ?? args.longEdgePercent ?? base.longEdgePercent,
    minLongEdge: args["min-long-edge"] ?? args.minLongEdge ?? base.minLongEdge,
    maxPatches: args["max-patches"] ?? args.maxPatches ?? base.maxPatches,
    jpegQuality: args["jpeg-quality"] ?? args.jpegQuality ?? base.jpegQuality,
    maxOutputBytes: args["max-output-bytes"] ?? args.maxOutputBytes ?? base.maxOutputBytes,
    optimizer: args.optimizer ?? base.optimizer,
  });
}

function normalizeOptimizationOptions(rawOptions = {}) {
  const requestedProfile = rawOptions.profile ?? DEFAULT_PROFILE;
  const profile = OPTIMIZATION_PROFILES[requestedProfile] ? requestedProfile : DEFAULT_PROFILE;
  const fallback = OPTIMIZATION_PROFILES[profile];
  const maxLongEdge = parsePositiveInteger(rawOptions.maxLongEdge ?? fallback.maxLongEdge, fallback.maxLongEdge);
  const longEdgePercent = parseLongEdgePercent(rawOptions.longEdgePercent ?? fallback.longEdgePercent, fallback.longEdgePercent);
  const minLongEdge = rawOptions.minLongEdge === undefined || rawOptions.minLongEdge === null
    ? fallback.minLongEdge
    : parsePositiveInteger(rawOptions.minLongEdge, undefined);
  const maxPatches = rawOptions.maxPatches === undefined || rawOptions.maxPatches === null
    ? undefined
    : parsePositiveInteger(rawOptions.maxPatches, undefined);
  const jpegQuality = clamp(parsePositiveInteger(rawOptions.jpegQuality ?? fallback.jpegQuality, fallback.jpegQuality), 1, 100);
  const noResizeJpegQuality = rawOptions.noResizeJpegQuality === undefined || rawOptions.noResizeJpegQuality === null
    ? fallback.noResizeJpegQuality
    : clamp(parsePositiveInteger(rawOptions.noResizeJpegQuality, undefined), 1, 100);
  const maxOutputBytes = rawOptions.maxOutputBytes === undefined || rawOptions.maxOutputBytes === null
    ? fallback.maxOutputBytes
    : parseNonNegativeInteger(rawOptions.maxOutputBytes, fallback.maxOutputBytes);
  const smallDirectBytes = parseNonNegativeInteger(rawOptions.smallDirectBytes ?? fallback.smallDirectBytes, fallback.smallDirectBytes);
  const optimizer = normalizeOptimizer(rawOptions.optimizer ?? process.env.SCREENSHOTTER_OPTIMIZER ?? fallback.optimizer ?? DEFAULT_OPTIMIZER);

  return {
    profile,
    maxLongEdge,
    longEdgePercent,
    minLongEdge,
    maxPatches,
    jpegQuality,
    noResizeJpegQuality,
    maxOutputBytes,
    smallDirectBytes,
    retinaDownscale: Boolean(rawOptions.retinaDownscale ?? fallback.retinaDownscale),
    optimizer,
  };
}

function normalizeOptimizer(value) {
  const normalized = String(value ?? DEFAULT_OPTIMIZER).toLowerCase();
  if (normalized === "sharp" || normalized === "vips" || normalized === "libvips") return "sharp";
  if (normalized === "native" || normalized === "imageio") return "native";
  if (normalized === "sips") return "sips";
  throw new Error(`Unknown optimizer: ${value}. Use sharp, native, or sips.`);
}

function optimizationKey(rawOptions = {}) {
  const options = normalizeOptimizationOptions(rawOptions);
  return [
    `profile=${options.profile}`,
    `maxLongEdge=${options.maxLongEdge}`,
    `longEdgePercent=${options.longEdgePercent ?? "none"}`,
    `minLongEdge=${options.minLongEdge ?? "none"}`,
    `maxPatches=${options.maxPatches ?? "none"}`,
    `jpegQuality=${options.jpegQuality}`,
    `noResizeJpegQuality=${options.noResizeJpegQuality ?? "none"}`,
    `maxOutputBytes=${options.maxOutputBytes ?? "none"}`,
    `smallDirectBytes=${options.smallDirectBytes}`,
    `retinaDownscale=${options.retinaDownscale ? 1 : 0}`,
    `optimizer=${options.optimizer}`,
  ].join(";");
}

async function nativeOptimizerBinary(store) {
  const cacheKey = store.dataDir;
  if (nativeOptimizerBinaries.has(cacheKey)) return nativeOptimizerBinaries.get(cacheKey) ?? undefined;

  if (!commandExists("xcrun") || !(await existingFile(NATIVE_OPTIMIZER_SOURCE))) {
    nativeOptimizerBinaries.set(cacheKey, null);
    return undefined;
  }

  const helperDir = join(store.dataDir, "helpers");
  const outputPath = join(helperDir, "native-image-optimizer");
  const moduleCachePath = join(helperDir, "swift-module-cache");
  await mkdir(moduleCachePath, { recursive: true });

  if (await needsRefresh(outputPath, NATIVE_OPTIMIZER_SOURCE)) {
    const result = run("xcrun", [
      "swiftc",
      "-module-cache-path", moduleCachePath,
      NATIVE_OPTIMIZER_SOURCE,
      "-o", outputPath,
    ], {
      env: { CLANG_MODULE_CACHE_PATH: moduleCachePath },
      timeoutMs: 60_000,
    });
    if (result.status !== 0) {
      nativeOptimizerBinaries.set(cacheKey, null);
      return undefined;
    }
  }

  nativeOptimizerBinaries.set(cacheKey, outputPath);
  return outputPath;
}

async function menuBarControllerBinary(store) {
  const cacheKey = store.dataDir;
  if (menuBarControllerBinaries.has(cacheKey)) return menuBarControllerBinaries.get(cacheKey) ?? undefined;

  if (!commandExists("xcrun") || !(await existingFile(MENU_BAR_CONTROLLER_SOURCE))) {
    menuBarControllerBinaries.set(cacheKey, null);
    return undefined;
  }

  const helperDir = join(store.dataDir, "helpers");
  const outputPath = join(helperDir, "menu-bar-controller");
  const moduleCachePath = join(helperDir, "swift-module-cache");
  await mkdir(moduleCachePath, { recursive: true });

  if (await needsRefresh(outputPath, MENU_BAR_CONTROLLER_SOURCE)) {
    const result = run("xcrun", [
      "swiftc",
      "-module-cache-path", moduleCachePath,
      MENU_BAR_CONTROLLER_SOURCE,
      "-o", outputPath,
    ], {
      env: { CLANG_MODULE_CACHE_PATH: moduleCachePath },
      timeoutMs: 60_000,
    });
    if (result.status !== 0) {
      menuBarControllerBinaries.set(cacheKey, null);
      return undefined;
    }
  }

  menuBarControllerBinaries.set(cacheKey, outputPath);
  return outputPath;
}

async function startMenuBarController(store, handleCommand, args) {
  const binary = await menuBarControllerBinary(store);
  if (!binary) return undefined;

  const child = spawn(binary, [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let closed = false;
  let stdoutBuffer = "";

  child.on("close", () => {
    closed = true;
  });
  child.on("error", (error) => {
    closed = true;
    if (shouldVerbose(args)) process.stderr.write(`[screenshotter toolbar] ${formatError(error)}\n`);
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;

      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let command;
      try {
        command = JSON.parse(line);
      } catch {
        continue;
      }

      Promise.resolve(handleCommand(command)).catch((error) => {
        console.error(`toolbar command failed: ${formatError(error)}`);
      });
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (shouldVerbose(args)) process.stderr.write(`[screenshotter toolbar] ${chunk}`);
  });

  return {
    sendState(state) {
      if (closed || !child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify({ type: "state", ...state })}\n`);
    },
    stop() {
      if (closed) return;
      child.stdin.end();
      child.kill();
    },
  };
}

async function loadSharpModule() {
  if (!sharpModulePromise) {
    sharpModulePromise = import("sharp")
      .then((module) => module.default ?? module)
      .catch(() => null);
  }
  return sharpModulePromise;
}

async function prewarmOptimizer(options) {
  if (normalizeOptimizationOptions(options).optimizer === "sharp") await loadSharpModule();
}

async function needsRefresh(outputPath, sourcePath) {
  const [outputStat, sourceStat] = await Promise.all([safeStat(outputPath), safeStat(sourcePath)]);
  if (!sourceStat?.isFile()) return false;
  return !outputStat?.isFile() || outputStat.mtimeMs < sourceStat.mtimeMs;
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
  await mkdir(store.logsDir, { recursive: true });
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
  const dataDir = resolve(expandHome(args["data-dir"] ?? process.env.SCREENSHOTTER_DATA_DIR ?? defaultDataDir()));
  return {
    dataDir,
    dbPath: join(dataDir, "screens.json"),
    logsDir: join(dataDir, "logs"),
    eventsLogPath: join(dataDir, "logs", "events.jsonl"),
    lockDir: join(dataDir, ".screens.lock"),
    originalsDir: join(dataDir, "originals"),
    optimizedDir: resolve(expandHome(args["optimized-dir"] ?? process.env.SCREENSHOTTER_OPTIMIZED_DIR ?? join(dataDir, "optimized"))),
  };
}

function defaultDataDir() {
  return join(homedir(), "Library", "Application Support", "screenshotter");
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
    else if (token === "--watch") args.watch = true;
    else if (token === "--toolbar") args.toolbar = true;
    else if (token === "--menubar") args.menubar = true;
    else if (token === "--tokens") args.tokens = true;
    else if (token === "--verbose") args.verbose = true;
    else if (token === "--log") args.log = true;
    else if (token === "--no-log") args["no-log"] = true;
    else if (token === "--no-clipboard") args["no-clipboard"] = true;
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

    if (WRAPPER_BOOLEAN_FLAGS.has(token)) {
      wrapperArgv.push(token);
      continue;
    }

    if (WRAPPER_VALUE_FLAGS.has(token)) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${token} requires a value`);
      wrapperArgv.push(token, value);
      continue;
    }

    const [assignmentFlag] = token.split("=", 1);
    if (token.includes("=") && WRAPPER_VALUE_FLAGS.has(assignmentFlag)) {
      wrapperArgv.push(token);
      continue;
    }

    appArgv.push(token);
  }

  return { wrapperArgv, appArgv };
}

async function reportScreenEvent(args, store, type, screen, extra = {}) {
  if (!screen) return;
  const event = screenEvent(type, screen, extra);
  if (shouldLogEvents(args)) {
    await appendFile(store.eventsLogPath, `${JSON.stringify(event)}\n`).catch((error) => {
      if (shouldVerbose(args)) process.stderr.write(`[screenshotter] failed to write log: ${formatError(error)}\n`);
    });
  }
  if (shouldVerbose(args)) {
    process.stderr.write(`${formatScreenEvent(event)}\n`);
    if (shouldLogEvents(args)) process.stderr.write(`[screenshotter] log: ${store.eventsLogPath}\n`);
  }
}

function screenEvent(type, screen, extra = {}) {
  const originalBytes = screen.originalBytes ?? 0;
  const optimizedBytes = screen.optimizedBytes ?? 0;
  return {
    ts: new Date().toISOString(),
    type,
    id: screen.id,
    target: screen.target ?? null,
    profile: screen.profile ?? null,
    maxLongEdge: screen.maxLongEdge ?? null,
    longEdgePercent: screen.longEdgePercent ?? null,
    minLongEdge: screen.minLongEdge ?? null,
    jpegQuality: screen.jpegQuality ?? null,
    maxOutputBytes: screen.maxOutputBytes ?? null,
    optimizer: screen.optimizer ?? null,
    sourcePath: screen.sourcePath,
    optimizedPath: screen.optimizedPath,
    originalBytes,
    optimizedBytes,
    savedBytes: Math.max(0, originalBytes - optimizedBytes),
    savedPercent: originalBytes > 0 ? round((1 - optimizedBytes / originalBytes) * 100, 1) : 0,
    originalWidth: screen.originalWidth ?? null,
    originalHeight: screen.originalHeight ?? null,
    width: screen.width ?? null,
    height: screen.height ?? null,
    ...extra,
  };
}

function addToolCheck(checks, command, purpose) {
  const available = commandExists(command);
  checks.push({
    name: command,
    status: available ? "pass" : "fail",
    message: available ? purpose : `${command} not found`,
  });
}

function resolveWatchTarget(args = {}) {
  if (args.target && args.target !== "auto") {
    return {
      target: args.target,
      clipboard: shouldCopyWatchClipboard(args),
      source: "explicit",
      reason: "--target",
    };
  }

  const detected = detectWatchTarget();
  const clipboard = shouldCopyWatchClipboard(args);
  return { ...detected, clipboard };
}

function shouldCopyWatchClipboard(args = {}) {
  return !args["no-clipboard"];
}

function detectWatchTarget() {
  const snapshot = processListSnapshot();
  const processes = snapshot.processes.filter((processInfo) => {
    if (processInfo.pid === process.pid) return false;
    const text = processInfo.text.toLowerCase();
    return !text.includes("screenshotter.mjs") && !text.includes("screenshotter watch");
  });
  const candidates = [
    {
      target: "codex-app",
      source: "auto",
      reason: "Codex app is running",
      match: isCodexAppProcess,
    },
    {
      target: "codex",
      source: "auto",
      reason: "Codex CLI is running",
      match: isCodexCliProcess,
    },
    {
      target: "pi",
      source: "auto",
      reason: "pi is running",
      match: isPiProcess,
    },
    {
      target: "claude-app",
      source: "auto",
      reason: "Claude app is running",
      match: isClaudeAppProcess,
    },
    {
      target: "claude-code",
      source: "auto",
      reason: "Claude Code is running",
      match: isClaudeCliProcess,
    },
  ];

  for (const candidate of candidates) {
    if (processes.some(candidate.match)) {
      const { match: _match, ...detected } = candidate;
      return detected;
    }
  }

  return {
    target: "default",
    source: "fallback",
    reason: snapshot.error ? `process detection unavailable: ${snapshot.error}` : "no supported agent process detected",
  };
}

function processListSnapshot() {
  if (process.env.SCREENSHOTTER_PROCESS_LIST !== undefined) {
    return { processes: parseProcessList(process.env.SCREENSHOTTER_PROCESS_LIST) };
  }

  const result = run("ps", ["-axo", "pid=,comm=,args="], { timeoutMs: 3000 });
  if (result.status !== 0) {
    return {
      processes: [],
      error: (result.stderr || result.stdout || `ps exited with ${result.status}`).trim(),
    };
  }

  return { processes: parseProcessList(result.stdout) };
}

function parseProcessList(raw) {
  return raw.split(/\r?\n/)
    .map(parseProcessLine)
    .filter(Boolean);
}

function parseProcessLine(line) {
  const match = /^\s*(\d+)\s+(.+)$/.exec(line);
  if (!match) return undefined;
  return {
    pid: Number(match[1]),
    text: match[2],
  };
}

function isCodexAppProcess(processInfo) {
  return /\/Applications\/Codex\.app\//i.test(processInfo.text)
    || /Codex\.app\/Contents\/Resources\/codex app-server/i.test(processInfo.text);
}

function isCodexCliProcess(processInfo) {
  return !isCodexAppProcess(processInfo) && hasCommandToken(processInfo.text, "codex");
}

function isPiProcess(processInfo) {
  return hasCommandToken(processInfo.text, "pi");
}

function isClaudeAppProcess(processInfo) {
  return /\/Applications\/Claude\.app\//i.test(processInfo.text);
}

function isClaudeCliProcess(processInfo) {
  return !isClaudeAppProcess(processInfo) && hasCommandToken(processInfo.text, "claude");
}

function hasCommandToken(text, token) {
  const escaped = escapeRegExp(token);
  return new RegExp(`(^|[\\s/])${escaped}(\\s|$)`, "i").test(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatScreenEvent(event) {
  const dimensions = event.originalWidth && event.originalHeight && event.width && event.height
    ? `${event.originalWidth}x${event.originalHeight} -> ${event.width}x${event.height}`
    : "dimensions unknown";
  const duration = event.durationMs === undefined ? "" : ` in ${event.durationMs}ms`;
  return [
    `[screenshotter] ${event.type}`,
    `${event.profile ?? "unknown"} / ${event.optimizer ?? "unknown"}`,
    `${formatBytes(event.originalBytes)} -> ${formatBytes(event.optimizedBytes)}`,
    `saved ${formatBytes(event.savedBytes)} (${event.savedPercent}%)`,
    dimensions,
    duration,
  ].filter(Boolean).join(" · ");
}

function formatDoctor(result) {
  const lines = [
    `screenshotter ${result.version} doctor`,
    "",
    ...result.checks.map((check) => `[${doctorStatusLabel(check.status)}] ${check.name}: ${check.message}`),
    "",
    `screenshot dir: ${result.screenshotDir}`,
    `data dir: ${result.dataDir}`,
    `default: ${formatProfileSummary(result.defaultProfile)}`,
    `watch: ${formatWatchTargetSummary(result.autoWatch)}`,
    "",
    result.ok
      ? "Ready. Run: screenshotter watch --verbose"
      : "Fix failed checks, then run screenshotter doctor again.",
  ];
  return `${lines.join("\n")}\n`;
}

function doctorStatusLabel(status) {
  if (status === "pass") return "ok";
  return status;
}

function formatProfileSummary(profile, { concise = false, includeProfileId = true } = {}) {
  const hasSharpOutputTarget = profile.optimizer === "sharp" && profile.maxOutputBytes;
  const name = includeProfileId
    ? `${profileDisplayName(profile.profile)} (${profile.profile})`
    : profileDisplayName(profile.profile);
  const maxLongEdge = profile.maxLongEdge
    ? concise ? `${profile.maxLongEdge}px` : `cap ${profile.maxLongEdge}px`
    : undefined;
  const noResizeQuality = profile.noResizeJpegQuality
    ? concise ? `q${profile.noResizeJpegQuality} no-resize` : `q${profile.noResizeJpegQuality} when not resized`
    : undefined;
  const maxOutputBytes = hasSharpOutputTarget
    ? concise ? `<=${formatBytes(profile.maxOutputBytes)}` : `max ${formatBytes(profile.maxOutputBytes)}`
    : undefined;
  const optimizer = concise && profile.optimizer === DEFAULT_OPTIMIZER ? undefined : profile.optimizer;

  return [
    name,
    profile.longEdgePercent ? `${profile.longEdgePercent}%` : undefined,
    profile.minLongEdge ? `floor ${profile.minLongEdge}px` : undefined,
    maxLongEdge,
    formatQualitySummary(profile),
    noResizeQuality,
    maxOutputBytes,
    optimizer,
  ].filter(Boolean).join(" / ");
}

function formatQualitySummary(profile) {
  const qualities = profile.optimizer === "sharp" && profile.maxOutputBytes
    ? sharpQualityCandidates(profile)
    : [profile.jpegQuality];
  if (qualities.length === 1) return `q${qualities[0]}`;
  return qualities.map((quality) => `q${quality}`).join("/");
}

function profileDisplayName(profile) {
  switch (profile) {
    case "readability":
      return "Low";
    case "balanced":
      return "Mid";
    case "token":
      return "High";
    default:
      return profile ?? "unknown";
  }
}

function formatWatchDelivery(args) {
  if (!args.clipboard) return "off";
  if (args["dry-run"]) return "dry-run";
  return "optimized image";
}

function formatWatchTargetSummary(target) {
  return [
    target.clipboard ? "clipboard" : "claim",
    target.target && target.target !== "default" ? target.target : undefined,
  ].filter(Boolean).join(" / ");
}

function shouldVerbose(args) {
  return Boolean(args.verbose || process.env.SCREENSHOTTER_VERBOSE === "1");
}

function shouldLogEvents(args) {
  if (args["no-log"]) return false;
  return Boolean(args.log || args.verbose || process.env.SCREENSHOTTER_LOG === "1" || process.env.SCREENSHOTTER_VERBOSE === "1");
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
    profile: screen.profile ?? DEFAULT_PROFILE,
    maxLongEdge: screen.maxLongEdge ?? null,
    longEdgePercent: screen.longEdgePercent ?? null,
    minLongEdge: screen.minLongEdge ?? null,
    maxPatches: screen.maxPatches ?? null,
    jpegQuality: screen.jpegQuality ?? null,
    maxOutputBytes: screen.maxOutputBytes ?? null,
    optimizer: screen.optimizer ?? null,
  };
}

function writeText(text) {
  process.stdout.write(text);
}

function usage() {
  return `screenshotter ${VERSION}

Usage:
  screenshotter codex [wrapper options] -- [codex args...]
  screenshotter claude [wrapper options] -- [claude args...]
  screenshotter clip [--target app] [--json]
  screenshotter paste [--target app] [--json]
  screenshotter codex-app [--verbose] [--json] [--reveal]
  screenshotter claude-app [--json] [--reveal]
  screenshotter watch [--toolbar] [--target auto|codex-app|codex|pi|claude-app|claude-code] [--no-clipboard] [--poll-ms 1500] [--verbose]
  screenshotter toolbar [watch options]
  screenshotter prepare <image> [--target pi] [--profile token|balanced|readability] [--optimizer sharp|native|sips] [--max-long-edge px] [--long-edge-percent pct] [--min-long-edge px] [--jpeg-quality 1-100] [--max-output-bytes n] [--json]
  screenshotter prepare-latest [--target codex-app] [--profile token|balanced|readability] [--optimizer sharp|native|sips] [--max-long-edge px] [--long-edge-percent pct] [--min-long-edge px] [--jpeg-quality 1-100] [--max-output-bytes n] [--json]
  screenshotter list [--target pi] [--state ready] [--json]
  screenshotter claim [--target pi] [--max 4] [--json]
  screenshotter clear [--target pi] [--files] [--json]
  screenshotter status [--target pi] [--tokens] [--json]
  screenshotter doctor [--json]
  screenshotter copy [--format markdown|paths|json] [--clipboard]
  screenshotter reveal [--target codex-app]
  screenshotter bench [--latest 10] [--profile token|balanced|readability] [--optimizer sharp|native|sips] [--max-long-edge px] [--long-edge-percent pct] [--min-long-edge px] [--jpeg-quality 1-100] [--max-output-bytes n] [--max-patches n] [--tokens] [--json]
  screenshotter mcp-server
  screenshotter screenshot-dir [--json]
  screenshotter data-dir [--json]

Environment:
  SCREENSHOTTER_DATA_DIR       Override the store directory.
  SCREENSHOTTER_OPTIMIZED_DIR  Override optimized image output directory.
  SCREENSHOTTER_OPTIMIZER      Use sharp, native, or sips. Sharp/libvips is the default.
  SCREENSHOTTER_VERBOSE=1      Print savings details to stderr and write event logs.
  SCREENSHOTTER_LOG=1          Write JSONL event logs.

Profiles:
  readability  Low/default: max long edge 4096 px, JPEG quality 90/88/85, 1 MB target.
  balanced     Mid: max long edge 3000 px, JPEG quality 85.
  token        High: max long edge 2200 px, JPEG quality 50, or 75 when not resized.
`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : undefined,
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function parseJsonish(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function commandExists(command) {
  return spawnSync("/usr/bin/which", [command], { stdio: "ignore" }).status === 0;
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

function fileSignature(fileStat) {
  return `${fileStat.size}:${fileStat.mtimeMs}`;
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

function parseLongEdgePercent(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(`Expected long-edge percent between 0 and 100, got ${value}`);
  if (numeric <= 1) return numeric * 100;
  if (numeric <= 100) return numeric;
  throw new Error(`Expected long-edge percent between 0 and 100, got ${value}`);
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

function formatPercent(value) {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 0.05) return `${rounded}%`;
  return `${value.toFixed(1)}%`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
