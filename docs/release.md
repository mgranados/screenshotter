# Release Checklist

## Preflight

1. Confirm package metadata:
   - `name`
   - `version`
   - `description`
   - `license`
   - `repository`
   - `bugs`
   - `homepage`
2. Update `CHANGELOG.md`.
3. Run:

   ```sh
   npm run check
   npm run bench:text-sources
   npm run eval:accessibility-provider -- --json
   npm run pack:dry-run
   ```

   The Accessibility gate needs the local macOS grant. Use `-- --prompt-permissions` when setting up a new release machine. `npm run check` already includes Swift type-checking and the deterministic adversarial suite.

## GitHub

1. Create a public repository.
2. Push this folder:

   ```sh
   git remote add origin git@github.com:mgranados/screenshotter.git
   git branch -M main
   git push -u origin main
   ```

3. Verify GitHub Actions passes on macOS.
4. Create a release tag:

   ```sh
   git tag v0.0.1
   git push origin v0.0.1
   ```

5. Attach a short release note with:
   - local-first macOS screenshot attachments
   - Codex CLI wrapper
   - Claude Code wrapper
   - Codex/Claude desktop clipboard helpers
   - pi `/screenshotter on` extension

## npm

The first public distribution should be npm:

```sh
npm publish --access public
```

Expected user install:

```sh
npm install -g @marttinn/screenshotter
screenshotter doctor
```

After publishing, verify from a clean directory:

```sh
npm view @marttinn/screenshotter version
npx @marttinn/screenshotter version
```

## Homebrew Later

After the CLI contract settles, add a tap formula that installs a packaged standalone binary or source checkout wrapper.

The eventual install target should be:

```sh
brew install screenshotter
```

## v0.1 Criteria

- `screenshotter watch` works on macOS and auto-detects the likely agent target.
- `screenshotter doctor` reports required setup checks clearly.
- `screenshotter bench --latest 10` is documented.
- pi `/screenshotter on` works through the CLI.
- Codex CLI wrapper works with `codex --image`.
- Claude Code wrapper works by passing optimized image paths in the prompt.
- MCP server initializes and returns image content from the smoke test.
- Desktop app helpers copy optimized images to the clipboard.
- README explains local storage and privacy.
