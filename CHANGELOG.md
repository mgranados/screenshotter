# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning once it reaches `0.1.0`. Before that, minor versions may still include CLI contract changes.

## Unreleased

## 0.1.1 - 2026-07-11

- Added one-shot and opt-in watched macOS clipboard image input.
- Ignored Finder file copies and rich clipboard content while preserving image-only screenshot capture.
- Prevented newer clipboard changes from being overwritten or dropped during screenshot processing.
- Simplified the README around the local attachment workflow and documented that screenshotter has no telemetry.
- Removed the remote SSH attachment transport and its pi bundle parser.
- Updated the GitHub Actions runtime actions while retaining the Node 20 and 22 package test matrix.

## 0.1.0 - 2026-07-11

- Renamed the project, package, and CLI to `screenshotter`.
- Added `screenshotter doctor` for first-run readiness checks.
- Added opt-in direct screen text capture through macOS Accessibility, with explicit OCR fallback modes.
- Added companion Markdown and compressed image clipboard attachments for local coding agents.
- Added auto target detection and app-aware text cleanup for browsers, terminals, and coding agents.
- Added optional `screenshotter toolbar` menu-bar controls for watch mode.
- Added processing and ready-state toolbar animations plus historical compression statistics.
- Added native ImageIO optimization by default, with optional Sharp/libvips and `sips` paths.
- Added persistent event logs, automatic artifact retention, benchmarks, and adversarial text extraction tests.
- Added pi `/screenshotter` extension and skill layout.

## 0.0.1

- Initial local-first macOS screenshot attachment CLI.
- Added Codex, Claude Code, desktop clipboard, and pi adapter flows.
