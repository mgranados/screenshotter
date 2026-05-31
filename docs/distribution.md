# Distribution

Recommended release path:

1. npm package for the CLI, pi extension, and skills.
2. GitHub releases for tags, release notes, and source archives.
3. Homebrew tap after the CLI contract settles.

## npm

npm is the best first distribution channel because the tool is already a Node CLI with a `bin` entry and a small runtime dependency set.

The unscoped `screenshotter` npm name is already published by another package. Keep `screenshotter` as the product and binary name, and publish under a scope such as `@mgranados/screenshotter` or an organization-owned scope.

Expected install:

```sh
npm install -g @mgranados/screenshotter
screenshotter doctor
pi install npm:@mgranados/screenshotter
```

Before publishing:

```sh
npm run check
npm run pack:dry-run
npm publish
```

Keep `files` in `package.json` explicit so benchmark artifacts, local stores, and editor files cannot accidentally ship.

The npm package also carries the pi resources through the `package.json` manifest:

```json
{
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

That lets `pi install npm:@mgranados/screenshotter` load the `/screenshotter` command and the matching `screenshotter` skill together.

## GitHub Releases

Tag every public release:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Release notes should include:

- install command
- breaking CLI changes, if any
- default compression profile and benchmark summary
- adapter changes for pi, Codex, and Claude Code

## Homebrew

Homebrew is the best second channel for macOS users. Add it once the CLI contract and package name are stable.

Two workable formula shapes:

- Install the npm package through Homebrew's Node support.
- Install a tagged source archive and symlink `bin/screenshotter.mjs`.

Expected install:

```sh
brew install screenshotter
```

The formula should run:

```sh
screenshotter version
screenshotter doctor --data-dir "$TMPDIR/screenshotter-test" --json
```

## Not Recommended First

- A standalone native app: too much packaging surface for a CLI-first tool.
- A Tauri app: useful later for a visual inbox, but unnecessary for the core local screenshot workflow.
- Docker: poor fit because the tool depends on macOS screenshot paths, clipboard behavior, `sips`, and Apple frameworks.
