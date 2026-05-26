# Codex

Codex has two different attachment paths:

- Codex CLI supports initial prompt image attachments with `--image`.
- Codex desktop app supports image attachment through the composer UI.

## Codex CLI Workflow

Start a screenshot watcher in one terminal:

```sh
agent-screens watch --target codex
```

Take native macOS screenshots with `Cmd+Shift+3` or `Cmd+Shift+4`.

Launch Codex through the wrapper:

```sh
agent-screens codex -- "fix this UI issue"
```

`agent-screens codex` claims ready `codex` screenshots, converts them into `--image <path>` arguments, and then executes `codex`.

## Examples

Interactive Codex:

```sh
agent-screens codex --
```

Non-interactive Codex:

```sh
agent-screens codex -- exec "review this screenshot"
```

Codex with extra flags:

```sh
agent-screens codex -- --model gpt-5.1 "what is wrong with this UI?"
```

Dry run:

```sh
agent-screens codex --dry-run -- "fix this UI issue"
```

The dry run prints the exact `codex` argument list without calling Codex.

This avoids clipboard paste entirely. The wrapper uses Codex CLI's `--image <FILE>` option for the initial prompt.

## Codex Desktop App Workflow

For the prompt composer in the desktop app, prepare the newest native macOS screenshot and copy the optimized image to the clipboard:

```sh
agent-screens codex-app
```

This command:

- prepares the latest screenshot
- writes an optimized JPEG derivative
- copies the optimized image to the macOS clipboard
- prints the optimized file path

Then paste it in Codex with `Cmd+V`.

`codex-app` is a named wrapper around the generic clipboard adapter:

```sh
agent-screens clip --target codex-app
```

To reveal the optimized file instead:

```sh
agent-screens codex-app --reveal
```

Then attach it in Codex with the composer `+` button, or drag the revealed file into the prompt.

Script-friendly output:

```sh
agent-screens codex-app --json
agent-screens clip --json
agent-screens paste --json
```

The JSON output includes the optimized file path. For `clip`, `paste`, and `codex-app`, the clipboard contains image data, not path text.

Copy prompt-ready Markdown or path text separately:

```sh
agent-screens copy --format markdown --clipboard
agent-screens copy --format paths --clipboard
```

Equivalent lower-level commands:

```sh
agent-screens prepare-latest --target codex-app --json
agent-screens reveal --target codex-app
```

## Limits

Codex CLI image attachment is available at process launch through `--image`. `agent-screens codex` cannot inject an image into an already-running Codex CLI session without terminal/UI automation.

The Codex desktop app does not currently expose a public local API for injecting an attachment into an already-open prompt. `agent-screens codex-app` gets the optimized image ready, but the final paste action still happens through the app UI.
