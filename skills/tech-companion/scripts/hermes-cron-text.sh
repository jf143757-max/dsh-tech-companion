#!/usr/bin/env bash
# Hermes no-agent cron script for the 吱吱老师 daily digest (zero model calls).
# Copy to ~/.hermes/scripts/ and create the job with --no-agent; schedule it every 30 min.
# Prints the digest text once a day after digestTime; prints nothing otherwise,
# which Hermes treats as a silent tick. The 复盘小问题 is a template here, because
# no model runs to find the common thread.
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
exec node "$CLI" cron-text
