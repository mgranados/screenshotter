# Architecture

`agent-screens` is a local-first screenshot inbox for AI agents.

The core contract is intentionally small:

```text
macOS screenshot -> prepare -> ready -> claim -> cleared
```

The CLI is the product boundary. Agent-specific integrations should be thin adapters over the CLI:

- pi uses `/screenshotter on` and claims images for the next interactive prompt.
- Codex CLI can claim screenshots and pass them with `codex --image`.
- Desktop apps can use `agent-screens clip` or app-specific wrappers, then accept the image with `Cmd+V`.
- Claude Code can consume file paths or use an MCP adapter later.
- Any other CLI can use JSON output or copied Markdown paths.

## Background-first Preparation

Background-first means compression happens when the screenshot appears, not when the user submits a prompt.

For pi, the extension already does this: `/screenshotter on` watches the macOS screenshot folder and calls `agent-screens prepare` as soon as a new native screenshot is detected. The next prompt only claims ready files.

For other agents, run:

```sh
agent-screens watch --target codex
```

Then wrappers can call:

```sh
agent-screens claim --target codex --json
```

This keeps prompt-time latency low and avoids every agent needing its own watcher and compression logic.

## Storage

The executable can live in a source checkout, on your PATH, or in a future Homebrew install. The mutable screenshot store stays in the user's data directory:

```text
~/Library/Application Support/agent-screens/
  screens.json
  optimized/
```

Override with:

```sh
AGENT_SCREENS_DATA_DIR=~/.agent-screens
AGENT_SCREENS_OPTIMIZED_DIR=~/ScreenshotsForAgents
```
