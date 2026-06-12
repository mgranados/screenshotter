import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const STATUS_KEY = "screenshotter";
const TARGET = "pi";
const READY_TTL_MS = 10 * 60_000;
const MAX_READY_SCREENSHOTS = 4;
const PROMPT_ATTACH_WAIT_MS = 1500;
const POLL_INTERVAL_MS = 1500;
const DEFAULT_PROFILE = "readability";
const SCREENSHOT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".tif", ".tiff"]);

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(extensionDir, "..", "..", "bin", "screenshotter.mjs");

export default function screenshotterExtension(pi) {
  const state = {
    enabled: false,
    sinceMs: 0,
    watchDir: undefined,
    watchMode: undefined,
    watcher: undefined,
    pollTimer: undefined,
    ctx: undefined,
    processingPaths: new Set(),
    processingTasks: new Set(),
    fileSignatures: new Map(),
    agentBusySinceMs: undefined,
    lastAgentBusyWindow: undefined,
    readyCount: 0,
    profile: DEFAULT_PROFILE,
  };

  pi.on("session_start", async (_event, ctx) => {
    state.ctx = ctx;
    await refreshReadyCount(pi, state);
    updateUi(ctx, state);
  });

  pi.on("session_shutdown", async () => {
    stopWatcher(state);
  });

  pi.on("agent_start", async () => {
    state.agentBusySinceMs = Date.now();
  });

  pi.on("agent_end", async () => {
    const startMs = state.agentBusySinceMs;
    state.agentBusySinceMs = undefined;
    if (startMs !== undefined) state.lastAgentBusyWindow = { startMs, endMs: Date.now() };
  });

  pi.on("input", async (event, ctx) => {
    state.ctx = ctx;
    if (!state.enabled || event.source !== "interactive") return { action: "continue" };

    trackProcessing(state, scanCandidates(pi, state));
    await waitForProcessing(state, PROMPT_ATTACH_WAIT_MS);
    const claimed = await runScreenshotter(pi, ["claim", "--target", TARGET, "--max", String(MAX_READY_SCREENSHOTS), "--fresh-ms", String(READY_TTL_MS), "--json"]);
    const screens = Array.isArray(claimed.screens) ? claimed.screens : [];
    if (screens.length === 0) {
      if (state.readyCount !== 0) await refreshReadyCount(pi, state);
      updateUi(ctx, state);
      return { action: "continue" };
    }

    const images = [];
    for (const screen of screens) {
      if (!screen.optimizedPath || !screen.mimeType) continue;
      try {
        const data = await fsp.readFile(screen.optimizedPath, "base64");
        images.push({ type: "image", data, mimeType: screen.mimeType });
      } catch {
        // The optimized file may have been removed. Skip it instead of blocking the prompt.
      }
    }

    await refreshReadyCount(pi, state);
    updateUi(ctx, state);

    if (images.length === 0) {
      notify(ctx, "screenshot file was unavailable; prompt sent without it", "warning");
      return { action: "continue" };
    }

    notify(ctx, `${images.length} screenshot${images.length === 1 ? "" : "s"} attached`);
    return {
      action: "transform",
      text: event.text,
      images: [...(event.images ?? []), ...images],
    };
  });

  pi.registerCommand("screenshotter", {
    description: "Enable or disable live native macOS screenshot capture for the current pi prompt",
    handler: async (args, ctx) => {
      state.ctx = ctx;
      const [command = "status"] = args.trim().split(/\s+/).filter(Boolean);

      switch (command.toLowerCase()) {
        case "on":
          await enableScreens(pi, state, ctx);
          return;
        case "token":
        case "balanced":
        case "readability":
          state.profile = command.toLowerCase();
          updateUi(ctx, state);
          notify(ctx, `screenshotter profile ${state.profile}`);
          return;
        case "off":
          stopWatcher(state);
          await runScreenshotter(pi, ["clear", "--target", TARGET, "--json"]).catch(() => undefined);
          await refreshReadyCount(pi, state);
          updateUi(ctx, state);
          notify(ctx, "screenshotter off");
          return;
        case "clear": {
          const result = await runScreenshotter(pi, ["clear", "--target", TARGET, "--json"]);
          await refreshReadyCount(pi, state);
          updateUi(ctx, state);
          notify(ctx, `cleared ${result.cleared ?? 0} screenshot${result.cleared === 1 ? "" : "s"}`);
          return;
        }
        case "status":
          await refreshReadyCount(pi, state);
          updateUi(ctx, state);
          notify(ctx, await formatStatus(pi, state));
          return;
        case "help":
          notify(ctx, usage());
          return;
        default:
          notify(ctx, usage(), "warning");
      }
    },
  });
}

async function enableScreens(pi, state, ctx) {
  if (!ctx.hasUI) {
    notify(ctx, "interactive UI is required", "error");
    return;
  }

  if (process.platform !== "darwin") {
    notify(ctx, "v1 supports native macOS screenshots only", "error");
    return;
  }

  const result = await runScreenshotter(pi, ["screenshot-dir", "--json"]);
  const watchDir = result.path || path.join(os.homedir(), "Desktop");
  const stat = await safeStat(watchDir);
  if (!stat?.isDirectory()) {
    notify(ctx, `screenshot folder is not available: ${watchDir}`, "error");
    return;
  }

  stopWatcher(state);
  await runScreenshotter(pi, ["clear", "--target", TARGET, "--json"]).catch(() => undefined);

  state.enabled = true;
  state.sinceMs = Date.now();
  state.watchDir = watchDir;
  state.watchMode = undefined;
  state.processingPaths.clear();
  state.fileSignatures = await snapshotFileSignatures(watchDir);
  state.readyCount = 0;
  state.profile = state.profile || DEFAULT_PROFILE;

  startNativeWatcher(pi, state);

  updateUi(ctx, state);
  notify(ctx, "screenshotter on");
}

function stopWatcher(state) {
  state.watcher?.close();
  state.watcher = undefined;
  clearInterval(state.pollTimer);
  state.pollTimer = undefined;
  state.enabled = false;
  state.watchDir = undefined;
  state.watchMode = undefined;
  state.fileSignatures.clear();
}

function startNativeWatcher(pi, state) {
  const watchDir = state.watchDir;
  if (!watchDir) return;

  try {
    state.watchMode = "native";
    state.watcher = fs.watch(watchDir, (eventType, fileName) => {
      if (eventType !== "rename" && eventType !== "change") return;

      const name = normalizeWatchFileName(fileName);
      if (!name) {
        trackProcessing(state, scanCandidates(pi, state));
        return;
      }

      trackProcessing(state, prepareCandidate(pi, state, path.join(watchDir, name)));
    });
  } catch (error) {
    startPollingFallback(pi, state, error);
    return;
  }

  state.watcher.on("error", (error) => {
    state.watcher?.close();
    state.watcher = undefined;

    if (state.enabled && isRecoverableWatchError(error)) {
      startPollingFallback(pi, state, error);
      return;
    }

    const latestCtx = state.ctx;
    stopWatcher(state);
    if (latestCtx) notify(latestCtx, `watcher stopped: ${formatError(error)}`, "error");
  });
}

function startPollingFallback(pi, state, error) {
  if (!state.enabled || state.pollTimer) return;
  state.watchMode = "polling";

  state.pollTimer = setInterval(() => {
    trackProcessing(state, scanCandidates(pi, state, { changedOnly: true }));
  }, POLL_INTERVAL_MS);
  state.pollTimer.unref?.();
  trackProcessing(state, scanCandidates(pi, state, { changedOnly: true }));

  const latestCtx = state.ctx;
  if (latestCtx) {
    notify(latestCtx, `native watcher unavailable; polling screenshot folder (${formatError(error)})`, "warning");
    updateUi(latestCtx, state);
  }
}

async function prepareCandidate(pi, state, candidatePath) {
  if (!state.enabled) return;
  if (!isSupportedScreenshotPath(candidatePath)) return;
  if (!state.ctx?.isIdle()) return;

  const key = path.resolve(candidatePath);
  if (state.processingPaths.has(key)) return;
  state.processingPaths.add(key);

  try {
    const stat = await safeStat(candidatePath);
    if (!stat?.isFile()) return;
    const signature = fileSignature(stat);
    if (state.fileSignatures.get(key) === signature) return;
    if (!isRecentFile(stat, state.sinceMs)) {
      state.fileSignatures.set(key, signature);
      return;
    }
    if (wasCreatedDuringAgentRun(stat, state)) {
      state.fileSignatures.set(key, signature);
      return;
    }
    if (!state.ctx?.isIdle()) return;

    await runScreenshotter(pi, ["prepare", candidatePath, "--target", TARGET, "--profile", state.profile || DEFAULT_PROFILE, "--json"]);
    state.fileSignatures.set(key, signature);
    await refreshReadyCount(pi, state);
    if (state.ctx) updateUi(state.ctx, state);
  } catch (error) {
    const latestCtx = state.ctx;
    if (latestCtx) notify(latestCtx, `failed to prepare screenshot: ${formatError(error)}`, "warning");
  } finally {
    state.processingPaths.delete(key);
  }
}

async function scanCandidates(pi, state, { changedOnly = false } = {}) {
  const watchDir = state.watchDir;
  const ctx = state.ctx;
  if (!state.enabled || !watchDir || !ctx?.isIdle()) return;

  const entries = await fsp.readdir(watchDir).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(watchDir, entry);
    if (!isSupportedScreenshotPath(candidate)) continue;
    if (changedOnly && !(await hasChanged(candidate, state))) continue;

    await prepareCandidate(pi, state, candidate);
  }
}

async function hasChanged(candidatePath, state) {
  const stat = await safeStat(candidatePath);
  if (!stat?.isFile()) return false;

  const key = path.resolve(candidatePath);
  return state.fileSignatures.get(key) !== fileSignature(stat);
}

async function snapshotFileSignatures(watchDir) {
  const signatures = new Map();
  const entries = await fsp.readdir(watchDir).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(watchDir, entry);
    if (!isSupportedScreenshotPath(candidate)) continue;

    const stat = await safeStat(candidate);
    if (stat?.isFile()) signatures.set(path.resolve(candidate), fileSignature(stat));
  }
  return signatures;
}

async function refreshReadyCount(pi, state) {
  try {
    const result = await runScreenshotter(pi, ["list", "--target", TARGET, "--state", "ready", "--json"]);
    state.readyCount = Array.isArray(result.screens) ? result.screens.length : 0;
  } catch {
    state.readyCount = 0;
  }
}

async function formatStatus(pi, state) {
  if (!state.enabled) return "off";
  const status = await runScreenshotter(pi, ["status", "--target", TARGET, "--tokens", "--json"]).catch(() => undefined);
  const tokenMode = status?.tokenEstimates?.modes?.gpt5HighDetailTiles;
  return [
    "on",
    `profile ${state.profile || DEFAULT_PROFILE}`,
    state.watchMode ? `mode ${state.watchMode}` : undefined,
    state.watchDir ? `watching ${state.watchDir}` : undefined,
    `${status?.ready ?? state.readyCount} ready`,
    status?.bytes?.saved ? `saved ${formatBytes(status.bytes.saved)} (${status.bytes.savedPercent}%)` : undefined,
    tokenMode?.saved ? `est. tokens saved ${tokenMode.saved}` : undefined,
    status?.dataDir ? `store ${status.dataDir}` : undefined,
  ].filter(Boolean).join(" · ");
}

async function runScreenshotter(pi, args) {
  const command = screenshotterCommand();
  const result = await pi.exec(command.executable, [...command.args, ...args], { timeout: 60_000 });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `screenshotter exited with ${result.code}`).trim());
  return JSON.parse(result.stdout || "{}");
}

function screenshotterCommand() {
  const configured = process.env.SCREENSHOTTER_CLI || cliPath;
  if (configured.endsWith(".js") || configured.endsWith(".mjs")) {
    return { executable: process.execPath, args: [configured] };
  }
  return { executable: configured, args: [] };
}

function trackProcessing(state, task) {
  state.processingTasks.add(task);
  task.finally(() => state.processingTasks.delete(task));
}

async function waitForProcessing(state, timeoutMs) {
  if (state.processingTasks.size === 0) return;
  await Promise.race([
    Promise.allSettled([...state.processingTasks]),
    delay(timeoutMs),
  ]);
}

function wasCreatedDuringAgentRun(stat, state) {
  const createdMs = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs;
  const activeStartMs = state.agentBusySinceMs;
  if (activeStartMs !== undefined && createdMs >= activeStartMs) return true;

  const lastWindow = state.lastAgentBusyWindow;
  return lastWindow !== undefined && createdMs >= lastWindow.startMs && createdMs <= lastWindow.endMs;
}

function isRecentFile(stat, sinceMs) {
  return Math.max(stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs) >= sinceMs - 1000;
}

function isSupportedScreenshotPath(filePath) {
  return SCREENSHOT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function fileSignature(stat) {
  return `${stat.size}:${stat.mtimeMs}`;
}

function isRecoverableWatchError(error) {
  const code = typeof error === "object" && error !== null ? error.code : undefined;
  return code === "EMFILE" || code === "ENOSPC";
}

function normalizeWatchFileName(fileName) {
  if (!fileName) return undefined;
  return typeof fileName === "string" ? fileName : fileName.toString("utf8");
}

function updateUi(ctx, state) {
  if (!ctx.hasUI) return;
  if (!state.enabled) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(STATUS_KEY, undefined);
    return;
  }

  const indicator = state.readyCount > 0 ? `shot ON:${state.readyCount}` : "shot ON";
  ctx.ui.setStatus(STATUS_KEY, indicator);
  ctx.ui.setWidget(
    STATUS_KEY,
    state.readyCount > 0 ? [`${state.readyCount} screenshot${state.readyCount === 1 ? "" : "s"} ready`] : undefined,
    { placement: "belowEditor" },
  );
}

function notify(ctx, message, type = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

function usage() {
  return [
    "screenshotter usage:",
    "/screenshotter on      enable live Cmd+Shift+3/4 screenshot capture",
    "/screenshotter token   use the aggressive readable 2200px profile",
    "/screenshotter balanced use the mid 3000px profile",
    "/screenshotter readability use the light default profile",
    "/screenshotter off     disable capture and clear ready screenshots",
    "/screenshotter status  show watcher state",
    "/screenshotter clear   clear ready screenshots",
  ].join("\n");
}

async function safeStat(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch {
    return undefined;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
