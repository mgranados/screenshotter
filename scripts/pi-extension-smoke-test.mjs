#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import screenshotterExtension from "../extensions/screenshotter/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin", "screenshotter.mjs");
const workDir = mkdtempSync(join(tmpdir(), "screenshotter-pi-smoke-"));
const screenshotDir = join(workDir, "screenshots");
const dataDir = join(workDir, "store");
const fakeCli = join(workDir, "fake-screenshotter.mjs");
const argLog = join(workDir, "fake-cli-args.jsonl");
const imagePath = join(screenshotDir, "Screenshot.png");
const capturedImagePath = join(screenshotDir, "Screenshot 2.png");
const remoteInboxDir = join(workDir, "remote-inbox");
const remoteContextPath = join(remoteInboxDir, "screen-context.md");
const remoteImagePath = join(remoteInboxDir, "screen.jpg");
const originalEnv = process.env.SCREENSHOTTER_CLI;
const originalRemoteInboxRoot = process.env.SCREENSHOTTER_REMOTE_INBOX_ROOT;

try {
  mkdirSync(screenshotDir, { recursive: true });
  mkdirSync(remoteInboxDir, { recursive: true });
  writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lmV5xwAAAABJRU5ErkJggg==", "base64"));
  writeFileSync(remoteImagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lmV5xwAAAABJRU5ErkJggg==", "base64"));
  writeFileSync(remoteContextPath, "# Screen Context\n\nRemote terminal context\n");
  writeFileSync(fakeCli, fakeCliSource(), { mode: 0o755 });
  process.env.SCREENSHOTTER_CLI = fakeCli;
  process.env.SCREENSHOTTER_REMOTE_INBOX_ROOT = remoteInboxDir;
  process.env.SCREENSHOTTER_TEST_CLI = cli;
  process.env.SCREENSHOTTER_TEST_DATA_DIR = dataDir;
  process.env.SCREENSHOTTER_TEST_SCREENSHOT_DIR = screenshotDir;
  process.env.SCREENSHOTTER_TEST_ARG_LOG = argLog;

  const events = new Map();
  const commands = new Map();
  const notifications = [];
  const statuses = [];
  const widgets = [];
  const pi = {
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    async exec(executable, args) {
      const result = spawnSync(executable, args, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.error?.message ?? "",
      };
    },
  };
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify(message, type = "info") {
        notifications.push({ message, type });
      },
      setStatus(key, value) {
        statuses.push({ key, value });
      },
      setWidget(key, value, options) {
        widgets.push({ key, value, options });
      },
    },
  };

  screenshotterExtension(pi);
  assert(commands.has("screenshotter"), "extension should register /screenshotter");
  assert(events.has("input"), "extension should register input hook");

  await events.get("session_start")?.({}, ctx);
  const remoteBundle = [
    "inspect this remote screenshot",
    "Screenshotter remote attachment bundle. Read the context and image before responding.",
    "[[screenshotter-remote-v1]]",
    JSON.stringify({ contextPath: remoteContextPath, imagePath: remoteImagePath, mimeType: "image/jpeg" }),
    "[[/screenshotter-remote-v1]]",
  ].join("\n");
  const remoteInput = await events.get("input")({ source: "interactive", text: remoteBundle, images: [] }, ctx);
  assert(remoteInput.action === "transform", "remote clipboard bundle should transform without enabling the local watcher");
  assert(remoteInput.text.includes("inspect this remote screenshot"), "remote clipboard transform should preserve the user prompt");
  assert(remoteInput.text.includes("Remote terminal context"), "remote clipboard transform should inline the context sidecar");
  assert(!remoteInput.text.includes("screenshotter-remote-v1"), "remote clipboard transform should remove transport markers");
  assert(remoteInput.images?.length === 1, "remote clipboard transform should attach the uploaded image");
  assert(remoteInput.images[0].mimeType === "image/jpeg", "remote clipboard transform should infer the image MIME type");

  const escapedBundle = [
    "[[screenshotter-remote-v1]]",
    JSON.stringify({ contextPath: remoteContextPath, imagePath, mimeType: "image/png" }),
    "[[/screenshotter-remote-v1]]",
  ].join("\n");
  const escapedInput = await events.get("input")({ source: "interactive", text: escapedBundle, images: [] }, ctx);
  assert(escapedInput.action === "continue", "remote clipboard transform should reject files outside its private inbox");

  await commands.get("screenshotter").handler("on", ctx);
  assert(notifications.some((item) => item.message === "screenshotter on"), "/screenshotter on should notify");
  assert(statuses.some((item) => item.key === "screenshotter" && item.value === "shot ON"), "status indicator should turn on");

  await commands.get("screenshotter").handler("balanced", ctx);
  assert(notifications.some((item) => item.message === "screenshotter profile balanced"), "/screenshotter balanced should switch profile");
  await commands.get("screenshotter").handler("token", ctx);
  assert(notifications.some((item) => item.message === "screenshotter profile token"), "/screenshotter token should switch profile");
  await commands.get("screenshotter").handler("text", ctx);
  assert(notifications.some((item) => item.message === "screenshotter direct text on"), "/screenshotter text should enable direct prompt text");

  writeFileSync(capturedImagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lmV5xwAAAABJRU5ErkJggg==", "base64"));
  const originalAccessibilityText = process.env.SCREENSHOTTER_ACCESSIBILITY_TEXT;
  const originalAccessibilityTitle = process.env.SCREENSHOTTER_ACCESSIBILITY_TITLE;
  const originalScreenTarget = process.env.SCREENSHOTTER_SCREEN_TARGET_JSON;
  process.env.SCREENSHOTTER_ACCESSIBILITY_TEXT = "Window title\nPrimary button";
  process.env.SCREENSHOTTER_ACCESSIBILITY_TITLE = "Mock pi window";
  process.env.SCREENSHOTTER_SCREEN_TARGET_JSON = JSON.stringify({
    frontmostApp: { name: "Mock Source", pid: 123 },
  });
  const inputResult = await events.get("input")({ source: "interactive", text: "use this screenshot", images: [] }, ctx);
  restoreEnv("SCREENSHOTTER_ACCESSIBILITY_TEXT", originalAccessibilityText);
  restoreEnv("SCREENSHOTTER_ACCESSIBILITY_TITLE", originalAccessibilityTitle);
  restoreEnv("SCREENSHOTTER_SCREEN_TARGET_JSON", originalScreenTarget);
  assert(inputResult.action === "transform", "input hook should transform when screenshots are ready");
  assert(inputResult.text.startsWith("use this screenshot"), "input hook should preserve original prompt text");
  assert(inputResult.text.includes("Window title\nPrimary button"), "input hook should append screen text when enabled");
  assert(inputResult.images?.length === 1, "input hook should attach one image");
  assert(inputResult.images[0].mimeType === "image/png", "input hook should use returned MIME type");
  assert(typeof inputResult.images[0].data === "string" && inputResult.images[0].data.length > 0, "attached image should be base64 data");
  const cliCalls = readFileSync(argLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const prepareCall = cliCalls.find((call) => call.command === "prepare" && call.args.includes(capturedImagePath));
  assert(prepareCall?.args.includes("--with-text"), "text mode should prepare screenshots with text");
  assert(prepareCall?.args.includes("--with-target-context"), "text mode should prepare screenshots with target context");
  assert(prepareCall?.args.includes("--no-ocr"), "text mode should keep OCR fallback off by default");
  assert(prepareCall?.args.includes("--text-max-chars"), "text mode should enforce a bounded context payload");
  const claimCall = cliCalls.find((call) => call.command === "claim");
  assert(claimCall?.args.includes("--with-text"), "text mode should claim screenshots with text");
  assert(claimCall?.args.includes("--no-ocr"), "text mode claims should keep OCR fallback off by default");

  await commands.get("screenshotter").handler("ocr", ctx);
  assert(notifications.some((item) => item.message === "screenshotter text with OCR fallback on"), "/screenshotter ocr should explicitly enable fallback");
  await events.get("input")({ source: "interactive", text: "check OCR mode", images: [] }, ctx);
  const ocrModeCalls = readFileSync(argLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const ocrClaimCall = ocrModeCalls.filter((call) => call.command === "claim").at(-1);
  const providerIndex = ocrClaimCall?.args.indexOf("--text-provider") ?? -1;
  assert(providerIndex >= 0 && ocrClaimCall.args[providerIndex + 1] === "auto", "/screenshotter ocr should request explicit auto fallback");
  await commands.get("screenshotter").handler("image", ctx);
  assert(notifications.some((item) => item.message === "screenshotter text off"), "/screenshotter image should disable prompt text");

  await commands.get("screenshotter").handler("status", ctx);
  assert(notifications.some((item) => item.message.includes("on")), "/screenshotter status should notify state");

  await commands.get("screenshotter").handler("off", ctx);
  assert(notifications.some((item) => item.message === "screenshotter off"), "/screenshotter off should notify");
  assert(widgets.some((item) => item.key === "screenshotter"), "extension should update widget state");

  console.log("pi extension smoke test passed");
} finally {
  if (originalEnv === undefined) delete process.env.SCREENSHOTTER_CLI;
  else process.env.SCREENSHOTTER_CLI = originalEnv;
  if (originalRemoteInboxRoot === undefined) delete process.env.SCREENSHOTTER_REMOTE_INBOX_ROOT;
  else process.env.SCREENSHOTTER_REMOTE_INBOX_ROOT = originalRemoteInboxRoot;
  delete process.env.SCREENSHOTTER_TEST_CLI;
  delete process.env.SCREENSHOTTER_TEST_DATA_DIR;
  delete process.env.SCREENSHOTTER_TEST_SCREENSHOT_DIR;
  delete process.env.SCREENSHOTTER_TEST_ARG_LOG;
  rmSync(workDir, { recursive: true, force: true });
}

function fakeCliSource() {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const [command, ...args] = process.argv.slice(2);
if (process.env.SCREENSHOTTER_TEST_ARG_LOG) {
  appendFileSync(process.env.SCREENSHOTTER_TEST_ARG_LOG, JSON.stringify({ command, args }) + "\\n");
}

if (command === "screenshot-dir") {
  process.stdout.write(JSON.stringify({ path: process.env.SCREENSHOTTER_TEST_SCREENSHOT_DIR }) + "\\n");
  process.exit(0);
}

const result = spawnSync(process.execPath, [
  process.env.SCREENSHOTTER_TEST_CLI,
  command,
  ...args,
  "--data-dir",
  process.env.SCREENSHOTTER_TEST_DATA_DIR,
], {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
