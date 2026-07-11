#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin", "screenshotter.mjs");
const workDir = mkdtempSync(join(tmpdir(), "screenshotter-mcp-smoke-"));
const dataDir = join(workDir, "store");
const imagePath = join(workDir, "input.png");
const originalScreenTargetJson = process.env.SCREENSHOTTER_SCREEN_TARGET_JSON;

let child;

try {
  writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lmV5xwAAAABJRU5ErkJggg==", "base64"));
  process.env.SCREENSHOTTER_SCREEN_TARGET_JSON = JSON.stringify({
    collectedAt: "2026-07-07T12:00:00.000Z",
    frontmostApp: {
      name: "MCP Mock App",
      pid: 222,
      bundleId: "com.example.McpMock",
    },
    pointer: {
      x: 22,
      y: 33,
    },
    pointerWindow: {
      ownerName: "MCP Mock App",
      windowTitle: "MCP Mock Window",
      pid: 222,
    },
  });

  child = spawn(process.execPath, [cli, "mcp-server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const responses = new Map();
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  output.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) responses.set(message.id, message);
  });

  let id = 1;
  const request = async (method, params) => {
    const currentId = id++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: currentId, method, params })}\n`);
    return waitFor(() => responses.get(currentId), `response for ${method}`, stderr);
  };
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "screenshotter-smoke", version: "0.0.0" },
  });
  assert(initialized.result?.serverInfo?.name === "screenshotter", "initialize should return screenshotter server");
  notify("notifications/initialized", {});

  const listed = await request("tools/list", {});
  const tools = listed.result?.tools?.map((tool) => tool.name) ?? [];
  assert(tools.includes("screenshotter_prepare"), "tools/list should include screenshotter_prepare");
  assert(tools.includes("screenshotter_claim"), "tools/list should include screenshotter_claim");

  const status = await callTool(request, "screenshotter_status", { target: "mcp-smoke", dataDir });
  assert(status.content?.[0]?.text?.includes("\"ready\""), "status should return JSON text");

  const prepared = await callTool(request, "screenshotter_prepare", {
    path: imagePath,
    target: "mcp-smoke",
    dataDir,
    includeImageData: true,
    ocr: true,
    withTargetContext: true,
  });
  assert(prepared.content?.some((item) => item.type === "image" && item.mimeType === "image/png"), "prepare should return MCP image content");
  assert(prepared.content?.[0]?.text?.includes("\"ocr\""), "prepare with ocr should return OCR metadata in JSON text");
  assert(prepared.content?.[0]?.text?.includes("\"screenTarget\""), "prepare with target context should return screenTarget in JSON text");

  const claimed = await callTool(request, "screenshotter_claim", {
    target: "mcp-smoke",
    dataDir,
    includeImageData: true,
  });
  assert(claimed.content?.some((item) => item.type === "image"), "claim should return MCP image content");

  const cleared = await callTool(request, "screenshotter_clear", {
    target: "mcp-smoke",
    dataDir,
  });
  assert(cleared.content?.[0]?.text?.includes("\"cleared\""), "clear should return JSON text");

  child.stdin.end();
  await waitForExit(child);
  console.log("mcp smoke test passed");
} finally {
  if (child && !child.killed) child.kill();
  restoreEnv("SCREENSHOTTER_SCREEN_TARGET_JSON", originalScreenTargetJson);
  rmSync(workDir, { recursive: true, force: true });
}

async function callTool(request, name, args) {
  const response = await request("tools/call", {
    name,
    arguments: args,
  });
  if (response.error) throw new Error(`${name} failed: ${response.error.message}`);
  if (response.result?.isError) throw new Error(`${name} returned tool error: ${response.result.content?.[0]?.text}`);
  return response.result;
}

async function waitFor(predicate, label, stderr) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Timed out waiting for ${label}\n${stderr.join("")}`);
}

async function waitForExit(process) {
  await new Promise((resolvePromise, rejectPromise) => {
    process.once("error", rejectPromise);
    process.once("close", resolvePromise);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
