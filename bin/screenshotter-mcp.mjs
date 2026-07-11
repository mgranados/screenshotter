#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8"));
const SERVER_NAME = "screenshotter";
const SERVER_VERSION = PACKAGE_JSON.version ?? "0.0.0";
const DEFAULT_TARGET = "mcp";
const DEFAULT_FRESH_MS = 10 * 60_000;
const DEFAULT_MAX = 4;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_PROFILE = "readability";
const CLI_PATH = join(ROOT_DIR, "bin", "screenshotter.mjs");

const TOOLS = [
  {
    name: "screenshotter_status",
    description: "Inspect the local screenshotter store, including ready counts, byte savings, and optional image-token estimates.",
    inputSchema: objectSchema({
      target: stringSchema("Optional target filter such as codex, claude-code, pi, or mcp."),
      tokens: booleanSchema("Include dimension-based token estimates.", true),
      dataDir: stringSchema("Override SCREENSHOTTER_DATA_DIR for this call."),
    }),
  },
  {
    name: "screenshotter_prepare_latest",
    description: "Optimize the latest native macOS screenshot and make it ready for a target agent.",
    inputSchema: prepareSchema({
      dir: stringSchema("Screenshot directory to scan. Defaults to the macOS screenshot folder."),
      includeImageData: booleanSchema("Return the optimized image as MCP image content.", true),
      maxImageBytes: integerSchema("Maximum optimized bytes to inline as MCP image content.", DEFAULT_MAX_IMAGE_BYTES),
    }),
  },
  {
    name: "screenshotter_prepare",
    description: "Optimize a specific local image path and make it ready for a target agent.",
    inputSchema: prepareSchema({
      path: stringSchema("Image path to optimize."),
      includeImageData: booleanSchema("Return the optimized image as MCP image content.", true),
      maxImageBytes: integerSchema("Maximum optimized bytes to inline as MCP image content.", DEFAULT_MAX_IMAGE_BYTES),
    }, ["path"]),
  },
  {
    name: "screenshotter_claim",
    description: "Atomically claim ready screenshots for this target and return their optimized paths, with optional MCP image content.",
    inputSchema: objectSchema({
      target: stringSchema("Target to claim screenshots for.", DEFAULT_TARGET),
      max: integerSchema("Maximum screenshots to claim.", DEFAULT_MAX),
      freshMs: integerSchema("Only claim screenshots prepared within this many milliseconds.", DEFAULT_FRESH_MS),
      includeImageData: booleanSchema("Return claimed screenshots as MCP image content.", true),
      maxImageBytes: integerSchema("Maximum optimized bytes per screenshot to inline as MCP image content.", DEFAULT_MAX_IMAGE_BYTES),
      withTargetContext: booleanSchema("Capture app and pointer-window metadata before collecting text.", false),
      withText: booleanSchema("Collect text context before returning claimed screen JSON.", false),
      noText: booleanSchema("Return image metadata without text context.", false),
      noOcr: booleanSchema("Disable OCR fallback when using the auto provider.", false),
      textProvider: enumSchema(["auto", "browser-dom", "accessibility", "ocr", "none"], "Text context provider.", "accessibility"),
      ocr: booleanSchema("Force local Apple Vision OCR text before returning claimed screen JSON.", false),
      requireOcr: booleanSchema("Fail the claim if explicitly requested OCR cannot run.", false),
      ocrLevel: enumSchema(["accurate", "fast"], "Apple Vision OCR recognition level.", "accurate"),
      ocrLanguages: stringSchema("Comma-separated Apple Vision OCR language identifiers.", "en-US"),
      textMaxChars: integerSchema("Maximum extracted text characters returned per screenshot.", 4000),
      dataDir: stringSchema("Override SCREENSHOTTER_DATA_DIR for this call."),
    }),
  },
  {
    name: "screenshotter_clear",
    description: "Clear screenshots for a target so they are no longer offered to future prompts.",
    inputSchema: objectSchema({
      target: stringSchema("Target to clear screenshots for.", DEFAULT_TARGET),
      files: booleanSchema("Also remove optimized image files from disk.", false),
      dataDir: stringSchema("Override SCREENSHOTTER_DATA_DIR for this call."),
    }),
  },
  {
    name: "screenshotter_clip_latest",
    description: "Optimize the latest native macOS screenshot and copy the optimized image data, or image plus text context, to the macOS clipboard.",
    inputSchema: prepareSchema({
      dir: stringSchema("Screenshot directory to scan. Defaults to the macOS screenshot folder."),
      withText: booleanSchema("Collect text context and copy text plus image to the clipboard.", false),
      clipboardMode: enumSchema(["image", "text", "both", "files", "attachments", "markdown", "codex-inline"], "Clipboard payload mode.", "image"),
      textMaxChars: integerSchema("Maximum text context characters to include in clipboard text.", 4000),
    }),
  },
  {
    name: "screenshotter_screenshot_dir",
    description: "Return the native macOS screenshot folder currently used by screenshotter.",
    inputSchema: objectSchema({}),
  },
];

const handlers = {
  screenshotter_status: statusTool,
  screenshotter_prepare_latest: prepareLatestTool,
  screenshotter_prepare: prepareTool,
  screenshotter_claim: claimTool,
  screenshotter_clear: clearTool,
  screenshotter_clip_latest: clipLatestTool,
  screenshotter_screenshot_dir: screenshotDirTool,
};

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  void handleLine(line);
});

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    sendError(null, -32700, `Parse error: ${formatError(error)}`);
    return;
  }

  if (message.id === undefined) {
    await handleNotification(message).catch((error) => {
      log(`notification ${message.method ?? "<unknown>"} failed: ${formatError(error)}`);
    });
    return;
  }

  try {
    const result = await handleRequest(message);
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    if (error instanceof RpcError) {
      sendError(message.id, error.code, error.message, error.data);
    } else {
      sendError(message.id, -32603, formatError(error));
    }
  }
}

async function handleNotification(_message) {
  // MCP clients send notifications/initialized after initialize. No response is expected.
}

async function handleRequest(message) {
  switch (message.method) {
    case "initialize":
      return initializeResult(message.params);
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(message.params);
    default:
      throw new RpcError(-32601, `Method not found: ${message.method}`);
  }
}

function initializeResult(params = {}) {
  return {
    protocolVersion: params.protocolVersion ?? "2024-11-05",
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
  };
}

async function callTool(params = {}) {
  const name = params.name;
  const args = params.arguments ?? {};
  const handler = handlers[name];
  if (!handler) throw new RpcError(-32602, `Unknown tool: ${name}`);

  try {
    return await handler(args);
  } catch (error) {
    return toolError(formatError(error));
  }
}

async function statusTool(args) {
  const cliArgs = ["status", "--json"];
  pushTarget(cliArgs, args.target);
  pushDataDir(cliArgs, args.dataDir);
  if (args.tokens !== false) cliArgs.push("--tokens");
  return jsonToolResult(await runScreenshotter(cliArgs));
}

async function prepareLatestTool(args) {
  const cliArgs = ["prepare-latest", "--json"];
  pushTarget(cliArgs, args.target ?? DEFAULT_TARGET);
  pushPrepareOptions(cliArgs, args);
  pushDataDir(cliArgs, args.dataDir);

  const result = await runScreenshotter(cliArgs);
  return screenshotToolResult(result, imageOptions(args));
}

async function prepareTool(args) {
  if (!args.path || typeof args.path !== "string") throw new Error("path is required");

  const cliArgs = ["prepare", args.path, "--json"];
  pushTarget(cliArgs, args.target ?? DEFAULT_TARGET);
  pushPrepareOptions(cliArgs, args);
  pushDataDir(cliArgs, args.dataDir);

  const result = await runScreenshotter(cliArgs);
  return screenshotToolResult(result, imageOptions(args));
}

async function claimTool(args) {
  const cliArgs = ["claim", "--json"];
  pushTarget(cliArgs, args.target ?? DEFAULT_TARGET);
  pushArg(cliArgs, "--max", args.max ?? DEFAULT_MAX);
  pushArg(cliArgs, "--fresh-ms", args.freshMs ?? DEFAULT_FRESH_MS);
  if (args.withTargetContext) cliArgs.push("--with-target-context");
  pushTextOptions(cliArgs, args);
  pushDataDir(cliArgs, args.dataDir);

  const result = await runScreenshotter(cliArgs);
  return screenshotToolResult(result, imageOptions(args));
}

async function clearTool(args) {
  const cliArgs = ["clear", "--json"];
  pushTarget(cliArgs, args.target ?? DEFAULT_TARGET);
  pushDataDir(cliArgs, args.dataDir);
  if (args.files) cliArgs.push("--files");
  return jsonToolResult(await runScreenshotter(cliArgs));
}

async function clipLatestTool(args) {
  const cliArgs = ["clip", "--json"];
  pushTarget(cliArgs, args.target ?? "app");
  pushPrepareOptions(cliArgs, args);
  pushArg(cliArgs, "--clipboard-mode", args.clipboardMode);
  pushArg(cliArgs, "--text-max-chars", args.textMaxChars);
  pushDataDir(cliArgs, args.dataDir);
  return jsonToolResult(await runScreenshotter(cliArgs));
}

async function screenshotDirTool() {
  return jsonToolResult(await runScreenshotter(["screenshot-dir", "--json"]));
}

async function runScreenshotter(args) {
  const command = screenshotterCommand();
  const result = await runProcess(command.executable, [...command.args, ...args], {
    timeoutMs: 60_000,
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `screenshotter exited with ${result.code}`).trim());
  }

  try {
    return JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(`screenshotter returned invalid JSON: ${formatError(error)}`);
  }
}

function runProcess(executable, args, { timeoutMs, maxBuffer }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let buffered = 0;
    let settled = false;
    let timeout;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const collect = (chunks) => (chunk) => {
      buffered += chunk.length;
      if (buffered > maxBuffer) {
        child.kill("SIGKILL");
        finish(() => rejectPromise(new Error(`screenshotter output exceeded ${maxBuffer} bytes`)));
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => finish(() => rejectPromise(error)));
    child.on("close", (code) => finish(() => resolvePromise({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    })));
    timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => rejectPromise(new Error(`screenshotter timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timeout.unref?.();
  });
}

function screenshotterCommand() {
  const configured = process.env.SCREENSHOTTER_CLI || CLI_PATH;
  if (configured.endsWith(".js") || configured.endsWith(".mjs")) {
    return { executable: process.execPath, args: [configured] };
  }
  return { executable: configured, args: [] };
}

async function screenshotToolResult(result, options) {
  const content = [
    {
      type: "text",
      text: JSON.stringify(result, null, 2),
    },
  ];

  if (options.includeImageData) {
    for (const screen of resultScreens(result)) {
      const image = await imageContent(screen, options.maxImageBytes);
      if (image) content.push(image);
    }
  }

  return { content };
}

function jsonToolResult(result) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

function toolError(message) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}

function resultScreens(result) {
  if (Array.isArray(result.screens)) return result.screens;
  if (result.screen) return [result.screen];
  return [];
}

async function imageContent(screen, maxImageBytes) {
  if (!screen?.optimizedPath || !screen.mimeType) return undefined;
  const file = await stat(screen.optimizedPath).catch(() => null);
  if (!file?.isFile() || file.size > maxImageBytes) return undefined;
  const bytes = await readFile(screen.optimizedPath);

  return {
    type: "image",
    data: bytes.toString("base64"),
    mimeType: screen.mimeType,
  };
}

function pushPrepareOptions(cliArgs, args) {
  pushArg(cliArgs, "--profile", args.profile);
  pushArg(cliArgs, "--optimizer", args.optimizer);
  pushArg(cliArgs, "--max-long-edge", args.maxLongEdge);
  pushArg(cliArgs, "--long-edge-percent", args.longEdgePercent);
  pushArg(cliArgs, "--min-long-edge", args.minLongEdge);
  pushArg(cliArgs, "--max-patches", args.maxPatches);
  pushArg(cliArgs, "--max-output-bytes", args.maxOutputBytes);
  if (args.withTargetContext) cliArgs.push("--with-target-context");
  pushTextOptions(cliArgs, args);
  pushArg(cliArgs, "--dir", args.dir);
  pushArg(cliArgs, "--optimized-dir", args.optimizedDir);
}

function pushTextOptions(cliArgs, args) {
  if (args.withText) cliArgs.push("--with-text");
  if (args.noText) cliArgs.push("--no-text");
  if (args.noOcr) cliArgs.push("--no-ocr");
  if (args.ocr) cliArgs.push("--ocr");
  if (args.requireOcr) cliArgs.push("--require-ocr");
  pushArg(cliArgs, "--text-provider", args.textProvider);
  pushArg(cliArgs, "--text-max-chars", args.textMaxChars);
  pushArg(cliArgs, "--ocr-level", args.ocrLevel);
  pushArg(cliArgs, "--ocr-languages", args.ocrLanguages);
}

function pushTarget(cliArgs, target) {
  if (target) pushArg(cliArgs, "--target", target);
}

function pushDataDir(cliArgs, dataDir) {
  pushArg(cliArgs, "--data-dir", dataDir);
}

function pushArg(cliArgs, flag, value) {
  if (value === undefined || value === null || value === false) return;
  cliArgs.push(flag, String(value));
}

function imageOptions(args) {
  return {
    includeImageData: args.includeImageData !== false,
    maxImageBytes: positiveInteger(args.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES),
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function objectSchema(properties, required = []) {
  const schemaProperties = {};
  for (const [name, schema] of Object.entries(properties)) {
    const { required: _required, ...rest } = schema;
    schemaProperties[name] = rest;
  }

  return {
    type: "object",
    additionalProperties: false,
    properties: schemaProperties,
    required: [
      ...required,
      ...Object.entries(properties)
        .filter(([, schema]) => schema.required)
        .map(([name]) => name),
    ],
  };
}

function prepareSchema(extraProperties = {}, required = []) {
  return objectSchema({
    target: stringSchema("Target name to prepare screenshots for.", DEFAULT_TARGET),
    profile: enumSchema(["token", "balanced", "readability"], "Optimization profile.", DEFAULT_PROFILE),
    optimizer: enumSchema(["native", "sharp", "sips"], "Image optimizer implementation. Native ImageIO is the default; Sharp/libvips is opt-in when installed separately."),
    maxLongEdge: integerSchema("Override maximum long edge in pixels."),
    longEdgePercent: numberSchema("Resize to this percentage of the source long edge. Accepts 40 or 0.4 for 40%."),
    minLongEdge: integerSchema("Minimum long edge floor when using percentage-based resizing."),
    maxPatches: integerSchema("Override maximum 32px patch budget."),
    maxOutputBytes: integerSchema("Override maximum output bytes for byte-aware optimizers."),
    withTargetContext: booleanSchema("Capture frontmost app and window-under-pointer metadata.", false),
    withText: booleanSchema("Collect text context and include it in the returned screen JSON.", false),
    noText: booleanSchema("Return image metadata without text context.", false),
    noOcr: booleanSchema("Disable OCR fallback when using the auto provider.", false),
    textProvider: enumSchema(["auto", "browser-dom", "accessibility", "ocr", "none"], "Text context provider.", "accessibility"),
    ocr: booleanSchema("Force local Apple Vision OCR and include it in the returned screen JSON.", false),
    requireOcr: booleanSchema("Fail if explicitly requested OCR cannot run.", false),
    ocrLevel: enumSchema(["accurate", "fast"], "Apple Vision OCR recognition level.", "accurate"),
    ocrLanguages: stringSchema("Comma-separated Apple Vision OCR language identifiers.", "en-US"),
    textMaxChars: integerSchema("Maximum extracted text characters returned per screenshot.", 4000),
    dataDir: stringSchema("Override SCREENSHOTTER_DATA_DIR for this call."),
    optimizedDir: stringSchema("Override SCREENSHOTTER_OPTIMIZED_DIR for this call."),
    ...extraProperties,
  }, required);
}

function stringSchema(description, defaultValue) {
  const schema = { type: "string", description };
  if (defaultValue !== undefined) schema.default = defaultValue;
  return schema;
}

function integerSchema(description, defaultValue) {
  const schema = { type: "integer", minimum: 1, description };
  if (defaultValue !== undefined) schema.default = defaultValue;
  return schema;
}

function numberSchema(description, defaultValue) {
  const schema = { type: "number", exclusiveMinimum: 0, description };
  if (defaultValue !== undefined) schema.default = defaultValue;
  return schema;
}

function booleanSchema(description, defaultValue) {
  const schema = { type: "boolean", description };
  if (defaultValue !== undefined) schema.default = defaultValue;
  return schema;
}

function enumSchema(values, description, defaultValue) {
  const schema = { type: "string", enum: values, description };
  if (defaultValue !== undefined) schema.default = defaultValue;
  return schema;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id, code, message, data) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
