#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const imagePath = join(screenshotDir, "Screenshot.png");
const originalEnv = process.env.SCREENSHOTTER_CLI;

try {
  mkdirSync(screenshotDir, { recursive: true });
  writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lmV5xwAAAABJRU5ErkJggg==", "base64"));
  writeFileSync(fakeCli, fakeCliSource(), { mode: 0o755 });
  process.env.SCREENSHOTTER_CLI = fakeCli;
  process.env.SCREENSHOTTER_TEST_CLI = cli;
  process.env.SCREENSHOTTER_TEST_DATA_DIR = dataDir;
  process.env.SCREENSHOTTER_TEST_SCREENSHOT_DIR = screenshotDir;

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
  await commands.get("screenshotter").handler("on", ctx);
  assert(notifications.some((item) => item.message === "screenshotter on"), "/screenshotter on should notify");
  assert(statuses.some((item) => item.key === "screenshotter" && item.value === "shot ON"), "status indicator should turn on");

  await commands.get("screenshotter").handler("balanced", ctx);
  assert(notifications.some((item) => item.message === "screenshotter profile balanced"), "/screenshotter balanced should switch profile");
  await commands.get("screenshotter").handler("token", ctx);
  assert(notifications.some((item) => item.message === "screenshotter profile token"), "/screenshotter token should switch profile");

  runReal(["prepare", imagePath, "--target", "pi", "--data-dir", dataDir, "--json"]);
  const inputResult = await events.get("input")({ source: "interactive", text: "use this screenshot", images: [] }, ctx);
  assert(inputResult.action === "transform", "input hook should transform when screenshots are ready");
  assert(inputResult.text === "use this screenshot", "input hook should preserve text");
  assert(inputResult.images?.length === 1, "input hook should attach one image");
  assert(inputResult.images[0].mimeType === "image/png", "input hook should use returned MIME type");
  assert(typeof inputResult.images[0].data === "string" && inputResult.images[0].data.length > 0, "attached image should be base64 data");

  await commands.get("screenshotter").handler("status", ctx);
  assert(notifications.some((item) => item.message.includes("on")), "/screenshotter status should notify state");

  await commands.get("screenshotter").handler("off", ctx);
  assert(notifications.some((item) => item.message === "screenshotter off"), "/screenshotter off should notify");
  assert(widgets.some((item) => item.key === "screenshotter"), "extension should update widget state");

  console.log("pi extension smoke test passed");
} finally {
  if (originalEnv === undefined) delete process.env.SCREENSHOTTER_CLI;
  else process.env.SCREENSHOTTER_CLI = originalEnv;
  delete process.env.SCREENSHOTTER_TEST_CLI;
  delete process.env.SCREENSHOTTER_TEST_DATA_DIR;
  delete process.env.SCREENSHOTTER_TEST_SCREENSHOT_DIR;
  rmSync(workDir, { recursive: true, force: true });
}

function runReal(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout || "{}");
}

function fakeCliSource() {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
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
