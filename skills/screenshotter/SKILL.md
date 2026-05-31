---
name: screenshotter
description: "Use when the user wants native macOS Cmd+Shift+3 or Cmd+Shift+4 screenshots captured by pi through the local screenshotter CLI without copy/paste or drag/drop."
---

# Screenshotter

Use this skill when the user asks about using screenshots with pi, especially native macOS `Cmd+Shift+3` or `Cmd+Shift+4` captures.

## Current behavior

The screenshotter package provides `/screenshotter` commands backed by the local `screenshotter` CLI:

- Screenshotter is **off by default**.
- `/screenshotter on` enables watching the macOS screenshot save folder for this pi session.
- Native `Cmd+Shift+3` and `Cmd+Shift+4` screenshots are detected while pi is idle.
- Detected screenshots are prepared and optimized locally by `screenshotter` using the high-fidelity `readability` profile by default.
- Captured screenshots attach to the next interactive prompt the user submits.
- Screenshots captured while the agent is already running are ignored.
- `/screenshotter token` switches to the cost-focused percentage profile when image-token cost matters more than tiny text.
- `/screenshotter balanced` switches to the 2200 px debugging profile.
- `/screenshotter off` disables watching and clears ready pi screenshots.

## Commands

```text
/screenshotter on      enable live native screenshot capture
/screenshotter token   use the cost-focused percentage profile
/screenshotter balanced use the safer 2200 px debugging profile
/screenshotter readability use the default higher-fidelity profile
/screenshotter off     disable capture and clear ready screenshots
/screenshotter status  show watcher mode, ready count, byte savings, and estimated token savings
/screenshotter clear   clear ready screenshots
```

## Agent guidance

- Do not ask the user to paste, copy, or drag/drop a screenshot when `/screenshotter on` is a better fit.
- If the user asks why nothing attached, check whether `/screenshotter on` was enabled, whether pi was idle when the screenshot was taken, and whether `/screenshotter clear` or `/screenshotter off` was used.
- Treat attached screenshots as visual context for the user's prompt; do not mention implementation details unless relevant.
