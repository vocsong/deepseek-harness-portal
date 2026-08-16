import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

function num(name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : Number(v)
}

const smtpConfigured = Boolean(process.env.SMTP_HOST)

export const config = {
  // Portal listen address (cloudflared on this host connects here).
  port: num('PORT', 8080),
  host: process.env.HOST ?? '127.0.0.1',

  // Apex/portal domain (login + admin UI). Override in production.
  domain: process.env.DOMAIN ?? 'example.com',

  // Base domain for per-instance subdomains: <slug>.<instanceDomain>.
  instanceDomain: process.env.INSTANCE_DOMAIN ?? 'example.com',

  // Suffix appended to the username-derived instance slug.
  instanceSlugSuffix: process.env.INSTANCE_SLUG_SUFFIX ?? '-deepseek',

  // Session cookie Domain. Empty = host-only (local dev).
  cookieDomain: process.env.COOKIE_DOMAIN ?? '',

  dataDir: process.env.DATA_DIR ?? join(root, 'data'),
  image: process.env.DSH_IMAGE ?? 'dsh:latest',

  // Host loopback port pool for published instance ports.
  portRangeStart: num('PORT_RANGE_START', 18000),
  portRangeEnd: num('PORT_RANGE_END', 18100),

  // Seeded admin account (created at first boot if absent).
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  adminName: process.env.ADMIN_NAME ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'changeme',

  instanceStartTimeoutMs: num('INSTANCE_START_TIMEOUT_MS', 180000),
  instanceCpus: process.env.INSTANCE_CPUS ?? '2',
  instanceMemory: process.env.INSTANCE_MEMORY ?? '2g',

  // ---- email / OTP ----
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: num('SMTP_PORT', 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
  },
  // When no SMTP host is configured (or OTP_DEV_MODE=true), OTP codes are
  // logged to the console and returned in the API response for testing.
  otpDevMode: process.env.OTP_DEV_MODE === 'true' || !smtpConfigured,
  otpTtlMs: num('OTP_TTL_MS', 10 * 60 * 1000),
  otpMaxAttempts: num('OTP_MAX_ATTEMPTS', 5),
}
