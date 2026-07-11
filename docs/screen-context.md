# Screen Context

Feature spec for text-aware screenshot handoff.

## Problem

Screenshots are good visual context, but pixels are a lossy way to carry text. Coding agents often need both:

- The visual state: layout, chrome, selection, colors, icons, canvas, terminal panes.
- The semantic text: labels, logs, table cells, code snippets, error messages, URLs.

The product should capture compact screen context for agents: compressed snaps plus exact text when available.

## Goal

When a user takes a screenshot or asks for the latest screen, `screenshotter` should prepare one context bundle:

```text
screen context = compressed screenshot + best available text
```

The bundle should be usable through the same surfaces that already exist:

- Clipboard paste into Codex, Claude, and desktop apps.
- pi prompt transform.
- CLI `prepare` / `claim` JSON.
- MCP tool responses.
- Wrapper workflows for Codex CLI and Claude Code.

## Non-goals

- Do not become a general OCR app.
- Do not build a persistent screenshot history UI for this feature.
- Do not upload screenshots or text in normal workflows.
- Do not use intrusive copy/select automation by default.
- Do not require browser or Accessibility permissions for image-only use.

## Provider Priority

Text providers should run in this order:

1. `selection`
   - Explicit user selection or already-available selected text.
   - Highest signal, lowest scope.
2. `macos-accessibility`
   - Frontmost app/window title, focused text, selected text, and visible AX static text.
   - Best default for native apps, Electron apps, and browsers that expose accessibility trees with one OS-level permission.
3. `browser-dom`
   - Active browser tab title, URL, selected text, and visible `document.body.innerText`.
   - Higher fidelity for web apps and docs, but requires browser automation or an extension.
4. `apple-vision-ocr`
   - Local OCR from screenshot pixels.
   - Fallback for canvas, image-only surfaces, remote desktops, and inaccessible apps.

Default policy:

```text
use first high-confidence direct provider; skip OCR unless direct text is empty or --ocr is explicit
```

## Context Object

Every prepared screen can include text context:

```json
{
  "textContext": {
    "text": "Visible or selected text...",
    "provider": "browser-dom",
    "source": "Google Chrome active tab",
    "app": "Google Chrome",
    "windowTitle": "Issue 123 - GitHub",
    "url": "https://github.com/example/repo/issues/123",
    "confidence": 1,
    "durationMs": 12.4,
    "collectedAt": "2026-07-07T12:00:00.000Z"
  },
  "textSources": [
    {
      "provider": "browser-dom",
      "status": "ready",
      "textLength": 1200,
      "durationMs": 12.4
    },
    {
      "provider": "apple-vision-ocr",
      "status": "skipped",
      "reason": "direct text available"
    }
  ]
}
```

Existing OCR fields can remain for compatibility during the prototype, but the long-term public shape should prefer `textContext` and `textSources`.

When target context is explicitly enabled, the same screen can also include app/window hints collected near prepare time:

```json
{
  "screenTarget": {
    "status": "ready",
    "collectedAt": "2026-07-07T12:00:00.000Z",
    "durationMs": 8.3,
    "frontmostApp": {
      "name": "Google Chrome",
      "pid": 123,
      "bundleId": "com.google.Chrome"
    },
    "pointer": {
      "x": 640,
      "y": 420
    },
    "pointerWindow": {
      "ownerName": "Google Chrome",
      "windowTitle": "Issue 123 - GitHub",
      "pid": 123,
      "windowNumber": 42,
      "layer": 0,
      "bounds": {
        "x": 80,
        "y": 60,
        "width": 1440,
        "height": 900
      }
    },
    "error": null
  }
}
```

`screenTarget` is adjacent context, not text extraction. It helps choose a direct text provider, label snippets, and debug mismatches between a screenshot and the current app.

## CLI UX

Image-only workflows remain unchanged:

```sh
screenshotter watch --verbose
screenshotter clip --target codex-app
```

Text-aware workflows:

```sh
screenshotter watch --with-text --verbose
screenshotter clip --with-text --target codex-app
screenshotter prepare-latest --with-text --json
screenshotter claim --target pi --with-text --json
```

Target-aware workflows are opt-in:

```sh
screenshotter watch --with-target-context --verbose
screenshotter clip --with-target-context --target codex-app
screenshotter prepare-latest --with-target-context --json
```

Provider controls:

```sh
screenshotter prepare-latest --text-provider auto --json
screenshotter prepare-latest --text-provider browser-dom --json
screenshotter prepare-latest --text-provider accessibility --json
screenshotter prepare-latest --text-provider ocr --json
screenshotter prepare-latest --no-text --json
```

Suggested semantics:

- `--with-text`: collect direct text through macOS Accessibility and paste/return it with the image.
- `--ocr`: force OCR as a provider, even when direct text exists.
- `--text-provider auto`: explicitly use Accessibility first, then OCR fallback.
- `--text-provider none` or `--no-text`: image only.
- `--text-max-chars n`: truncate pasted text snippets.
- `--no-ocr`: disable OCR fallback when using the auto provider.
- `--with-target-context`: collect frontmost app and window-under-pointer metadata.
- `--clipboard-mode files`: copy attachable file URLs for the optimized image and a text sidecar.
- `--clipboard-mode attachments`: collect direct text and target context, then copy attachable file URLs for a markdown context file and optimized image.
- `--clipboard-mode markdown`: copy one plain-text prompt with extracted text plus optimized image path.
- `--clipboard-mode codex-inline`: fallback Codex app automation that pastes text inline first, then the optimized image.

## Clipboard Behavior

For desktop apps, `--with-text` should copy two pasteboard objects by default:

1. Plain-text context snippet.
2. Optimized screenshot image.

Apps that accept both get both in one paste. Apps with narrower paste support use the representation they understand.

Use `--clipboard-mode attachments` when both text context and image attachment must land in an app or web composer. It copies a `.md` context file and the optimized image file to the clipboard as file URLs, so the user can paste once into Codex, Claude, claude.ai, or another file-aware composer. Pair it with `--no-ocr` when OCR noise is worse than missing text. Use `codex-inline` only if Codex refuses the `.md` attachment.

Recommended text format:

```text
Screen text from Google Chrome - Issue 123 - GitHub
URL: https://github.com/example/repo/issues/123

<text snippet>
```

If no direct text is available and OCR is unavailable, paste image only and report `textContext: null`.

## Permissions

Permissions should be explicit and provider-specific.

| Provider | Permission | Notes |
| --- | --- | --- |
| `macos-accessibility` | macOS Accessibility permission | One OS-level grant to the terminal/helper running screenshotter. Reads exposed AX tree text without per-target-app automation. Uses app-family roots for common browsers, Slack, Notion, VS Code, Claude, Codex, Ghostty, iTerm2, Terminal, Warp, WezTerm, Alacritty, and kitty. |
| `browser-dom` via extension | Browser extension active tab permission | Preferred for browsers because scope is visible and revocable. |
| `browser-dom` via AppleScript/JXA | Browser automation permission | Good prototype, less ideal long-term. Safari also requires Develop -> Allow JavaScript from Apple Events. |
| `screenTarget` | Screen Recording may be needed for full window titles on modern macOS | Always opt-in. Used for app/window routing, not for reading page text. |
| `selection` copy automation | Accessibility + clipboard mutation | Only behind an explicit flag; restore clipboard where possible. |
| `apple-vision-ocr` | Local Vision framework | No app text permission, but can fail in restricted sandboxes. |

`screenshotter doctor` should report provider readiness without failing image-only use.

## Implementation Shape

Keep the feature in this repo, but behind provider boundaries:

```text
src/context/
  collect-context.js
  merge-text-sources.js
  providers/
    browser-dom.js
    macos-accessibility.js
    clipboard-selection.js
    apple-vision-ocr.js
scripts/
  macos-accessibility-text.swift
  screen-target-snapshot.swift
extensions/
  browser-dom/
```

Core flow:

```js
const image = await prepareImage(sourcePath, options);
const text = await collectTextContext({ providers, sourcePath, frontmostApp });
const screen = await storeScreen({ image, text });
```

Adapters should consume one screen object instead of separately calling image and text helpers.

## Browser DOM Provider

Prototype:

- Detect frontmost browser app.
- Use JXA/AppleScript to read active tab `document.title`, `location.href`, `window.getSelection().toString()`, and `document.body.innerText`.
- Return a provider failure when automation is denied.

Long-term:

- Ship a browser extension under this repo.
- Extension collects active tab text on demand.
- Local native-messaging or localhost bridge hands text to the CLI.
- Avoid persistent broad page access where possible; prefer active-tab gesture semantics.

## macOS Accessibility Provider

Prototype:

- Swift helper finds `NSWorkspace.shared.frontmostApplication`.
- Reads focused window title.
- Reads selected/focused text if exposed.
- Recursively collects visible `AXStaticText`, `AXTextField`, and related text roles.
- Caps depth, node count, and output length.

Failure modes:

- Accessibility permission denied.
- App exposes no useful AX text.
- Text order is incomplete or noisy.

## Quality Gates

Use separate gates for separate claims:

```sh
npm run bench:text-sources
npm run eval:accessibility-provider -- --json
npm run eval:context-adversarial
```

Minimum acceptance:

- Accessibility provider F1: `>= 0.95` against the native fixture app.
- OCR fallback F1: `>= 0.85` when Vision is available.
- Accessibility fixture latency gate: `<= 250 ms`, including helper process startup.
- OCR latency can be slower because it is fallback.

`bench:text-sources` renders native fixture PNGs and validates OCR plus the scoring baseline. Its generated-source result is not evidence for a live DOM or Accessibility provider. `eval:accessibility-provider` launches a native fixture app and invokes the exact shipped Accessibility helper against its PID. Missing permission, empty output, and low F1 all fail distinctly. Browser DOM still needs its own browser-driven fixture evaluation before it can make the same quality claim.

The adversarial suite is deterministic and covers opt-in redaction, stale OCR removal, output caps, pointer targeting, shared artifacts, concurrent commits, retention, corrupt state, helper fingerprints, terminal/browser/assistant cleanup fixtures, benchmark fail-closed behavior, and MCP responsiveness.

## Implementation Status

The CLI, JavaScript API, pi extension, MCP server, clipboard bundles, target snapshots, Accessibility provider, explicit browser DOM provider, and OCR fallback all use the shared `textContext` / `textSources` shape. Image-only use remains the default. The remaining provider-quality gap is a browser-driven live DOM fixture evaluation.

## Product Copy

Short:

> Local screen context for coding agents: compressed snaps plus exact text when available.

Long:

> Take a normal macOS screenshot. `screenshotter` prepares a compact screen-context bundle for your agent: an optimized image for visual state, and direct text from the browser, app, or local OCR when available.
