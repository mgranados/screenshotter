#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const image = args.image || args._[0];
const compressed = args.compressed || args._[1];
const model = args.model;
const provider = args.provider || "codex";
const timeoutMs = Number(args["timeout-ms"] ?? 180_000);

if (!image || !compressed || !model) {
  console.error("Usage: npm run quality:model -- --image original.png --compressed optimized.jpg --model <vision-model> --allow-external");
  process.exit(1);
}

if (provider !== "codex") {
  console.error(`Unsupported provider: ${provider}`);
  process.exit(1);
}

if (!existsSync(resolve(image))) {
  console.error(`Original image not found: ${resolve(image)}`);
  process.exit(1);
}

if (!existsSync(resolve(compressed))) {
  console.error(`Compressed image not found: ${resolve(compressed)}`);
  process.exit(1);
}

if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
  console.error("--timeout-ms must be at least 1000");
  process.exit(1);
}

if (!args["allow-external"]) {
  console.error([
    "Refusing to call external model without --allow-external.",
    "This sends both images to the configured Codex/OpenAI model service.",
    "Use only with screenshots you are willing to upload.",
  ].join("\n"));
  process.exit(2);
}

const workDir = mkdtempSync(join(tmpdir(), "screenshotter-model-quality-"));
try {
  console.error(`Using model: ${model}`);
  console.error("Running model check on original image...");
  const originalResult = runCodex({
    imagePath: resolve(image),
    model,
    outputPath: join(workDir, "original.json"),
    label: "original",
    timeoutMs,
  });
  console.error("Running model check on compressed image...");
  const compressedResult = runCodex({
    imagePath: resolve(compressed),
    model,
    outputPath: join(workDir, "compressed.json"),
    label: "compressed",
    timeoutMs,
  });

  console.log(JSON.stringify({
    model,
    original: originalResult,
    compressed: compressedResult,
    deltaDetected: numberOrNull(compressedResult.detected_count) - numberOrNull(originalResult.detected_count),
  }, null, 2));
} finally {
  if (!args.keep) rmSync(workDir, { recursive: true, force: true });
}

function runCodex({ imagePath, model, outputPath, label, timeoutMs }) {
  const prompt = [
    `Inspect this ${label} Pokémon sheet image.`,
    "Count how many numbered Pokémon entries from 1 through 184 are visually detectable/readable.",
    "Return only compact JSON with keys detected_count, missing_numbers, uncertain_numbers, notes.",
    "Do not use tools.",
  ].join(" ");

  const result = spawnSync("codex", [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C", process.cwd(),
    "-s", "read-only",
    "-m", model,
    "--image", imagePath,
    "-o", outputPath,
    prompt,
  ], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });

  if (result.error) {
    throw new Error(`codex failed for ${basename(imagePath)}: ${result.error.message}`);
  }

  if (result.signal) {
    throw new Error(`codex timed out or was interrupted for ${basename(imagePath)} with signal ${result.signal}`);
  }

  if (result.status !== 0) {
    throw new Error(`codex failed for ${basename(imagePath)}\n${result.stderr || result.stdout}`);
  }

  if (!existsSync(outputPath)) {
    throw new Error(`codex did not write expected output file: ${outputPath}\n${result.stderr || result.stdout}`);
  }

  const raw = readFileSync(outputPath, "utf8").trim();
  return parseJsonish(raw);
}

function parseJsonish(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) return { raw };
    try {
      return JSON.parse(match[0]);
    } catch {
      return { raw };
    }
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--allow-external" || token === "--keep") {
      parsed[token.slice(2)] = true;
    } else if (token.startsWith("--")) {
      const [key, inlineValue] = token.slice(2).split("=", 2);
      parsed[key] = inlineValue ?? argv[++index];
    } else {
      parsed._.push(token);
    }
  }
  return parsed;
}
