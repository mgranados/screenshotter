# Codex

Codex has two different attachment paths:

- Codex CLI supports initial prompt image attachments with `--image`.
- Codex desktop app supports image attachment through the composer UI.

## Codex CLI Workflow

Start a screenshot watcher in one terminal:

```sh
screenshotter watch --target codex
```

Take native macOS screenshots with `Cmd+Shift+3` or `Cmd+Shift+4`.

Launch Codex through the wrapper:

```sh
screenshotter codex -- "fix this UI issue"
```

`screenshotter codex` claims ready `codex` screenshots, converts them into `--image <path>` arguments, and then executes `codex`.

## Examples

Interactive Codex:

```sh
screenshotter codex --
```

Non-interactive Codex:

```sh
screenshotter codex -- exec "review this screenshot"
```

Codex with extra flags:

```sh
screenshotter codex -- --model gpt-5.1 "what is wrong with this UI?"
```

Dry run:

```sh
screenshotter codex --dry-run -- "fix this UI issue"
```

The dry run prints the exact `codex` argument list without calling Codex.

This avoids clipboard paste entirely. The wrapper uses Codex CLI's `--image <FILE>` option for the initial prompt.

## Codex CLI MCP Workflow

Codex CLI can also load the local MCP server:

```sh
codex mcp add screenshotter -- screenshotter mcp-server
```

Then ask Codex to use the latest screenshot. The MCP server exposes `screenshotter_prepare_latest` and `screenshotter_claim`, returning JSON plus image content when the optimized screenshot is small enough to inline.

This path is best when you are already inside a Codex session and want the model to pull screenshot context through a tool call. It is still pull-based: Codex needs to call the MCP tool after your prompt asks for screenshot context.

## Codex Desktop App Workflow

For the best desktop workflow, run a long-lived watcher:

```sh
screenshotter watch --verbose
```

When Codex app is running, `watch` auto-detects it and targets `codex-app`. Clipboard handoff is the default for all watcher targets. Take a native macOS screenshot and paste into Codex with `Cmd+V`. The watcher optimizes each new screenshot, copies it to the clipboard, prints compression details, and writes JSONL events.

```sh
screenshotter watch --target codex-app --verbose
```

Use the explicit command only when auto-detection picks a different running agent.

For the prompt composer in the desktop app, prepare the newest native macOS screenshot and copy the optimized image to the clipboard:

```sh
screenshotter codex-app
```

This command:

- prepares the latest screenshot
- writes an optimized JPEG derivative
- copies the optimized image to the macOS clipboard
- prints the optimized file path

Then paste it in Codex with `Cmd+V`.

For test runs, use verbose mode:

```sh
screenshotter codex-app --verbose
```

This prints compression details to stderr and appends JSONL events to:

```text
~/Library/Application Support/screenshotter/logs/events.jsonl
```

Use `--dry-run --json --verbose` to test preparation without copying to the clipboard.

`codex-app` is a named wrapper around the generic clipboard adapter:

```sh
screenshotter clip --target codex-app
```

To reveal the optimized file instead:

```sh
screenshotter codex-app --reveal
```

Then attach it in Codex with the composer `+` button, or drag the revealed file into the prompt.

Script-friendly output:

```sh
screenshotter codex-app --json
screenshotter clip --json
screenshotter paste --json
```

The JSON output includes the optimized file path. For `clip`, `paste`, and `codex-app`, the clipboard contains image data, not path text.

Copy prompt-ready Markdown or path text separately:

```sh
screenshotter copy --format markdown --clipboard
screenshotter copy --format paths --clipboard
```

Equivalent lower-level commands:

```sh
screenshotter prepare-latest --target codex-app --json
screenshotter reveal --target codex-app
```

## Limits

Codex CLI image attachment is available at process launch through `--image`. `screenshotter codex` cannot inject an image into an already-running Codex CLI session without terminal/UI automation. The MCP server gives an already-running session a pull-based tool path instead.

The Codex desktop app does not currently expose a public local API for injecting an attachment into an already-open prompt. `screenshotter codex-app` gets the optimized image ready, but the final paste action still happens through the app UI.
