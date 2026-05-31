# Security Policy

## Supported Versions

Until the project reaches `0.1.0`, only the latest commit on the default branch is supported.

## Reporting a Vulnerability

Report security issues privately to the maintainer instead of opening a public issue. Once the public GitHub repository exists, enable GitHub private vulnerability reporting and use that channel.

Include:

- A concise description of the issue.
- The affected command or integration.
- Reproduction steps using synthetic screenshots when possible.
- Whether private screenshot contents, local paths, clipboard contents, or shell execution are involved.

## Privacy Boundary

`screenshotter` is designed to be local-first:

- Normal prepare, watch, claim, clipboard, and benchmark flows do not upload screenshots.
- Original screenshots are never modified.
- Optimized copies are stored locally.
- Model-backed quality checks require explicit `--allow-external`.

Security-sensitive changes should preserve that boundary.
