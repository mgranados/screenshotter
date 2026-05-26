#!/usr/bin/env bash
set -euo pipefail

agent_screens="${AGENT_SCREENS_BIN:-agent-screens}"
exec "$agent_screens" codex -- "$@"
