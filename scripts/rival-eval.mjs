#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT_DIR, "bin", "screenshotter.mjs");
const TEXT_SCALE_EVAL = join(ROOT_DIR, "scripts", "text-scale-eval.mjs");
const DEFAULT_CANDIDATES = [
  { name: "token-768-q45", profile: "token", maxLongEdge: 768, jpegQuality: 45 },
  { name: "token-896-q45", profile: "token", maxLongEdge: 896, jpegQuality: 45 },
  { name: "token-1024-q45", profile: "token", maxLongEdge: 1024, jpegQuality: 45 },
  { name: "token-1152-q45", profile: "token", maxLongEdge: 1152, jpegQuality: 45 },
  { name: "token-1280-q45", profile: "token", maxLongEdge: 1280, jpegQuality: 45 },
  { name: "balanced-1600-q50", profile: "balanced", maxLongEdge: 1600, jpegQuality: 50 },
  { name: "balanced-1800-q50", profile: "balanced", maxLongEdge: 1800, jpegQuality: 50 },
  { name: "balanced-2000-q50", profile: "balanced", maxLongEdge: 2000, jpegQuality: 50 },
  { name: "balanced-2200-q50", profile: "balanced", maxLongEdge: 2200, jpegQuality: 50 },
  { name: "readability-4096-q90", profile: "readability", maxLongEdge: 4096, jpegQuality: 90 },
];

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const latest = parsePositiveInteger(args.latest ?? 20, 20);
const qualityLatest = parsePositiveInteger(args["quality-latest"] ?? Math.min(latest, 10), Math.min(latest, 10));
const minRetention = parseFraction(args["min-retention"] ?? 0.9, 0.9);
const minSourceLongEdge = parsePositiveInteger(args["min-source-long-edge"] ?? 3000, 3000);
const screenshotDir = resolve(expandHome(args.dir ?? macScreenshotDir()));
const workDir = args["work-dir"] ? resolve(expandHome(args["work-dir"])) : mkdtempSync(join(tmpdir(), "screenshotter-rival-eval-"));
const keep = Boolean(args.keep);
const json = Boolean(args.json);
const qualityEngine = normalizeQualityEngine(args["quality-engine"] ?? defaultQualityEngine());
const visionLevel = args["vision-level"] ?? "accurate";
const model = args.model;
const candidates = parseCandidates(args.candidates);

if (qualityEngine === "codex" && (!model || !args["allow-external"])) {
  console.error("--quality-engine codex requires --model <vision-model> --allow-external.");
  console.error("This sends original and resized screenshots to the configured model service.");
  process.exit(2);
}

try {
  mkdirSync(workDir, { recursive: true });

  const qualityByCandidateKey = qualityEngine === "none"
    ? new Map()
    : runQualityEvals(candidates);
  const candidateRows = candidates.map((candidate) => {
    const bench = runBench(candidate);
    const quality = qualityByCandidateKey.get(candidateKey(candidate)) ?? null;
    return rankableRow(candidate, bench, quality);
  });
  const rankedRows = candidateRows
    .map((row) => ({ ...row, score: candidateScore(row) }))
    .sort(compareRows);
  const eligibleRows = rankedRows.filter((row) => row.eligible);
  const recommendation = eligibleRows[0] ?? null;

  const result = {
    screenshotDir,
    workDir,
    latest,
    quality: {
      engine: qualityEngine,
      latest: qualityEngine === "none" ? 0 : qualityLatest,
      minSourceLongEdge: qualityEngine === "none" ? null : minSourceLongEdge,
      minRetention: qualityEngine === "none" ? null : minRetention,
      visionLevel: qualityEngine === "vision" ? visionLevel : undefined,
      model: qualityEngine === "codex" ? model : undefined,
    },
    recommendation: recommendation ? recommendationSummary(recommendation) : null,
    candidates: rankedRows,
  };

  if (json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
} finally {
  if (!keep && !args["work-dir"]) rmSync(workDir, { recursive: true, force: true });
}

function runBench(candidate) {
  const dataDir = join(workDir, "store");
  return runJson(process.execPath, [
    CLI,
    "bench",
    "--dir", screenshotDir,
    "--latest", String(latest),
    "--profile", candidate.profile,
    "--max-long-edge", String(candidate.maxLongEdge),
    "--jpeg-quality", String(candidate.jpegQuality),
    "--tokens",
    "--data-dir", dataDir,
    "--json",
  ]);
}

function runQualityEvals(candidateList) {
  const byCandidateKey = new Map();
  const groups = new Map();
  for (const candidate of candidateList) {
    const key = String(candidate.jpegQuality);
    const group = groups.get(key) ?? { jpegQuality: candidate.jpegQuality, edges: new Set() };
    group.edges.add(candidate.maxLongEdge);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const edges = [...group.edges].sort((a, b) => b - a);
    const commandArgs = [
      TEXT_SCALE_EVAL,
      "--dir", screenshotDir,
      "--latest", String(qualityLatest),
      "--min-source-long-edge", String(minSourceLongEdge),
      "--edges", edges.join(","),
      "--jpeg-quality", String(group.jpegQuality),
      "--min-retention", String(minRetention),
      "--engine", qualityEngine,
      "--json",
    ];
    if (qualityEngine === "vision") {
      commandArgs.push("--vision-level", visionLevel);
      if (args["vision-languages"]) commandArgs.push("--vision-languages", args["vision-languages"]);
    }
    if (qualityEngine === "codex") {
      commandArgs.push("--model", model, "--allow-external");
    }

    const result = runJson(process.execPath, commandArgs, { allowNonZero: true });
    for (const summary of result.summaries ?? []) {
      for (const candidate of candidateList) {
        if (candidate.jpegQuality !== group.jpegQuality || candidate.maxLongEdge !== summary.maxLongEdge) continue;
        byCandidateKey.set(candidateKey(candidate), {
          engine: qualityEngine,
          evaluated: summary.evaluated,
          p10Retention: summary.p10Retention,
          medianRetention: summary.medianRetention,
          avgRetention: summary.avgRetention,
          passRate: summary.passRate,
          passes: Boolean(summary.passes),
          bytesSavedPercent: summary.bytesSavedPercent,
          patchBudget10000SavedPercent: summary.tokenEstimates?.patchBudget10000?.savedPercent ?? 0,
        });
      }
    }
  }

  return byCandidateKey;
}

function rankableRow(candidate, bench, quality) {
  const tokenModes = bench.tokenEstimates?.modes ?? {};
  const row = {
    name: candidate.name,
    profile: candidate.profile,
    maxLongEdge: candidate.maxLongEdge,
    jpegQuality: candidate.jpegQuality,
    sampleCount: bench.sampleCount,
    avgMs: bench.prepareMs?.avg ?? null,
    medianMs: bench.prepareMs?.median ?? null,
    optimizedMB: bytesToMb(bench.optimizedBytes),
    savedPercent: bench.savedPercent ?? 0,
    gpt5HighDetailSavedPercent: tokenModes.gpt5HighDetailTiles?.savedPercent ?? 0,
    gpt4oHighDetailSavedPercent: tokenModes.gpt4oHighDetailTiles?.savedPercent ?? 0,
    patchBudget1536SavedPercent: tokenModes.patchBudget1536?.savedPercent ?? 0,
    patchBudget10000SavedPercent: tokenModes.patchBudget10000?.savedPercent ?? 0,
    quality,
  };
  row.eligible = qualityEngine === "none" || quality?.passes === true;
  return row;
}

function candidateScore(row) {
  const apiCostScore = (row.gpt5HighDetailSavedPercent * 0.45)
    + (row.gpt4oHighDetailSavedPercent * 0.15)
    + (row.patchBudget10000SavedPercent * 0.3)
    + (row.patchBudget1536SavedPercent * 0.1);
  const byteScore = row.savedPercent * 0.15;
  const speedScore = clamp(100 - (row.avgMs ?? 100), 0, 100) * 0.05;
  const qualityScore = row.quality?.p10Retention === undefined || row.quality?.p10Retention === null
    ? 0
    : clamp(row.quality.p10Retention * 100, 0, 100) * 0.1;
  const penalty = row.eligible ? 0 : 1000;
  return round(apiCostScore + byteScore + speedScore + qualityScore - penalty, 2);
}

function compareRows(a, b) {
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if (b.score !== a.score) return b.score - a.score;
  if (b.gpt5HighDetailSavedPercent !== a.gpt5HighDetailSavedPercent) return b.gpt5HighDetailSavedPercent - a.gpt5HighDetailSavedPercent;
  if (b.patchBudget10000SavedPercent !== a.patchBudget10000SavedPercent) return b.patchBudget10000SavedPercent - a.patchBudget10000SavedPercent;
  return (a.avgMs ?? 0) - (b.avgMs ?? 0);
}

function recommendationSummary(row) {
  return {
    name: row.name,
    profile: row.profile,
    maxLongEdge: row.maxLongEdge,
    jpegQuality: row.jpegQuality,
    score: row.score,
    avgMs: row.avgMs,
    savedPercent: row.savedPercent,
    gpt5HighDetailSavedPercent: row.gpt5HighDetailSavedPercent,
    patchBudget10000SavedPercent: row.patchBudget10000SavedPercent,
    p10Retention: row.quality?.p10Retention ?? null,
    medianRetention: row.quality?.medianRetention ?? null,
  };
}

function printHuman(result) {
  console.log("Rival optimization eval");
  console.log(`Screenshots: ${result.latest} from ${result.screenshotDir}`);
  if (result.quality.engine === "none") {
    console.log("Quality gate: skipped; ranking is cost/speed/bytes only");
  } else {
    const modelInfo = result.quality.model ? ` (${result.quality.model})` : "";
    console.log(`Quality gate: ${result.quality.engine}${modelInfo}, ${result.quality.latest} retina screenshots, p10 >= ${percent(result.quality.minRetention)}`);
  }
  console.log("");
  console.log([
    "candidate".padEnd(23),
    "edge".padStart(5),
    "q".padStart(3),
    "avg".padStart(7),
    "MB".padStart(7),
    "bytes".padStart(7),
    "gpt5".padStart(7),
    "patch".padStart(7),
    "p10 text".padStart(9),
    "pass".padStart(5),
    "score".padStart(7),
  ].join("  "));
  for (const row of result.candidates) {
    console.log([
      row.name.padEnd(23),
      String(row.maxLongEdge).padStart(5),
      String(row.jpegQuality).padStart(3),
      ms(row.avgMs).padStart(7),
      fixed(row.optimizedMB, 2).padStart(7),
      percent(row.savedPercent / 100).padStart(7),
      percent(row.gpt5HighDetailSavedPercent / 100).padStart(7),
      percent(row.patchBudget10000SavedPercent / 100).padStart(7),
      percent(row.quality?.p10Retention).padStart(9),
      passLabel(row).padStart(5),
      fixed(row.score, 2).padStart(7),
    ].join("  "));
  }
  console.log("");
  if (result.recommendation) {
    const rec = result.recommendation;
    console.log([
      `Recommendation: ${rec.name}`,
      `edge ${rec.maxLongEdge}px`,
      `q${rec.jpegQuality}`,
      `bytes saved ${percent(rec.savedPercent / 100)}`,
      `gpt5 saved ${percent(rec.gpt5HighDetailSavedPercent / 100)}`,
      `patch saved ${percent(rec.patchBudget10000SavedPercent / 100)}`,
      rec.p10Retention === null ? "quality not gated" : `p10 text ${percent(rec.p10Retention)}`,
    ].join(", "));
  } else {
    console.log("Recommendation: no candidate passed the quality gate.");
  }
}

function parseCandidates(value) {
  if (!value) return DEFAULT_CANDIDATES;
  return String(value).split(",").map((item) => {
    const [name, edge, quality, profile = "token"] = item.split(":");
    if (!name || !edge || !quality) {
      throw new Error("Each --candidates item must be name:maxLongEdge:jpegQuality[:profile]");
    }
    return {
      name,
      profile,
      maxLongEdge: parsePositiveInteger(edge),
      jpegQuality: parsePositiveInteger(quality),
    };
  });
}

function candidateKey(candidate) {
  return `${candidate.name}:${candidate.maxLongEdge}:${candidate.jpegQuality}`;
}

function runJson(command, commandArgs, { allowNonZero = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowNonZero) {
    throw new Error(`${[command, ...commandArgs].join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  const parsed = parseJsonish(result.stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${[command, ...commandArgs].join(" ")} did not return JSON\n${result.stderr || result.stdout}`);
  }
  if (result.status !== 0 && !parsed.summaries) {
    throw new Error(`${[command, ...commandArgs].join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return parsed;
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

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json" || token === "--keep" || token === "--help" || token === "--allow-external") {
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

function normalizeQualityEngine(value) {
  if (value === "apple-vision") return "vision";
  if (["none", "ocr", "vision", "codex"].includes(value)) return value;
  throw new Error("--quality-engine must be none, ocr, vision, apple-vision, or codex");
}

function defaultQualityEngine() {
  return process.platform === "darwin" && commandExists("xcrun") ? "vision" : "none";
}

function commandExists(command) {
  return spawnSync("/usr/bin/which", [command], { stdio: "ignore" }).status === 0;
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

function parsePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) throw new Error(`Expected positive integer, got ${value}`);
  return Math.floor(numeric);
}

function parseFraction(value, fallback) {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) throw new Error(`Expected fraction between 0 and 1, got ${value}`);
  return numeric;
}

function bytesToMb(bytes) {
  return round((bytes ?? 0) / 1024 / 1024, 3);
}

function passLabel(row) {
  if (qualityEngine === "none") return "n/a";
  return row.eligible ? "yes" : "no";
}

function ms(value) {
  if (value === null || value === undefined) return "n/a";
  return `${round(value, 1)}ms`;
}

function percent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return `${round(value * 100, 1)}%`;
}

function fixed(value, decimals) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return Number(value).toFixed(decimals);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function printUsage() {
  console.log(`Usage:
  npm run eval:rivals -- [options]

Options:
  --latest <n>
      Number of recent screenshots to benchmark. Default: 20.
  --quality-engine none|ocr|vision|apple-vision|codex
      Text retention gate. Default: vision on macOS when xcrun is available, otherwise none.
  --quality-latest <n>
      Number of retina screenshots for text retention. Default: min(latest, 10).
  --min-source-long-edge <px>
      Only quality-test source screenshots whose long edge is at least this size. Default: 3000.
  --min-retention <0..1>
      Required p10 text retention. Default: 0.9.
  --candidates name:edge:quality[:profile],...
      Override built-in rival candidates.
  --model <model> --allow-external
      Required with --quality-engine codex.
  --json
      Print JSON instead of a human table.
`);
}
