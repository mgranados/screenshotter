#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(join(ROOT_DIR, "package.json"), "utf8")).version;
const SCHEMA_VERSION = 1;
const STATS_SCHEMA_VERSION = 1;
const BALANCED_MAX_LONG_EDGE_PX = 3000;
const BALANCED_JPEG_QUALITY = 85;
const TOKEN_MAX_LONG_EDGE_PX = 2200;
const TOKEN_JPEG_QUALITY = 50;
const TOKEN_NO_RESIZE_JPEG_QUALITY = 75;
const RETINA_DPI_THRESHOLD = 120;
const RETINA_DOWNSCALE_FACTOR = 0.5;
const MIN_RETINA_DOWNSCALE_LONG_EDGE_PX = 3000;
const SMALL_DIRECT_SEND_BYTES = 256 * 1024;
const FILE_STABLE_INTERVAL_MS = 100;
const FILE_STABLE_SETTLED_MS = 150;
const FILE_STABLE_TIMEOUT_MS = 5000;
const DEFAULT_FRESH_MS = 10 * 60_000;
const DEFAULT_CLAIM_MAX = 4;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_CLIPBOARD_POLL_INTERVAL_MS = 500;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;
const ARTIFACT_LOCK_TIMEOUT_MS = 90_000;
const LOCK_HEARTBEAT_MS = 5000;
const DEFAULT_READY_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_RECORD_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_SCREEN_RECORDS = 500;
const NATIVE_OPTIMIZER_SOURCE = join(ROOT_DIR, "scripts", "native-image-optimizer.swift");
const MENU_BAR_CONTROLLER_SOURCE = join(ROOT_DIR, "scripts", "menu-bar-controller.swift");
const APPLE_VISION_OCR_SOURCE = join(ROOT_DIR, "scripts", "apple-vision-ocr.swift");
const SCREEN_TARGET_SNAPSHOT_SOURCE = join(ROOT_DIR, "scripts", "screen-target-snapshot.swift");
const MACOS_ACCESSIBILITY_TEXT_SOURCE = join(ROOT_DIR, "scripts", "macos-accessibility-text.swift");
const CLIPBOARD_IMAGE_READER_SOURCE = join(ROOT_DIR, "scripts", "clipboard-image-reader.swift");
const DEFAULT_PROFILE = "readability";
const DEFAULT_OPTIMIZER = "native";
const DEFAULT_OCR_LEVEL = "accurate";
const DEFAULT_OCR_LANGUAGES = ["en-US"];
const DEFAULT_TEXT_PROVIDER = "accessibility";
const DEFAULT_TEXT_SNIPPET_MAX_CHARS = 4000;
const CODEX_APP_PASTE_DELAY_MS = 800;
const READABILITY_MAX_OUTPUT_BYTES = 1_000_000;
const SHARP_JPEG_MIN_QUALITY = 85;
const SHARP_JPEG_CHROMA_SUBSAMPLING = "4:4:4";
const SHARP_JPEG_QUANTISATION_TABLE = 3;
const PROCESS_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

const SCREENSHOT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".tif", ".tiff"]);
const DIRECT_SEND_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const JPEG_DERIVATIVE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".tif", ".tiff"]);
const IMAGE_PASTEBOARD_TYPES_BY_MIME = new Map([
  ["image/jpeg", "public.jpeg"],
  ["image/png", "public.png"],
  ["image/gif", "com.compuserve.gif"],
  ["image/tiff", "public.tiff"],
  ["image/webp", "org.webmproject.webp"],
]);
const IMAGE_PASTEBOARD_TYPES_BY_EXTENSION = new Map([
  [".jpg", "public.jpeg"],
  [".jpeg", "public.jpeg"],
  [".png", "public.png"],
  [".gif", "com.compuserve.gif"],
  [".tif", "public.tiff"],
  [".tiff", "public.tiff"],
  [".webp", "org.webmproject.webp"],
]);
const WRAPPER_BOOLEAN_FLAGS = new Set(["--dry-run", "--json", "--verbose", "--log", "--no-log", "--no-clipboard", "--clipboard-input", "--ocr", "--text", "--with-text", "--no-text", "--with-target-context", "--target-context", "--no-ocr", "--require-ocr", "--no-language-correction", "--prompt-permissions"]);
const WRAPPER_VALUE_FLAGS = new Set([
  "--target",
  "--max",
  "--fresh-ms",
  "--clipboard-poll-ms",
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
  "--clipboard-mode",
  "--ocr-level",
  "--ocr-languages",
  "--text-provider",
  "--text-max-chars",
]);
const API_OPTION_ALIASES = [
  ["dataDir", "data-dir"],
  ["optimizedDir", "optimized-dir"],
  ["maxLongEdge", "max-long-edge"],
  ["longEdgePercent", "long-edge-percent"],
  ["minLongEdge", "min-long-edge"],
  ["jpegQuality", "jpeg-quality"],
  ["maxOutputBytes", "max-output-bytes"],
  ["maxPatches", "max-patches"],
  ["clipboardMode", "clipboard-mode"],
  ["textProvider", "text-provider"],
  ["textMaxChars", "text-max-chars"],
  ["ocrLevel", "ocr-level"],
  ["ocrLanguages", "ocr-languages"],
  ["dryRun", "dry-run"],
  ["withText", "with-text"],
  ["noText", "no-text"],
  ["noOcr", "no-ocr"],
  ["withTargetContext", "with-target-context"],
  ["noLanguageCorrection", "no-language-correction"],
  ["requireOcr", "require-ocr"],
];
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
const appleVisionOcrBinaries = new Map();
const screenTargetSnapshotBinaries = new Map();
const macosAccessibilityTextBinaries = new Map();
const clipboardImageReaderBinaries = new Map();
let sharpModulePromise;
const maintainedStores = new Set();

if (isCliEntryPoint()) {
  main().catch((error) => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}

export async function prepareImage(input, options = {}) {
  const args = apiArgs(options);
  return publicResult((await preparePath(args, input)).result, projectionOptions(args));
}

export async function prepareLatestScreen(options = {}) {
  const args = apiArgs(options);
  return publicResult(await prepareLatest(args), projectionOptions(args));
}

export async function copyPreparedScreen(screen, options = {}) {
  const args = apiArgs(options);
  if (args["dry-run"]) {
    const mode = clipboardDeliveryMode(args);
    return {
      status: `${mode}-dry-run`,
      label: "clipboard dry-run",
      textCopied: mode !== "image" && Boolean(formatScreenTextSnippet(screen, args)),
    };
  }
  return copyScreenToClipboard(screen, args);
}

export async function prepareLatestForClipboard(options = {}) {
  const args = apiArgs(options);
  const result = await prepareLatest(args);
  const clipboard = await copyPreparedScreen(result.screen, args);
  return publicResult({ ...result, clipboard }, projectionOptions(args));
}

export async function prepareClipboardForClipboard(options = {}) {
  const args = apiArgs(options);
  const captured = await captureClipboardImage(storePaths(args));
  if (!captured.imagePath) throw new Error("The clipboard does not contain a screenshot-like image");
  try {
    const { result } = await preparePath(args, captured.imagePath, {
      sourcePath: "clipboard",
      sourceKind: "clipboard",
    });
    const clipboard = args["no-clipboard"]
      ? { status: null, label: "", textCopied: false }
      : await copyPreparedScreenIfClipboardUnchanged(result.screen, args, captured.changeCount);
    return publicResult({ ...result, clipboard }, projectionOptions(args));
  } finally {
    await captured.cleanup();
  }
}

function isCliEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(modulePath);
  } catch {
    return resolve(entry) === modulePath;
  }
}

function apiArgs(options = {}) {
  if (Object.hasOwn(options, "remoteTarget") || Object.hasOwn(options, "remote-target")) {
    throw new Error("Unknown option: --remote-target");
  }
  const args = { ...options, _: Array.isArray(options._) ? options._ : [] };
  for (const [camelKey, cliKey] of API_OPTION_ALIASES) applyApiAlias(args, options, camelKey, cliKey);
  if (options.targetContext !== undefined && args["with-target-context"] === undefined) args["with-target-context"] = options.targetContext;
  return args;
}

function applyApiAlias(args, options, camelKey, cliKey) {
  if (options[camelKey] !== undefined && args[cliKey] === undefined) {
    args[cliKey] = options[camelKey];
  }
}

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
    case "clipboard":
    case "prepare-clipboard":
      return clipboardInputCommand(args);
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
    case "stats":
      return statsCommand(args);
    case "gc":
      return gcCommand(args);
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

async function clipboardInputCommand(args) {
  const result = await prepareClipboardForClipboard(args);
  await reportScreenEvent(args, storePaths(args), "clipboard-input", result.screen, {
    prepared: result.prepared,
    clipboard: result.clipboard?.status,
  });
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

async function preparePath(args, input, sourceOptions = {}) {
  const sourcePath = resolve(expandHome(input));
  if (!isSupportedScreenshotPath(sourcePath)) throw new Error(`Unsupported screenshot type: ${sourcePath}`);

  const store = storePaths(args);
  await ensureStore(store);
  const targetOptions = screenTargetOptions(args);
  const targetSnapshotPromise = targetOptions.enabled
    ? collectScreenTargetSnapshot(store)
    : Promise.resolve(null);
  const sourceStat = await waitForStableFile(sourcePath);
  if (!sourceStat) throw new Error(`File did not become stable: ${sourcePath}`);
  const targetSnapshot = await targetSnapshotPromise;
  const result = await prepareOne(store, sourcePath, sourceStat, args.target ?? null, optimizationOptions(args), {
    ...sourceOptions,
    text: {
      ...textContextOptions(args),
      forceRefresh: Boolean(targetSnapshot),
    },
    screenTarget: {
      ...targetOptions,
      snapshot: targetSnapshot,
    },
  });
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
    textOptions: textContextOptions(args),
    screenTargetOptions: screenTargetOptions(args),
    ready: 0,
    history: [],
  };
  const watchDir = resolve(expandHome(args.dir ?? macScreenshotDir()));
  const watchStat = await safeStat(watchDir);
  if (!watchStat?.isDirectory()) throw new Error(`screenshot folder is not available: ${watchDir}`);

  const store = storePaths(args);
  await ensureStore(store);
  await prewarmOptimizer(watchState.options);
  await prewarmWatchResources(store, watchState, watchArgs).catch((error) => {
    if (shouldVerbose(watchArgs)) process.stderr.write(`[screenshotter] prewarm failed: ${formatError(error)}\n`);
  });
  let sinceMs = Date.now();
  const pollIntervalMs = parsePositiveInteger(args["poll-ms"], DEFAULT_POLL_INTERVAL_MS);
  const clipboardPollIntervalMs = parsePositiveInteger(args["clipboard-poll-ms"], DEFAULT_CLIPBOARD_POLL_INTERVAL_MS);
  const processingPaths = new Set();
  const processingTasks = new Set();
  const fileSignatures = new Map();
  const toolbarMode = Boolean(args.toolbar || args.menubar);
  let menuBar;
  let watcher;
  let pollTimer;
  let clipboardMonitor;
  let clipboardQueue = Promise.resolve();
  let lastClipboardChangeCount = null;
  let controlTimer;
  let stopWatch;
  let menuAnimationSequence = 0;

  writeText(`screenshotter ${toolbarMode ? "toolbar" : "watch"}\n`);
  writeText(`watching: ${watchDir}\n`);
  if (args.target && args.target !== "auto") writeText(`target: ${target}\n`);
  writeText(`store: ${store.dataDir}\n`);
  writeText(`profile: ${formatProfileSummary(watchState.options, { concise: true, includeProfileId: false })}\n`);
  writeText(`clipboard: ${formatWatchDelivery(watchArgs)}\n`);
  if (args["clipboard-input"]) writeText("clipboard input: native change monitor ready\n");

  const pushControlState = async () => {
    if (!menuBar) return;
    const [db, stats] = await Promise.all([
      readDb(store).catch(() => emptyDb()),
      readStats(store).catch(() => emptyStats()),
    ]);
    const recentHistory = recentCompressionHistory(db.screens);
    watchState.ready = filterScreens(db.screens, { target, state: "ready" }).length;
    menuBar.sendState({
      enabled: watchState.enabled,
      profile: watchState.profile,
      ready: watchState.ready,
      target,
      history: recentHistory,
      stats: {
        screensPrepared: stats.screensPrepared,
        savedBytes: stats.savedBytes,
      },
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
      if (args["clipboard-input"]) {
        lastClipboardChangeCount = await clipboardChangeCount(store).catch(() => lastClipboardChangeCount);
      }
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

  const prepareCandidate = async (candidatePath, sourceOptions = {}) => {
    if (!watchState.enabled) return;
    if (!isSupportedScreenshotPath(candidatePath)) return;
    const key = resolve(candidatePath);
    if (processingPaths.has(key)) return;
    processingPaths.add(key);
    const animationId = `capture-${++menuAnimationSequence}`;
    let animationStarted = false;
    let animationResolved = false;

    try {
      const started = performance.now();
      const initialStat = await safeStat(candidatePath);
      if (initialStat?.isFile()) {
        const initialSignature = fileSignature(initialStat);
        if (fileSignatures.get(key) === initialSignature) return;
        if (Math.max(initialStat.birthtimeMs, initialStat.ctimeMs, initialStat.mtimeMs) < sinceMs - 1000) {
          fileSignatures.set(key, initialSignature);
          return;
        }
      }
      if (menuBar) {
        menuBar.sendEvent({ type: "processing", id: animationId });
        animationStarted = true;
      }
      const captureInputs = await measureAsync(async () => {
        const targetSnapshotPromise = watchState.screenTargetOptions.enabled
          ? measureAsync(() => collectScreenTargetSnapshot(store))
          : Promise.resolve({ value: null, durationMs: 0 });
        const fileStatPromise = measureAsync(() => waitForStableFile(candidatePath));
        const [targeted, stabilized] = await Promise.all([targetSnapshotPromise, fileStatPromise]);
        return {
          targetSnapshot: targeted.value,
          fileStat: stabilized.value,
          targetSnapshotMs: targeted.durationMs,
          fileStableMs: stabilized.durationMs,
        };
      });
      const { targetSnapshot, fileStat } = captureInputs.value;
      if (!fileStat) return;
      if (sourceOptions.sourceKind !== "clipboard" && !isNativeMacScreenshotPath(candidatePath)) return;
      const signature = fileSignature(fileStat);
      if (fileSignatures.get(key) === signature) return;
      if (Math.max(fileStat.birthtimeMs, fileStat.ctimeMs, fileStat.mtimeMs) < sinceMs - 1000) {
        fileSignatures.set(key, signature);
        return;
      }
      const prepared = await measureAsync(() => prepareOne(store, key, fileStat, target, watchState.options, {
        ...sourceOptions,
        text: {
          ...watchState.textOptions,
          forceRefresh: Boolean(targetSnapshot),
        },
        screenTarget: {
          ...watchState.screenTargetOptions,
          snapshot: targetSnapshot,
        },
      }));
      const result = prepared.value;
      const screen = result.screen;
      const copied = await measureAsync(() => maybeCopyWatchClipboard(watchArgs, screen, {
        store,
        expectedChangeCount: sourceOptions.clipboardChangeCount,
      }));
      const clipboard = copied.value;
      if (args["clipboard-input"] && clipboard.status && clipboard.status !== "failed" && clipboard.status !== "superseded" && !clipboard.status.endsWith("-dry-run")) {
        lastClipboardChangeCount = await clipboardChangeCount(store).catch(() => lastClipboardChangeCount);
      }
      const durationMs = round(performance.now() - started, 1);
      const concurrency = estimateConcurrencyPerformance(durationMs, {
        captureInputsMs: captureInputs.durationMs,
        targetSnapshotMs: captureInputs.value.targetSnapshotMs,
        fileStableMs: captureInputs.value.fileStableMs,
        prepare: result.timings,
      });
      fileSignatures.set(key, signature);
      await reportScreenEvent(watchArgs, store, "watch.prepare", screen, {
        prepared: result.prepared,
        durationMs,
        clipboard: clipboard.status,
        clipboardError: clipboard.error,
        targetSource: watchTarget.source,
        timings: {
          captureInputsMs: captureInputs.durationMs,
          targetSnapshotMs: captureInputs.value.targetSnapshotMs,
          fileStableMs: captureInputs.value.fileStableMs,
          prepareMs: prepared.durationMs,
          clipboardMs: copied.durationMs,
          totalMs: durationMs,
          prepare: result.timings ?? null,
          concurrency,
        },
      });
      writeText(formatWatchPrepareLine(result, screen, durationMs, clipboard.label, watchArgs));
      await pushControlState();
      if (menuBar && animationStarted) {
        const clipboardReady = clipboard.status
          && clipboard.status !== "failed"
          && !clipboard.status.endsWith("-dry-run");
        menuBar.sendEvent(clipboardReady
          ? {
              type: "ready",
              id: animationId,
              clipboard: clipboard.status,
              hasImage: Boolean(screen.optimizedPath),
              hasText: Boolean(screen.textContext?.text),
            }
          : {
              type: clipboard.status === "failed" ? "failed" : "idle",
              id: animationId,
            });
        animationResolved = true;
      }
    } catch (error) {
      if (menuBar && animationStarted && !animationResolved) {
        menuBar.sendEvent({ type: "failed", id: animationId });
        animationResolved = true;
      }
      console.error(`failed to prepare ${candidatePath}: ${formatError(error)}`);
    } finally {
      if (menuBar && animationStarted && !animationResolved) {
        menuBar.sendEvent({ type: "idle", id: animationId });
      }
      processingPaths.delete(key);
    }
  };

  const scanRecent = async () => {
    const entries = await readdir(watchDir).catch(() => []);
    for (const entry of entries) await prepareCandidate(join(watchDir, entry));
  };

  const scanClipboard = async (captured) => {
    const imagePath = captured?.path;
    if (!imagePath) return;
    if (!watchState.enabled || captured.changeCount === lastClipboardChangeCount) {
      await rm(imagePath, { force: true });
      return;
    }
    try {
      lastClipboardChangeCount = captured.changeCount;
      await prepareCandidate(imagePath, {
        sourcePath: "clipboard",
        sourceKind: "clipboard",
        clipboardChangeCount: captured.changeCount,
      });
    } catch (error) {
      if (shouldVerbose(watchArgs)) process.stderr.write(`[screenshotter] clipboard input failed: ${formatError(error)}\n`);
    } finally {
      await rm(imagePath, { force: true });
    }
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

  if (args["clipboard-input"]) {
    lastClipboardChangeCount = await clipboardChangeCount(store).catch(() => null);
    clipboardMonitor = await startClipboardImageMonitor(store, {
      pollIntervalMs: clipboardPollIntervalMs,
      onImage: (captured) => {
        const queued = clipboardQueue.then(() => scanClipboard(captured));
        clipboardQueue = queued.catch(() => undefined);
        track(queued);
      },
      onError: (error) => {
        if (shouldVerbose(watchArgs)) process.stderr.write(`[screenshotter] clipboard monitor: ${formatError(error)}\n`);
      },
    });
  }

  await new Promise((resolvePromise) => {
    stopWatch = resolvePromise;
    process.once("SIGINT", stopWatch);
    process.once("SIGTERM", stopWatch);
  }).finally(async () => {
    watcher?.close();
    clearInterval(pollTimer);
    clearInterval(controlTimer);
    clipboardMonitor?.stop();
    menuBar?.stop();
    await Promise.allSettled([...processingTasks]);
    await clipboardMonitor?.cleanup();
  });
}

async function maybeCopyWatchClipboard(args, screen, { store, expectedChangeCount } = {}) {
  if (!args.clipboard) return { status: null, label: "" };
  const mode = clipboardDeliveryMode(args);
  if (args["dry-run"]) return { status: `${mode}-dry-run`, label: "clipboard dry-run" };
  try {
    if (expectedChangeCount !== undefined) {
      const currentChangeCount = await clipboardChangeCount(store);
      if (currentChangeCount !== expectedChangeCount) {
        return { status: "superseded", label: "clipboard changed; delivery skipped" };
      }
    }
    const copied = await copyScreenToClipboard(screen, args);
    return { status: copied.status, label: copied.label };
  } catch (error) {
    return { status: "failed", label: "clipboard failed", error: formatError(error) };
  }
}

async function prepareOne(store, sourcePath, sourceStat, target, rawOptions = {}, rawContextOptions = {}) {
  const totalStarted = performance.now();
  const options = normalizeOptimizationOptions(rawOptions);
  const contextOptions = normalizePrepareContextOptions(rawContextOptions);
  const textOptions = contextOptions.text;
  const screenTargetOptions = contextOptions.screenTarget;
  const inspected = await measureAsync(() => inspectSourceFile(sourcePath));
  const source = inspected.value;
  const hash = source.hash;
  const now = new Date().toISOString();
  const optimizeKey = optimizationKey(options);
  const recordedSourcePath = rawContextOptions.sourcePath ?? sourcePath;
  const lookup = { hash, target, optimizeKey, sourcePath: recordedSourcePath, contextOptions };

  const reused = await measureAsync(() => withStoreLock(store, async () => {
    const db = await readDb(store);
    return findReusableScreen(db.screens, lookup) ?? null;
  }));
  const existing = reused.value;

  if (existing) {
    const enriched = { ...existing };
    let changed = false;
    const enrichment = await measureAsync(async () => {
      if (target && !enriched.target) {
        enriched.target = target;
        changed = true;
      }
      if (screenTargetOptions.enabled && shouldRefreshScreenTarget(enriched, screenTargetOptions)) {
        await applyScreenTargetToScreen(store, enriched, screenTargetOptions);
        changed = true;
      }
      if (textOptions.enabled && shouldRefreshTextContext(enriched, textOptions)) {
        await applyTextContextToScreen(store, enriched, textOptions);
        changed = true;
      }
    });
    if (!changed) {
      return {
        screen: enriched,
        prepared: false,
        timings: {
          inspectMs: inspected.durationMs,
          lookupMs: reused.durationMs,
          enrichmentMs: enrichment.durationMs,
          totalMs: round(performance.now() - totalStarted, 1),
        },
      };
    }

    const persisted = await measureAsync(() => withStoreLock(store, async () => {
      const db = await readDb(store);
      const current = db.screens.find((screen) => screen.id === enriched.id);
      if (!current) return enriched;
      mergeScreenEnrichment(current, enriched, contextOptions);
      if (target && !current.target) current.target = target;
      await writeDb(store, db);
      return current;
    }));
    return {
      screen: persisted.value,
      prepared: false,
      timings: {
        inspectMs: inspected.durationMs,
        lookupMs: reused.durationMs,
        enrichmentMs: enrichment.durationMs,
        persistMs: persisted.durationMs,
        totalMs: round(performance.now() - totalStarted, 1),
      },
    };
  }

  const contextScreen = { sourcePath };
  const textPlan = textPreparationPlan(textOptions);
  const parallelStarted = performance.now();
  const [optimization, context] = await Promise.all([
    measureAsync(() => withArtifactLock(store, `${hash}:${optimizeKey}`, () => (
      optimizeForPrompt(store, sourcePath, hash, sourceStat, source.metadata, options)
    ))),
    collectPreparationContext(store, contextScreen, screenTargetOptions, textOptions, textPlan.parallelProviders),
  ]);
  const parallelStageMs = round(performance.now() - parallelStarted, 1);
  const optimized = optimization.value;
  let textResult = context.textResult ?? { textContext: null, sources: [] };
  let textMs = context.textMs;
  let fallbackTextMs = 0;
  if (textOptions.enabled && !textResult?.textContext && textPlan.remainingProviders.length > 0) {
    const collected = await measureAsync(() => collectTextContextProviders(
      store,
      contextScreen,
      textOptions,
      textPlan.remainingProviders,
      textResult?.sources,
    ));
    textResult = collected.value;
    fallbackTextMs = collected.durationMs;
    textMs = round(textMs + fallbackTextMs, 1);
  }

  const screen = {
    id: `scr_${hash.slice(0, 12)}_${Date.now().toString(36)}`,
    hash,
    sourcePath: recordedSourcePath,
    sourceKind: rawContextOptions.sourceKind ?? "file",
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
  if (screenTargetOptions.enabled) {
    screen.screenTarget = contextScreen.screenTarget ?? null;
    screen.screenTargetKey = contextScreen.screenTargetKey;
  }
  if (textOptions.enabled) applyTextContextResultToScreen(screen, textResult, textOptions);

  const persisted = await measureAsync(() => withStoreLock(store, async () => {
    const db = await readDb(store);
    const raced = findReusableScreen(db.screens, lookup);
    if (raced) {
      mergeScreenEnrichment(raced, screen, contextOptions);
      await writeDb(store, db);
      return { screen: raced, prepared: false };
    }

    db.screens.push(screen);
    await writeDb(store, db);
    await recordPreparedScreenStats(store, screen);
    return { screen, prepared: true };
  }));
  return {
    ...persisted.value,
    timings: {
      inspectMs: inspected.durationMs,
      lookupMs: reused.durationMs,
      optimizeMs: optimization.durationMs,
      targetMs: context.targetMs,
      textMs,
      parallelTextMs: context.textMs,
      fallbackTextMs,
      parallelStageMs,
      persistMs: persisted.durationMs,
      totalMs: round(performance.now() - totalStarted, 1),
    },
  };
}

function textPreparationPlan(options) {
  if (!options.enabled) return { parallelProviders: [], remainingProviders: [] };
  const providers = textProviderSequence(options);
  const ocrIndex = providers.indexOf("ocr");
  if (ocrIndex < 0) return { parallelProviders: providers, remainingProviders: [] };
  return {
    parallelProviders: providers.slice(0, ocrIndex),
    remainingProviders: providers.slice(ocrIndex),
  };
}

async function collectPreparationContext(store, screen, targetOptions, textOptions, textProviders) {
  let targetMs = 0;
  let textMs = 0;
  let textResult = null;

  if (targetOptions.enabled) {
    const targeted = await measureAsync(() => applyScreenTargetToScreen(store, screen, targetOptions));
    targetMs = targeted.durationMs;
  }
  if (textProviders.length > 0) {
    const collected = await measureAsync(() => collectTextContextProviders(store, screen, textOptions, textProviders));
    textResult = collected.value;
    textMs = collected.durationMs;
  }

  return { targetMs, textMs, textResult };
}

function findReusableScreen(screens, { hash, target, optimizeKey, sourcePath, contextOptions }) {
  const requiresCaptureIdentity = contextOptions.text.enabled || contextOptions.screenTarget.enabled;
  return screens.find((screen) => (
    screen.hash === hash
    && screenState(screen) === "ready"
    && (!screen.target || screen.target === target)
    && screen.optimizeKey === optimizeKey
    && (!requiresCaptureIdentity || screen.sourcePath === sourcePath)
  ));
}

function mergeScreenEnrichment(target, source, contextOptions) {
  if (contextOptions.screenTarget.enabled) {
    target.screenTarget = source.screenTarget ?? null;
    target.screenTargetKey = source.screenTargetKey;
  }
  if (contextOptions.text.enabled) {
    target.textContext = source.textContext ?? null;
    target.textSources = source.textSources ?? [];
    target.textContextKey = source.textContextKey;
    target.ocrText = source.ocrText ?? null;
    target.ocrTextLength = source.ocrTextLength ?? 0;
    target.ocr = source.ocr ?? null;
  }
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
  const textOptions = textContextOptions(args);
  const targetOptions = screenTargetOptions(args);
  const targetSnapshot = targetOptions.enabled ? await collectScreenTargetSnapshot(store) : null;
  const claimedTargetOptions = {
    ...targetOptions,
    snapshot: targetSnapshot,
  };
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  const claimed = await withStoreLock(store, async () => {
    const db = await readDb(store);
    const candidates = db.screens
      .filter((screen) => screenState(screen) === "ready")
      .filter((screen) => !screen.target || screen.target === target)
      .filter((screen) => nowMs - screenPreparedAtMs(screen) <= freshMs)
      .sort((a, b) => screenPreparedAtMs(a) - screenPreparedAtMs(b));

    const screens = [];
    for (const screen of candidates) {
      if (!(await existingFile(screen.optimizedPath))) {
        screen.status = "cleared";
        screen.clearedAt = now;
        screen.clearReason = "optimized-file-missing";
        continue;
      }
      screens.push(screen);
      if (screens.length >= max) break;
    }

    for (const screen of screens) {
      screen.status = "claimed";
      screen.target = target;
      screen.claimedAt = now;
    }

    await writeDb(store, db);
    return screens;
  });

  if (textOptions.enabled || targetOptions.enabled) {
    try {
      for (const screen of claimed) {
        if (targetOptions.enabled) {
          await applyScreenTargetToScreen(store, screen, claimedTargetOptions);
        }
        const effectiveTextOptions = {
          ...textOptions,
          forceRefresh: Boolean(targetSnapshot),
        };
        if (shouldRefreshTextContext(screen, effectiveTextOptions)) {
          await applyTextContextToScreen(store, screen, effectiveTextOptions);
        }
      }
      await withStoreLock(store, async () => {
        const db = await readDb(store);
        for (const enriched of claimed) {
          const current = db.screens.find((screen) => screen.id === enriched.id);
          if (current) mergeScreenEnrichment(current, enriched, {
            text: textOptions,
            screenTarget: targetOptions,
          });
        }
        await writeDb(store, db);
      });
    } catch (error) {
      await withStoreLock(store, async () => {
        const db = await readDb(store);
        for (const claimedScreen of claimed) {
          const current = db.screens.find((screen) => screen.id === claimedScreen.id);
          if (current && screenState(current) === "claimed" && current.claimedAt === now) {
            current.status = "ready";
            current.claimedAt = null;
          }
        }
        await writeDb(store, db);
      });
      throw error;
    }
  }

  return { screens: claimed };
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
    }

    await writeDb(store, db);
    const removablePaths = removeFiles
      ? [...new Set(screens.map((screen) => screen.optimizedPath).filter(Boolean))]
        .filter((path) => !db.screens.some((screen) => screenState(screen) !== "cleared" && screen.optimizedPath === path))
      : [];
    return {
      cleared: screens.length,
      removablePaths,
      textIds: removeFiles ? screens.map((screen) => screen.id).filter(Boolean) : [],
    };
  });

  if (removeFiles) {
    await Promise.all(result.removablePaths.map((path) => rm(path, { force: true })));
    await Promise.all(result.textIds.flatMap((id) => [
      rm(join(store.textDir, `${id}.txt`), { force: true }),
      rm(join(store.textDir, `${id}-screen-context.md`), { force: true }),
    ]));
  }

  return writeResult(args, { cleared: result.cleared });
}

async function statusCommand(args) {
  const store = storePaths(args);
  await ensureStore(store);
  const db = await readDb(store);
  const stats = await readStats(store);
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
    latest: activeScreens.at(-1) ?? null,
    historical: stats,
  };
  if (args.tokens || args["token-estimates"]) result.tokenEstimates = summarizeTokenEstimates(activeScreens);
  return writeResult(args, result);
}

async function statsCommand(args) {
  const store = storePaths(args);
  await ensureStore(store);
  return writeResult(args, { stats: await readStats(store) });
}

async function gcCommand(args) {
  const store = storePaths(args);
  await ensureStore(store, { maintain: false });
  return writeResult(args, await compactStore(store, { removeOrphans: true }));
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
    const projection = projectionOptions(args);
    text = JSON.stringify({ screens: screens.map((screen) => publicScreen(screen, projection)) }, null, 2);
  } else if (format === "markdown") {
    text = screens.map((screen) => `![${screen.id}](${screen.optimizedPath})`).join("\n");
  } else if (format === "text") {
    text = screens.map((screen) => formatScreenTextSnippet(screen, args)).filter(Boolean).join("\n\n");
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
  add(
    "browser dom text",
    process.platform === "darwin" && commandExists("osascript") ? "pass" : "warn",
    process.platform === "darwin" && commandExists("osascript")
      ? "available for supported frontmost browsers when automation permission is granted"
      : "requires macOS osascript browser automation",
  );

  const sharp = await loadSharpModule();
  add(
    "optional sharp optimizer",
    "pass",
    sharp ? `sharp ${sharp.versions?.sharp ?? "available"}` : "not installed; native ImageIO is the default",
  );

  const hasXcrun = commandExists("xcrun");
  const addSwiftHelperCheck = async (name, sourcePath, messages) => {
    if (!(await existingFile(sourcePath))) {
      add(name, "warn", `missing helper source: ${sourcePath}`);
      return;
    }
    if (!hasXcrun) {
      add(name, "warn", messages.noXcrun);
      return;
    }
    const swiftc = run("xcrun", ["-find", "swiftc"], { timeoutMs: 5000 });
    add(
      name,
      swiftc.status === 0 ? "pass" : "warn",
      swiftc.status === 0 ? messages.available : messages.noSwiftc,
    );
  };

  await addSwiftHelperCheck("native optimizer", NATIVE_OPTIMIZER_SOURCE, {
    available: "Swift compiler available",
    noXcrun: "xcrun not found; will fall back to sips",
    noSwiftc: "Swift compiler not found; will fall back to sips",
  });
  await addSwiftHelperCheck("apple vision ocr", APPLE_VISION_OCR_SOURCE, {
    available: "Apple Vision OCR helper can be built",
    noXcrun: "xcrun not found; --ocr and --with-text will be unavailable",
    noSwiftc: "Swift compiler not found; --ocr and --with-text will be unavailable",
  });
  await addSwiftHelperCheck("screen target context", SCREEN_TARGET_SNAPSHOT_SOURCE, {
    available: "screen target helper can be built",
    noXcrun: "xcrun not found; --with-target-context will be unavailable",
    noSwiftc: "Swift compiler not found; --with-target-context will be unavailable",
  });
  await addSwiftHelperCheck("macos accessibility text", MACOS_ACCESSIBILITY_TEXT_SOURCE, {
    available: "accessibility text helper can be built",
    noXcrun: "xcrun not found; accessibility text provider will be unavailable",
    noSwiftc: "Swift compiler not found; accessibility text provider will be unavailable",
  });
  await addSwiftHelperCheck("clipboard image input", CLIPBOARD_IMAGE_READER_SOURCE, {
    available: "clipboard image helper can be built",
    noXcrun: "xcrun not found; clipboard image input will be unavailable",
    noSwiftc: "Swift compiler not found; clipboard image input will be unavailable",
  });
  await addAccessibilityPermissionCheck(add, store, args);

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

async function addAccessibilityPermissionCheck(add, store, args = {}) {
  if (process.platform !== "darwin") {
    add("accessibility permission", "warn", "macOS Accessibility is unavailable on this platform");
    return;
  }

  const binary = await macosAccessibilityTextBinary(store);
  if (!binary) {
    add("accessibility permission", "warn", "accessibility text helper is unavailable");
    return;
  }

  const shouldPrompt = Boolean(args["prompt-permissions"] || args.promptPermissions);
  const result = run(binary, ["--check", ...(shouldPrompt ? ["--prompt"] : [])], { timeoutMs: 5000 });
  if (result.status !== 0) {
    add("accessibility permission", "warn", (result.stderr || result.stdout || `helper exited with ${result.status}`).trim());
    return;
  }

  const parsed = parseJsonish(result.stdout);
  if (parsed.trusted === true || parsed.status === "ready") {
    add("accessibility permission", "pass", "granted");
    return;
  }

  add(
    "accessibility permission",
    "warn",
    parsed.prompted
      ? "permission prompt opened; grant access, then rerun doctor"
      : "missing; run `screenshotter doctor --prompt-permissions` to request it",
    { prompted: Boolean(parsed.prompted), trusted: false },
  );
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
      screens: result.screens.map((screen) => publicScreen(screen, projectionOptions(args))),
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
      screens: result.screens.map((screen) => publicScreen(screen, projectionOptions(args))),
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
  const mode = clipboardDeliveryMode(args);
  const clipboard = shouldReveal
    ? { status: null, label: null, textCopied: false }
    : args["dry-run"]
      ? { status: `${mode}-dry-run`, label: "clipboard dry-run", textCopied: mode !== "image" && Boolean(formatScreenTextSnippet(screen, args)) }
      : await copyScreenToClipboard(screen, args);

  await reportScreenEvent(args, storePaths(args), "clipboard", screen, {
    prepared: result.prepared,
    clipboard: clipboard.status,
    textCopied: clipboard.textCopied,
    appLabel,
  });

  if (args.json || args["dry-run"]) {
    return writeResult({ ...args, json: true }, {
      path: screen.optimizedPath,
      prepared: result.prepared,
      target,
      clipboard: clipboard.status,
      textCopied: clipboard.textCopied,
      attach: shouldReveal
        ? "Use the app's file picker or drag this file into the prompt."
        : clipboard.pasted
          ? `Already pasted into ${appLabel}.`
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
      : clipboard.pasted
        ? `Pasted ${clipboard.label} into ${appLabel}.`
      : `The ${clipboard.label} is on the clipboard. Paste it into ${appLabel} with Cmd+V.`,
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
  const contextOptions = {
    text: textContextOptions(args),
    screenTarget: screenTargetOptions(args),
  };
  const hasContextOptions = contextOptions.text.enabled || contextOptions.screenTarget.enabled;
  const requestedOptimizer = normalizeOptimizer(args.optimizer ?? options.optimizer ?? "native");
  const dataDir = args["data-dir"]
    ? resolve(expandHome(args["data-dir"]))
    : await mkdtemp(join(tmpdir(), "screenshotter-bench-"));
  const store = storePaths({ ...args, "data-dir": dataDir });
  await ensureStore(store);
  await prewarmOptimizer(options);

  let effectiveOptimizer = requestedOptimizer;
  let rows;
  if (requestedOptimizer === "native" && !hasContextOptions) {
    rows = await benchNativeBatch(store, files, args, { ...options, optimizer: "native" });
  } else {
    rows = await benchPrepareRows(store, files, args, { ...options, optimizer: requestedOptimizer }, contextOptions);
  }
  if (!rows && requestedOptimizer === "native") {
    effectiveOptimizer = "sips";
    rows = await benchPrepareRows(store, files, args, { ...options, optimizer: "sips" }, contextOptions);
  }

  const durations = rows.map((row) => row.durationMs).sort((a, b) => a - b);
  const wallDurations = rows.map((row) => row.wallMs ?? row.durationMs).sort((a, b) => a - b);
  const originalBytes = rows.reduce((sum, row) => sum + row.originalBytes, 0);
  const optimizedBytes = rows.reduce((sum, row) => sum + row.optimizedBytes, 0);
  const timing = {
    min: durations[0] ?? 0,
    median: durations[Math.floor(durations.length / 2)] ?? 0,
    max: durations.at(-1) ?? 0,
    avg: round(durations.reduce((sum, value) => sum + value, 0) / Math.max(durations.length, 1), 1),
  };
  const wallTiming = {
    min: wallDurations[0] ?? 0,
    median: wallDurations[Math.floor(wallDurations.length / 2)] ?? 0,
    max: wallDurations.at(-1) ?? 0,
    avg: round(wallDurations.reduce((sum, value) => sum + value, 0) / Math.max(wallDurations.length, 1), 1),
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
    wallMs: wallTiming,
    originalBytes,
    optimizedBytes,
    savedPercent: originalBytes > 0 ? round((1 - optimizedBytes / originalBytes) * 100, 1) : 0,
    rows,
  };
  if (args.tokens || args["token-estimates"]) result.tokenEstimates = summarizeTokenEstimates(rows);
  return writeResult(args, result);
}

async function benchPrepareRows(store, files, args, options, contextOptions = {}) {
  const rows = [];
  for (const file of files) {
    const wallStarted = performance.now();
    const sourceStat = await waitForStableFile(file);
    if (!sourceStat) continue;
    const fileWaitMs = performance.now() - wallStarted;
    const started = performance.now();
    const result = await prepareOne(store, file, sourceStat, args.target ?? "bench", options, contextOptions);
    const durationMs = performance.now() - started;
    const row = benchRowFromScreen(file, result.screen, options, durationMs, result.prepared);
    row.fileWaitMs = round(fileWaitMs, 1);
    row.wallMs = round(performance.now() - wallStarted, 1);
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
    longEdgePercent: screen.longEdgePercent ?? options.longEdgePercent ?? null,
    minLongEdge: screen.minLongEdge ?? options.minLongEdge ?? null,
    maxPatches: screen.maxPatches ?? options.maxPatches ?? null,
    jpegQuality: screen.jpegQuality ?? options.jpegQuality,
    maxOutputBytes: screen.maxOutputBytes ?? options.maxOutputBytes ?? null,
    durationMs: round(durationMs, 1),
    prepared,
    optimizer: screen.optimizer ?? options.optimizer ?? "sips",
  };
  if (screen.screenTarget) {
    row.screenTarget = {
      status: screen.screenTarget.status ?? null,
      durationMs: screen.screenTarget.durationMs ?? null,
      app: screen.screenTarget.frontmostApp?.name ?? null,
      pointerApp: screen.screenTarget.pointerWindow?.app?.name ?? screen.screenTarget.pointerWindow?.ownerName ?? null,
    };
  }
  if (Array.isArray(screen.textSources) && screen.textSources.length > 0) {
    row.textSources = screen.textSources.map((source) => ({
      provider: source.provider,
      status: source.status,
      durationMs: source.durationMs ?? null,
      textLength: source.textLength ?? 0,
    }));
  }
  if (screen.textContext) {
    row.textContext = {
      provider: screen.textContext.provider ?? null,
      durationMs: screen.textContext.durationMs ?? null,
      textLength: screen.textContext.text?.length ?? 0,
    };
  }
  return row;
}

function recentCompressionHistory(screens, limit = 3) {
  return screens
    .filter((screen) => screen.originalBytes !== undefined && screen.optimizedBytes !== undefined)
    .sort((a, b) => screenPreparedAtMs(b) - screenPreparedAtMs(a))
    .slice(0, limit)
    .map(compressionHistoryEntry);
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
    formatTextSummary(screen, { verbose }),
    formatOcrSummary(screen, { verbose }),
    `in ${durationMs}ms`,
    clipboardLabel,
  ].filter(Boolean).join(" ") + "\n";
}

function formatOcrSummary(screen, { verbose = false } = {}) {
  if (screen.textContext?.provider === "apple-vision-ocr") return undefined;
  if (!screen.ocr) return undefined;
  if (screen.ocr.status === "ready") return verbose ? `ocr ${screen.ocrTextLength ?? 0} chars` : "ocr";
  if (screen.ocr.status === "empty") return verbose ? "ocr empty" : undefined;
  return verbose ? `ocr ${screen.ocr.status}` : undefined;
}

function formatTextSummary(screen, { verbose = false } = {}) {
  if (screen.textContext?.text) {
    const provider = screen.textContext.provider ?? "text";
    return verbose ? `${provider} ${screen.textContext.text.length} chars` : provider;
  }
  if (!verbose || !Array.isArray(screen.textSources) || screen.textSources.length === 0) return undefined;
  const failed = screen.textSources.find((source) => source.status && source.status !== "skipped");
  return failed ? `${failed.provider} ${failed.status}` : undefined;
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
  const result = await runAsync(binary, [
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

  const result = await runAsync("sips", args, { timeoutMs: 15_000 });
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

function normalizePrepareContextOptions(rawOptions = {}) {
  const textRaw = rawOptions.text ?? rawOptions.textContext ?? rawOptions;
  const screenTargetRaw = rawOptions.screenTarget ?? rawOptions.targetContext ?? {};
  return {
    text: normalizeTextContextOptions(textRaw),
    screenTarget: normalizeScreenTargetOptions(screenTargetRaw),
  };
}

function screenTargetOptions(args = {}) {
  return normalizeScreenTargetOptions({
    enabled: shouldCollectScreenTarget(args),
  });
}

function shouldCollectScreenTarget(args = {}) {
  if (args["with-target-context"] || args["target-context"] || args.withTargetContext || args.targetContext) return true;
  const rawMode = args["clipboard-mode"] ?? args.clipboardMode;
  return rawMode !== undefined && normalizeClipboardMode(rawMode) === "attachments";
}

function normalizeScreenTargetOptions(rawOptions = {}) {
  const enabled = Boolean(rawOptions.enabled);
  return {
    enabled,
    snapshot: rawOptions.snapshot ? normalizeScreenTargetSnapshot(rawOptions.snapshot) : null,
    key: `enabled=${enabled ? 1 : 0}`,
  };
}

function shouldRefreshScreenTarget(screen, options) {
  if (!options.enabled) return false;
  return Boolean(options.snapshot) || screen.screenTargetKey !== options.key || screen.screenTarget === undefined;
}

async function applyScreenTargetToScreen(store, screen, rawOptions = {}) {
  const options = normalizeScreenTargetOptions(rawOptions);
  if (!options.enabled) return;
  screen.screenTarget = options.snapshot ?? await collectScreenTargetSnapshot(store);
  screen.screenTargetKey = options.key;
}

async function collectScreenTargetSnapshot(store) {
  const started = performance.now();
  if (process.env.SCREENSHOTTER_SCREEN_TARGET_JSON !== undefined) {
    const parsed = parseJsonish(process.env.SCREENSHOTTER_SCREEN_TARGET_JSON);
    return normalizeScreenTargetSnapshot({
      status: "ready",
      ...parsed,
      durationMs: round(performance.now() - started, 1),
    });
  }

  if (process.platform !== "darwin") {
    return normalizeScreenTargetSnapshot({
      status: "unavailable",
      error: "screen target snapshot requires macOS",
      collectedAt: new Date().toISOString(),
      durationMs: round(performance.now() - started, 1),
    });
  }

  const binary = await screenTargetSnapshotBinary(store);
  if (!binary) {
    return normalizeScreenTargetSnapshot({
      status: "unavailable",
      error: "screen target snapshot helper is unavailable",
      collectedAt: new Date().toISOString(),
      durationMs: round(performance.now() - started, 1),
    });
  }

  const result = await runAsync(binary, [], { timeoutMs: 5000 });
  if (result.status !== 0) {
    return normalizeScreenTargetSnapshot({
      status: "failed",
      error: (result.stderr || result.stdout || `screen target helper exited with ${result.status}`).trim(),
      collectedAt: new Date().toISOString(),
      durationMs: round(performance.now() - started, 1),
    });
  }

  const parsed = parseJsonish(result.stdout);
  return normalizeScreenTargetSnapshot({
    status: "ready",
    ...parsed,
    durationMs: round(performance.now() - started, 1),
  });
}

function normalizeScreenTargetSnapshot(snapshot = {}) {
  return {
    status: snapshot.status ?? "ready",
    collectedAt: snapshot.collectedAt ?? new Date().toISOString(),
    durationMs: snapshot.durationMs ?? null,
    frontmostApp: snapshot.frontmostApp ?? null,
    pointer: snapshot.pointer ?? null,
    pointerWindow: snapshot.pointerWindow ?? null,
    error: snapshot.error ?? null,
  };
}

function textContextOptions(args = {}) {
  return normalizeTextContextOptions({
    enabled: shouldCollectTextContext(args),
    provider: args["text-provider"] ?? args.textProvider ?? (args.ocr ? "ocr" : DEFAULT_TEXT_PROVIDER),
    noOcr: Boolean(args["no-ocr"]),
    ocrLevel: args["ocr-level"] ?? args.ocrLevel,
    ocrLanguages: args["ocr-languages"] ?? args.ocrLanguages,
    usesLanguageCorrection: !args["no-language-correction"],
    requireOcr: Boolean(args["require-ocr"] || args.requireOcr),
    maxChars: args["text-max-chars"] ?? args.textMaxChars,
  });
}

function shouldCollectTextContext(args = {}) {
  if (args["no-text"]) return false;
  if (args.ocr || args.text || args["with-text"]) return true;
  const rawMode = args["clipboard-mode"] ?? args.clipboardMode;
  const mode = rawMode === undefined ? undefined : normalizeClipboardMode(rawMode);
  if (mode === "both" || mode === "text" || mode === "files" || mode === "attachments" || mode === "markdown" || mode === "codex-inline") return true;
  const provider = args["text-provider"] ?? args.textProvider;
  return provider !== undefined && provider !== "none";
}

function normalizeTextContextOptions(rawOptions = {}) {
  const provider = normalizeTextProvider(rawOptions.provider ?? DEFAULT_TEXT_PROVIDER);
  const maxChars = parsePositiveInteger(rawOptions.maxChars ?? rawOptions.textMaxChars, DEFAULT_TEXT_SNIPPET_MAX_CHARS);
  const ocr = normalizeOcrOptions({
    enabled: provider === "ocr" || provider === "auto",
    level: rawOptions.ocrLevel ?? rawOptions.level,
    languages: rawOptions.ocrLanguages ?? rawOptions.languages,
    usesLanguageCorrection: rawOptions.usesLanguageCorrection,
    required: rawOptions.requireOcr ?? rawOptions.required,
  });
  const noOcr = Boolean(rawOptions.noOcr);
  const enabled = Boolean(rawOptions.enabled) && provider !== "none";

  return {
    enabled,
    provider,
    noOcr,
    maxChars,
    forceRefresh: Boolean(rawOptions.forceRefresh),
    ocr,
    key: [
      `provider=${provider}`,
      `noOcr=${noOcr ? 1 : 0}`,
      `maxChars=${maxChars}`,
      `ocr=${ocr.key}`,
    ].join(";"),
  };
}

function normalizeTextProvider(value) {
  const normalized = String(value ?? DEFAULT_TEXT_PROVIDER).toLowerCase();
  if (normalized === "auto") return "auto";
  if (normalized === "none" || normalized === "off") return "none";
  if (normalized === "browser" || normalized === "browser-dom" || normalized === "dom") return "browser-dom";
  if (normalized === "accessibility" || normalized === "ax" || normalized === "macos-accessibility") return "accessibility";
  if (normalized === "ocr" || normalized === "apple-vision" || normalized === "apple-vision-ocr") return "ocr";
  throw new Error(`Unknown text provider: ${value}. Use auto, browser-dom, accessibility, ocr, or none.`);
}

function normalizeOcrOptions(rawOptions = {}) {
  const languages = normalizeOcrLanguages(rawOptions.languages ?? rawOptions.ocrLanguages ?? DEFAULT_OCR_LANGUAGES);
  const level = rawOptions.level ?? rawOptions.ocrLevel ?? DEFAULT_OCR_LEVEL;
  if (level !== "accurate" && level !== "fast") throw new Error(`Unknown OCR level: ${level}. Use accurate or fast.`);

  return {
    enabled: Boolean(rawOptions.enabled),
    level,
    languages,
    usesLanguageCorrection: rawOptions.usesLanguageCorrection !== false,
    required: Boolean(rawOptions.required),
    key: [
      `level=${level}`,
      `languages=${languages.join(",")}`,
      `correction=${rawOptions.usesLanguageCorrection === false ? 0 : 1}`,
    ].join(";"),
  };
}

function normalizeOcrLanguages(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? DEFAULT_OCR_LANGUAGES.join(",")).split(",");
  const languages = values
    .map((language) => String(language).trim())
    .filter(Boolean);
  return languages.length > 0 ? languages : DEFAULT_OCR_LANGUAGES;
}

function shouldRefreshTextContext(screen, options) {
  if (!options.enabled) return false;
  return options.forceRefresh || screen.textContextKey !== options.key || screen.textContext === undefined;
}

async function applyTextContextToScreen(store, screen, rawOptions = {}) {
  const options = normalizeTextContextOptions(rawOptions);
  const result = await collectTextContext(store, screen, options);
  applyTextContextResultToScreen(screen, result, options);
}

function applyTextContextResultToScreen(screen, result, options) {
  screen.textContext = result.textContext;
  screen.textSources = result.sources;
  screen.textContextKey = options.key;

  const ocrSource = result.sources.find((source) => source.provider === "apple-vision-ocr");
  if (ocrSource) {
    applyOcrSourceCompatibility(screen, ocrSource, options.ocr);
  } else {
    screen.ocrText = null;
    screen.ocrTextLength = 0;
    screen.ocr = null;
  }
}

async function collectTextContext(store, screen, rawOptions = {}) {
  const options = normalizeTextContextOptions(rawOptions);
  if (!options.enabled) return { textContext: null, sources: [] };
  return collectTextContextProviders(store, screen, options, textProviderSequence(options));
}

async function collectTextContextProviders(store, screen, options, providers, initialSources = []) {
  const sources = [...(initialSources ?? [])];
  for (const provider of providers) {
    let source;
    if (provider === "browser-dom") source = await collectBrowserDomText(screen, options);
    else if (provider === "accessibility") source = await collectAccessibilityTextSource(store, screen, options);
    else if (provider === "ocr") source = await collectOcrTextSource(store, screen.sourcePath, {
      ...options.ocr,
      maxChars: options.maxChars,
    });
    else continue;

    sources.push(source);
    if (source.provider === "apple-vision-ocr" && options.ocr.required && source.status !== "ready" && source.status !== "empty") {
      throw new Error(source.error || `OCR failed with status ${source.status}`);
    }
    if (source.status === "ready" && normalizeTextContextText(source.text)) {
      return {
        textContext: textContextFromSource(source, options.maxChars),
        sources,
      };
    }
  }

  return { textContext: null, sources };
}

function textProviderSequence(options) {
  switch (options.provider) {
    case "browser-dom":
      return ["browser-dom"];
    case "accessibility":
      return ["accessibility"];
    case "ocr":
      return options.noOcr ? [] : ["ocr"];
    case "auto":
      return options.noOcr ? ["accessibility"] : ["accessibility", "ocr"];
    case "none":
    default:
      return [];
  }
}

function textContextFromSource(source, maxChars = DEFAULT_TEXT_SNIPPET_MAX_CHARS) {
  return {
    text: limitTextContext(source.text, maxChars),
    provider: source.provider,
    source: source.source ?? null,
    app: source.app ?? null,
    windowTitle: source.windowTitle ?? null,
    url: source.url ?? null,
    confidence: source.confidence ?? null,
    durationMs: source.durationMs ?? null,
    collectedAt: source.collectedAt ?? new Date().toISOString(),
  };
}

async function collectBrowserDomText(screen, options) {
  const started = performance.now();
  if (process.env.SCREENSHOTTER_BROWSER_DOM_TEXT !== undefined) {
    const text = limitTextContext(process.env.SCREENSHOTTER_BROWSER_DOM_TEXT, options.maxChars);
    return textSourceResult({
      provider: "browser-dom",
      status: text ? "ready" : "empty",
      text,
      app: process.env.SCREENSHOTTER_BROWSER_DOM_APP ?? "Mock Browser",
      windowTitle: process.env.SCREENSHOTTER_BROWSER_DOM_TITLE ?? "Mock Tab",
      url: process.env.SCREENSHOTTER_BROWSER_DOM_URL ?? null,
      source: "environment",
      confidence: 1,
      started,
    });
  }

  if (process.platform !== "darwin") {
    return textSourceResult({
      provider: "browser-dom",
      status: "unavailable",
      error: "browser DOM provider requires macOS automation",
      started,
    });
  }

  const target = preferredScreenTarget(screen);
  const result = await runAsync("osascript", ["-l", "JavaScript", "-e", browserDomJxaScript({
    appName: target?.name,
    maxChars: options.maxChars,
  })], { timeoutMs: 3000 });
  if (result.status !== 0) {
    return textSourceResult({
      provider: "browser-dom",
      status: "failed",
      error: (result.stderr || result.stdout || `osascript exited with ${result.status}`).trim(),
      started,
    });
  }

  const parsed = parseJsonish(result.stdout);
  const text = limitTextContext(parsed.selectedText || parsed.text || "", options.maxChars);
  return textSourceResult({
    provider: "browser-dom",
    status: parsed.status === "ready" && text ? "ready" : parsed.status || (text ? "ready" : "empty"),
    text,
    app: parsed.app ?? null,
    windowTitle: parsed.windowTitle ?? parsed.title ?? null,
    url: parsed.url ?? null,
    source: parsed.source ?? "frontmost browser",
    confidence: text ? 1 : 0,
    error: parsed.error ?? null,
    started,
  });
}

function browserDomJxaScript({ appName: requestedAppName, maxChars }) {
  const safeAppName = JSON.stringify(requestedAppName ?? "");
  const safeMaxChars = parsePositiveInteger(maxChars, DEFAULT_TEXT_SNIPPET_MAX_CHARS);
  return `
ObjC.import("AppKit");

const requestedAppName = ${safeAppName};
const maxChars = ${safeMaxChars};

function appName() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return app ? ObjC.unwrap(app.localizedName) : "";
}

function supportedBrowser(name) {
  return [
    "Google Chrome",
    "Chromium",
    "Brave Browser",
    "Microsoft Edge",
    "Arc",
    "Safari"
  ].indexOf(name) !== -1;
}

function payloadJavaScript() {
  return "(function(){var selected=String(window.getSelection?window.getSelection():'');var body=document.body?document.body.innerText:'';return JSON.stringify({title:document.title||'',url:location.href||'',selectedText:selected.slice(0,${safeMaxChars}),text:(selected||body).slice(0,${safeMaxChars})});})()";
}

function run() {
  const name = requestedAppName || appName();
  if (!supportedBrowser(name)) {
    return JSON.stringify({ status: "unavailable", app: name, error: "frontmost app is not a supported browser" });
  }

  try {
    const app = Application(name);
    const js = payloadJavaScript();
    let raw;
    if (name === "Safari") {
      if (app.documents.length === 0) return JSON.stringify({ status: "empty", app: name, error: "no Safari document" });
      raw = app.doJavaScript(js, { in: app.documents[0] });
    } else {
      if (app.windows.length === 0) return JSON.stringify({ status: "empty", app: name, error: "no browser window" });
      raw = app.windows[0].activeTab().execute({ javascript: js });
    }

    const parsed = JSON.parse(raw || "{}");
    const text = parsed.selectedText || parsed.text || "";
    return JSON.stringify({
      status: text ? "ready" : "empty",
      app: name,
      source: name + " active tab",
      windowTitle: parsed.title || "",
      url: parsed.url || "",
      selectedText: parsed.selectedText || "",
      text: text
    });
  } catch (error) {
    return JSON.stringify({ status: "failed", app: name, error: String(error) });
  }
}
`;
}

async function collectOcrTextSource(store, path, options) {
  const started = performance.now();
  if (process.env.SCREENSHOTTER_OCR_TEXT !== undefined) {
    const text = limitTextContext(process.env.SCREENSHOTTER_OCR_TEXT, options.maxChars);
    return textSourceResult({
      provider: "apple-vision-ocr",
      status: text ? "ready" : "empty",
      text,
      source: "source screenshot",
      confidence: text ? 0.85 : 0,
      started,
      ocr: {
        key: options.key,
        level: options.level,
        languages: options.languages,
        usesLanguageCorrection: options.usesLanguageCorrection,
      },
    });
  }
  const result = await extractTextFromImage(store, path, options);
  return textSourceResult({
    provider: "apple-vision-ocr",
    status: result.status,
    text: limitTextContext(result.text ?? "", options.maxChars),
    source: "source screenshot",
    confidence: result.status === "ready" ? 0.85 : 0,
    error: result.error ?? null,
    ocr: {
      key: options.key,
      level: options.level,
      languages: options.languages,
      usesLanguageCorrection: options.usesLanguageCorrection,
    },
    started,
  });
}

function collectUnavailableTextSource(provider, error) {
  return textSourceResult({
    provider,
    status: "unavailable",
    error,
    started: performance.now(),
  });
}

async function collectAccessibilityTextSource(store, screen, options) {
  const started = performance.now();
  const target = preferredScreenTarget(screen);
  if (process.env.SCREENSHOTTER_ACCESSIBILITY_TEXT !== undefined) {
    const text = limitTextContext(process.env.SCREENSHOTTER_ACCESSIBILITY_TEXT, options.maxChars);
    return textSourceResult({
      provider: "macos-accessibility",
      status: text ? "ready" : "empty",
      text,
      app: process.env.SCREENSHOTTER_ACCESSIBILITY_APP ?? target?.name ?? "Mock App",
      windowTitle: process.env.SCREENSHOTTER_ACCESSIBILITY_TITLE ?? null,
      source: "environment",
      confidence: 0.9,
      started,
    });
  }

  if (process.platform !== "darwin") {
    return textSourceResult({
      provider: "macos-accessibility",
      status: "unavailable",
      error: "macOS Accessibility provider requires macOS",
      started,
    });
  }

  const binary = await macosAccessibilityTextBinary(store);
  if (!binary) {
    return textSourceResult({
      provider: "macos-accessibility",
      status: "unavailable",
      error: "macOS Accessibility helper is unavailable",
      started,
    });
  }

  const args = [];
  if (target?.pid) args.push("--pid", String(target.pid));
  args.push("--max-chars", String(options.maxChars));

  const result = await runAsync(binary, args, { timeoutMs: 4000 });
  if (result.status !== 0) {
    return textSourceResult({
      provider: "macos-accessibility",
      status: "failed",
      error: (result.stderr || result.stdout || `accessibility helper exited with ${result.status}`).trim(),
      started,
    });
  }

  const parsed = parseJsonish(result.stdout);
  const text = limitTextContext(parsed.text ?? "", options.maxChars);
  return textSourceResult({
    provider: "macos-accessibility",
    status: parsed.status === "ready" && text ? "ready" : parsed.status || (text ? "ready" : "empty"),
    text,
    app: parsed.app ?? target?.name ?? null,
    windowTitle: parsed.windowTitle ?? null,
    source: parsed.source ?? "macOS Accessibility",
    confidence: text ? 0.9 : 0,
    error: parsed.error ?? null,
    started,
  });
}

function preferredScreenTarget(screen) {
  const pointerWindow = screen?.screenTarget?.pointerWindow;
  const pointerApp = pointerWindow?.app;
  const pointerPid = pointerWindow?.pid ?? pointerApp?.pid;
  if (pointerPid) {
    return {
      pid: pointerPid,
      name: pointerApp?.name ?? pointerWindow?.ownerName ?? null,
      bundleId: pointerApp?.bundleId ?? null,
      source: "pointer-window",
    };
  }

  const frontmost = screen?.screenTarget?.frontmostApp;
  return frontmost?.pid ? { ...frontmost, source: "frontmost-app" } : null;
}

function textSourceResult(source) {
  const text = normalizeTextContextText(source.text ?? "");
  return {
    provider: source.provider,
    status: source.status,
    text,
    textLength: text.length,
    source: source.source ?? null,
    app: source.app ?? null,
    windowTitle: source.windowTitle ?? null,
    url: source.url ?? null,
    confidence: source.confidence ?? null,
    durationMs: round(performance.now() - source.started, 1),
    collectedAt: new Date().toISOString(),
    error: source.error ?? null,
    ocr: source.ocr ?? null,
  };
}

function applyOcrSourceCompatibility(screen, source, options) {
  const text = normalizeTextContextText(source.text ?? "");
  screen.ocrText = text;
  screen.ocrTextLength = text.length;
  screen.ocr = {
    status: source.status,
    key: source.ocr?.key ?? options.key,
    level: source.ocr?.level ?? options.level,
    languages: source.ocr?.languages ?? options.languages,
    usesLanguageCorrection: source.ocr?.usesLanguageCorrection ?? options.usesLanguageCorrection,
    extractedAt: source.collectedAt,
    durationMs: source.durationMs,
    error: source.error ?? null,
  };
}

async function extractTextFromImage(store, path, options) {
  if (process.platform !== "darwin") {
    return { status: "unavailable", text: "", error: "Apple Vision OCR requires macOS" };
  }

  const binary = await appleVisionOcrBinary(store);
  if (!binary) {
    return { status: "unavailable", text: "", error: "Apple Vision OCR helper is unavailable" };
  }

  const result = await runAsync(binary, [
    path,
    "--level", options.level,
    "--languages", options.languages.join(","),
    ...(options.usesLanguageCorrection ? [] : ["--no-language-correction"]),
  ], { timeoutMs: 30_000 });
  if (result.status !== 0) {
    return {
      status: "failed",
      text: "",
      error: (result.stderr || result.stdout || `OCR helper exited with ${result.status}`).trim(),
    };
  }

  const text = normalizeOcrText(result.stdout);
  return {
    status: text ? "ready" : "empty",
    text,
  };
}

function normalizeOcrText(text) {
  return normalizeTextContextText(text);
}

function normalizeTextContextText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function limitTextContext(text, maxChars = DEFAULT_TEXT_SNIPPET_MAX_CHARS) {
  const normalized = normalizeTextContextText(text);
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trimEnd();
}

function formatScreenTextSnippet(screen, args = {}) {
  const text = normalizeTextContextText(screen.textContext?.text ?? screen.ocrText ?? "");
  if (!text) return "";
  const maxChars = parsePositiveInteger(args["text-max-chars"] ?? args.textMaxChars ?? DEFAULT_TEXT_SNIPPET_MAX_CHARS, DEFAULT_TEXT_SNIPPET_MAX_CHARS);
  return truncateText(text, maxChars);
}

function formatClipboardText(screen, args = {}) {
  const snippet = formatScreenTextSnippet(screen, args);
  if (!snippet) return "";
  const context = screen.textContext;
  const heading = context?.source || context?.windowTitle
    ? [
      `Screen text from ${context.source ?? context.provider}`,
      context.windowTitle ? `Title: ${context.windowTitle}` : undefined,
      context.url ? `URL: ${context.url}` : undefined,
    ].filter(Boolean).join("\n")
    : "Screen text";
  return `${heading}\n\n${snippet}`;
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, Math.max(0, maxChars - 20)).trimEnd();
  return `${truncated}\n[truncated]`;
}

async function nativeOptimizerBinary(store) {
  return swiftHelperBinary(store, {
    cache: nativeOptimizerBinaries,
    sourcePath: NATIVE_OPTIMIZER_SOURCE,
    outputName: "native-image-optimizer",
  });
}

async function menuBarControllerBinary(store) {
  return swiftHelperBinary(store, {
    cache: menuBarControllerBinaries,
    sourcePath: MENU_BAR_CONTROLLER_SOURCE,
    outputName: "menu-bar-controller",
  });
}

async function appleVisionOcrBinary(store) {
  return swiftHelperBinary(store, {
    cache: appleVisionOcrBinaries,
    sourcePath: APPLE_VISION_OCR_SOURCE,
    outputName: "apple-vision-ocr",
  });
}

async function screenTargetSnapshotBinary(store) {
  return swiftHelperBinary(store, {
    cache: screenTargetSnapshotBinaries,
    sourcePath: SCREEN_TARGET_SNAPSHOT_SOURCE,
    outputName: "screen-target-snapshot",
  });
}

async function macosAccessibilityTextBinary(store) {
  return swiftHelperBinary(store, {
    cache: macosAccessibilityTextBinaries,
    sourcePath: MACOS_ACCESSIBILITY_TEXT_SOURCE,
    outputName: "macos-accessibility-text",
  });
}

async function clipboardImageReaderBinary(store) {
  return swiftHelperBinary(store, {
    cache: clipboardImageReaderBinaries,
    sourcePath: CLIPBOARD_IMAGE_READER_SOURCE,
    outputName: "clipboard-image-reader",
  });
}

async function swiftHelperBinary(store, { cache, sourcePath, outputName }) {
  if (!(await existingFile(sourcePath))) return undefined;
  const fingerprint = createHash("sha256")
    .update(await readFile(sourcePath))
    .update(`\0${process.arch}\0${process.platform}\0${VERSION}`)
    .digest("hex");
  const cacheKey = `${store.dataDir}:${outputName}:${fingerprint}`;
  if (cache.has(cacheKey)) return await cache.get(cacheKey) ?? undefined;

  const helperPromise = buildSwiftHelperBinary(store, { sourcePath, outputName, fingerprint });
  cache.set(cacheKey, helperPromise);
  const outputPath = await helperPromise;
  cache.set(cacheKey, outputPath ?? null);
  return outputPath ?? undefined;
}

async function buildSwiftHelperBinary(store, { sourcePath, outputName, fingerprint }) {
  const helperDir = join(store.dataDir, "helpers");
  const outputPath = join(helperDir, outputName);
  const fingerprintPath = `${outputPath}.sha256`;
  const moduleCachePath = join(helperDir, "swift-module-cache");
  await mkdir(moduleCachePath, { recursive: true });

  const isCurrent = async () => (
    await existingFile(outputPath)
    && (await readFile(fingerprintPath, "utf8").catch(() => "")).trim() === fingerprint
  );
  if (await isCurrent()) return outputPath;
  if (!commandExists("xcrun")) return undefined;

  return withDirectoryLock(join(helperDir, `.${outputName}.build.lock`), async () => {
    if (await isCurrent()) return outputPath;
    const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
    const result = run("xcrun", [
      "swiftc",
      "-module-cache-path", moduleCachePath,
      sourcePath,
      "-o", temporaryPath,
    ], {
      env: { CLANG_MODULE_CACHE_PATH: moduleCachePath },
      timeoutMs: 60_000,
    });
    if (result.status !== 0) {
      await rm(temporaryPath, { force: true });
      return undefined;
    }
    await rename(temporaryPath, outputPath);
    await writeFile(fingerprintPath, `${fingerprint}\n`, { mode: 0o600 });
    return outputPath;
  }, { timeoutMs: ARTIFACT_LOCK_TIMEOUT_MS });
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
    sendEvent(event) {
      if (closed || !child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify(event)}\n`);
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

async function prewarmWatchResources(store, watchState, args = {}) {
  const started = performance.now();
  const tasks = [() => prewarmOptimizer(watchState.options).then(() => true)];

  if (args["clipboard-input"]) tasks.push(() => clipboardImageReaderBinary(store).then(Boolean));

  if (watchState.screenTargetOptions?.enabled) {
    tasks.push(() => prewarmScreenTargetSnapshot(store));
  }

  if (watchState.textOptions?.enabled) {
    const providers = new Set(textProviderSequence(watchState.textOptions));
    if (providers.has("accessibility")) tasks.push(() => prewarmAccessibilityText(store));
    if (providers.has("ocr")) tasks.push(() => appleVisionOcrBinary(store).then(Boolean));
  }

  const results = await Promise.allSettled(tasks.map((task) => task()));
  const ready = results.filter((result) => result.status === "fulfilled" && result.value).length;
  if (shouldVerbose(args)) {
    writeText(`[screenshotter] prewarm: ${ready}/${tasks.length} helpers ready in ${round(performance.now() - started, 1)}ms\n`);
  }
}

async function prewarmScreenTargetSnapshot(store) {
  const binary = await screenTargetSnapshotBinary(store);
  if (!binary) return false;
  run(binary, [], { timeoutMs: 5000 });
  return true;
}

async function prewarmAccessibilityText(store) {
  const binary = await macosAccessibilityTextBinary(store);
  if (!binary) return false;
  run(binary, ["--check"], { timeoutMs: 5000 });
  return true;
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

  while (Date.now() < deadline) {
    const current = await safeStat(filePath);
    if (current?.isFile() && current.size > 0) {
      const newestWriteMs = Math.max(current.mtimeMs, current.ctimeMs);
      if (Date.now() - newestWriteMs >= FILE_STABLE_SETTLED_MS) return current;
      if (current.size === previousSize) {
        return current;
      } else {
        previousSize = current.size;
      }
    }
    await delay(FILE_STABLE_INTERVAL_MS);
  }

  return undefined;
}

async function withStoreLock(store, fn) {
  return withDirectoryLock(store.lockDir, fn, { timeoutMs: LOCK_TIMEOUT_MS });
}

async function withArtifactLock(store, key, fn) {
  const lockName = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return withDirectoryLock(join(store.locksDir, `${lockName}.lock`), fn, {
    timeoutMs: ARTIFACT_LOCK_TIMEOUT_MS,
  });
}

async function withDirectoryLock(lockDir, fn, { timeoutMs, staleMs = LOCK_STALE_MS } = {}) {
  const started = Date.now();
  const ownerPath = join(lockDir, "owner.json");
  const owner = {
    pid: process.pid,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
  };
  await mkdir(dirname(lockDir), { recursive: true });

  while (true) {
    let created = false;
    try {
      await mkdir(lockDir);
      created = true;
      await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if (created) await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      if (error?.code !== "EEXIST") throw error;
      if (await staleDirectoryLock(lockDir, ownerPath, staleMs)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for lock: ${lockDir}`);
      await delay(50);
    }
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lockDir, now, now).catch(() => undefined);
  }, Math.min(LOCK_HEARTBEAT_MS, Math.max(250, Math.floor(staleMs / 3))));
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    const currentOwner = await readLockOwner(ownerPath);
    if (currentOwner?.token === owner.token) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function staleDirectoryLock(lockDir, ownerPath, staleMs) {
  const lockStat = await safeStat(lockDir);
  if (!lockStat || Date.now() - lockStat.mtimeMs <= staleMs) return false;
  const owner = await readLockOwner(ownerPath);
  return !owner?.pid || !processIsAlive(owner.pid);
}

async function readLockOwner(ownerPath) {
  try {
    return JSON.parse(await readFile(ownerPath, "utf8"));
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function ensureStore(store, { maintain = true } = {}) {
  await mkdir(store.dataDir, { recursive: true, mode: 0o700 });
  await chmod(store.dataDir, 0o700).catch(() => undefined);
  await mkdir(store.originalsDir, { recursive: true, mode: 0o700 });
  await mkdir(store.optimizedDir, { recursive: true, mode: 0o700 });
  await mkdir(store.textDir, { recursive: true, mode: 0o700 });
  await mkdir(store.logsDir, { recursive: true, mode: 0o700 });
  await mkdir(store.locksDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(store.dbPath), { recursive: true });
  await createStoreFile(store.dbPath, `${JSON.stringify(emptyDb(), null, 2)}\n`);
  await createStoreFile(store.statsPath, `${JSON.stringify(emptyStats(), null, 2)}\n`);
  await Promise.all([
    chmod(store.dbPath, 0o600).catch(() => undefined),
    chmod(store.statsPath, 0o600).catch(() => undefined),
  ]);

  if (maintain && !maintainedStores.has(store.dataDir)) {
    maintainedStores.add(store.dataDir);
    await compactStore(store);
  }
}

async function createStoreFile(path, contents) {
  try {
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

async function compactStore(store, { removeOrphans = false } = {}) {
  const retention = storeRetentionOptions();
  const compacted = await withStoreLock(store, async () => {
    const db = await readDb(store);
    const result = compactScreenRecords(db, retention);
    if (result.changed) await writeDb(store, db);
    return {
      ...result,
      activePaths: [...new Set(db.screens
        .filter((screen) => screenState(screen) !== "cleared")
        .map((screen) => screen.optimizedPath)
        .filter(Boolean))],
    };
  });

  const cleanup = await cleanupRetiredArtifacts(store, compacted.retiredScreens, compacted.activePaths, { removeOrphans });
  return {
    expired: compacted.expired,
    removedRecords: compacted.removedScreens.length,
    removedFiles: cleanup.removedFiles,
    retainedRecords: compacted.retained,
  };
}

function storeRetentionOptions() {
  return {
    readyRetentionMs: parseNonNegativeInteger(process.env.SCREENSHOTTER_READY_RETENTION_MS, DEFAULT_READY_RETENTION_MS),
    recordRetentionMs: parseNonNegativeInteger(process.env.SCREENSHOTTER_RECORD_RETENTION_MS, DEFAULT_RECORD_RETENTION_MS),
    maxRecords: parsePositiveInteger(process.env.SCREENSHOTTER_MAX_SCREEN_RECORDS, DEFAULT_MAX_SCREEN_RECORDS),
  };
}

function compactScreenRecords(db, options, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const retired = [];
  let expired = 0;
  for (const screen of db.screens) {
    if (screenState(screen) !== "ready") continue;
    if (nowMs - screenPreparedAtMs(screen) <= options.readyRetentionMs) continue;
    screen.status = "cleared";
    screen.clearedAt = now;
    screen.clearReason = "retention-expired";
    retired.push(screen);
    expired += 1;
  }

  const newestFirst = [...db.screens].sort((a, b) => screenPreparedAtMs(b) - screenPreparedAtMs(a));
  const retainedNewest = newestFirst
    .filter((screen) => nowMs - screenPreparedAtMs(screen) <= options.recordRetentionMs)
    .slice(0, options.maxRecords);
  const retainedIds = new Set(retainedNewest.map((screen) => screen.id));
  const removedScreens = db.screens.filter((screen) => !retainedIds.has(screen.id));
  db.screens = retainedNewest.sort((a, b) => screenPreparedAtMs(a) - screenPreparedAtMs(b));

  return {
    changed: expired > 0 || removedScreens.length > 0,
    expired,
    retiredScreens: [...new Map([...retired, ...removedScreens].map((screen) => [screen.id, screen])).values()],
    removedScreens,
    retained: db.screens.length,
  };
}

async function cleanupRetiredArtifacts(store, retiredScreens, activePaths, { removeOrphans }) {
  const active = new Set(activePaths);
  const candidates = new Set(retiredScreens.map((screen) => screen.optimizedPath).filter(Boolean));
  if (removeOrphans) {
    const entries = await readdir(store.optimizedDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile()) candidates.add(join(store.optimizedDir, entry.name));
    }
  }

  let removedFiles = 0;
  for (const path of candidates) {
    if (active.has(path)) continue;
    if (await existingFile(path)) removedFiles += 1;
    await rm(path, { force: true });
  }
  for (const screen of retiredScreens) {
    if (!screen.id) continue;
    await rm(join(store.textDir, `${screen.id}.txt`), { force: true });
    await rm(join(store.textDir, `${screen.id}-screen-context.md`), { force: true });
  }
  return { removedFiles };
}

async function readDb(store) {
  try {
    const parsed = JSON.parse(await readFile(store.dbPath, "utf8"));
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.screens)) {
      throw new Error(`unsupported or invalid schema version ${parsed.schemaVersion ?? "unknown"}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return emptyDb();
    throw new Error(`Could not read screenshot store ${store.dbPath}: ${formatError(error)}`);
  }
}

async function writeDb(store, db) {
  const tmpPath = `${store.dbPath}.tmp-${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, store.dbPath);
}

function emptyDb() {
  return { schemaVersion: SCHEMA_VERSION, screens: [] };
}

async function readStats(store) {
  try {
    const parsed = JSON.parse(await readFile(store.statsPath, "utf8"));
    if (parsed.schemaVersion !== STATS_SCHEMA_VERSION) {
      throw new Error(`unsupported stats schema version ${parsed.schemaVersion ?? "unknown"}`);
    }
    return normalizeStats(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStats();
    throw new Error(`Could not read screenshot stats ${store.statsPath}: ${formatError(error)}`);
  }
}

async function writeStats(store, stats) {
  const tmpPath = `${store.statsPath}.tmp-${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(normalizeStats(stats), null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, store.statsPath);
}

async function recordPreparedScreenStats(store, screen) {
  const stats = await readStats(store);
  const originalBytes = Math.max(0, screen.originalBytes ?? 0);
  const optimizedBytes = Math.max(0, screen.optimizedBytes ?? 0);
  const savedBytes = Math.max(0, originalBytes - optimizedBytes);
  const preparedAt = screenPreparedAt(screen) ?? new Date().toISOString();

  stats.screensPrepared += 1;
  stats.originalBytes += originalBytes;
  stats.optimizedBytes += optimizedBytes;
  stats.savedBytes += savedBytes;
  stats.firstPreparedAt = stats.firstPreparedAt ?? preparedAt;
  stats.lastPreparedAt = preparedAt;
  incrementStatsBucket(stats.byProfile, screen.profile ?? DEFAULT_PROFILE, originalBytes, optimizedBytes, savedBytes);
  incrementStatsBucket(stats.byOptimizer, screen.optimizer ?? "unknown", originalBytes, optimizedBytes, savedBytes);
  await writeStats(store, stats);
}

function emptyStats() {
  return {
    schemaVersion: STATS_SCHEMA_VERSION,
    screensPrepared: 0,
    originalBytes: 0,
    optimizedBytes: 0,
    savedBytes: 0,
    firstPreparedAt: null,
    lastPreparedAt: null,
    byProfile: {},
    byOptimizer: {},
  };
}

function normalizeStats(rawStats = {}) {
  const stats = emptyStats();
  stats.screensPrepared = nonNegativeNumber(rawStats.screensPrepared);
  stats.originalBytes = nonNegativeNumber(rawStats.originalBytes);
  stats.optimizedBytes = nonNegativeNumber(rawStats.optimizedBytes);
  stats.savedBytes = nonNegativeNumber(rawStats.savedBytes);
  stats.firstPreparedAt = rawStats.firstPreparedAt ?? null;
  stats.lastPreparedAt = rawStats.lastPreparedAt ?? null;
  stats.byProfile = normalizeStatsBuckets(rawStats.byProfile);
  stats.byOptimizer = normalizeStatsBuckets(rawStats.byOptimizer);
  return stats;
}

function normalizeStatsBuckets(rawBuckets = {}) {
  const buckets = {};
  if (!rawBuckets || typeof rawBuckets !== "object") return buckets;
  for (const [key, value] of Object.entries(rawBuckets)) {
    buckets[key] = {
      screensPrepared: nonNegativeNumber(value?.screensPrepared),
      originalBytes: nonNegativeNumber(value?.originalBytes),
      optimizedBytes: nonNegativeNumber(value?.optimizedBytes),
      savedBytes: nonNegativeNumber(value?.savedBytes),
    };
  }
  return buckets;
}

function incrementStatsBucket(buckets, key, originalBytes, optimizedBytes, savedBytes) {
  const bucket = buckets[key] ?? {
    screensPrepared: 0,
    originalBytes: 0,
    optimizedBytes: 0,
    savedBytes: 0,
  };
  bucket.screensPrepared += 1;
  bucket.originalBytes += originalBytes;
  bucket.optimizedBytes += optimizedBytes;
  bucket.savedBytes += savedBytes;
  buckets[key] = bucket;
}

function nonNegativeNumber(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function storePaths(args) {
  const dataDir = resolve(expandHome(args["data-dir"] ?? process.env.SCREENSHOTTER_DATA_DIR ?? defaultDataDir()));
  return {
    dataDir,
    dbPath: join(dataDir, "screens.json"),
    statsPath: join(dataDir, "stats.json"),
    logsDir: join(dataDir, "logs"),
    eventsLogPath: join(dataDir, "logs", "events.jsonl"),
    lockDir: join(dataDir, ".screens.lock"),
    locksDir: join(dataDir, "locks"),
    originalsDir: join(dataDir, "originals"),
    optimizedDir: resolve(expandHome(args["optimized-dir"] ?? process.env.SCREENSHOTTER_OPTIMIZED_DIR ?? join(dataDir, "optimized"))),
    textDir: join(dataDir, "text"),
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
    else if (token === "--clipboard-input") args["clipboard-input"] = true;
    else if (token === "--ocr") args.ocr = true;
    else if (token === "--text") args.text = true;
    else if (token === "--with-text") args["with-text"] = true;
    else if (token === "--no-text") args["no-text"] = true;
    else if (token === "--with-target-context") args["with-target-context"] = true;
    else if (token === "--target-context") args["target-context"] = true;
    else if (token === "--no-ocr") args["no-ocr"] = true;
    else if (token === "--require-ocr") args["require-ocr"] = true;
    else if (token === "--no-language-correction") args["no-language-correction"] = true;
    else if (token === "--prompt-permissions") args["prompt-permissions"] = true;
    else if (token === "--token-estimates") args["token-estimates"] = true;
    else if (token.startsWith("--")) {
      const [key, inlineValue] = token.slice(2).split("=", 2);
      if (key === "remote-target") throw new Error(`Unknown option: --${key}`);
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
    await appendFile(store.eventsLogPath, `${JSON.stringify(event)}\n`, { mode: 0o600 }).catch((error) => {
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
    textProvider: screen.textContext?.provider ?? null,
    textLength: screen.textContext?.text ? screen.textContext.text.length : 0,
    ocrStatus: screen.ocr?.status ?? null,
    ocrTextLength: screen.ocrTextLength ?? (screen.ocrText ? screen.ocrText.length : 0),
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
  const mode = clipboardDeliveryMode(args);
  if (mode === "both") return "text + optimized image";
  if (mode === "text") return "text";
  if (mode === "files") return "optimized image + text file";
  if (mode === "attachments") return "context file + optimized image";
  if (mode === "markdown") return "markdown context";
  if (mode === "codex-inline") return "Codex app inline paste";
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
  const result = publicResult(value, projectionOptions(args));
  if (args.json) return writeText(`${JSON.stringify(result, null, 2)}\n`);
  if ("screens" in result) return writeText(formatScreens(result.screens));
  return writeText(`${JSON.stringify(result, null, 2)}\n`);
}

function formatScreens(screens) {
  if (screens.length === 0) return "No screenshots\n";
  return `${screens.map((screen) => `${screen.id} ${screen.status} ${screen.optimizedPath}`).join("\n")}\n`;
}

function projectionOptions(args = {}) {
  return {
    includeText: shouldCollectTextContext(args),
    includeTarget: screenTargetOptions(args).enabled,
  };
}

function publicResult(value, options = {}) {
  if (!value || typeof value !== "object") return value;
  const result = { ...value };
  if (result.screen) result.screen = publicScreen(result.screen, options);
  if (Array.isArray(result.screens)) result.screens = result.screens.map((screen) => publicScreen(screen, options));
  if (result.latest) result.latest = publicScreen(result.latest, options);
  if (result.stats) result.stats = publicStats(result.stats);
  if (result.historical) result.historical = publicStats(result.historical);
  return result;
}

function publicScreen(screen, options = {}) {
  const status = screenState(screen);
  const includeText = Boolean(options.includeText);
  const includeTarget = Boolean(options.includeTarget);
  return {
    id: screen.id,
    hash: screen.hash,
    sourcePath: screen.sourcePath,
    sourceKind: screen.sourceKind ?? "file",
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
    screenTarget: includeTarget ? publicScreenTarget(screen.screenTarget) : null,
    textContext: includeText ? publicTextContext(screen.textContext) : null,
    textSources: includeText ? publicTextSources(screen.textSources) : [],
    ocrText: includeText ? screen.ocrText ?? null : null,
    ocrTextLength: includeText ? screen.ocrTextLength ?? (screen.ocrText ? screen.ocrText.length : 0) : 0,
    ocr: includeText ? publicOcr(screen.ocr) : null,
  };
}

function publicScreenTarget(target) {
  return target ? {
    status: target.status ?? null,
    collectedAt: target.collectedAt ?? null,
    durationMs: target.durationMs ?? null,
    frontmostApp: target.frontmostApp ?? null,
    pointer: target.pointer ?? null,
    pointerWindow: target.pointerWindow ?? null,
    error: target.error ?? null,
  } : null;
}

function publicTextContext(context) {
  return context ? {
    text: context.text ?? "",
    provider: context.provider ?? null,
    source: context.source ?? null,
    app: context.app ?? null,
    windowTitle: context.windowTitle ?? null,
    url: context.url ?? null,
    confidence: context.confidence ?? null,
    durationMs: context.durationMs ?? null,
    collectedAt: context.collectedAt ?? null,
  } : null;
}

function publicTextSources(sources) {
  return Array.isArray(sources) ? sources.map((source) => ({
    provider: source.provider ?? null,
    status: source.status ?? null,
    textLength: source.textLength ?? (source.text ? source.text.length : 0),
    source: source.source ?? null,
    app: source.app ?? null,
    windowTitle: source.windowTitle ?? null,
    url: source.url ?? null,
    confidence: source.confidence ?? null,
    durationMs: source.durationMs ?? null,
    collectedAt: source.collectedAt ?? null,
    error: source.error ?? null,
  })) : [];
}

function publicOcr(ocr) {
  return ocr ? {
    status: ocr.status ?? null,
    level: ocr.level ?? null,
    languages: ocr.languages ?? [],
    usesLanguageCorrection: ocr.usesLanguageCorrection ?? null,
    extractedAt: ocr.extractedAt ?? null,
    durationMs: ocr.durationMs ?? null,
    error: ocr.error ?? null,
  } : null;
}

function publicStats(stats) {
  const normalized = normalizeStats(stats);
  return {
    schemaVersion: normalized.schemaVersion,
    screensPrepared: normalized.screensPrepared,
    firstPreparedAt: normalized.firstPreparedAt,
    lastPreparedAt: normalized.lastPreparedAt,
    bytes: statsBytesSummary(normalized),
    byProfile: publicStatsBuckets(normalized.byProfile),
    byOptimizer: publicStatsBuckets(normalized.byOptimizer),
  };
}

function publicStatsBuckets(buckets) {
  return Object.fromEntries(Object.entries(buckets).map(([key, bucket]) => [
    key,
    {
      screensPrepared: bucket.screensPrepared,
      bytes: statsBytesSummary(bucket),
    },
  ]));
}

function statsBytesSummary(stats) {
  const original = stats.originalBytes ?? 0;
  const optimized = stats.optimizedBytes ?? 0;
  const saved = stats.savedBytes ?? Math.max(0, original - optimized);
  return {
    original,
    optimized,
    saved,
    originalFormatted: formatBytes(original),
    optimizedFormatted: formatBytes(optimized),
    savedFormatted: formatBytes(saved),
    savedPercent: original > 0 ? round((saved / original) * 100, 1) : 0,
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
  screenshotter clip [--target app] [--with-text] [--with-target-context] [--text-provider auto|browser-dom|accessibility|ocr|none] [--clipboard-mode image|text|both|files|attachments|markdown|codex-inline] [--json]
  screenshotter paste [--target app] [--with-text] [--with-target-context] [--text-provider auto|browser-dom|accessibility|ocr|none] [--clipboard-mode image|text|both|files|attachments|markdown|codex-inline] [--json]
  screenshotter clipboard [--target app] [--with-text] [--with-target-context] [--no-clipboard] [--json]
  screenshotter codex-app [--with-text] [--with-target-context] [--verbose] [--json] [--reveal]
  screenshotter claude-app [--with-text] [--with-target-context] [--json] [--reveal]
  screenshotter watch [--toolbar] [--target auto|codex-app|codex|pi|claude-app|claude-code] [--clipboard-input] [--clipboard-poll-ms 500] [--with-text] [--with-target-context] [--no-clipboard] [--poll-ms 1500] [--verbose]
  screenshotter toolbar [watch options]
  screenshotter prepare <image> [--target pi] [--with-text] [--with-target-context] [--text-provider auto|browser-dom|accessibility|ocr|none] [--ocr-level accurate|fast] [--ocr-languages en-US] [--profile token|balanced|readability] [--optimizer sharp|native|sips] [--max-long-edge px] [--long-edge-percent pct] [--min-long-edge px] [--jpeg-quality 1-100] [--max-output-bytes n] [--json]
  screenshotter prepare-latest [--target codex-app] [--with-text] [--with-target-context] [--text-provider auto|browser-dom|accessibility|ocr|none] [--profile token|balanced|readability] [--optimizer sharp|native|sips] [--max-long-edge px] [--long-edge-percent pct] [--min-long-edge px] [--jpeg-quality 1-100] [--max-output-bytes n] [--json]
  screenshotter list [--target pi] [--state ready] [--json]
  screenshotter claim [--target pi] [--max 4] [--json]
  screenshotter clear [--target pi] [--files] [--json]
  screenshotter gc [--json]
  screenshotter status [--target pi] [--tokens] [--json]
  screenshotter stats [--json]
  screenshotter doctor [--prompt-permissions] [--json]
  screenshotter copy [--format markdown|paths|json|text] [--clipboard]
  screenshotter reveal [--target codex-app]
  screenshotter bench [--latest 10] [--profile token|balanced|readability] [--optimizer sharp|native|sips] [--max-long-edge px] [--long-edge-percent pct] [--min-long-edge px] [--jpeg-quality 1-100] [--max-output-bytes n] [--max-patches n] [--tokens] [--json]
  screenshotter mcp-server
  screenshotter screenshot-dir [--json]
  screenshotter data-dir [--json]

Environment:
  SCREENSHOTTER_DATA_DIR       Override the store directory.
  SCREENSHOTTER_OPTIMIZED_DIR  Override optimized image output directory.
  SCREENSHOTTER_OPTIMIZER      Use native, sharp, or sips. Native ImageIO is the default; sharp/libvips is opt-in.
  SCREENSHOTTER_VERBOSE=1      Print savings details to stderr and write event logs.
  SCREENSHOTTER_LOG=1          Write JSONL event logs.
  SCREENSHOTTER_READY_RETENTION_MS   Ready-screen retention (default: 24 hours).
  SCREENSHOTTER_RECORD_RETENTION_MS  Cleared/claimed record retention (default: 30 days).
  SCREENSHOTTER_MAX_SCREEN_RECORDS   Maximum retained screen records (default: 500).

Profiles:
  readability  Low/default: max long edge 4096 px, JPEG quality 90. Sharp mode adds q90/q88/q85 with a 1 MB target.
  balanced     Mid: max long edge 3000 px, JPEG quality 85.
  token        High: max long edge 2200 px, JPEG quality 50, or 75 when not resized.

Text:
  --with-text collects direct visible text through macOS Accessibility.
  --text-provider auto explicitly enables Accessibility with Apple Vision OCR fallback.
  --ocr forces Apple Vision OCR as the text provider.
  --no-ocr disables OCR fallback when using the auto provider.
  --text-max-chars caps extracted text before it is stored or returned (default: 4000).
  --clipboard-mode attachments collects direct text and app/window context, then copies the markdown context file and optimized image.
  --clipboard-mode codex-inline pastes text inline, then the optimized image, into Codex as a fallback.
  clipboard imports the current clipboard image, optimizes it, and copies the result back by default.
  watch --clipboard-input also imports newly copied images; macOS does not identify screenshot-origin images separately.

Target context:
  --with-target-context records frontmost app and the visible window under the pointer.
`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : undefined,
    maxBuffer: PROCESS_MAX_BUFFER_BYTES,
    timeout: options.timeoutMs,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

async function measureAsync(operation) {
  const started = performance.now();
  const value = await operation();
  return {
    value,
    durationMs: round(performance.now() - started, 1),
  };
}

function estimateConcurrencyPerformance(durationMs, timings = {}) {
  const prepare = timings.prepare ?? {};
  const captureSavedMs = Math.max(0,
    (timings.targetSnapshotMs ?? 0)
    + (timings.fileStableMs ?? 0)
    - (timings.captureInputsMs ?? 0));
  const prepareSavedMs = Math.max(0,
    (prepare.optimizeMs ?? 0)
    + (prepare.targetMs ?? 0)
    + (prepare.parallelTextMs ?? 0)
    - (prepare.parallelStageMs ?? 0));
  const savedMs = round(captureSavedMs + prepareSavedMs, 1);
  const serialEstimateMs = round(durationMs + savedMs, 1);
  return {
    savedMs,
    serialEstimateMs,
    improvementPercent: serialEstimateMs > 0 ? round((savedMs / serialEstimateMs) * 100, 1) : 0,
  };
}

function runAsync(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const maxBufferBytes = options.maxBufferBytes ?? PROCESS_MAX_BUFFER_BYTES;
    let stdout = "";
    let stderr = "";
    let bufferedBytes = 0;
    let settled = false;
    let terminationError;
    let timeout;
    let forceKillTimeout;

    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
      const detail = error || terminationError;
      resolvePromise({
        status: detail ? 1 : (status ?? 1),
        stdout,
        stderr: [stderr, detail].filter(Boolean).join(stderr && detail ? "\n" : ""),
      });
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : undefined,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(1, formatError(error));
      return;
    }

    const terminate = (error) => {
      if (terminationError) return;
      terminationError = error;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 250);
      forceKillTimeout.unref?.();
    };
    const collect = (stream, append) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        bufferedBytes += Buffer.byteLength(chunk);
        if (bufferedBytes > maxBufferBytes) {
          terminate(`Process output exceeded ${formatBytes(maxBufferBytes)}`);
          return;
        }
        append(chunk);
      });
    };

    collect(child.stdout, (chunk) => { stdout += chunk; });
    collect(child.stderr, (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(1, formatError(error)));
    child.once("close", (code, signal) => {
      const signalError = signal && !terminationError ? `${command} terminated by ${signal}` : undefined;
      finish(code, signalError);
    });

    if (options.timeoutMs) {
      timeout = setTimeout(() => terminate(`${command} timed out after ${options.timeoutMs}ms`), options.timeoutMs);
      timeout.unref?.();
    }
  });
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

async function copyScreenToClipboard(screen, args = {}) {
  const mode = clipboardDeliveryMode(args);
  const text = mode === "image" ? "" : formatClipboardText(screen, args);
  const image = {
    path: screen.optimizedPath,
    pasteboardType: imagePasteboardType(screen),
  };

  if (mode === "attachments") return copyScreenAttachmentsToClipboard(screen, args, text);
  if (mode === "codex-inline") return pasteScreenInlineIntoCodexApp(text, image);

  if (mode === "text") {
    if (!text) throw new Error("No text context is available for the screenshot");
    await pbcopy(text);
    return { status: "text", label: "text snippet", textCopied: true };
  }

  if (mode === "markdown") {
    await pbcopy(formatMarkdownClipboardText(screen, args, text));
    return { status: "markdown", label: "markdown context", textCopied: Boolean(text) };
  }

  if (mode === "files") {
    const paths = [screen.optimizedPath];
    if (text) paths.push(await writeScreenTextFile(screen, args, text));
    await copyFileUrlsToClipboard(paths);
    return {
      status: text ? "files" : "image-file",
      label: text ? "optimized image and text file" : "optimized image file",
      textCopied: Boolean(text),
    };
  }

  if (mode === "both") {
    if (text) {
      await copyImageDataToClipboard(image, { text });
      return { status: "both", label: "text snippet and optimized image", textCopied: true };
    }

    await copyImageDataToClipboard(image);
    return { status: "image", label: "optimized image", textCopied: false };
  }

  await copyImageDataToClipboard(image);
  return { status: "image", label: "optimized image", textCopied: false };
}

async function copyScreenAttachmentsToClipboard(screen, args, text) {
  const paths = [];
  const extractedText = formatScreenTextSnippet(screen, args);
  if (extractedText || screen.screenTarget) {
    paths.push(await writeScreenContextMarkdownFile(screen, args, extractedText));
  }

  paths.push(screen.optimizedPath);
  await copyFileUrlsToClipboard(paths);

  return {
    status: "attachments",
    label: extractedText || screen.screenTarget ? "context file and optimized image" : "optimized image",
    textCopied: Boolean(extractedText || text),
  };
}

async function pasteScreenInlineIntoCodexApp(text, image) {
  if (text) {
    await pbcopy(text);
    pasteClipboardIntoCodexApp();
    await delay(CODEX_APP_PASTE_DELAY_MS);
  }

  await copyImageDataToClipboard(image);
  pasteClipboardIntoCodexApp();

  return {
    status: "codex-inline",
    label: text ? "text snippet and optimized image" : "optimized image",
    textCopied: Boolean(text),
    pasted: true,
  };
}

function pasteClipboardIntoCodexApp() {
  const script = `
tell application "Codex" to activate
delay 0.2
tell application "System Events"
  keystroke "v" using command down
end tell
`;
  const result = run("osascript", ["-e", script], { timeoutMs: 5000 });
  if (result.status !== 0) {
    const details = result.stderr || result.stdout || `osascript exited with ${result.status}`;
    throw new Error(`Could not paste into Codex app. Grant Accessibility/Automation permission and keep the Codex prompt focused. ${details}`);
  }
}

function clipboardMode(args = {}) {
  const configured = args["clipboard-mode"] ?? args.clipboardMode;
  if (configured !== undefined) return normalizeClipboardMode(configured);
  if (args.text || args["with-text"]) return "both";
  return "image";
}

function clipboardDeliveryMode(args = {}) {
  return clipboardMode(args);
}

function normalizeClipboardMode(value) {
  const mode = String(value ?? "image").toLowerCase();
  if (mode === "image") return "image";
  if (mode === "text") return "text";
  if (mode === "both") return "both";
  if (mode === "files" || mode === "file") return "files";
  if (mode === "attachments" || mode === "attachment" || mode === "app-attachments" || mode === "context-files" || mode === "context-bundle" || mode === "bundle") return "attachments";
  if (mode === "markdown" || mode === "md" || mode === "prompt") return "markdown";
  if (mode === "codex-app" || mode === "codex" || mode === "codex-attachments" || mode === "codex-files" || mode === "claude" || mode === "claude-app" || mode === "claude-ai") return "attachments";
  if (mode === "codex-inline" || mode === "codex-text") return "codex-inline";
  throw new Error(`Unknown clipboard mode: ${value}. Use image, text, both, files, attachments, markdown, or codex-inline.`);
}

function formatMarkdownClipboardText(screen, args, text = formatClipboardText(screen, args)) {
  return [
    "Screenshot context",
    "",
    `Optimized image: ${screen.optimizedPath}`,
    screen.sourcePath ? `Source image: ${screen.sourcePath}` : undefined,
    "",
    text ? text : "No screen text was extracted.",
  ].filter((part) => part !== undefined).join("\n");
}

async function writeScreenTextFile(screen, args, text) {
  const store = storePaths(args);
  const id = screen.id || screen.hash?.slice(0, 12) || "screen";
  const filePath = join(store.textDir, `${id}.txt`);
  await mkdir(store.textDir, { recursive: true });
  await writeFile(filePath, `${text.trimEnd()}\n`, { mode: 0o600 });
  return filePath;
}

async function writeScreenContextMarkdownFile(screen, args, text) {
  const store = storePaths(args);
  const id = screen.id || screen.hash?.slice(0, 12) || "screen";
  const filePath = join(store.textDir, `${id}-screen-context.md`);
  await mkdir(store.textDir, { recursive: true });
  await writeFile(filePath, formatScreenContextMarkdown(screen, text), { mode: 0o600 });
  return filePath;
}

export function formatScreenContextMarkdown(screen, text, pathOverrides = {}) {
  const frontmostApp = screen.screenTarget?.frontmostApp;
  const pointerWindow = screen.screenTarget?.pointerWindow;
  const pointerApp = pointerWindow?.app ?? pointerWindow;
  const pointerAppName = pointerApp?.name;
  const textContext = screen.textContext;
  const shouldShowPointerApp = pointerWindow?.windowTitle && pointerAppName && pointerAppName !== frontmostApp?.name;
  const extractedText = text ? text.trimEnd() : "No direct screen text was extracted.";
  const codeFence = markdownCodeFence(extractedText);
  const optimizedPath = pathOverrides.optimizedPath ?? screen.optimizedPath;
  const sourcePath = Object.hasOwn(pathOverrides, "sourcePath") ? pathOverrides.sourcePath : screen.sourcePath;
  return [
    "# Screen Context",
    "",
    "## Image",
    "",
    `- Optimized image: ${optimizedPath}`,
    screen.sourceKind === "clipboard" ? "- Source: macOS clipboard" : (sourcePath ? `- Source image: ${sourcePath}` : undefined),
    frontmostApp?.name ? `- App: ${frontmostApp.name}` : undefined,
    pointerWindow?.windowTitle ? `- Pointer window: ${pointerWindow.windowTitle}` : undefined,
    shouldShowPointerApp ? `- Pointer window app: ${pointerAppName}` : undefined,
    textContext?.windowTitle ? `- Text window: ${textContext.windowTitle}` : undefined,
    textContext?.url ? `- URL: ${textContext.url}` : undefined,
    textContext?.provider ? `- Text source: ${formatTextProviderLabel(textContext.provider)}` : undefined,
    "",
    "## Extracted Text",
    "",
    `${codeFence}text`,
    extractedText,
    codeFence,
    "",
    ...formatTextSourceDiagnostics(screen),
  ].filter((part) => part !== undefined).join("\n");
}

function markdownCodeFence(text) {
  const runs = String(text ?? "").match(/`+/g) ?? [];
  const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 0);
  return "`".repeat(Math.max(3, longestRun + 1));
}

function formatTextProviderLabel(provider) {
  switch (provider) {
    case "browser-dom":
      return "browser DOM";
    case "macos-accessibility":
      return "macOS Accessibility";
    case "apple-vision-ocr":
      return "Apple Vision OCR";
    default:
      return provider;
  }
}

function formatTextSourceDiagnostics(screen) {
  const sources = Array.isArray(screen.textSources) ? screen.textSources : [];
  if (sources.length === 0) return [];
  const rows = sources
    .filter((source) => source.status !== "ready")
    .map((source) => {
      const parts = [
        `- ${formatTextProviderLabel(source.provider)}: ${source.status ?? "unknown"}`,
        source.app ? `app=${source.app}` : undefined,
        source.error ? `error=${source.error}` : undefined,
      ].filter(Boolean);
      return parts.join(" | ");
    });
  if (rows.length === 0) return [];
  return [
    "## Text Source Diagnostics",
    "",
    ...rows,
    "",
  ];
}

async function copyFileUrlsToClipboard(paths) {
  const script = `
ObjC.import("AppKit");
ObjC.import("Foundation");

function run(argv) {
  const filenames = $.NSMutableArray.arrayWithCapacity(argv.length);
  const urls = $.NSMutableArray.arrayWithCapacity(argv.length);
  for (let index = 0; index < argv.length; index += 1) {
    const path = $.NSString.alloc.initWithUTF8String(argv[index]);
    filenames.addObject(path);
    urls.addObject($.NSURL.fileURLWithPath(path));
  }

  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  const wroteUrls = pasteboard.writeObjects(urls);
  const wroteFilenames = pasteboard.setPropertyListForType(filenames, $.NSFilenamesPboardType);
  if (!wroteUrls && !wroteFilenames) {
    throw new Error("Could not write file paths to clipboard");
  }
}
`;
  const result = await runAsync("osascript", ["-l", "JavaScript", "-e", script, ...paths], { timeoutMs: 5000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `osascript exited with ${result.status}`);
}

async function copyImageDataToClipboard(image, { text = "" } = {}) {
  const script = `
ObjC.import("AppKit");
ObjC.import("Foundation");

function run(argv) {
  const path = argv[0];
  const pasteboardType = argv[1] || "public.png";
  const text = argv[2] || "";
  const data = $.NSData.dataWithContentsOfFile(path);
  if (!data) throw new Error("Could not read image data: " + path);

  const objects = $.NSMutableArray.arrayWithCapacity(text.length > 0 ? 2 : 1);
  if (text.length > 0) {
    objects.addObject(pasteboardTextItem(text));
  }
  objects.addObject(pasteboardDataItem(data, pasteboardType));

  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  if (!pasteboard.writeObjects(objects)) throw new Error("Could not write clipboard items");
}

function pasteboardTextItem(text) {
  const item = $.NSPasteboardItem.alloc.init;
  if (!item.setStringForType(
    $.NSString.alloc.initWithUTF8String(text),
    $.NSString.alloc.initWithUTF8String("public.utf8-plain-text")
  )) {
    throw new Error("Could not create text pasteboard item");
  }
  return item;
}

function pasteboardDataItem(data, pasteboardType) {
  const item = $.NSPasteboardItem.alloc.init;
  if (!item.setDataForType(data, $.NSString.alloc.initWithUTF8String(pasteboardType))) {
    throw new Error("Could not create image pasteboard item");
  }
  return item;
}
`;
  const result = await runAsync("osascript", ["-l", "JavaScript", "-e", script, image.path, image.pasteboardType, text], { timeoutMs: 5000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `osascript exited with ${result.status}`);
}

async function clipboardChangeCount(store) {
  if (process.env.SCREENSHOTTER_CLIPBOARD_CHANGE_COUNT !== undefined) {
    return Number(process.env.SCREENSHOTTER_CLIPBOARD_CHANGE_COUNT);
  }
  const binary = await clipboardImageReaderBinary(store);
  if (!binary) throw new Error("clipboard image reader is unavailable");
  const result = await runAsync(binary, ["--metadata"], { timeoutMs: 5000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `clipboard image reader exited with ${result.status}`);
  const metadata = parseJsonish(result.stdout);
  return Number.isFinite(metadata.changeCount) ? metadata.changeCount : null;
}

async function startClipboardImageMonitor(store, { pollIntervalMs, onImage, onError }) {
  const binary = await clipboardImageReaderBinary(store);
  if (!binary) throw new Error("clipboard image monitor is unavailable");
  const captureDir = await mkdtemp(join(tmpdir(), "screenshotter-clipboard-monitor-"));
  const child = spawn(binary, ["--watch", captureDir, "--poll-ms", String(pollIntervalMs)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stopped = false;
  let stdoutBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const captured = parseJsonish(line);
      if (captured.path) onImage(captured);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => onError(chunk.trim()));
  child.on("error", onError);
  child.on("close", (code) => {
    if (!stopped && code !== 0) onError(`clipboard image monitor exited with ${code}`);
  });

  return {
    stop() {
      stopped = true;
      child.kill();
    },
    cleanup() {
      return rm(captureDir, { recursive: true, force: true });
    },
  };
}

async function captureClipboardImage(store) {
  const captureDir = await mkdtemp(join(tmpdir(), "screenshotter-clipboard-"));
  const cleanup = () => rm(captureDir, { recursive: true, force: true });
  const fixturePath = process.env.SCREENSHOTTER_CLIPBOARD_IMAGE_PATH;
  if (fixturePath) {
    const extension = extname(fixturePath).toLowerCase() || ".png";
    const imagePath = join(captureDir, `clipboard${extension}`);
    await copyFile(fixturePath, imagePath);
    const fixtureChangeCount = Number(process.env.SCREENSHOTTER_CLIPBOARD_CHANGE_COUNT);
    return {
      imagePath,
      changeCount: Number.isFinite(fixtureChangeCount) ? fixtureChangeCount : undefined,
      cleanup,
    };
  }

  const binary = await clipboardImageReaderBinary(store);
  if (!binary) {
    await cleanup();
    throw new Error("clipboard image reader is unavailable");
  }
  const result = await runAsync(binary, [captureDir], { timeoutMs: 5000 });
  if (result.status !== 0) {
    await cleanup();
    throw new Error(result.stderr || result.stdout || `clipboard image reader exited with ${result.status}`);
  }
  const captured = parseJsonish(result.stdout);
  if (!captured.path) {
    await cleanup();
    return { imagePath: null, cleanup: async () => undefined };
  }
  return { imagePath: captured.path, changeCount: captured.changeCount, cleanup };
}

async function copyPreparedScreenIfClipboardUnchanged(screen, args, expectedChangeCount) {
  if (expectedChangeCount !== undefined) {
    const currentChangeCount = await clipboardChangeCount(storePaths(args));
    if (currentChangeCount !== expectedChangeCount) {
      return { status: "superseded", label: "clipboard changed; delivery skipped", textCopied: false };
    }
  }
  return copyPreparedScreen(screen, args);
}

function imagePasteboardType(screen = {}) {
  const mimeType = String(screen.mimeType ?? "").toLowerCase();
  if (IMAGE_PASTEBOARD_TYPES_BY_MIME.has(mimeType)) return IMAGE_PASTEBOARD_TYPES_BY_MIME.get(mimeType);
  const ext = extname(screen.optimizedPath ?? screen.sourcePath ?? "").toLowerCase();
  return IMAGE_PASTEBOARD_TYPES_BY_EXTENSION.get(ext) ?? "public.png";
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

function isNativeMacScreenshotPath(filePath) {
  const marker = run("/usr/bin/xattr", [
    "-p",
    "com.apple.metadata:kMDItemIsScreenCapture",
    filePath,
  ], { timeoutMs: 1000 });
  if (marker.status === 0 && marker.stdout.length > 0) return true;
  return /^(?:Screenshot|Screen Shot)(?:\s|$)/i.test(basename(filePath));
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
