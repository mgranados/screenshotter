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
```

`list` is read-only. `claim` atomically claims ready screenshots by changing their public status from `ready` to `claimed`.

Use `clip` for desktop apps that can accept pasted images but do not expose a public attachment API. It prepares the latest screenshot, copies the optimized image data to the macOS clipboard, and leaves the final paste action to the user.

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
  "optimized": true
}
```

Adapters should prefer `optimizedPath` and `mimeType`.
