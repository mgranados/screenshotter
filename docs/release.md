# Release Checklist

## GitHub

1. Create a public repository.
2. Push this folder:

   ```sh
   git remote add origin git@github.com:<owner>/agent-screens.git
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

## Homebrew Later

After the CLI contract settles, add a tap formula that installs a packaged standalone binary or source checkout wrapper.

The eventual install target should be:

```sh
brew install agent-screens
```

## v0.1 Criteria

- `agent-screens watch` works on macOS.
- `agent-screens bench --latest 10` is documented.
- pi `/screenshotter on` works through the CLI.
- Codex CLI wrapper works with `codex --image`.
- Claude Code wrapper works by passing optimized image paths in the prompt.
- Desktop app helpers copy optimized images to the clipboard.
- README explains local storage and privacy.
