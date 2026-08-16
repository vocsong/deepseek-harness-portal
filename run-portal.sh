#!/bin/bash
# Run the portal (foreground).
set -euo pipefail
cd "$(dirname "$0")"

# Load .env if present (gitignored; see .env.example).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

cd portal

export NODE_ENV="${NODE_ENV:-production}"
export DOMAIN="${DOMAIN:-example.com}"
export PORTAL_ORIGIN="${PORTAL_ORIGIN:-https://${DOMAIN}}"
export INSTANCE_DOMAIN="${INSTANCE_DOMAIN:-example.com}"
export INSTANCE_SLUG_SUFFIX="${INSTANCE_SLUG_SUFFIX:--deepseek}"
export COOKIE_DOMAIN="${COOKIE_DOMAIN:-}"
export PORT="${PORT:-8080}"

# Seeded admin (first boot only). Startup refuses to seed without an explicit
# non-placeholder password of at least 16 characters.
export ADMIN_EMAIL="${ADMIN_EMAIL:-}"
export ADMIN_NAME="${ADMIN_NAME:-}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

# Email / OTP. Production requires SMTP. Development OTP logging requires
# NODE_ENV=development, DOMAIN=localhost, and explicit OTP_DEV_MODE=true.
export SMTP_HOST="${SMTP_HOST:-}"
export SMTP_PORT="${SMTP_PORT:-587}"
export SMTP_SECURE="${SMTP_SECURE:-false}"
export SMTP_USER="${SMTP_USER:-}"
export SMTP_PASS="${SMTP_PASS:-}"
export SMTP_FROM="${SMTP_FROM:-}"
export OTP_DEV_MODE="${OTP_DEV_MODE:-}"

export INSTANCE_CPUS="${INSTANCE_CPUS:-2}"
export INSTANCE_MEMORY="${INSTANCE_MEMORY:-2g}"
export INSTANCE_IDLE_TIMEOUT_MS="${INSTANCE_IDLE_TIMEOUT_MS:-900000}"
export INSTANCE_IDLE_SWEEP_INTERVAL_MS="${INSTANCE_IDLE_SWEEP_INTERVAL_MS:-60000}"

exec node src/index.js
