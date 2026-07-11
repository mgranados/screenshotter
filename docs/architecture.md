# Architecture

`screenshotter` is a local-first screen-context inbox for AI agents.

The core contract is intentionally small:

```text
macOS screenshot -> prepare -> ready -> claim -> cleared
```

The screenshot is the trigger and visual payload. The prepared screen record can also carry text context from direct providers or local OCR, plus opt-in target metadata for frontmost app and window-under-pointer routing. The feature spec lives in [screen-context.md](screen-context.md).

The CLI is the product boundary. Agent-specific integrations should be thin adapters over the CLI:

- pi uses `/screenshotter on` and claims images for the next interactive prompt.
- Codex CLI can claim screenshots and pass them with `codex --image`.
- Desktop apps can use `screenshotter clip` or app-specific wrappers, then accept the image with `Cmd+V`.
- Codex CLI and Claude Code can use the local MCP server to pull latest screenshots from an already-running session.
- Claude Code can consume file paths through the wrapper when launched from `screenshotter claude`.
- Any other CLI can use JSON output or copied Markdown paths.

## Background-first Preparation

Background-first means compression happens when the screenshot appears, not when the user submits a prompt.

For pi, the extension already does this: `/screenshotter on` watches the macOS screenshot folder and calls `screenshotter prepare` as soon as a new native screenshot is detected. The next prompt only claims ready files.

For other agents, run:

```sh
screenshotter watch
```

When `--target` is omitted, `watch` inspects running agent processes and chooses the likely target. The watcher copies each optimized screenshot to the clipboard by default for quick desktop handoff, and also prepares screenshots for later `claim`. Use `--no-clipboard` for a claim-only watcher.

Wrappers can call:

```sh
screenshotter claim --target codex --json
```

This keeps prompt-time latency low and avoids every agent needing its own watcher and compression logic.

## Text Context

Text is a first-class part of screen context, but it is provider-based and optional.

Automatic provider priority:

```text
macOS Accessibility > Apple Vision OCR
```

Browser DOM extraction is available only when explicitly selected because it requires browser-specific automation permission. Selection-driving automation is not part of the default implementation. Image preparation and text collection stay separate internally, then merge into one screen record. Direct text is preferred when available because it is exact and fast. OCR remains the fallback for pixels-only surfaces.

Text-aware outputs should preserve the same adapter contract:

- Clipboard workflows paste text plus the optimized image when `--with-text` is enabled.
- pi prompt transforms append text snippets and attach images.
- MCP and JSON clients receive the optimized image path plus `textContext`.

Apps and web composers that need both text and image should use the generic attachment bundle. `--clipboard-mode attachments` collects direct text and app/window context, then puts a markdown context file and the optimized image file on the clipboard as file URLs. It stays opt-in and does not require app-specific UI automation. `codex-inline` remains available as a noisier Codex fallback.

Outside attachment mode, `--with-target-context` records app/window hints at prepare time without requiring text collection.

## Storage

The executable can live in a source checkout, on your PATH, or in a future Homebrew install. The mutable screenshot store stays in the user's data directory:

```text
~/Library/Application Support/screenshotter/
  screens.json
  stats.json
  optimized/
  text/
  logs/events.jsonl
```

Screen metadata and generated text are owner-only. Ready records expire after 24 hours, terminal records after 30 days, and the store retains at most 500 records by default. Lifetime byte savings stay in `stats.json`; `screenshotter gc` applies retention immediately and removes orphan optimized files.

Override with:

```sh
SCREENSHOTTER_DATA_DIR=~/.screenshotter
SCREENSHOTTER_OPTIMIZED_DIR=~/ScreenshotsForAgents
```
