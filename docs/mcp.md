# MCP

`screenshotter` includes a local stdio MCP server for agents that support MCP tools.

The server wraps the existing CLI API. It does not run a background daemon, use the network, or require login.

## Install

For an installed npm package:

```sh
codex mcp add screenshotter -- screenshotter mcp-server
claude mcp add screenshotter -- screenshotter mcp-server
```

For a source checkout:

```sh
codex mcp add screenshotter -- node /path/to/screenshotter/bin/screenshotter-mcp.mjs
claude mcp add screenshotter -- node /path/to/screenshotter/bin/screenshotter-mcp.mjs
```

## Tools

- `screenshotter_status`: show ready counts, byte savings, and token estimates.
- `screenshotter_prepare_latest`: optimize the latest native macOS screenshot.
- `screenshotter_prepare`: optimize a specific local image path.
- `screenshotter_claim`: atomically claim ready screenshots for the current target.
- `screenshotter_clear`: clear screenshots for a target.
- `screenshotter_clip_latest`: optimize latest screenshot and copy it to the macOS clipboard.
- `screenshotter_screenshot_dir`: show the native macOS screenshot folder.

Prepare and claim tools return JSON text plus MCP image content when the optimized file is small enough to inline. They also return `optimizedPath` so clients that prefer file paths can attach or reference the image directly.

## Suggested Agent Prompt

```text
When the user asks to use the latest screenshot, call screenshotter_prepare_latest.
When screenshots were already prepared for this session, call screenshotter_claim.
Use returned MCP image content as visual context. If image content is not returned, use optimizedPath.
Use target "codex" in Codex and "claude-code" in Claude Code.
```

## Limits

MCP is pull-based. The model or user prompt must cause a tool call. This is different from the pi extension, which can intercept the next interactive prompt and attach screenshots automatically.
