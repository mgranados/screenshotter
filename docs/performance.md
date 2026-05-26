# Performance

The default policy is the balanced-fast profile:

- `balanced`: JPEG quality 50, max long edge 2200 px, direct-copy sendable screenshots at or below 256 KB.
- `token`: JPEG quality 45, max long edge 1024 px.
- `readability`: JPEG quality 78, max long edge 4096 px, direct-copy sendable screenshots at or below 512 KB.

All profiles use `sips` only in the hot path, parse PNG/JPEG/GIF/WebP metadata locally before falling back to `sips`, keep the original file when JPEG would be larger, and avoid WebP, MozJPEG, OCR, or multi-candidate search during normal preparation.

This is the deliberate compromise: lower compression ratio than exhaustive candidate search, but much faster and predictable enough for live agent workflows. Small screenshots can skip conversion because saving tens of KB is usually not worth a `sips` process launch, and preserving the original is also higher quality.

## Local Benchmark

Command:

```sh
agent-screens bench --latest 20 --json
agent-screens bench --latest 20 --profile token --tokens --json
```

Quality command:

```sh
npm run quality -- --image "/path/to/screenshot.png" --min-ssim 0.99
```

Representative local run against a folder of recent macOS screenshots:

| Metric | Result |
| --- | ---: |
| Sample | 20 recent PNG screenshots |
| Average prepare time | 75.9 ms |
| Median prepare time | 107.0 ms |
| Min / max prepare time | 1.7 ms / 161.3 ms |
| Original total | 10.03 MB |
| Optimized total | 2.62 MB |
| Size reduction | 73.9% |
| `patchBudget10000` savings | 45.6% |

Control run on the same 20-screenshot sample with the previous 3000 px balanced edge:

| Max long edge | Avg prepare | Median prepare | Optimized total | Size reduction | `patchBudget10000` savings |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 3000 px | 70.2 ms | 100.2 ms | 3.31 MB | 67.0% | 23.0% |
| 2200 px | 75.9 ms | 107.0 ms | 2.62 MB | 73.9% | 45.6% |

Before local metadata parsing and the small-file direct-copy threshold, a previous 20-screenshot sample averaged 186.1 ms with a 172.7 ms median. The current path is still much faster than that old baseline while using the smaller Apple Vision-backed 2200 px default.

## Token Estimates

`bench --tokens` and `status --tokens` report dimension-based estimates for common image billing modes:

- `openaiLowDetail`: fixed low-detail image cost, so byte compression does not change it.
- `gpt5HighDetailTiles` and `gpt4oHighDetailTiles`: high-detail 512 px tile estimates after standard image scaling.
- `patchBudget1536`, `patchBudget2500`, and `patchBudget10000`: 32 px patch-count estimates under common patch budgets.

The estimates intentionally do not treat JPEG byte savings as token savings. Token savings appear when a profile changes image dimensions.

Use the token profile when cost is more important than full-resolution readability:

```sh
agent-screens prepare "/path/to/screenshot.png" --profile token --json
agent-screens bench --latest 100 --profile token --tokens --json
```

Current 20-screenshot `token` profile run:

| Metric | Result |
| --- | ---: |
| Average prepare time | 96.4 ms |
| Median prepare time | 110.3 ms |
| Optimized total | 1.16 MB |
| Size reduction | 88.5% |
| `gpt5HighDetailTiles` savings | 27.8% |
| `patchBudget10000` savings | 82.7% |

## Text Downscale Eval

Retina screenshots are the best place to save tokens without removing screen area. The text-scale eval tests full-image downscales across multiple screenshots and compares recognized text against the original. It does not crop or mask any part of the screenshot.

Recommended local gate using Apple Vision OCR:

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

Practical default: `balanced` uses 2200 px because it is the current best candidate from Apple Vision. A 10-screenshot sweep made 1600 px look viable, but the larger 20-screenshot run dropped below the 90% p10 gate. Do not push lower by default until a cheap model-backed Codex eval passes the same screenshot corpus.

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

Quality 50 is the current default because it is the smallest tested setting so far that passed the external model readability gate on this sheet:

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
