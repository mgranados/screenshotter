#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin", "screenshotter.mjs");
const args = parseArgs(process.argv.slice(2));
const image = args.image || args._[0];
if (!image) {
  console.error("Usage: npm run quality -- --image /path/to/screenshot.png [--min-ssim 0.99]");
  process.exit(1);
}

const minSsim = Number(args["min-ssim"] ?? 0.99);
const dataDir = args["data-dir"] || mkdtempSync(join(tmpdir(), "screenshotter-quality-"));
let shouldCleanup = !args["data-dir"];

try {
  const prepared = runJson(process.execPath, [cli, "prepare", resolve(image), "--target", "quality", "--data-dir", dataDir, "--json"]);
  const screen = prepared.screen;
  const ffmpeg = spawnSync("ffmpeg", [
    "-hide_banner",
    "-i", screen.optimizedPath,
    "-i", resolve(image),
    "-lavfi", "[0:v][1:v]ssim;[0:v][1:v]psnr",
    "-f", "null",
    "-",
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });

  if (ffmpeg.status !== 0) {
    throw new Error(ffmpeg.stderr || ffmpeg.stdout || "ffmpeg quality check failed");
  }

  const output = `${ffmpeg.stdout}\n${ffmpeg.stderr}`;
  const ssim = Number(/All:([0-9.]+)/.exec(output)?.[1]);
  const psnr = Number(/average:([0-9.]+)/.exec(output)?.[1]);
  const originalBytes = statSync(resolve(image)).size;
  const optimizedBytes = statSync(screen.optimizedPath).size;
  const result = {
    image: resolve(image),
    optimizedPath: screen.optimizedPath,
    originalBytes,
    optimizedBytes,
    savedPercent: round((1 - optimizedBytes / originalBytes) * 100, 1),
    ssim,
    psnr,
    passed: Number.isFinite(ssim) && ssim >= minSsim,
    minSsim,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  if (shouldCleanup) rmSync(dataDir, { recursive: true, force: true });
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const [key, inlineValue] = token.slice(2).split("=", 2);
      parsed[key] = inlineValue ?? argv[++index];
    } else {
      parsed._.push(token);
    }
  }
  return parsed;
}

function runJson(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout || "{}");
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
