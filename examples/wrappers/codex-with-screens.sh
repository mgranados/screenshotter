#!/usr/bin/env bash
set -euo pipefail

screenshotter_cmd="${SCREENSHOTTER_BIN:-screenshotter}"
exec "$screenshotter_cmd" codex -- "$@"
