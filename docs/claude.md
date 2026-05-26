# Claude

Claude desktop does not need MCP for screenshot handoff. Use the local clipboard connector.

## Claude Desktop App Workflow

Prepare the newest native macOS screenshot and copy the optimized image to the clipboard:

```sh
agent-screens claude-app
```

This command:

- prepares the latest screenshot
- writes an optimized derivative
- copies the optimized image to the macOS clipboard
- prints the optimized file path

Then paste it in Claude with `Cmd+V`.

`claude-app` is a named wrapper around the generic clipboard adapter:

```sh
agent-screens clip --target claude-app
```

To reveal the optimized file instead:

```sh
agent-screens claude-app --reveal
```

Then attach it in Claude with the file picker, or drag the revealed file into the prompt.

Script-friendly output:

```sh
agent-screens claude-app --json
```

The JSON output includes the optimized file path. For `claude-app`, the clipboard contains image data, not path text, unless `--reveal` is used.

## Claude Code CLI

Claude Code can work with images by path. Anthropic's [Claude Code image workflow](https://code.claude.com/docs/en/common-workflows#work-with-images) documents image paths as one supported way to add an image to a conversation.

For a no-paste flow, start a watcher in one terminal:

```sh
agent-screens watch --target claude-code
```

Take native macOS screenshots with `Cmd+Shift+3` or `Cmd+Shift+4`.

Launch Claude through the wrapper:

```sh
agent-screens claude -- "describe this screenshot"
```

`agent-screens claude` claims ready `claude-code` screenshots and appends their optimized image paths to the initial Claude prompt:

```text
Use these screenshot image files as visual context:
1. /path/to/optimized.jpg
```

Non-interactive Claude:

```sh
agent-screens claude -- -p "review this UI screenshot"
```

Dry run:

```sh
agent-screens claude --dry-run -- "review this UI screenshot"
```

The dry run prints the exact `claude` argument list without calling Claude.

For lower-level adapters, use the generic executable API:

```sh
agent-screens prepare <path> --target claude-code --json
agent-screens claim --target claude-code --max 4 --json
```

Adapters should attach or reference `screens[].optimizedPath` with `screens[].mimeType`.

## Limits

The Claude desktop app connector is intentionally human-in-the-loop: it prepares and copies the optimized image, then the user pastes with `Cmd+V`. It does not attempt UI automation or keystroke injection.

For Claude Code, `agent-screens claude` avoids paste by adding image paths to the startup prompt. It cannot inject images into an already-running Claude Code session without terminal/UI automation.
