# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning once it reaches `0.1.0`. Before that, minor versions may still include CLI contract changes.

## Unreleased

- Renamed the project, package, and CLI to `screenshotter`.
- Added `screenshotter doctor` for first-run readiness checks.
- Added product positioning and release criteria in `docs/product.md`.
- Added auto target detection to `screenshotter watch`.
- Added optional `screenshotter toolbar` menu-bar controls for watch mode.
- Changed the default profile to high-fidelity `readability` so tiny UI text remains readable.
- Added Sharp/libvips optimization as the default prepare path, with native ImageIO and `sips` fallbacks.
- Added `--optimizer sharp|native|sips` for prepare and benchmark control runs.
- Added token-aware benchmark output for common image-token and patch accounting modes.
- Added batched Apple Vision OCR for text-scale downscale evaluation.
- Added pi `/screenshotter` extension and skill layout.

## 0.0.1

- Initial local-first macOS screenshot attachment CLI.
- Added Codex, Claude Code, desktop clipboard, and pi adapter flows.
