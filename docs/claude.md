# Claude

Claude desktop does not need MCP for screenshot handoff. Use the local clipboard connector.

## Claude Desktop App Workflow

Prepare the newest native macOS screenshot and copy the optimized image to the clipboard:

```sh
screenshotter claude-app
```

This command:

- prepares the latest screenshot
- writes an optimized derivative
- copies the optimized image to the macOS clipboard
- prints the optimized file path

Then paste it in Claude with `Cmd+V`.

To paste screen text plus the optimized screenshot into Claude Desktop or claude.ai:

```sh
screenshotter claude-app --clipboard-mode attachments
```

This copies direct Accessibility text in a markdown context file plus the optimized image file. Paste once with `Cmd+V` in the active Claude composer. Add `--text-provider auto` only when you explicitly want Apple Vision OCR fallback.

`claude-app` is a named wrapper around the generic clipboard adapter:

```sh
screenshotter clip --target claude-app
```

To reveal the optimized file instead:

```sh
screenshotter claude-app --reveal
```

Then attach it in Claude with the file picker, or drag the revealed file into the prompt.

Script-friendly output:

```sh
screenshotter claude-app --json
```

The JSON output includes the optimized file path. For `claude-app`, the clipboard contains image data, not path text, unless `--reveal` is used.

## Claude Code CLI

Claude Code can work with images by path. Anthropic's [Claude Code image workflow](https://code.claude.com/docs/en/common-workflows#work-with-images) documents image paths as one supported way to add an image to a conversation.

For a no-paste flow, start a watcher in one terminal:

```sh
screenshotter watch --target claude-code
```

Take native macOS screenshots with `Cmd+Shift+3` or `Cmd+Shift+4`.

Launch Claude through the wrapper:

```sh
screenshotter claude -- "describe this screenshot"
```

`screenshotter claude` claims ready `claude-code` screenshots and appends their optimized image paths to the initial Claude prompt:

```text
Use these screenshot image files as visual context:
1. /path/to/optimized.jpg
```

Non-interactive Claude:

```sh
screenshotter claude -- -p "review this UI screenshot"
```

Dry run:

```sh
screenshotter claude --dry-run -- "review this UI screenshot"
```

The dry run prints the exact `claude` argument list without calling Claude.

For lower-level adapters, use the generic executable API:

```sh
screenshotter prepare <path> --target claude-code --json
screenshotter claim --target claude-code --max 4 --json
```

Adapters should attach or reference `screens[].optimizedPath` with `screens[].mimeType`.

## Claude Code MCP Workflow

Claude Code can load the local MCP server:

```sh
claude mcp add screenshotter -- screenshotter mcp-server
```

Then ask Claude to use the latest screenshot. The MCP server exposes `screenshotter_prepare_latest` and `screenshotter_claim`, returning JSON plus image content when the optimized screenshot is small enough to inline.

This is the best already-running-session path. It is still pull-based: Claude needs to call the MCP tool after your prompt asks for screenshot context.

## Limits

The Claude desktop app connector is intentionally human-in-the-loop: it prepares and copies the optimized image, then the user pastes with `Cmd+V`. It does not attempt UI automation or keystroke injection.

For Claude Code, `screenshotter claude` avoids paste by adding image paths to the startup prompt. It cannot inject images into an already-running Claude Code session without terminal/UI automation. The MCP server gives an already-running session a pull-based tool path instead.
