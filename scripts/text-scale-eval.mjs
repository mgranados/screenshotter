#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_EDGES = [3000, 2600, 2400, 2200, 2000, 1800, 1600];
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".tif", ".tiff"]);
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VISION_OCR_SOURCE = join(ROOT_DIR, "scripts", "apple-vision-ocr.swift");
const VISION_BATCH_OCR_SOURCE = join(ROOT_DIR, "scripts", "apple-vision-batch-ocr.swift");

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}
const screenshotDir = resolve(expandHome(args.dir ?? macScreenshotDir()));
const latest = parsePositiveInteger(args.latest ?? args.limit, 10);
const edges = parseEdges(args.edges ?? args["max-long-edges"] ?? DEFAULT_EDGES.join(","));
const minRetention = Number(args["min-retention"] ?? 0.9);
const jpegQuality = parsePositiveInteger(args["jpeg-quality"] ?? 50, 50);
const psm = String(args.psm ?? 11);
const engine = normalizeEngine(args.engine ?? "ocr");
const model = args.model;
const timeoutMs = parsePositiveInteger(args["timeout-ms"] ?? 180_000, 180_000);
const visionLevel = args["vision-level"] ?? "accurate";
const parsedVisionLanguages = String(args["vision-languages"] ?? "en-US")
  .split(",")
  .map((language) => language.trim())
  .filter(Boolean);
const visionLanguages = parsedVisionLanguages.length ? parsedVisionLanguages : ["en-US"];
const minSourceLongEdge = args["min-source-long-edge"] === undefined
  ? undefined
  : parsePositiveInteger(args["min-source-long-edge"], undefined);
const keep = Boolean(args.keep);
const workDir = args["work-dir"] ? resolve(expandHome(args["work-dir"])) : mkdtempSync(join(tmpdir(), "screenshotter-text-scale-"));

if (!Number.isFinite(minRetention) || minRetention < 0 || minRetention > 1) {
  console.error("--min-retention must be between 0 and 1");
  process.exit(1);
}

if (!existsSync(screenshotDir)) {
  console.error(`Screenshot directory not found: ${screenshotDir}`);
  process.exit(1);
}

if (!["ocr", "vision", "codex"].includes(engine)) {
  console.error("--engine must be ocr, vision, or codex");
  process.exit(1);
}

if (!["accurate", "fast"].includes(visionLevel)) {
  console.error("--vision-level must be accurate or fast");
  process.exit(1);
}

if (engine === "codex" && (!model || !args["allow-external"])) {
  console.error([
    "Codex engine requires --model <vision-model> --allow-external.",
    "This sends original and resized screenshots to the configured model service.",
  ].join("\n"));
  process.exit(2);
}

if (engine === "ocr" && !commandExists("tesseract")) {
  console.error("OCR engine requires tesseract on PATH. Install it with: brew install tesseract");
  process.exit(2);
}

if (engine === "vision" && !commandExists("xcrun")) {
  console.error("Apple Vision engine requires xcrun/swiftc from the macOS developer tools.");
  process.exit(2);
}

if (!commandExists("sips")) {
  console.error("This eval requires the macOS sips command on PATH.");
  process.exit(2);
}

let visionOcrBinary;
let visionBatchOcrBinary;
let visionBatchFallbacks = 0;

try {
  if (engine === "vision") visionBatchOcrBinary = compileVisionBatchOcrHelper();
  const filteredImages = await latestImages(screenshotDir, latest, { minSourceLongEdge });
  const originalTexts = recognizeTexts(filteredImages.map((imagePath) => ({ path: imagePath, label: "original" })));
  const rowSlots = [];
  const variantItems = [];

  for (const imagePath of filteredImages) {
    const originalText = originalTexts.get(imagePath) ?? "";
    const originalTokens = tokenCounts(originalText);
    const originalTokenCount = countTokens(originalTokens);
    const originalDimensions = imageDimensions(imagePath);
    const originalBytes = statSync(imagePath).size;
    if (originalTokenCount === 0) {
      rowSlots.push({
        path: imagePath,
        skipped: "no text detected in original",
        originalBytes,
        originalWidth: originalDimensions.width,
        originalHeight: originalDimensions.height,
        originalTokenCount,
      });
      continue;
    }

    const variants = [];
    for (const maxLongEdge of edges) {
      const variantPath = createVariant(imagePath, workDir, maxLongEdge, jpegQuality, originalDimensions);
      const dimensions = imageDimensions(variantPath);
      const optimizedBytes = statSync(variantPath).size;
      variants.push({
        maxLongEdge,
        path: variantPath,
        width: dimensions.width,
        height: dimensions.height,
        optimizedBytes,
        bytesSavedPercent: originalBytes > 0 ? round((1 - optimizedBytes / originalBytes) * 100, 1) : 0,
        originalTextTokens: originalTokenCount,
        tokenEstimates: tokenEstimatesForDimensions({
          originalWidth: originalDimensions.width,
          originalHeight: originalDimensions.height,
          width: dimensions.width,
          height: dimensions.height,
        }),
      });
      variantItems.push({ path: variantPath, label: `max ${maxLongEdge}` });
    }

    rowSlots.push({
      path: imagePath,
      originalBytes,
      originalWidth: originalDimensions.width,
      originalHeight: originalDimensions.height,
      originalTokens,
      originalTokenCount,
      variants,
    });
  }

  const variantTexts = recognizeTexts(variantItems);
  const rows = rowSlots.map((row) => {
    if (row.skipped) return row;
    return {
      path: row.path,
      originalBytes: row.originalBytes,
      originalWidth: row.originalWidth,
      originalHeight: row.originalHeight,
      originalTokenCount: row.originalTokenCount,
      variants: row.variants.map((variant) => {
        const variantText = variantTexts.get(variant.path) ?? "";
        const variantTokens = tokenCounts(variantText);
        return {
          ...variant,
          tokenRetention: round(tokenRetention(row.originalTokens, variantTokens), 4),
          recognizedTextTokens: countTokens(variantTokens),
        };
      }),
    };
  });

  const evaluatedRows = rows.filter((row) => !row.skipped);
  const summaries = edges.map((maxLongEdge) => {
    const variants = evaluatedRows
      .map((row) => row.variants.find((variant) => variant.maxLongEdge === maxLongEdge))
      .filter(Boolean);
    const retentions = variants.map((variant) => variant.tokenRetention).sort((a, b) => a - b);
    const passingCount = retentions.filter((retention) => retention >= minRetention).length;
    const originalBytes = evaluatedRows.reduce((sum, row) => sum + row.originalBytes, 0);
    const optimizedBytes = variants.reduce((sum, variant) => sum + variant.optimizedBytes, 0);
    const tokenSummary = summarizeTokenEstimates(variants.map((variant) => variant.tokenEstimates));
    return {
      maxLongEdge,
      evaluated: variants.length,
      minRetention: retentions[0] ?? null,
      p10Retention: percentile(retentions, 0.1),
      medianRetention: percentile(retentions, 0.5),
      avgRetention: retentions.length ? round(retentions.reduce((sum, value) => sum + value, 0) / retentions.length, 4) : null,
      passRate: retentions.length ? round(passingCount / retentions.length, 4) : null,
      bytesSavedPercent: originalBytes > 0 ? round((1 - optimizedBytes / originalBytes) * 100, 1) : 0,
      tokenEstimates: tokenSummary,
      passes: retentions.length > 0 && (percentile(retentions, 0.1) ?? 0) >= minRetention,
    };
  });

  const passing = summaries.filter((summary) => summary.passes);
  const recommendation = passing.length
    ? passing.reduce((best, current) => current.maxLongEdge < best.maxLongEdge ? current : best)
    : null;

  const result = {
    engine,
    model: engine === "codex" ? model : undefined,
    visionLevel: engine === "vision" ? visionLevel : undefined,
    visionLanguages: engine === "vision" ? visionLanguages : undefined,
    visionBatch: engine === "vision" ? {
      enabled: true,
      fallbackImages: visionBatchFallbacks,
    } : undefined,
    note: engineNote(),
    screenshotDir,
    workDir,
    latest,
    minSourceLongEdge: minSourceLongEdge ?? null,
    jpegQuality,
    minRetention,
    sampleCount: rows.length,
    evaluatedCount: evaluatedRows.length,
    skippedCount: rows.length - evaluatedRows.length,
    recommendation: recommendation ? {
      maxLongEdge: recommendation.maxLongEdge,
      p10Retention: recommendation.p10Retention,
      medianRetention: recommendation.medianRetention,
      bytesSavedPercent: recommendation.bytesSavedPercent,
      patchBudget10000SavedPercent: recommendation.tokenEstimates.patchBudget10000?.savedPercent ?? 0,
    } : null,
    summaries,
    rows: args.rows ? rows : undefined,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanResult(result);
  }
  if (!recommendation) process.exitCode = 1;
} finally {
  if (!keep && !args["work-dir"]) rmSync(workDir, { recursive: true, force: true });
}

function recognizeText(imagePath, label) {
  if (engine === "codex") return recognizeTextWithCodex(imagePath, label);
  if (engine === "vision") return recognizeTextWithVision(imagePath);
  return recognizeTextWithOcr(imagePath);
}

function recognizeTexts(items) {
  if (items.length === 0) return new Map();
  if (engine === "vision") return recognizeTextsWithVisionBatch(items.map((item) => item.path));

  const texts = new Map();
  for (const item of items) {
    texts.set(item.path, recognizeText(item.path, item.label));
  }
  return texts;
}

function recognizeTextWithOcr(imagePath) {
  const result = spawnSync("tesseract", [
    imagePath,
    "stdout",
    "--psm", psm,
    "-l", "eng",
  ], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0) {
    return "";
  }

  return result.stdout;
}

function recognizeTextWithVision(imagePath) {
  if (!visionOcrBinary) visionOcrBinary = compileVisionOcrHelper();
  const result = spawnSync(visionOcrBinary, [
    imagePath,
    "--level", visionLevel,
    "--languages", visionLanguages.join(","),
  ], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
  });

  if (result.status !== 0) {
    return "";
  }

  return result.stdout;
}

function recognizeTextsWithVisionBatch(paths) {
  const result = spawnSync(visionBatchOcrBinary, [
    "--level", visionLevel,
    "--languages", visionLanguages.join(","),
    "--include-text",
    ...paths,
  ], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: timeoutMs,
  });

  if (result.status !== 0) {
    visionBatchFallbacks += paths.length;
    const fallback = new Map();
    for (const path of paths) fallback.set(path, recognizeTextWithVision(path));
    return fallback;
  }

  const parsed = parseJsonish(result.stdout);
  if (!Array.isArray(parsed.rows)) {
    visionBatchFallbacks += paths.length;
    const fallback = new Map();
    for (const path of paths) fallback.set(path, recognizeTextWithVision(path));
    return fallback;
  }

  const texts = new Map();
  for (const row of parsed.rows) {
    if (row.error) {
      visionBatchFallbacks += 1;
      texts.set(row.path, recognizeTextWithVision(row.path));
    } else {
      texts.set(row.path, typeof row.text === "string" ? row.text : "");
    }
  }
  for (const path of paths) {
    if (!texts.has(path)) {
      visionBatchFallbacks += 1;
      texts.set(path, recognizeTextWithVision(path));
    }
  }
  return texts;
}

function recognizeTextWithCodex(imagePath, label) {
  const outputPath = join(workDir, `${basename(imagePath).replace(/[^A-Za-z0-9._-]+/g, "_")}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const prompt = [
    `Transcribe all visible UI text in this ${label} screenshot.`,
    "Preserve labels, headings, numbers, and short UI strings.",
    "Return only compact JSON with a single key named text.",
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

  if (result.status !== 0 || !existsSync(outputPath)) {
    return "";
  }

  const parsed = parseJsonish(readFileSync(outputPath, "utf8").trim());
  return typeof parsed.text === "string" ? parsed.text : "";
}

function compileVisionOcrHelper() {
  const outputPath = join(workDir, "apple-vision-ocr");
  const moduleCachePath = join(workDir, "swift-module-cache");
  mkdirSync(moduleCachePath, { recursive: true });
  const result = spawnSync("xcrun", [
    "swiftc",
    "-module-cache-path",
    moduleCachePath,
    VISION_OCR_SOURCE,
    "-o",
    outputPath,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: moduleCachePath,
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
  });

  if (result.status !== 0) {
    throw new Error(`Apple Vision OCR helper failed to compile\n${result.stderr || result.stdout}`);
  }

  return outputPath;
}

function compileVisionBatchOcrHelper() {
  const outputPath = join(workDir, "apple-vision-batch-ocr");
  const moduleCachePath = join(workDir, "swift-module-cache");
  mkdirSync(moduleCachePath, { recursive: true });
  const result = spawnSync("xcrun", [
    "swiftc",
    "-module-cache-path",
    moduleCachePath,
    VISION_BATCH_OCR_SOURCE,
    "-o",
    outputPath,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: moduleCachePath,
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
  });

  if (result.status !== 0) {
    throw new Error(`Apple Vision batch OCR helper failed to compile\n${result.stderr || result.stdout}`);
  }

  return outputPath;
}

function engineNote() {
  if (engine === "ocr") {
    return "Tesseract OCR is fully local but conservative. Use --engine vision or --engine codex for thresholds closer to UI-reading agents.";
  }
  if (engine === "vision") {
    return "Apple Vision OCR stays local and is usually a better proxy for UI text readability than Tesseract. Use --engine codex for model-specific thresholds.";
  }
  return "Codex engine uses the requested vision-capable model transcription as the text-readability signal.";
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

function createVariant(inputPath, outputDir, maxLongEdge, quality, originalDimensions) {
  const stem = basename(inputPath).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_");
  const outputPath = join(outputDir, `${stem}-max${maxLongEdge}-q${quality}.jpg`);
  if (existsSync(outputPath)) return outputPath;

  const sipsArgs = [
    "-s", "format", "jpeg",
    "-s", "formatOptions", String(quality),
  ];
  const originalLongEdge = Math.max(originalDimensions.width ?? 0, originalDimensions.height ?? 0);
  if (originalLongEdge > maxLongEdge) sipsArgs.push("--resampleHeightWidthMax", String(maxLongEdge));
  sipsArgs.push(inputPath, "--out", outputPath);

  const result = spawnSync("sips", sipsArgs, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`sips failed for ${inputPath}\n${result.stderr || result.stdout}`);
  }

  return outputPath;
}

function tokenCounts(text) {
  const counts = new Map();
  const tokens = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= 2 || /^\d$/.test(token));

  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function countTokens(counts) {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

function tokenRetention(original, candidate) {
  const total = countTokens(original);
  if (total === 0) return 0;

  let retained = 0;
  for (const [token, count] of original) {
    retained += Math.min(count, candidate.get(token) ?? 0);
  }
  return retained / total;
}

function imageDimensions(imagePath) {
  const result = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", imagePath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) return {};
  return {
    width: Number(/pixelWidth:\s*(\d+)/.exec(result.stdout)?.[1]),
    height: Number(/pixelHeight:\s*(\d+)/.exec(result.stdout)?.[1]),
  };
}

function tokenEstimatesForDimensions(dimensions) {
  return {
    gpt5HighDetailTiles: tokenEstimatePair(dimensions, (w, h) => highDetailTileTokens(w, h, 70, 140), "tokens"),
    patchBudget1536: tokenEstimatePair(dimensions, (w, h) => patchCount(w, h, 1536), "patches"),
    patchBudget10000: tokenEstimatePair(dimensions, (w, h) => patchCount(w, h, 10000), "patches"),
  };
}

function tokenEstimatePair(dimensions, estimator, unit) {
  const original = estimator(dimensions.originalWidth, dimensions.originalHeight);
  const optimized = estimator(dimensions.width, dimensions.height);
  return {
    unit,
    original,
    optimized,
    saved: original - optimized,
    savedPercent: original > 0 ? round((1 - optimized / original) * 100, 1) : 0,
  };
}

function summarizeTokenEstimates(estimates) {
  const totals = {};
  for (const estimate of estimates) {
    for (const [name, value] of Object.entries(estimate)) {
      totals[name] ??= { unit: value.unit, original: 0, optimized: 0, saved: 0 };
      totals[name].original += value.original;
      totals[name].optimized += value.optimized;
      totals[name].saved += value.saved;
    }
  }
  for (const value of Object.values(totals)) {
    value.savedPercent = value.original > 0 ? round((1 - value.optimized / value.original) * 100, 1) : 0;
  }
  return totals;
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
  return Math.min(Math.ceil(width / 32) * Math.ceil(height / 32), budget);
}

async function latestImages(dir, limit, { minSourceLongEdge } = {}) {
  const entries = await readdir(dir, { withFileTypes: true });
  const images = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = join(dir, entry.name);
    if (!IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())) continue;
    const fileStat = await stat(filePath);
    images.push({ path: filePath, mtimeMs: fileStat.mtimeMs });
  }
  return images
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.path)
    .filter((imagePath) => {
      if (!minSourceLongEdge) return true;
      const dimensions = imageDimensions(imagePath);
      return Math.max(dimensions.width ?? 0, dimensions.height ?? 0) >= minSourceLongEdge;
    })
    .slice(0, limit);
}

function printHumanResult(result) {
  console.log("Text scale eval");
  console.log(`Engine: ${result.engine}${result.model ? ` (${result.model})` : ""}`);
  if (result.engine === "vision") console.log(`Apple Vision: ${result.visionLevel}, ${result.visionLanguages.join(",")}`);
  if (result.visionBatch) console.log(`Apple Vision batch: ${result.visionBatch.enabled ? "on" : "off"}, fallbacks ${result.visionBatch.fallbackImages}`);
  console.log(`Screenshots: ${result.evaluatedCount} evaluated, ${result.skippedCount} skipped`);
  if (result.minSourceLongEdge) console.log(`Source filter: long edge >= ${result.minSourceLongEdge}px`);
  console.log(result.note);
  console.log("");

  console.log("Max edge  p10 text  median   bytes saved  patch saved  pass");
  for (const summary of result.summaries) {
    const patchSaved = summary.tokenEstimates.patchBudget10000?.savedPercent ?? 0;
    console.log([
      String(summary.maxLongEdge).padStart(8),
      percent(summary.p10Retention).padStart(8),
      percent(summary.medianRetention).padStart(7),
      percent(summary.bytesSavedPercent / 100).padStart(12),
      percent(patchSaved / 100).padStart(11),
      summary.passes ? "yes" : "no",
    ].join("  "));
  }

  console.log("");
  if (result.recommendation) {
    console.log([
      `Recommendation: max long edge ${result.recommendation.maxLongEdge}px`,
      `p10 text retention ${percent(result.recommendation.p10Retention)}`,
      `median ${percent(result.recommendation.medianRetention)}`,
      `bytes saved ${percent(result.recommendation.bytesSavedPercent / 100)}`,
    ].join(", "));
  } else {
    console.log(`Recommendation: none of the tested sizes cleared p10 >= ${percent(result.minRetention)}`);
  }
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return values[index];
}

function parseEdges(value) {
  return String(value)
    .split(",")
    .map((part) => parsePositiveInteger(part.trim()))
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((a, b) => b - a);
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) throw new Error(`Expected positive integer, got ${value}`);
  return Math.floor(numeric);
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json" || token === "--keep" || token === "--rows" || token === "--allow-external" || token === "--help") {
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

function normalizeEngine(value) {
  if (value === "apple-vision") return "vision";
  return value;
}

function printUsage() {
  console.log(`Usage:
  npm run eval:text-scale -- [options]

Options:
  --engine ocr|vision|apple-vision|codex
      ocr: Tesseract OCR, fully local conservative baseline.
      vision: Apple Vision OCR, fully local and recommended for fast local tuning.
      codex: Codex CLI vision model transcription; requires --model and --allow-external.
  --model <model>
      Codex model id for --engine codex.
  --allow-external
      Required for --engine codex because screenshots are sent to the configured model service.
  --latest <n>
      Number of screenshots to test after filters. Default: 10.
  --min-source-long-edge <px>
      Only test source screenshots whose long edge is at least this size.
  --edges <px,px,...>
      Candidate max long edges. Default: 3000,2600,2400,2200,2000,1800,1600.
  --min-retention <0..1>
      Required p10 text retention. Default: 0.9.
  --vision-level accurate|fast
      Apple Vision recognition level. Default: accurate.
  --vision-languages <lang,lang>
      Apple Vision recognition languages. Default: en-US.
  --json
      Print JSON instead of a human table.
`);
}

function macScreenshotDir() {
  const fallback = join(homedir(), "Desktop");
  const result = spawnSync("defaults", ["read", "com.apple.screencapture", "location"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const configured = result.status === 0 ? expandHome(result.stdout.trim()) : "";
  return configured || fallback;
}

function expandHome(value) {
  if (!value || value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function commandExists(command) {
  return spawnSync("/usr/bin/which", [command], { stdio: "ignore" }).status === 0;
}

function percent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${round(value * 100, 1)}%`;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
