# screenshotter

Local macOS screenshots for coding agents.

Take a screenshot. `screenshotter` optimizes it locally and copies it to your clipboard.

## Install

```sh
git clone https://github.com/mgranados/screenshotter.git
cd screenshotter
node bin/screenshotter.mjs doctor
```

Optional:

```sh
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/screenshotter.mjs" ~/.local/bin/screenshotter
```

## Use

```sh
screenshotter watch --verbose
```

Take a screenshot with `Cmd+Shift+3` or `Cmd+Shift+4`, then paste into Codex, Claude, or another agent with `Cmd+V`.

For pi:

```sh
pi install . -l
```

Then run `/screenshotter on`.

## Savings

| Size | Original | Default | Token mode | Bandwidth saved / 1k | GPT-5.5 tokens saved | Claude Opus tokens saved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Pro Display XDR | 5.48 MB | 0.89 MB | 0.36 MB | 5.0 GB | 7,284 | 1,152 |
| 16in MacBook Pro | 1.86 MB | 0.83 MB | 0.20 MB | 1.6 GB | 6,284 | 3,095 |
| 14in MacBook Pro | 2.34 MB | 0.75 MB | 0.20 MB | 2.1 GB | 4,614 | 3,088 |
| Window 1920x1200 | 1.04 MB | 0.40 MB | 0.20 MB | 0.8 GB | 1,048 | 1,438 |
| Window 1440x900 | 0.63 MB | 0.38 MB | 0.20 MB | 0.4 GB | 73 | 94 |

Average from 5 recent screenshots. Default preserves readability. Token mode resizes for lower API image-token cost.

## Profiles

```sh
screenshotter watch --profile readability  # default
screenshotter watch --profile balanced
screenshotter watch --profile token
```

In pi: `/screenshotter readability`, `/screenshotter balanced`, or `/screenshotter token`.

## Commands

```sh
screenshotter watch --verbose
screenshotter clip --target codex-app
screenshotter claude-app --verbose
screenshotter prepare-latest --target manual --json
screenshotter claim --target manual --json
screenshotter bench --latest 20 --tokens --json
screenshotter doctor
```

MCP, experimental:

```sh
codex mcp add screenshotter -- screenshotter mcp-server
claude mcp add screenshotter -- screenshotter mcp-server
```

No symlink:

```sh
node bin/screenshotter.mjs watch --verbose
```

Verbose runs write JSONL logs to:

```text
~/Library/Application Support/screenshotter/logs/events.jsonl
```

## License

MIT.
