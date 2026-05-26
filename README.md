# agent-screens

Local-first screenshot attachments for AI coding agents on macOS.

`agent-screens` takes native macOS screenshots, optimizes them locally, and hands them to agents as prompt-ready image files or clipboard images. It works with Codex, Claude Code, pi, shell scripts, and thin adapters for other CLIs.

- No login.
- No cloud service.
- No MCP required.
- Original screenshots are never modified.
- Optimized copies stay on your machine.

## Requirements

- macOS
- Node.js 20+
- A CLI or desktop agent that can accept image files, pasted images, or prompt text containing image paths

## Install From Source

```sh
git clone https://github.com/<owner>/agent-screens.git
cd agent-screens
node bin/agent-screens.mjs status --json
```

To put it on your PATH:

```sh
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/agent-screens.mjs" ~/.local/bin/agent-screens
agent-screens status --json
```

If `~/.local/bin` is not already on your PATH, add it in your shell profile.

## Fastest Start

### Codex Or Claude Desktop

Take a screenshot with `Cmd+Shift+3` or `Cmd+Shift+4`, then copy the optimized image to the clipboard:

```sh
agent-screens codex-app
# or
agent-screens claude-app
```

Paste into the prompt with `Cmd+V`.

For file-picker or drag-drop fallback:

```sh
agent-screens codex-app --reveal
agent-screens claude-app --reveal
```

### Codex CLI

Start a watcher:

```sh
agent-screens watch --target codex
```

Take a macOS screenshot, then run Codex through the wrapper:

```sh
agent-screens codex -- "use the screenshot"
```

The wrapper claims ready screenshots and passes them to `codex --image`.

### Claude Code CLI

Start a watcher:

```sh
agent-screens watch --target claude-code
```

Take a macOS screenshot, then run Claude through the wrapper:

```sh
agent-screens claude -- "use the screenshot"
```

The wrapper claims ready screenshots and appends their optimized image paths to the initial Claude prompt.

### pi

This repo includes a pi extension and skill:

```sh
pi -e .
```

Inside pi:

```text
/screenshotter on
```

Screenshots taken while pi is idle attach to the next interactive prompt.

If pi is running from another package or checkout, point it at this CLI:

```sh
AGENT_SCREENS_CLI=agent-screens pi -e <path-to-pi-package>
```

## CLI API

Adapters can treat `agent-screens` as a local executable API:

```sh
agent-screens prepare <image> [--target pi] [--profile token|balanced|readability] [--json]
agent-screens prepare-latest [--target codex-app] [--profile token|balanced|readability] [--json]
agent-screens list [--target pi] [--state ready] [--json]
agent-screens claim [--target pi] [--max 4] [--json]
agent-screens clear [--target pi] [--files] [--json]
agent-screens status [--target pi] [--tokens] [--json]
agent-screens copy [--format markdown|paths|json] [--clipboard]
agent-screens clip [--target app] [--json]
agent-screens reveal [--target app]
agent-screens bench [--latest 10] [--profile token|balanced|readability] [--tokens] [--json]
```

Public lifecycle:

```text
prepare -> ready -> claim -> cleared
```

Compatibility aliases remain available for existing adapters: `stage`, `stage-latest`, `drain`, and `--status staged`.

## Storage

By default, data is stored in:

```text
~/Library/Application Support/agent-screens
```

Override it with:

```sh
AGENT_SCREENS_DATA_DIR=~/.agent-screens
AGENT_SCREENS_OPTIMIZED_DIR=~/ScreenshotsForAgents
```

## Compression Policy

There are three local profiles:

- `balanced`: fast default, JPEG quality 50, max long edge 2200 px.
- `token`: more aggressive sizing, JPEG quality 45, max long edge 1024 px.
- `readability`: higher fidelity, JPEG quality 78, max long edge 4096 px.

All profiles keep the original when JPEG would be larger and avoid WebP/MozJPEG/OCR/multi-candidate search during normal preparation.

Local benchmark on 20 recent screenshots:

| Metric | Result |
| --- | ---: |
| Average prepare time | 75.9 ms |
| Median prepare time | 107.0 ms |
| Size reduction | 73.9% |

See [docs/performance.md](docs/performance.md).

For retina screenshots, `npm run eval:text-scale` benchmarks full-image downscales against original text retention. Use `--engine vision` for a local Apple Vision OCR gate, then `--engine codex --model <cheap-vision-model> --allow-external` for a model-specific check. The current 20-screenshot Apple Vision run passed at 2200 px with p10 text retention above 90%, about 83% byte savings, and about 64% 32px-patch savings.

## Cost Impact

Screenshot-heavy agent workflows can spend real money on image input tokens. `agent-screens` helps by using `--profile token` to send fewer image tokens when the model bills from image dimensions.

Estimate from a local 20-screenshot benchmark:

- Token profile resize savings: 2,686.4 input tokens per screenshot in the most favorable patch/original-detail estimate.

Estimated input-token savings:

| Screens | Model / mode | Estimated resize savings |
| ---: | --- | ---: |
| 300 | GPT-5.5 / Opus standard $5/M | $4.03 |
| 300 | GPT-5.5 fast $12.50/M | $10.07 |
| 300 | Opus 4.7 fast $30/M | $24.18 |
| 1,000 | GPT-5.5 / Opus standard $5/M | $13.43 |
| 1,000 | GPT-5.5 fast $12.50/M | $33.58 |
| 1,000 | Opus 4.7 fast $30/M | $80.59 |
| 10,000 | GPT-5.5 / Opus standard $5/M | $134.32 |
| 10,000 | GPT-5.5 fast $12.50/M | $335.79 |
| 10,000 | Opus 4.7 fast $30/M | $805.91 |

These are directional estimates, not billing guarantees. Actual savings depend on model image-token accounting, detail mode, cache behavior, and provider pricing.

## Development

```sh
npm run check
agent-screens bench --latest 10 --json
agent-screens bench --latest 10 --profile token --tokens --json
npm run eval:text-scale -- --engine vision --latest 20 --min-source-long-edge 3000 --edges 2400,2200,2000,1800
npm run quality -- --image "/path/to/screenshot.png" --min-ssim 0.99
```

## Docs

- [Architecture](docs/architecture.md)
- [Adapter contract](docs/adapter-contract.md)
- [pi screenshotter skill API](docs/pi-screenshotter-skill-api.md)
- [Codex CLI](docs/codex.md)
- [Claude](docs/claude.md)
- [Performance](docs/performance.md)
- [Release checklist](docs/release.md)

## License

MIT
