#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "screenshotter.mjs");
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".tif", ".tiff"]);

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const latest = parsePositiveInteger(args.latest ?? 20, 20);
const visionLatest = parsePositiveInteger(args["vision-latest"] ?? latest, latest);
const screenshotDir = resolve(expandHome(args.dir ?? macScreenshotDir()));
const workDir = args["work-dir"] ? resolve(expandHome(args["work-dir"])) : mkdtempSync(join(tmpdir(), "screenshotter-poc-bench-"));
const keep = Boolean(args.keep);
const runVision = !args["skip-vision"];
const runCodecs = !args["skip-codecs"];
const json = Boolean(args.json);

try {
  mkdirSync(workDir, { recursive: true });
  const images = await latestImages(screenshotDir, latest);
  const retinaImages = await latestImages(screenshotDir, visionLatest, { minSourceLongEdge: parsePositiveInteger(args["vision-min-source-long-edge"] ?? 3000, 3000) });

  const result = {
    screenshotDir,
    workDir,
    sampleCount: images.length,
    retinaSampleCount: retinaImages.length,
    benchmarks: {},
    notes: [],
  };

  const current = runCliBench(["--latest", String(latest), "--tokens", "--json"]);
  result.benchmarks.currentNativeReadability = summarizeCliBench(current);

  const sipsBalanced = runCliBench(["--latest", String(latest), "--optimizer", "sips", "--tokens", "--json"]);
  result.benchmarks.sipsBalanced2200 = summarizeCliBench(sipsBalanced);

  const oldBalanced = runCliBench(["--latest", String(latest), "--optimizer", "sips", "--max-long-edge", "3000", "--tokens", "--json"]);
  result.benchmarks.previousBalanced3000 = summarizeCliBench(oldBalanced);

  const token = runCliBench(["--latest", String(latest), "--profile", "token", "--tokens", "--json"]);
  result.benchmarks.tokenProfile = summarizeCliBench(token);

  result.benchmarks.aggressiveEdges = {};
  for (const edge of [2200, 2000, 1800, 1600]) {
    const bench = runCliBench(["--latest", String(latest), "--max-long-edge", String(edge), "--tokens", "--json"]);
    result.benchmarks.aggressiveEdges[edge] = summarizeCliBench(bench);
  }

  const nativeHelper = compileSwift("scripts/native-image-optimizer.swift", "native-image-optimizer");
  result.benchmarks.nativeImageIOPerFile = benchNativeImageIO(nativeHelper, images, { batch: false, maxLongEdge: 2200, jpegQuality: 50 });
  result.benchmarks.nativeImageIOBatch = benchNativeImageIO(nativeHelper, images, { batch: true, maxLongEdge: 2200, jpegQuality: 50 });

  if (runCodecs) {
    if (commandExists("cwebp")) {
      result.benchmarks.webpCwebp = benchCwebp(images, { maxLongEdge: 2200, quality: 50 });
    } else {
      result.notes.push("cwebp not found; skipped WebP codec benchmark.");
    }

    if (commandExists("jpegtran") && result.benchmarks.nativeImageIOBatch?.rows?.length) {
      result.benchmarks.jpegtranOptimize = benchJpegtran(result.benchmarks.nativeImageIOBatch.rows);
    } else {
      result.notes.push("jpegtran not found or no native JPEG rows; skipped JPEG post-optimize benchmark.");
    }
  }

  if (runVision) {
    const visionOneShot = compileSwift("scripts/apple-vision-ocr.swift", "apple-vision-ocr");
    const visionBatch = compileSwift("scripts/apple-vision-batch-ocr.swift", "apple-vision-batch-ocr");
    result.benchmarks.appleVisionOneShot = benchVisionOneShot(visionOneShot, retinaImages);
    result.benchmarks.appleVisionBatch = benchVisionBatch(visionBatch, retinaImages);

    const textScale = runTextScaleEval(visionLatest);
    result.benchmarks.aggressiveTextRetention = summarizeTextScale(textScale);
  } else {
    result.notes.push("Vision benchmarks skipped with --skip-vision.");
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
} finally {
  if (!keep && !args["work-dir"]) rmSync(workDir, { recursive: true, force: true });
}

function runCliBench(extraArgs) {
  return runJson(process.execPath, [CLI, "bench", "--dir", screenshotDir, ...extraArgs]);
}

function summarizeCliBench(bench) {
  return {
    sampleCount: bench.sampleCount,
    avgMs: bench.prepareMs?.avg ?? null,
    medianMs: bench.prepareMs?.median ?? null,
    minMs: bench.prepareMs?.min ?? null,
    maxMs: bench.prepareMs?.max ?? null,
    originalBytes: bench.originalBytes,
    optimizedBytes: bench.optimizedBytes,
    savedPercent: bench.savedPercent,
    gpt5HighDetailSavedPercent: bench.tokenEstimates?.modes?.gpt5HighDetailTiles?.savedPercent ?? 0,
    patch10000SavedPercent: bench.tokenEstimates?.modes?.patchBudget10000?.savedPercent ?? 0,
    patch10000Saved: bench.tokenEstimates?.modes?.patchBudget10000?.saved ?? 0,
  };
}

function benchNativeImageIO(helper, images, { batch, maxLongEdge, jpegQuality }) {
  const outDir = join(workDir, batch ? "native-batch" : "native-per-file");
  mkdirSync(outDir, { recursive: true });
  const start = performance.now();
  const rows = [];
  let originalBytes = 0;
  let optimizedBytes = 0;

  if (batch) {
    const output = runJson(helper, ["--out-dir", outDir, "--max-long-edge", String(maxLongEdge), "--quality", String(jpegQuality), ...images]);
    const end = performance.now();
    return {
      sampleCount: images.length,
      wallMs: round(end - start, 1),
      helperMs: output.durationMs,
      originalBytes: output.originalBytes,
      optimizedBytes: output.optimizedBytes,
      savedPercent: output.savedPercent,
      rows: output.rows ?? [],
    };
  }

  for (const imagePath of images) {
    const output = runJson(helper, ["--out-dir", outDir, "--max-long-edge", String(maxLongEdge), "--quality", String(jpegQuality), imagePath]);
    const row = output.rows?.[0];
    if (!row || row.error) continue;
    rows.push(row);
    originalBytes += row.originalBytes;
    optimizedBytes += row.optimizedBytes;
  }

  const end = performance.now();
  return {
    sampleCount: rows.length,
    wallMs: round(end - start, 1),
    originalBytes,
    optimizedBytes,
    savedPercent: savedPercent(originalBytes, optimizedBytes),
    rows,
  };
}

function benchCwebp(images, { maxLongEdge, quality }) {
  const outDir = join(workDir, "cwebp");
  mkdirSync(outDir, { recursive: true });
  const start = performance.now();
  let originalBytes = 0;
  let optimizedBytes = 0;
  const rows = [];

  for (const imagePath of images) {
    const dimensions = imageDimensions(imagePath);
    const target = targetDimensions(dimensions.width, dimensions.height, maxLongEdge);
    const outputPath = join(outDir, `${safeStem(imagePath)}-max${maxLongEdge}-q${quality}.webp`);
    const rowStart = performance.now();
    const result = spawnSync("cwebp", [
      "-quiet",
      "-mt",
      "-q", String(quality),
      "-resize", String(target.width), String(target.height),
      imagePath,
      "-o", outputPath,
    ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const durationMs = round(performance.now() - rowStart, 1);
    if (result.status !== 0 || !existsSync(outputPath)) {
      rows.push({ path: imagePath, error: result.stderr || result.stdout, durationMs });
      continue;
    }
    const original = statSync(imagePath).size;
    const optimized = statSync(outputPath).size;
    originalBytes += original;
    optimizedBytes += optimized;
    rows.push({
      path: imagePath,
      optimizedPath: outputPath,
      originalBytes: original,
      optimizedBytes: optimized,
      savedPercent: savedPercent(original, optimized),
      width: target.width,
      height: target.height,
      durationMs,
    });
  }

  return {
    sampleCount: rows.filter((row) => !row.error).length,
    wallMs: round(performance.now() - start, 1),
    originalBytes,
    optimizedBytes,
    savedPercent: savedPercent(originalBytes, optimizedBytes),
    rows,
  };
}

function benchJpegtran(nativeRows) {
  const outDir = join(workDir, "jpegtran");
  mkdirSync(outDir, { recursive: true });
  const start = performance.now();
  let originalBytes = 0;
  let optimizedBytes = 0;
  const rows = [];

  for (const nativeRow of nativeRows) {
    if (!nativeRow.optimizedPath || extname(nativeRow.optimizedPath).toLowerCase() !== ".jpg") continue;
    const outputPath = join(outDir, `${safeStem(nativeRow.optimizedPath)}-opt.jpg`);
    const rowStart = performance.now();
    const result = spawnSync("jpegtran", [
      "-copy", "none",
      "-optimize",
      "-outfile", outputPath,
      nativeRow.optimizedPath,
    ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const durationMs = round(performance.now() - rowStart, 1);
    if (result.status !== 0 || !existsSync(outputPath)) {
      rows.push({ path: nativeRow.optimizedPath, error: result.stderr || result.stdout, durationMs });
      continue;
    }
    const original = statSync(nativeRow.optimizedPath).size;
    const optimized = statSync(outputPath).size;
    originalBytes += original;
    optimizedBytes += optimized;
    rows.push({
      path: nativeRow.optimizedPath,
      optimizedPath: outputPath,
      originalBytes: original,
      optimizedBytes: optimized,
      savedPercent: savedPercent(original, optimized),
      durationMs,
    });
  }

  return {
    sampleCount: rows.filter((row) => !row.error).length,
    wallMs: round(performance.now() - start, 1),
    originalBytes,
    optimizedBytes,
    savedPercent: savedPercent(originalBytes, optimizedBytes),
    rows,
  };
}

function benchVisionOneShot(helper, images) {
  const start = performance.now();
  const rows = [];
  for (const imagePath of images) {
    const rowStart = performance.now();
    const result = spawnSync(helper, [imagePath], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    rows.push({
      path: imagePath,
      durationMs: round(performance.now() - rowStart, 1),
      textLength: result.status === 0 ? result.stdout.length : 0,
      ok: result.status === 0,
    });
  }
  return {
    sampleCount: images.length,
    okCount: rows.filter((row) => row.ok).length,
    wallMs: round(performance.now() - start, 1),
    avgMs: round(rows.reduce((sum, row) => sum + row.durationMs, 0) / Math.max(1, rows.length), 1),
    rows,
  };
}

function benchVisionBatch(helper, images) {
  const start = performance.now();
  const output = runJson(helper, images);
  return {
    sampleCount: images.length,
    wallMs: round(performance.now() - start, 1),
    helperMs: output.durationMs,
    okCount: output.rows?.filter((row) => !row.error).length ?? 0,
    rows: output.rows ?? [],
  };
}

function runTextScaleEval(limit) {
  const output = runJson(process.execPath, [
    join(ROOT, "scripts", "text-scale-eval.mjs"),
    "--engine", "vision",
    "--latest", String(limit),
    "--min-source-long-edge", "3000",
    "--edges", "2400,2200,2000,1800,1600",
    "--json",
  ], { allowNonZero: true });
  return output;
}

function summarizeTextScale(output) {
  return {
    evaluatedCount: output.evaluatedCount,
    recommendation: output.recommendation,
    summaries: (output.summaries ?? []).map((summary) => ({
      maxLongEdge: summary.maxLongEdge,
      p10Retention: summary.p10Retention,
      medianRetention: summary.medianRetention,
      passRate: summary.passRate,
      bytesSavedPercent: summary.bytesSavedPercent,
      patch10000SavedPercent: summary.tokenEstimates?.patchBudget10000?.savedPercent ?? 0,
      passes: summary.passes,
    })),
  };
}

function compileSwift(relativeSource, outputName) {
  const source = join(ROOT, relativeSource);
  const output = join(workDir, outputName);
  const moduleCache = join(workDir, "swift-module-cache");
  mkdirSync(moduleCache, { recursive: true });
  const result = spawnSync("xcrun", [
    "swiftc",
    "-module-cache-path", moduleCache,
    source,
    "-o", output,
  ], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: moduleCache,
    },
  });
  if (result.status !== 0) {
    throw new Error(`Failed to compile ${relativeSource}\n${result.stderr || result.stdout}`);
  }
  return output;
}

function runJson(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
  });
  if (result.status !== 0 && !options.allowNonZero) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  const stdout = result.stdout.trim();
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error(`Expected JSON from ${command}\n${result.stderr || result.stdout}`);
  return JSON.parse(stdout.slice(start));
}

async function latestImages(dir, limit, { minSourceLongEdge } = {}) {
  const entries = await readdir(dir, { withFileTypes: true });
  const images = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const fileStat = await stat(path);
    images.push({ path, mtimeMs: fileStat.mtimeMs });
  }
  return images
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.path)
    .filter((path) => {
      if (!minSourceLongEdge) return true;
      const dimensions = imageDimensions(path);
      return Math.max(dimensions.width, dimensions.height) >= minSourceLongEdge;
    })
    .slice(0, limit);
}

function imageDimensions(imagePath) {
  const result = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", imagePath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    width: Number(/pixelWidth:\s*(\d+)/.exec(result.stdout)?.[1] ?? 0),
    height: Number(/pixelHeight:\s*(\d+)/.exec(result.stdout)?.[1] ?? 0),
  };
}

function targetDimensions(width, height, maxLongEdge) {
  const longEdge = Math.max(width, height);
  if (!longEdge || longEdge <= maxLongEdge) return { width, height };
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function printHuman(result) {
  console.log(`PoC benchmark sample: ${result.sampleCount} screenshots`);
  console.log(`Vision sample: ${result.retinaSampleCount} retina screenshots`);
  console.log("");

  console.log("Optimization paths");
  printRows([
    ["current native readability", result.benchmarks.currentNativeReadability?.avgMs, result.benchmarks.currentNativeReadability?.optimizedBytes, result.benchmarks.currentNativeReadability?.savedPercent, result.benchmarks.currentNativeReadability?.patch10000SavedPercent],
    ["sips CLI 2200", result.benchmarks.sipsBalanced2200?.avgMs, result.benchmarks.sipsBalanced2200?.optimizedBytes, result.benchmarks.sipsBalanced2200?.savedPercent, result.benchmarks.sipsBalanced2200?.patch10000SavedPercent],
    ["sips CLI 3000", result.benchmarks.previousBalanced3000?.avgMs, result.benchmarks.previousBalanced3000?.optimizedBytes, result.benchmarks.previousBalanced3000?.savedPercent, result.benchmarks.previousBalanced3000?.patch10000SavedPercent],
    ["token profile", result.benchmarks.tokenProfile?.avgMs, result.benchmarks.tokenProfile?.optimizedBytes, result.benchmarks.tokenProfile?.savedPercent, result.benchmarks.tokenProfile?.patch10000SavedPercent],
    ["native ImageIO per file", perImageMs(result.benchmarks.nativeImageIOPerFile), result.benchmarks.nativeImageIOPerFile?.optimizedBytes, result.benchmarks.nativeImageIOPerFile?.savedPercent, "n/a"],
    ["native ImageIO batch", perImageMs(result.benchmarks.nativeImageIOBatch), result.benchmarks.nativeImageIOBatch?.optimizedBytes, result.benchmarks.nativeImageIOBatch?.savedPercent, "n/a"],
    ["cwebp q50 all images", perImageMs(result.benchmarks.webpCwebp), result.benchmarks.webpCwebp?.optimizedBytes, result.benchmarks.webpCwebp?.savedPercent, "same dims"],
    ["jpegtran native JPEG rows", perImageMs(result.benchmarks.jpegtranOptimize), result.benchmarks.jpegtranOptimize?.optimizedBytes, result.benchmarks.jpegtranOptimize?.savedPercent, "bytes only"],
  ], ["Path", "ms/img", "optimized", "bytes saved", "patch saved"]);

  if (result.benchmarks.appleVisionOneShot && result.benchmarks.appleVisionBatch) {
    console.log("");
    console.log("Apple Vision OCR");
    printRows([
      ["one process per image", perImageMs(result.benchmarks.appleVisionOneShot), null, null, `${result.benchmarks.appleVisionOneShot.okCount}/${result.benchmarks.appleVisionOneShot.sampleCount}`],
      ["batch process", perImageMs(result.benchmarks.appleVisionBatch), null, null, `${result.benchmarks.appleVisionBatch.okCount}/${result.benchmarks.appleVisionBatch.sampleCount}`],
    ], ["Path", "ms/img", "", "", "ok"]);
  }

  const textRetention = result.benchmarks.aggressiveTextRetention;
  if (textRetention) {
    console.log("");
    console.log("High-compression downscale text retention");
    printRows(textRetention.summaries.map((summary) => [
      `${summary.maxLongEdge}px`,
      null,
      null,
      summary.bytesSavedPercent,
      `${percent(summary.p10Retention)} p10 / ${percent(summary.medianRetention)} med / ${summary.passes ? "pass" : "fail"}`,
    ]), ["Edge", "", "", "bytes saved", "retention"]);
    if (textRetention.recommendation) {
      console.log(`Recommendation: ${textRetention.recommendation.maxLongEdge}px`);
    }
  }

  if (result.notes.length) {
    console.log("");
    for (const note of result.notes) console.log(`Note: ${note}`);
  }
}

function printRows(rows, headers) {
  const formatted = rows.map((row) => row.map(formatCell));
  const allRows = [headers, ...formatted];
  const widths = headers.map((_, index) => Math.max(...allRows.map((row) => String(row[index] ?? "").length)));
  console.log(headers.map((cell, index) => String(cell).padEnd(widths[index])).join("  "));
  console.log(headers.map((_, index) => "-".repeat(widths[index])).join("  "));
  for (const row of formatted) {
    console.log(row.map((cell, index) => String(cell).padEnd(widths[index])).join("  "));
  }
}

function formatCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (value > 1024 * 1024) return `${round(value / 1024 / 1024, 2)} MB`;
    if (value > 1024) return `${round(value / 1024, 1)} KB`;
    return String(value);
  }
  return String(value);
}

function perImageMs(summary) {
  if (!summary) return null;
  if (summary.avgMs) return summary.avgMs;
  return round((summary.wallMs ?? 0) / Math.max(1, summary.sampleCount ?? 1), 1);
}

function commandExists(command) {
  return spawnSync("/usr/bin/which", [command], { stdio: "ignore" }).status === 0;
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json" || token === "--keep" || token === "--skip-vision" || token === "--skip-codecs" || token === "--help") {
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

function parsePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) throw new Error(`Expected positive integer, got ${value}`);
  return Math.floor(number);
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

function safeStem(filePath) {
  return basename(filePath).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function savedPercent(original, optimized) {
  if (!original) return 0;
  return round((1 - optimized / original) * 100, 1);
}

function percent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${round(value * 100, 1)}%`;
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function printUsage() {
  console.log(`Usage:
  npm run bench:poc -- [options]

Options:
  --latest <n>                         Latest screenshots for optimizer/codec benchmarks. Default: 20.
  --vision-latest <n>                  Retina screenshots for Apple Vision/text evals. Default: same as --latest.
  --vision-min-source-long-edge <px>   Retina filter for Vision evals. Default: 3000.
  --skip-vision                        Skip Apple Vision and text-retention evals.
  --skip-codecs                        Skip WebP/jpegtran codec evals.
  --json                               Print full JSON.
  --keep                               Keep temp files.
`);
}
