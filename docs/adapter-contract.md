# Adapter Contract

Adapters should treat `screenshotter` as a local executable API.

## Commands

```sh
screenshotter prepare <path> --target <name> --json
screenshotter list --target <name> --state ready --json
screenshotter claim --target <name> --json
screenshotter clear --target <name> --json
screenshotter copy --format markdown
screenshotter clip --target <name>
screenshotter clip --target <name> --with-text
screenshotter prepare-latest --target <name> --with-target-context --json
```

`list` is read-only. `claim` atomically claims ready screenshots by changing their public status from `ready` to `claimed`.

Use `clip` for desktop apps that can accept pasted images but do not expose a public attachment API. It prepares the latest screenshot, copies the optimized image data to the macOS clipboard, and leaves the final paste action to the user.

Use `--ocr` on `prepare`, `prepare-latest`, or `claim` to extract local Apple Vision text from the source screenshot. Use `--with-text` or `--clipboard-mode both` on `clip` to copy both a text snippet and the optimized image to the pasteboard. Use `--clipboard-mode files` for apps that paste attachments more reliably than mixed text/image pasteboard items; it copies file paths for the optimized image and a `.txt` text sidecar when text is available. Use `--clipboard-mode attachments` for a generic app/web composer bundle containing a markdown context file and the optimized image file. Use `--clipboard-mode markdown` when an app drops attachments but reliably accepts plain text. Use `--clipboard-mode codex-inline` only as the Codex fallback that pastes screen text into the prompt.

When the receiving agent runs on an SSH host, add `--remote-target <ssh-host>` to attachment mode. The producer uploads the sidecar and image to the remote private inbox before copying a versioned marker containing remote paths. Adapters should consume `[[screenshotter-remote-v1]]` bundles before normal prompt expansion, validate that both canonical paths remain inside `~/.cache/screenshotter/inbox`, inline the context file, and attach the image bytes. Invalid bundles must remain ordinary text or fail closed without reading arbitrary paths.

When an adapter can read text directly from a browser DOM, native accessibility tree, or explicitly copied selection, it should prefer that direct text over OCR and still attach `optimizedPath` for visual context. OCR is the fallback for pixels-only surfaces.

Use `--with-target-context` only when app/window routing metadata is useful. It records `screenTarget` with the frontmost app and the window under the pointer at prepare time; it does not read DOM text by itself.

## Screen Object

```json
{
  "id": "scr_abcd1234_mpgt",
  "hash": "sha256...",
  "sourcePath": "/Users/me/Desktop/Screenshot.png",
  "optimizedPath": "/Users/me/Library/Application Support/screenshotter/optimized/abcd.jpg",
  "mimeType": "image/jpeg",
  "createdAt": "2026-05-22T10:00:00.000Z",
  "preparedAt": "2026-05-22T10:00:01.000Z",
  "claimedAt": null,
  "status": "ready",
  "clearedAt": null,
  "target": "codex",
  "originalBytes": 1000000,
  "optimizedBytes": 250000,
  "width": 2400,
  "height": 1350,
  "originalWidth": 3000,
  "originalHeight": 1688,
  "optimized": true,
  "ocrText": "Visible text from the screenshot",
  "ocrTextLength": 32,
  "ocr": {
    "status": "ready",
    "level": "accurate",
    "languages": ["en-US"],
    "usesLanguageCorrection": true,
    "extractedAt": "2026-05-22T10:00:01.000Z",
    "durationMs": 42.1,
    "error": null
  },
  "screenTarget": {
    "status": "ready",
    "collectedAt": "2026-05-22T10:00:01.000Z",
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
      "pid": 123
    },
    "error": null
  }
}
```

Adapters should prefer `optimizedPath` and `mimeType`.
