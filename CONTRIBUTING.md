# Contributing

Thanks for helping improve `screenshotter`.

## Development Setup

Requirements:

- macOS
- Node.js 20 or newer
- Xcode command line tools for the optional native Swift helpers

Run the local check:

```sh
npm run check
```

Run a quick benchmark:

```sh
npm run bench -- --latest 10
```

Run a package dry run before release changes:

```sh
npm run pack:dry-run
```

## Design Constraints

- Keep the CLI contract stable. Integrations should call `screenshotter` instead of importing internal files.
- Keep screenshot processing local by default. Do not add network calls to normal prepare, watch, claim, or clipboard flows.
- Avoid OCR, multi-candidate search, and heavyweight codecs in the hot path.
- Preserve originals. Optimized files must be separate copies.
- Prefer macOS built-ins and dependency-free code unless a dependency removes clear complexity.

## Benchmarks

Performance changes should include:

- `screenshotter bench --latest 20 --tokens --json`
- `screenshotter bench --latest 20 --optimizer sips --tokens --json` when comparing optimizer changes
- `npm run eval:text-scale -- --engine vision --latest 20 --min-source-long-edge 3000` when changing default dimensions

Do not upload private screenshots in issues or pull requests. Share aggregate benchmark output or synthetic fixtures instead.

## Pull Requests

Before opening a PR:

1. Run `npm run check`.
2. Run `npm run pack:dry-run` if package contents changed.
3. Update `README.md`, `docs/`, and `CHANGELOG.md` for user-visible changes.
