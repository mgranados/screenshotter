# Architecture

`screenshotter` is a local-first screenshot inbox for AI agents.

The core contract is intentionally small:

```text
macOS screenshot -> prepare -> ready -> claim -> cleared
```

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

## Storage

The executable can live in a source checkout, on your PATH, or in a future Homebrew install. The mutable screenshot store stays in the user's data directory:

```text
~/Library/Application Support/screenshotter/
  screens.json
  optimized/
```

Override with:

```sh
SCREENSHOTTER_DATA_DIR=~/.screenshotter
SCREENSHOTTER_OPTIMIZED_DIR=~/ScreenshotsForAgents
```
