# Manual Test Plan

Run these in order. Promote each workflow only after it feels good in real use.

## 1. Codex App

Start:

```sh
screenshotter doctor
screenshotter watch --verbose
```

Test:

1. Take a screenshot with `Cmd+Shift+4`.
2. Confirm the watcher prints a line like `ready scr_... 4.8 MB -> 316 KB ... copied to clipboard`.
3. Paste into Codex with `Cmd+V`.
4. Ask Codex to describe the screen and verify it can read the important text.
5. Take a second similar screenshot and confirm the watcher processes only the new file.

Expected:

- Watch auto-detects `codex-app` when Codex app is running and uses default clipboard handoff.
- Optimized image lands on the clipboard.
- Source screenshot is untouched.
- Default output is around 1 MB for full-desktop Retina screenshots, but varies with source content.
- Logs are written to `~/Library/Application Support/screenshotter/logs/events.jsonl` when `--verbose` is on.

Fallback:

```sh
screenshotter codex-app --reveal
```

Then drag the revealed file into Codex or attach it with the composer.

## 2. Codex CLI

Start:

```sh
screenshotter watch --target codex --verbose
```

The explicit target is useful while testing. The product goal is for `screenshotter watch --verbose` to choose `codex` automatically when Codex CLI is the detected agent.

Test:

```sh
screenshotter codex --dry-run -- "describe this screenshot"
screenshotter codex -- "describe this screenshot"
```

Expected:

- Dry run shows `--image <optimized-path>` before the prompt.
- Real run launches `codex` with the claimed screenshot attached.

## 3. Claude App

Start:

```sh
screenshotter claude-app --verbose
```

Expected:

- Latest screenshot is optimized and copied to the clipboard.
- Paste into Claude with `Cmd+V`.

## 4. Claude Code

Start:

```sh
screenshotter watch --target claude-code --verbose
```

The explicit target is useful while testing. The product goal is for `screenshotter watch --verbose` to choose `claude-code` automatically when Claude Code is the detected agent.

Test:

```sh
screenshotter claude --dry-run -- "describe this screenshot"
screenshotter claude -- "describe this screenshot"
```

Expected:

- Dry run appends optimized image paths to the Claude prompt.
- Real run launches `claude` with those paths in the initial prompt.
