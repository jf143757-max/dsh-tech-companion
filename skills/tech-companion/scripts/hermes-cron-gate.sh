#!/usr/bin/env bash
# Hermes cron pre-check for the 吱吱老师 daily digest (agent mode).
# Copy to ~/.hermes/scripts/ and attach with --script; schedule it every 30 min.
# Before digestTime, after today's check, in manual mode, or on an empty day it
# prints {"wakeAgent": false}, so Hermes skips the model and sends nothing.
set -euo pipefail
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
CLI="${TECH_COMPANION_CLI:-}"
if [ -z "$CLI" ]; then
  CLI="$(find -L "$HERMES_HOME/skills" -path '*/tech-companion/scripts/companion.mjs' -print -quit 2>/dev/null || true)"
fi
if [ -z "$CLI" ] || ! command -v node >/dev/null 2>&1; then
  echo "tech-companion: companion.mjs or node not found" >&2
  exit 1
fi
exec node "$CLI" cron-gate
