#!/bin/bash
set -euo pipefail

PORT="${PORT:-3000}"
ARGS=(web --host 0.0.0.0 --port "$PORT")
if [ -n "${TRUSTED_HOST:-}" ]; then
  ARGS+=(--trusted-host "$TRUSTED_HOST")
fi

cd /app/dsh
exec node --import tsx/esm apps/cli/src/bin.ts "${ARGS[@]}"
