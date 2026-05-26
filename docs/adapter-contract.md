# Adapter Contract

Adapters should treat `agent-screens` as a local executable API.

## Commands

```sh
agent-screens prepare <path> --target <name> --json
agent-screens list --target <name> --state ready --json
agent-screens claim --target <name> --json
agent-screens clear --target <name> --json
agent-screens copy --format markdown
agent-screens clip --target <name>
```

`list` is read-only. `claim` atomically claims ready screenshots by changing their public status from `ready` to `claimed`.

Use `clip` for desktop apps that can accept pasted images but do not expose a public attachment API. It prepares the latest screenshot, copies the optimized image data to the macOS clipboard, and leaves the final paste action to the user.

Compatibility aliases remain available for existing adapters: `stage`, `stage-latest`, `drain`, and `--status staged/drained/cleared`.

## Screen Object

```json
{
  "id": "scr_abcd1234_mpgt",
  "hash": "sha256...",
  "sourcePath": "/Users/me/Desktop/Screenshot.png",
  "optimizedPath": "/Users/me/Library/Application Support/agent-screens/optimized/abcd.jpg",
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
