# screenshotter

[![npm version](https://img.shields.io/npm/v/@marttinn/screenshotter.svg)](https://www.npmjs.com/package/@marttinn/screenshotter)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#install)

Local-first macOS screenshots for coding agents. `screenshotter` compresses screenshots, captures useful screen context, and puts both on the clipboard ready to paste into Codex, Claude, or another agent.

No telemetry. Screenshot processing, text extraction, and storage all happen locally on your Mac.

![Screenshotter toolbar preparing a compressed screenshot and Accessibility Markdown for Codex and Claude](docs/assets/screenshotter-demo.gif)

## Install

Requires macOS and Node.js 20+.

```sh
npm install -g @marttinn/screenshotter
screenshotter doctor --prompt-permissions
```

## Recommended setup

This is the workflow shown in the demo:

```sh
screenshotter toolbar --clipboard-mode attachments
```

Then:

1. Take a screenshot using your usual macOS action or shortcut.
2. Wait for the menu-bar icon to confirm it is ready.
3. Paste with `Cmd+V`.

`screenshotter` reacts to Apple’s screenshot file marker, with the documented `Screenshot …` filename as a fallback—not to a particular keyboard shortcut. Default shortcuts, remapped shortcuts, and Screenshot.app all work when they save to your configured macOS screenshot folder.

The clipboard contains two attachments:

- a locally compressed image;
- a small Markdown file with the frontmost app, window, and visible text from macOS Accessibility.

OCR is off unless you explicitly enable it.

## Prefer screenshots on the clipboard?

If your screenshot action copies an image instead of saving a file, `screenshotter clipboard` can process it. With the default macOS shortcuts, holding `Control` selects this behavior:

- `Ctrl+Shift+Cmd+3` copies the full screen;
- `Ctrl+Shift+Cmd+4` copies a selected area.

To optimize the image currently on the clipboard and put the smaller version back:

```sh
screenshotter clipboard
```

If your usual screenshot action writes to the clipboard, add `--clipboard-input` to the recommended toolbar command and leave it running:

```sh
screenshotter toolbar --clipboard-input --clipboard-mode attachments
```

Now any screenshot action that puts an image-only item on the clipboard can trigger processing; the keyboard combination itself is irrelevant. File copies and rich clipboard content such as URLs, HTML, RTF, or text are ignored. Wait for the menu-bar confirmation, then paste the optimized attachments with `Cmd+V`.

## Useful variations

```sh
# Image only
screenshotter toolbar

# Same attachment workflow without the menu-bar UI
screenshotter watch --clipboard-mode attachments

# Smaller output
screenshotter toolbar --profile balanced
screenshotter toolbar --profile token

# Accessibility text, then OCR only when direct text is unavailable
screenshotter toolbar --text-provider auto --clipboard-mode attachments

# Process the newest saved screenshot once
screenshotter clip --clipboard-mode attachments
```

## Options

Most options work with `toolbar`, `watch`, `clip`, `clipboard`, and `prepare`.

| Option | What it does |
| --- | --- |
| `--profile readability` | Default; prioritizes readable text and UI detail. |
| `--profile balanced` | Medium-size output. |
| `--profile token` | Smallest built-in profile. |
| `--with-text` | Captures visible text through macOS Accessibility. |
| `--with-target-context` | Records the frontmost app and window under the pointer. |
| `--text-provider accessibility` | Direct text only; this is the default with `--with-text`. |
| `--text-provider auto` | Accessibility first, then Apple Vision OCR fallback. |
| `--ocr` | Forces Apple Vision OCR. |
| `--no-ocr` | Prevents OCR fallback. |
| `--clipboard-mode image` | Copies only image data; the default. |
| `--clipboard-mode attachments` | Captures direct text and app/window context, then copies the image and context Markdown file; recommended. |
| `--clipboard-mode both` | Copies text and image data as separate pasteboard items. |
| `--clipboard-mode files` | Copies local file references. |
| `--clipboard-mode markdown` | Copies a text prompt containing local paths and context. |
| `--clipboard-mode text` | Copies extracted text only. |
| `--clipboard-mode codex-inline` | Activates Codex and pastes text followed by the image. |
| `--clipboard-input` | Watches for screenshot-like image-only clipboard changes; ignores files and rich content. |
| `--clipboard-poll-ms <ms>` | Tunes the native metadata-only change monitor; the default is 500 ms. Clipboard image data is read only after a change. |
| `--no-clipboard` | Prepares screenshots without changing the clipboard. |
| `--target <name>` | Labels prepared screenshots for a specific consumer. |
| `--poll-ms <ms>` | Changes the fallback watcher and clipboard polling interval. |
| `--verbose` | Prints timings and delivery details. |
| `--json` | Returns machine-readable output for one-shot commands. |
| `--dry-run` | Shows the planned result without clipboard delivery. |

Fine-grained image controls are available when needed: `--optimizer`, `--max-long-edge`, `--long-edge-percent`, `--min-long-edge`, `--jpeg-quality`, `--max-output-bytes`, and `--max-patches`. Run `screenshotter help` for the complete command reference.

## Other integrations

Install the pi package and enable live capture:

```sh
pi install npm:@marttinn/screenshotter
```

Then run `/screenshotter on` in pi.

Experimental MCP server:

```sh
codex mcp add screenshotter -- screenshotter mcp-server
claude mcp add screenshotter -- screenshotter mcp-server
```

See [Codex usage](docs/codex.md), [Claude usage](docs/claude.md), and [agent integration](docs/agents.md) for adapter-specific workflows.

## Data and maintenance

Prepared images, context files, statistics, and optional logs live under:

```text
~/Library/Application Support/screenshotter
```

```sh
screenshotter status --json
screenshotter stats --json
screenshotter gc --json
```

Ready records expire after 24 hours, claimed or cleared records after 30 days, and the store is bounded to 500 records by default.

## Development

```sh
git clone https://github.com/mgranados/screenshotter.git
cd screenshotter
npm install
npm run check
node bin/screenshotter.mjs doctor
```

When running from source, replace `screenshotter` with `node bin/screenshotter.mjs`.

## License

MIT.
