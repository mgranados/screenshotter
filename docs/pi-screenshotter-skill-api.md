# pi Screenshotter Skill API

This document is the handoff contract for a pi `/screenshotter` skill that uses the local `screenshotter` CLI.

`screenshotter` is a local executable API. It does not require login, network access, MCP, or a background service. The pi skill should call the executable, read JSON from stdout, and attach returned `optimizedPath` images to the next interactive prompt.

## Vocabulary

Use these public names in the skill:

```text
prepare -> ready -> claim -> cleared
```

- `prepare`: optimize a screenshot and make it ready for a target agent.
- `ready`: screenshot is available for a future prompt.
- `claim`: atomically take ready screenshots for the current prompt.
- `claimed`: screenshot was handed to the agent.
- `cleared`: screenshot should no longer be offered.

Compatibility aliases exist, but new pi code should use `prepare`, `claim`, and `--state ready`.

## CLI Resolution

Prefer `SCREENSHOTTER_CLI` when set. Otherwise use the repo-local CLI path.

For a source checkout:

```sh
node <screenshotter-checkout>/bin/screenshotter.mjs status --json
```

For an installed package:

```sh
screenshotter status --json
```

If `SCREENSHOTTER_CLI` points to a `.js` or `.mjs` file, execute it with `node`. If it points to a binary name, execute it directly.

## Target

Use a stable pi target name:

```text
pi
```

Every prepare/list/claim/clear command should include:

```sh
--target pi
```

## Commands

Prepare one screenshot:

```sh
screenshotter prepare "/path/to/Screenshot.png" --target pi --json
```

List ready screenshots:

```sh
screenshotter list --target pi --state ready --json
```

Claim screenshots for the next prompt:

```sh
screenshotter claim --target pi --max 4 --fresh-ms 600000 --json
```

Clear pi screenshots:

```sh
screenshotter clear --target pi --json
```

Status:

```sh
screenshotter status --target pi --json
```

Get the native macOS screenshot folder:

```sh
screenshotter screenshot-dir --json
```

## JSON Shapes

Prepare response:

```json
{
  "screen": {
    "id": "scr_42b31d7edf39_mph6jxml",
    "hash": "sha256...",
    "sourcePath": "/Users/me/Desktop/Screenshot.png",
    "optimizedPath": "/Users/me/Library/Application Support/screenshotter/optimized/42b31d.jpg",
    "mimeType": "image/jpeg",
    "createdAt": "2026-05-22T16:11:28.511Z",
    "preparedAt": "2026-05-22T17:15:01.244Z",
    "claimedAt": null,
    "clearedAt": null,
    "status": "ready",
    "target": "pi",
    "originalBytes": 923722,
    "optimizedBytes": 157151,
    "width": 2200,
    "height": 1424,
    "originalWidth": 3680,
    "originalHeight": 2382,
    "optimized": true
  },
  "prepared": true
}
```

Claim response:

```json
{
  "screens": [
    {
      "id": "scr_42b31d7edf39_mph6jxml",
      "optimizedPath": "/Users/me/Library/Application Support/screenshotter/optimized/42b31d.jpg",
      "mimeType": "image/jpeg",
      "status": "claimed",
      "target": "pi",
      "preparedAt": "2026-05-22T17:15:01.244Z",
      "claimedAt": "2026-05-22T17:15:20.100Z"
    }
  ]
}
```

Status response:

```json
{
  "version": "0.0.1",
  "dataDir": "/Users/me/Library/Application Support/screenshotter",
  "screenshotDir": "/Users/me/Desktop",
  "ready": 1,
  "claimed": 0,
  "cleared": 0,
  "total": 1
}
```

The pi skill should attach `optimizedPath` and use `mimeType` as the image MIME type.

When pi itself runs on a remote SSH host, the macOS watcher cannot run inside that pi process. Run the local toolbar with `--clipboard-mode attachments --remote-target <ssh-host>` instead. Its versioned clipboard bundle points at files already uploaded to the remote private inbox. The extension consumes that bundle before the normal enabled-state check, appends the sidecar context, and supplies the image as base64 prompt content.

## Suggested pi Flow

1. `/screenshotter on`
   - Resolve the screenshot directory with `screenshotter screenshot-dir --json`.
   - Clear old pi items with `screenshotter clear --target pi --json`.
   - Watch or poll the screenshot directory.
   - Only process screenshots while pi is idle.

2. On file create/change
   - Ignore unsupported extensions.
   - Ignore files older than the `/screenshotter on` timestamp.
   - Ignore files created while the agent is running.
   - Wait briefly until the file is stable if the skill does its own stability check.
   - Run `screenshotter prepare <path> --target pi --profile readability --json` by default.
   - Refresh ready count with `screenshotter list --target pi --state ready --json`.

3. Before the next interactive user prompt
   - Wait briefly for in-flight prepare tasks.
   - Run `screenshotter claim --target pi --max 4 --fresh-ms 600000 --json`.
   - Attach each claimed screenshot from `screens[].optimizedPath`.
   - Submit the user's original text plus the image attachments.

4. `/screenshotter status`
   - Run `screenshotter status --target pi --tokens --json`.
   - Show whether watching is on, active profile, watcher mode, watched directory, `ready` count, byte savings, and estimated token savings.

5. `/screenshotter token`, `/screenshotter balanced`, `/screenshotter readability`
   - Store the selected profile for future `prepare` calls in this pi session.
   - Keep `readability` as the default so tiny UI text remains readable.

6. `/screenshotter clear`
   - Run `screenshotter clear --target pi --json`.

7. `/screenshotter off`
   - Stop the watcher.
   - Run `screenshotter clear --target pi --json`.

## Attachment Rules

- Claim at most 4 screenshots by default.
- Use a freshness window of 10 minutes by default: `--fresh-ms 600000`.
- Attach only images returned by `claim`.
- Do not attach screenshots created while the agent was busy.
- Do not ask the user to copy/paste or drag/drop when `/screenshotter on` is available.
- If no screenshots are claimed, continue the prompt without image attachments.

## Skill Instruction Block

Paste this into the pi screenshotter skill:

```md
Use the local `screenshotter` CLI as the screenshot API.

Public lifecycle: `prepare -> ready -> claim -> cleared`.

Use target `pi` for all commands.

Commands:
- `screenshotter screenshot-dir --json` to find the native macOS screenshot folder.
- `screenshotter prepare <path> --target pi --profile readability --json` when a new native screenshot is detected by default.
- `screenshotter prepare <path> --target pi --profile balanced --json` only after the user switches to the mid 3000 px profile.
- `screenshotter prepare <path> --target pi --profile token --json` only after the user switches to the aggressive readable 2200 px profile.
- `screenshotter list --target pi --state ready --json` to count ready screenshots.
- `screenshotter claim --target pi --max 4 --fresh-ms 600000 --json` immediately before the next interactive prompt.
- `screenshotter clear --target pi --json` for `/screenshotter clear` and `/screenshotter off`.
- `screenshotter status --target pi --tokens --json` for `/screenshotter status`.

Attach `screens[].optimizedPath` from the claim response to the user's next prompt. Use `screens[].mimeType` as the MIME type. Only claim while handling an interactive user prompt. Ignore screenshots captured while the agent is already running.

If `SCREENSHOTTER_CLI` is set, use it. If it points to a `.js` or `.mjs` file, execute it with `node`; otherwise execute it directly. If unset in local development, use the repo-local `bin/screenshotter.mjs`.
```
