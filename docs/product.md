# Product

`screenshotter` is a local screenshot inbox for AI coding agents.

The product promise is simple: take a normal macOS screenshot, and the next agent prompt gets a readable, optimized image without drag-drop, manual compression, or uploading through a third-party service.

## User

Primary user:

- Engineers using agentic coding tools all day.
- They debug UI, terminal output, browser state, diffs, logs, and app screenshots.
- They care about readability, speed, privacy, and image-token cost.

First supported workflows:

- pi interactive sessions with `/screenshotter on`.
- Codex app and Claude app through a long-running clipboard watcher.
- Codex CLI and Claude Code through wrappers or MCP.

## Product Shape

The CLI is the stable product boundary:

```sh
screenshotter doctor
screenshotter watch --verbose
screenshotter prepare-latest --target manual --json
screenshotter claim --target manual --json
screenshotter bench --latest 20 --tokens --json
screenshotter mcp-server
```

Adapters should stay thin and call the CLI instead of importing internals.

## Defaults

- Local-first. Normal prepare/watch/claim/clipboard flows never upload screenshots.
- Originals untouched. Optimized files are separate copies.
- Readability profile by default: preserve normal Retina screenshot dimensions up to 4096 px long edge, JPEG quality 90, with a 1 MB byte target.
- Sharp/libvips optimizer first, native ImageIO and `sips` fallbacks.
- Verbose mode writes JSONL event logs for support and benchmarking.

## v0.1 Product Criteria

- `screenshotter doctor` clearly tells a user if their machine is ready.
- `/screenshotter on` works in pi from a package install.
- `screenshotter watch --verbose` auto-detects Codex app and is good enough for daily Codex app use.
- MCP smoke test works for Codex CLI and Claude Code experiments.
- README stays short enough that a new user can start in under one minute.
- Performance docs include current speed, compression, and token-estimate numbers.
- npm package dry run contains only intentional release files.

## Distribution

First channel: npm.

```sh
npm install -g @mgranados/screenshotter
screenshotter doctor
```

Second channel: Homebrew after the CLI contract settles.

Do not build a GUI first. The product value is the invisible local workflow: screenshot, optimize, attach.

## Roadmap

1. Finish pi quality loop.
2. Test Codex app watcher daily and tighten paste/log UX.
3. Add Codex CLI MCP setup docs after hands-on testing.
4. Add Claude Code MCP setup docs after hands-on testing.
5. Publish `0.1.0` on npm.
6. Add Homebrew formula after the npm release is stable.

## Not Now

- Cloud sync.
- Screenshot history UI.
- Tauri app.
- WebP in the default hot path.
- OCR or multi-candidate optimization during normal screenshot preparation.
