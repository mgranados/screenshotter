# PoC Benchmarks

Command:

```sh
npm run bench:poc -- --latest 20 --vision-latest 20
```

Machine-local sample:

- 20 latest screenshots for optimizer and codec benchmarks.
- 20 latest retina screenshots with source long edge >= 3000 px for Apple Vision/text-retention benchmarks.
- Apple Vision requires normal macOS execution; sandboxed runs can fail to access Vision services.

## Summary

| Idea | Result | Recommendation |
| --- | --- | --- |
| Native ImageIO optimizer | 18.0 ms/image batch vs 81.2 ms/image `sips` CLI baseline, with similar bytes | Available as `--optimizer native` |
| Persistent worker / batch mode | Native batch 18.0 ms/image vs native per-file 33.9 ms/image | Implemented for native benchmark runs |
| Batch Apple Vision OCR | 419.9 ms/image batch vs 669.8 ms/image per-file | Implemented for text-scale evals |
| More aggressive downscale | 2200 px passed; 2000 px and below failed p10 >= 90% | Keep 2200 px as the safer readability profile |
| Optional WebP/JPEG optimization | WebP much smaller but 2.4x slower; jpegtran gives byte-only wins | Optional slow profile only |

## Optimization Paths

| Path | ms/image | Optimized total | Byte savings | Patch savings |
| --- | ---: | ---: | ---: | ---: |
| sips CLI 2200 baseline | 81.2 | 2.50 MB | 73.9% | 45.6% |
| sips CLI 3000 baseline | 75.5 | 3.16 MB | 67.0% | 23.0% |
| token profile | 102.7 | 1.10 MB | 88.5% | 82.7% |
| native ImageIO per file | 33.9 | 2.55 MB | 73.3% | n/a |
| native ImageIO batch | 18.0 | 2.55 MB | 73.3% | n/a |
| cwebp q50 all images | 195.9 | 1.14 MB | 88.0% | same dimensions |
| jpegtran native JPEG rows | 24.2 | 1.55 MB | 12.8% | bytes only |

Notes:

- Native ImageIO is the strongest speed PoC. It roughly matches current byte savings while avoiding repeated `sips` process startup.
- WebP gives byte savings close to the `token` profile, but it does not improve dimension-token savings beyond the chosen dimensions.
- `jpegtran` was run only on native helper JPEG outputs, not copied PNG rows. The 12.8% is an additional JPEG-row byte reduction, not total corpus reduction.

## Apple Vision OCR

| Path | ms/image | OK |
| --- | ---: | ---: |
| one process per image | 669.8 | 20/20 |
| batch process | 419.9 | 20/20 |

Batching Apple Vision is worth doing for the eval harness. It is not relevant to normal `prepare`, because OCR is intentionally not in the hot path.

## High-Compression Downscale

| Max long edge | Byte savings | Text retention |
| ---: | ---: | --- |
| 2400 px | 80.4% | 91.1% p10 / 95.9% median / pass |
| 2200 px | 82.6% | 91.4% p10 / 94.9% median / pass |
| 2000 px | 85.2% | 89.8% p10 / 95.6% median / fail |
| 1800 px | 87.2% | 88.2% p10 / 94.7% median / fail |
| 1600 px | 89.6% | 89.8% p10 / 94.2% median / fail |

Recommendation: keep `readability` as the default for product use when tiny UI text must remain readable. Use 3000 px as the mid profile and 2200 px as the aggressive readable profile. The next lower fixed readability candidate, 2000 px, saves only a few more byte/patch points and misses the p10 readability gate.

## Implementation Status

The three highest-value PoCs are now wired into the tool:

- Native ImageIO is the default optimizer for normal `prepare` and `prepare-latest`; Sharp/libvips remains available as `--optimizer sharp` when installed separately.
- `screenshotter bench` uses the selected optimizer and accepts `--optimizer sharp`, `--optimizer native`, or `--optimizer sips` for control runs.
- `npm run eval:text-scale -- --engine vision` uses the batch Apple Vision helper and reports fallback count in JSON/human output.
