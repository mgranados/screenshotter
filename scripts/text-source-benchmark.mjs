#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VISION_OCR_SOURCE = join(ROOT_DIR, "scripts", "apple-vision-ocr.swift");
const FIXTURE_RENDERER_SOURCE = join(ROOT_DIR, "scripts", "text-fixture-renderer.swift");
const DEFAULT_MIN_OCR_F1 = 0.85;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const workDir = args["work-dir"] ? resolve(expandHome(args["work-dir"])) : mkdtempSync(join(tmpdir(), "screenshotter-text-source-"));
const keep = Boolean(args.keep);
const runVision = !args["skip-vision"];
const minOcrF1 = parseThreshold(args["min-ocr-f1"] ?? DEFAULT_MIN_OCR_F1, "min-ocr-f1");
const visionLevel = args["vision-level"] ?? "accurate";
const visionLanguages = normalizeLanguages(args["vision-languages"] ?? "en-US");
const selectedFixtureNames = args.fixtures
  ? new Set(String(args.fixtures).split(",").map((name) => name.trim()).filter(Boolean))
  : null;
const allFixtures = defaultFixtures();
const fixtures = selectedFixtureNames
  ? allFixtures.filter((fixture) => selectedFixtureNames.has(fixture.name))
  : allFixtures;

if (fixtures.length === 0) {
  console.error("No fixtures selected.");
  process.exit(1);
}

if (!["accurate", "fast"].includes(visionLevel)) {
  console.error("--vision-level must be accurate or fast");
  process.exit(1);
}

let visionBinary;
let fixtureRenderer;
const notes = [];

try {
  mkdirSync(workDir, { recursive: true });
  fixtureRenderer = compileSwiftHelper(FIXTURE_RENDERER_SOURCE, join(workDir, "text-fixture-renderer"), workDir);

  if (runVision) {
    if (args["vision-binary"]) {
      visionBinary = resolve(expandHome(args["vision-binary"]));
      if (!existsSync(visionBinary)) throw new Error(`Vision binary not found: ${visionBinary}`);
    } else if (process.platform !== "darwin") {
      notes.push("Apple Vision OCR skipped: benchmark is not running on macOS.");
    } else if (!commandExists("xcrun")) {
      notes.push("Apple Vision OCR skipped: xcrun/swiftc is unavailable.");
    } else {
      visionBinary = compileVisionOcrHelper(workDir);
    }
  } else {
    notes.push("Apple Vision OCR skipped with --skip-vision.");
  }

  const rows = [];
  for (const fixture of fixtures) {
    const groundTruth = fixtureText(fixture);
    const html = renderFixtureHtml(fixture);
    const htmlPath = join(workDir, `${fixture.name}.html`);
    const fixturePath = join(workDir, `${fixture.name}.json`);
    const imagePath = join(workDir, `${fixture.name}.png`);
    writeFileSync(htmlPath, html);
    writeFileSync(fixturePath, JSON.stringify(renderFixturePayload(fixture)));
    renderFixtureImage(fixtureRenderer, fixturePath, imagePath);

    const sourceStart = performance.now();
    const sourceText = extractVisibleTextFromHtml(html);
    const sourceDurationMs = round(performance.now() - sourceStart, 1);

    const sourceMetrics = compareText(groundTruth, sourceText);
    const row = {
      fixture: fixture.name,
      description: fixture.description,
      groundTruthTokens: countTokens(tokenCounts(groundTruth)),
      htmlPath: args.rows ? htmlPath : undefined,
      screenshotPath: args.rows ? imagePath : undefined,
      screenshotBytes: statSync(imagePath).size,
      methods: {
        fixtureSource: {
          kind: "synthetic-source-baseline",
          durationMs: sourceDurationMs,
          textLength: sourceText.length,
          ...sourceMetrics,
        },
      },
    };

    if (visionBinary) {
      const ocrStart = performance.now();
      const ocr = recognizeTextWithVision(visionBinary, imagePath, {
        level: visionLevel,
        languages: visionLanguages,
      });
      const ocrDurationMs = round(performance.now() - ocrStart, 1);
      row.methods.visionScreenshotOcr = {
        kind: "pixel-ocr",
        durationMs: ocrDurationMs,
        textLength: ocr.text.length,
        status: ocr.status,
        error: ocr.error ?? null,
        ...compareText(groundTruth, ocr.text),
      };
    }

    rows.push(row);
  }

  const summaries = summarizeRows(rows);
  if (visionBinary && summaries.visionScreenshotOcr?.evaluated === 0) {
    notes.push("Apple Vision OCR produced no successful rows. If this is running inside a restricted sandbox, rerun from a normal terminal or grant the required runtime permissions.");
  }

  const result = {
    benchmark: "synthetic-source-baseline-vs-screenshot-ocr",
    note: "The source baseline only validates fixture/scoring integrity; it is not a browser DOM or Accessibility provider quality result. Apple Vision OCR is measured from native-rendered fixture PNGs.",
    workDir,
    keptArtifacts: keep || Boolean(args["work-dir"]),
    fixtureCount: rows.length,
    vision: visionBinary ? {
      level: visionLevel,
      languages: visionLanguages,
    } : null,
    thresholds: {
      minOcrF1,
    },
    summaries,
    rows: args.rows ? rows : undefined,
    notes,
    recommendation: recommendation(rows, { runVision }),
  };

  const ocrSummary = result.summaries.visionScreenshotOcr;
  const ocrPass = !runVision || Boolean(
    visionBinary
    && ocrSummary?.evaluated === rows.length
    && (ocrSummary.minF1 ?? 0) >= minOcrF1
  );

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanResult(result);
  }

  if (!ocrPass) process.exitCode = 1;
} finally {
  if (!keep && !args["work-dir"]) rmSync(workDir, { recursive: true, force: true });
}

function recommendation(rows, { runVision }) {
  const sourceBaseline = summarizeMethod(rows, "fixtureSource");
  const ocr = summarizeMethod(rows, "visionScreenshotOcr");
  if (!runVision) {
    return "Synthetic fixture and scoring validation passed; no live text provider was evaluated.";
  }
  if (!ocr || ocr.evaluated === 0) {
    return "OCR was requested but did not produce a complete evaluation. Fix Vision execution or rerun with --skip-vision; do not treat the synthetic source baseline as provider validation.";
  }

  const sourceF1 = sourceBaseline.avgF1 ?? 0;
  const ocrF1 = ocr.avgF1 ?? 0;
  if (sourceF1 >= ocrF1) {
    return "The OCR fallback cleared the configured fixture gate. Validate live browser and Accessibility providers separately before changing provider priority.";
  }
  return "OCR scored above the fixture source baseline; inspect scoring and fixture rendering before relying on this result.";
}

function summarizeRows(rows) {
  return {
    fixtureSource: summarizeMethod(rows, "fixtureSource"),
    visionScreenshotOcr: summarizeMethod(rows, "visionScreenshotOcr"),
  };
}

function summarizeMethod(rows, method) {
  const values = rows
    .map((row) => row.methods[method])
    .filter((entry) => entry && entry.status !== "failed");
  if (values.length === 0) return { evaluated: 0 };

  return {
    evaluated: values.length,
    avgMs: round(avg(values.map((value) => value.durationMs)), 1),
    minF1: round(Math.min(...values.map((value) => value.f1)), 4),
    avgF1: round(avg(values.map((value) => value.f1)), 4),
    minRecall: round(Math.min(...values.map((value) => value.tokenRecall)), 4),
    avgRecall: round(avg(values.map((value) => value.tokenRecall)), 4),
    minCharSimilarity: round(Math.min(...values.map((value) => value.charSimilarity)), 4),
    avgCharSimilarity: round(avg(values.map((value) => value.charSimilarity)), 4),
  };
}

function avg(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function compareText(expected, actual) {
  const expectedTokens = tokenCounts(expected);
  const actualTokens = tokenCounts(actual);
  const expectedCount = countTokens(expectedTokens);
  const actualCount = countTokens(actualTokens);
  const overlap = tokenOverlap(expectedTokens, actualTokens);
  const tokenRecall = expectedCount > 0 ? overlap / expectedCount : 1;
  const tokenPrecision = actualCount > 0 ? overlap / actualCount : expectedCount === 0 ? 1 : 0;
  const f1 = tokenPrecision + tokenRecall > 0
    ? (2 * tokenPrecision * tokenRecall) / (tokenPrecision + tokenRecall)
    : 0;

  return {
    tokenRecall: round(tokenRecall, 4),
    tokenPrecision: round(tokenPrecision, 4),
    f1: round(f1, 4),
    charSimilarity: round(charSimilarity(expected, actual), 4),
    tokenCount: actualCount,
  };
}

function tokenCounts(text) {
  const counts = new Map();
  for (const token of normalizeTokens(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function normalizeTokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .split(/[^a-z0-9_.$@/-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 || /^\d$/.test(token));
}

function countTokens(counts) {
  let total = 0;
  for (const value of counts.values()) total += value;
  return total;
}

function tokenOverlap(left, right) {
  let total = 0;
  for (const [token, count] of left.entries()) {
    total += Math.min(count, right.get(token) ?? 0);
  }
  return total;
}

function charSimilarity(expected, actual) {
  const left = normalizeForDistance(expected);
  const right = normalizeForDistance(actual);
  if (!left && !right) return 1;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length, 1);
}

function normalizeForDistance(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(left, right) {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = new Array(right.length + 1);
  let current = new Array(right.length + 1);
  for (let index = 0; index <= right.length; index += 1) previous[index] = index;

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[right.length];
}

function recognizeTextWithVision(binary, imagePath, options) {
  const result = spawnSync(binary, [
    imagePath,
    "--level", options.level,
    "--languages", options.languages.join(","),
  ], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0) {
    return {
      status: "failed",
      text: "",
      error: (result.stderr || result.stdout || `Vision OCR exited with ${result.status}`).trim(),
    };
  }

  return {
    status: "ok",
    text: result.stdout.trim(),
  };
}

function compileVisionOcrHelper(outputDir) {
  return compileSwiftHelper(VISION_OCR_SOURCE, join(outputDir, "apple-vision-ocr"), outputDir);
}

function compileSwiftHelper(sourcePath, outputPath, outputDir) {
  if (!existsSync(sourcePath)) throw new Error(`Missing Swift helper: ${sourcePath}`);
  const moduleCachePath = join(outputDir, "swift-module-cache");
  mkdirSync(moduleCachePath, { recursive: true });
  const result = spawnSync("xcrun", [
    "swiftc",
    "-module-cache-path", moduleCachePath,
    sourcePath,
    "-o", outputPath,
  ], {
    encoding: "utf8",
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCachePath },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `swiftc exited with ${result.status}`);
  }
  return outputPath;
}

function renderFixtureImage(binary, fixturePath, imagePath) {
  const result = spawnSync(binary, [fixturePath, imagePath], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 || !existsSync(imagePath)) {
    throw new Error(result.stderr || result.stdout || `fixture renderer exited with ${result.status}`);
  }
}

function renderFixtureHtml(fixture) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(fixture.description)}</title>`,
    '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px;color:#17202a;background:#f7f8fb}.panel{background:white;border:1px solid #d9dee8;border-radius:8px;margin:0 0 20px;padding:20px}.section{margin:0 0 16px}.tiny{font-size:12px}.mono{font-family:"SFMono-Regular",Menlo,Consolas,monospace}</style>',
    "</head>",
    "<body>",
    ...fixture.blocks.map((block) => [
      `<section class="panel ${block.mono ? "mono" : ""}">`,
      ...block.lines.map((line) => `<div class="section${block.tiny ? " tiny" : ""}">${escapeHtml(line)}</div>`),
      "</section>",
    ].join("\n")),
    "</body>",
    "</html>",
  ].join("\n");
}

function renderFixturePayload(fixture) {
  return {
    width: fixture.width,
    height: fixture.height,
    blocks: fixture.blocks.map((block) => ({
      x: block.x,
      y: block.y,
      width: block.width,
      height: block.height,
      fontSize: block.fontSize,
      lineHeight: block.lineHeight ?? null,
      mono: Boolean(block.mono),
      lines: block.lines,
    })),
  };
}

function fixtureText(fixture) {
  return fixture.blocks
    .flatMap((block) => block.lines)
    .join("\n");
}

function extractVisibleTextFromHtml(html) {
  const source = String(html);
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(source);
  const body = bodyMatch ? bodyMatch[1] : source;
  return decodeHtmlEntities(body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(div|p|section|article|header|footer|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim());
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function printHumanResult(result) {
  console.log("Text source benchmark");
  console.log(`fixtures: ${result.fixtureCount}`);
  if (result.vision) console.log(`vision: ${result.vision.level} / ${result.vision.languages.join(",")}`);
  for (const [method, summary] of Object.entries(result.summaries)) {
    if (!summary || summary.evaluated === 0) {
      console.log(`${method}: skipped`);
      continue;
    }
    console.log(`${method}: f1 avg ${formatPercent(summary.avgF1)} min ${formatPercent(summary.minF1)} · recall avg ${formatPercent(summary.avgRecall)} min ${formatPercent(summary.minRecall)} · avg ${summary.avgMs}ms`);
  }
  for (const note of result.notes) console.log(`note: ${note}`);
  console.log(`recommendation: ${result.recommendation}`);
}

function printUsage() {
  console.log(`Usage:
  node scripts/text-source-benchmark.mjs [--json] [--rows] [--keep]

Options:
  --fixtures names             Comma-separated fixture names.
  --skip-vision                Run only the synthetic fixture/scoring baseline.
  --vision-level accurate|fast Apple Vision OCR recognition level.
  --vision-languages en-US     Apple Vision OCR languages.
  --vision-binary path         Use an alternate OCR executable for provider-failure testing.
  --min-ocr-f1 n               OCR quality gate when Vision runs. Default ${DEFAULT_MIN_OCR_F1}.
  --work-dir path              Write fixture HTML/PNG artifacts here.
  --keep                       Keep generated artifacts.
`);
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") parsed.help = true;
    else if (token === "--json") parsed.json = true;
    else if (token === "--rows") parsed.rows = true;
    else if (token === "--keep") parsed.keep = true;
    else if (token === "--skip-vision") parsed["skip-vision"] = true;
    else if (token.startsWith("--")) {
      const [key, inlineValue] = token.slice(2).split("=", 2);
      parsed[key] = inlineValue ?? argv[++index];
    } else {
      parsed._.push(token);
    }
  }
  return parsed;
}

function parseThreshold(value, name) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    throw new Error(`--${name} must be between 0 and 1`);
  }
  return numeric;
}

function normalizeLanguages(value) {
  const languages = String(value)
    .split(",")
    .map((language) => language.trim())
    .filter(Boolean);
  return languages.length ? languages : ["en-US"];
}

function commandExists(command) {
  return spawnSync("/usr/bin/which", [command], { stdio: "ignore" }).status === 0;
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return process.env.HOME;
  if (value.startsWith("~/")) return join(process.env.HOME, value.slice(2));
  return value;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatPercent(value) {
  if (value === undefined || value === null) return "n/a";
  return `${round(value * 100, 1)}%`;
}

function defaultFixtures() {
  return [
    {
      name: "settings-panel",
      description: "Settings panel with labels, values, and controls",
      width: 1440,
      height: 900,
      blocks: [
        {
          x: 64,
          y: 84,
          width: 560,
          height: 220,
          fontSize: 24,
          lineHeight: 42,
          weight: 700,
          lines: [
            "Workspace Settings",
            "Project: Screenshotter",
            "Default profile: readability",
            "Clipboard mode: text and image",
          ],
        },
        {
          x: 680,
          y: 84,
          width: 640,
          height: 300,
          fontSize: 16,
          lineHeight: 28,
          lines: [
            "OCR provider: Apple Vision",
            "Recognition level: accurate",
            "Languages: en-US",
            "Max text snippet: 4000 characters",
            "Status: ready for Codex prompt paste",
            "Action: Copy text snippet and compressed snap",
          ],
        },
        {
          x: 64,
          y: 392,
          width: 1256,
          height: 148,
          fontSize: 13,
          lineHeight: 23,
          tiny: true,
          color: "#3d4a5c",
          lines: [
            "Fine print: direct text extraction should win when the browser DOM or native accessibility tree exposes readable labels.",
            "Fallback: screenshot OCR still handles canvas, image-only UIs, remote desktops, and apps with inaccessible text.",
            "Quality gate: compare token recall, precision, F1 score, character similarity, and extraction latency.",
          ],
        },
      ],
    },
    {
      name: "operations-table",
      description: "Operational table with dense rows and mixed punctuation",
      width: 1600,
      height: 1000,
      blocks: [
        {
          x: 72,
          y: 78,
          width: 1370,
          height: 80,
          fontSize: 26,
          lineHeight: 42,
          weight: 700,
          lines: [
            "Release Readiness",
            "Run ID: text-source-2026-07-07",
          ],
        },
        {
          x: 72,
          y: 210,
          width: 1370,
          height: 370,
          fontSize: 16,
          lineHeight: 31,
          mono: true,
          lines: [
            "CHECK                     OWNER        RESULT     NOTES",
            "npm run check             build        passed     syntax and smoke tests",
            "Apple Vision OCR          native       passed     local-only text extraction",
            "DOM text adapter          browser      passed     exact visible text from source",
            "AX text adapter           macOS        pending    requires Accessibility permission",
            "Clipboard paste payload   desktop      passed     plain text plus optimized image",
            "Regression threshold      quality      0.9900     minimum direct-source F1 score",
            "Fallback threshold        quality      0.8500     minimum OCR F1 score",
          ],
        },
        {
          x: 72,
          y: 646,
          width: 1370,
          height: 100,
          fontSize: 14,
          lineHeight: 25,
          lines: [
            "Interpretation: DOM and accessibility extraction can preserve exact text, order, punctuation, and hidden metadata when adapters are scoped correctly.",
            "Screenshot OCR is broader but lossy: it depends on font size, contrast, scaling, language detection, and visual layout.",
          ],
        },
      ],
    },
    {
      name: "code-review",
      description: "Code review style content with monospace text",
      width: 1500,
      height: 960,
      blocks: [
        {
          x: 64,
          y: 80,
          width: 1320,
          height: 96,
          fontSize: 24,
          lineHeight: 40,
          weight: 700,
          lines: [
            "Review Comment",
            "File: bin/screenshotter.mjs",
          ],
        },
        {
          x: 64,
          y: 226,
          width: 1320,
          height: 320,
          fontSize: 17,
          lineHeight: 30,
          mono: true,
          lines: [
            "async function copyScreenToClipboard(screen, args = {}) {",
            "  const mode = clipboardMode(args);",
            "  const text = mode === \"image\" ? \"\" : formatClipboardText(screen, args);",
            "  if (mode === \"both\" && text) return copyTextAndImageToClipboard(screen.optimizedPath, text);",
            "  return copyImageToClipboard(screen.optimizedPath);",
            "}",
          ],
        },
        {
          x: 64,
          y: 610,
          width: 1320,
          height: 150,
          fontSize: 15,
          lineHeight: 27,
          lines: [
            "Finding: direct source text avoids OCR mistakes in punctuation-heavy code blocks.",
            "Risk: DOM adapters only work where the underlying app exposes text nodes or an accessibility tree.",
            "Mitigation: attach both exact text and the compressed screenshot so the model can cross-check context.",
          ],
        },
      ],
    },
  ];
}
