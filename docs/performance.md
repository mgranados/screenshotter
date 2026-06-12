# Performance

The default policy is the readability profile:

- `readability`: Low/default, JPEG quality 90/88/85, max long edge 4096 px, 1 MB byte target.
- `balanced`: Mid, JPEG quality 85, max long edge 3000 px.
- `token`: High, JPEG quality 50 when resizing, JPEG quality 75 when no resize is needed, max long edge 2200 px.

All profiles use Sharp/libvips by default, with native macOS ImageIO and `sips` fallbacks. The default JPEG path uses 4:4:4 chroma for UI text, Sharp quantisation table 3, strips metadata, keeps the original file when JPEG would be larger, and avoids WebP, AVIF, OCR, or slow MozJPEG during normal preparation.

The readability profile tries q90 first, then q88/q85 only when needed to stay under the byte target. This keeps quality high for most screenshots while avoiding oversized full-desktop attachments.

## Local Benchmark

Command:

```sh
screenshotter bench --latest 20 --json
screenshotter bench --latest 20 --profile balanced --json
screenshotter bench --latest 20 --profile balanced --optimizer sips --json
screenshotter bench --latest 20 --tokens --json
```

Quality command:

```sh
npm run quality -- --image "/path/to/screenshot.png" --min-ssim 0.99
```

Representative local run against the latest macOS screenshot with the default `readability` profile:

| Metric | Result |
| --- | ---: |
| Source | 3456x2234 PNG |
| Optimized | 3456x2234 JPEG |
| Prepare time | 79.6 ms |
| Original size | 2.07 MB |
| Optimized size | 958 KB |
| Size reduction | 55.9% |
| `gpt5HighDetailTiles` savings | 0.0% |
| `patchBudget10000` savings | 0.0% |

Control runs on the latest 5-screenshot sample:

| Path | Avg prepare | Median prepare | Optimized total | Size reduction | `patchBudget10000` savings |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sharp/libvips, readability full size, q90/q88 byte ladder | 125.1 ms | 86.4 ms | 4.48 MB | 71.5% | 0.0% |
| native ImageIO, readability full size, q88 | 88.1 ms | 83.6 ms | 5.77 MB | 63.3% | 0.0% |
| native ImageIO, readability full size, q90 | 91.3 ms | 71.1 ms | 5.83 MB | 62.9% | 0.0% |

The default now prioritizes reading tiny UI text and keeping files near 1 MB over image-token savings. Use `--profile token` when dimension savings matter more than full-resolution fidelity, and use `--optimizer native` or `--optimizer sips` for comparison.

Menu labels use rounded latest-20 Sharp/libvips savings estimates:

| Menu label | CLI profile | Setting | Estimate |
| --- | --- | --- | ---: |
| Low Compression (avg ~30%) | `readability` | 4096 px, q90/q88/q85 with 1 MB target | ~30% |
| Mid Compression (avg ~45%) | `balanced` | 3000 px, q85 | ~45% |
| High Compression (avg ~80%) | `token` | 2200 px, q50 when resizing, q75 otherwise | ~80% |

The menu bar status item uses the camera icon plus a compact three-bar compression stack: one filled bar for Low, two for Mid, and three for High. The compression history shows actual per-screenshot savings.

## Token Estimates

`bench --tokens` and `status --tokens` report dimension-based estimates for common image billing modes:

- `openaiLowDetail`: fixed low-detail image cost, so byte compression does not change it.
- `gpt5HighDetailTiles` and `gpt4oHighDetailTiles`: high-detail 512 px tile estimates after standard image scaling.
- `patchBudget1536`, `patchBudget2500`, and `patchBudget10000`: 32 px patch-count estimates under common patch budgets.

The estimates intentionally do not treat JPEG byte savings as token savings. Token savings appear when a profile changes image dimensions.

The token profile is available when you want scripts to document that compression and dimension savings are more important than full-resolution fidelity:

```sh
screenshotter prepare "/path/to/screenshot.png" --profile token --json
screenshotter bench --latest 100 --profile token --tokens --json
```

Current latest-20 `token` profile comparison:

| Metric | Result |
| --- | ---: |
| Median prepare time | 40.6 ms |
| Original total | 7.23 MB |
| Optimized total | 1.80 MB |
| Size reduction | 75.4% |
| `gpt5HighDetailTiles` savings | 0.0% |
| `patchBudget10000` savings | 42.6% |

On the latest full-desktop screenshot, the old token default produced `3456x2234 -> 1400x905` and `2.07 MB -> 309 KB`. That was good compression but did not preserve tiny menu/status text. The new readability default keeps `3456x2234` and produced `2.07 MB -> 1.17 MB`, which is the right tradeoff when every label matters.

## Rival Eval

Use the rival eval when changing defaults or tuning the token profile. It benchmarks competing edge/quality settings, runs an optional text-retention gate, then ranks only the candidates that pass.

```sh
npm run eval:rivals -- --latest 20 --quality-engine vision
```

The built-in rivals compare smaller fixed `token` sizes, fixed-edge debug sizes, and the `readability` profile. The ranking favors API image-token savings first, then byte savings and speed, while excluding candidates that miss the configured p10 text-retention gate.

Useful variants:

```sh
npm run eval:rivals -- --quality-engine none --json
npm run eval:rivals -- --quality-engine vision --quality-latest 20 --min-retention 0.9
npm run eval:rivals -- --candidates cheap:1024:45:token,fixed:1400:85:token,debug:2200:50:balanced
```

## Text Downscale Eval

Retina screenshots are the best place to save tokens without removing screen area. The text-scale eval tests full-image downscales across multiple screenshots and compares recognized text against the original. It does not crop or mask any part of the screenshot.

Recommended local gate using batched Apple Vision OCR:

```sh
npm run eval:text-scale -- \
  --engine vision \
  --latest 20 \
  --min-source-long-edge 3000 \
  --edges 3000,2600,2400,2200,2000,1800,1600
```

Tesseract remains available as a conservative local baseline:

```sh
npm run eval:text-scale -- \
  --engine ocr \
  --latest 20 \
  --min-source-long-edge 3000 \
  --edges 3000,2600,2400
```

Model-backed check for release-critical thresholds:

```sh
npm run eval:text-scale -- \
  --engine codex \
  --model <cheap-vision-model> \
  --allow-external \
  --latest 10 \
  --min-source-long-edge 3000 \
  --edges 2400,2200,2000,1800
```

The Codex engine intentionally requires `--allow-external` because it sends original and resized screenshots to the configured model service. Use the cheapest vision-capable Codex model available in your local setup, since that is closer to the model that will actually read the screenshot during agent work.

The eval reports p10, median, average, and pass rate for original-text retention. A candidate passes only when p10 retention is at least 90%, so one easy screenshot cannot hide a bad small-text case.

Current local retina-only Apple Vision run:

| Max long edge | p10 text retention | Median retention | Byte savings | 32px patch savings | Result |
| ---: | ---: | ---: | ---: | ---: | --- |
| 2200 px | 91.4% | 94.9% | 82.6% | 64.1% | Passes |
| 2000 px | 89.8% | 95.6% | 85.2% | 70.1% | Fails p10 |
| 1800 px | 88.2% | 94.7% | 87.2% | 75.6% | Fails p10 |
| 1600 px | 89.8% | 94.2% | 89.6% | 80.9% | Fails p10 |
| 1500 px | 87.1% | 93.8% | 90.1% | 83.1% | Fails p10 |
| 1400 px | 87.0% | 93.0% | 91.4% | 85.3% | Fails p10 |

Practical high-compression profile: `token` uses 2200 px because it is the current smallest candidate from Apple Vision that cleared the p10 text-retention gate in this sweep. A 10-screenshot sweep made 1600 px look viable, but the larger 20-screenshot run dropped below the 90% p10 gate. Keep 2200 px available for text-heavy debugging until a cheap model-backed Codex eval passes the same screenshot corpus at a smaller size.

## Pokémon Sheet Stress Test

A 1124x858 screenshot containing 184 numbered Pokémon entries is a useful small-text stress case.

On that image:

| JPEG quality | Output | SSIM vs original | PSNR |
| --- | ---: | ---: | ---: |
| 50 | 234 KB | 0.972621 | 35.66 dB |
| 70 | 348 KB | 0.987342 | 41.73 dB |
| 75 | 373 KB | 0.989188 | 42.93 dB |
| 78 | 386 KB | 0.990305 | 43.67 dB |
| 82 | 399 KB | 0.991408 | 44.50 dB |

Quality 50 is the `balanced` profile setting because it is the smallest tested setting so far that passed the external model readability gate on this sheet:

```json
{
  "original": { "detected_count": 184, "missing_numbers": [], "uncertain_numbers": [] },
  "compressed": { "detected_count": 184, "missing_numbers": [], "uncertain_numbers": [] },
  "deltaDetected": 0
}
```

That reduces the image from 1.52 MB to about 234 KB. It does not meet the stricter local 0.99 SSIM gate, so the release policy is: model-readability fixture wins for screenshots with tiny labels, while SSIM remains the local no-upload sanity check.

The local OCR engines available during testing could not reliably read all 184 names from the original 1124×858 PNG, so OCR is not used as the release gate yet. SSIM plus visual inspection is the current gate for this fixture; a future fixture can add model-based or coordinate-aware detection.

An optional model-based check is available:

```sh
npm run quality:model -- \
  --image "/path/to/original.png" \
  --compressed "/path/to/optimized.jpg" \
  --model <vision-model> \
  --allow-external
```

This intentionally requires `--allow-external` because it sends screenshots to the configured Codex/OpenAI model service.
