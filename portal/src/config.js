import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

function num(name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : Number(v)
}

const domain = process.env.DOMAIN ?? 'example.com'
const portalOrigin = (() => {
  const raw = process.env.PORTAL_ORIGIN ?? `https://${domain}`
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported scheme')
    return url.origin
  } catch {
    throw new Error(`PORTAL_ORIGIN must be an absolute http(s) origin (received "${raw}")`)
  }
})()

export const config = {
  environment: process.env.NODE_ENV ?? 'production',

  // Portal listen address (cloudflared on this host connects here).
  port: num('PORT', 8080),
  host: process.env.HOST ?? '127.0.0.1',

  // Apex/portal domain (login + admin UI). Override in production.
  domain,
  portalOrigin,

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
  adminEmail: process.env.ADMIN_EMAIL ?? '',
  adminName: process.env.ADMIN_NAME ?? '',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',

  instanceStartTimeoutMs: num('INSTANCE_START_TIMEOUT_MS', 180000),
  instanceCpus: process.env.INSTANCE_CPUS ?? '2',
  instanceMemory: process.env.INSTANCE_MEMORY ?? '2g',

  // Auto-stop instances after this much inactivity (no proxied requests).
  idleTimeoutMs: num('INSTANCE_IDLE_TIMEOUT_MS', 15 * 60 * 1000),
  // How often the idle sweep runs.
  idleSweepIntervalMs: num('INSTANCE_IDLE_SWEEP_INTERVAL_MS', 60 * 1000),

  // ---- email / OTP ----
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: num('SMTP_PORT', 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
  },
  // Development OTP logging must be explicitly enabled. Production never
  // infers dev mode from missing SMTP configuration.
  otpDevMode: process.env.OTP_DEV_MODE === 'true',
  otpTtlMs: num('OTP_TTL_MS', 10 * 60 * 1000),
  otpMaxAttempts: num('OTP_MAX_ATTEMPTS', 5),
}

export function validateConfig() {
  const localDomain = new Set(['localhost', '127.0.0.1', '[::1]']).has(config.domain.toLowerCase())
  const loopbackBind = new Set(['127.0.0.1', '::1', 'localhost']).has(config.host.toLowerCase())
  if (config.otpDevMode && (config.environment !== 'development' || !localDomain || !loopbackBind)) {
    throw new Error('OTP_DEV_MODE=true is allowed only with NODE_ENV=development on a loopback-only localhost deployment')
  }
  if (!config.otpDevMode) {
    if (!config.smtp.host || !config.smtp.from) {
      throw new Error('SMTP_HOST and SMTP_FROM are required unless explicit localhost development OTP mode is enabled')
    }
    if (Boolean(config.smtp.user) !== Boolean(config.smtp.pass)) {
      throw new Error('SMTP_USER and SMTP_PASS must either both be set or both be empty')
    }
  }
  if (!Number.isInteger(config.smtp.port) || config.smtp.port < 1 || config.smtp.port > 65535) {
    throw new Error('SMTP_PORT must be an integer from 1 to 65535')
  }
  if (!Number.isFinite(config.otpTtlMs) || config.otpTtlMs <= 0) throw new Error('OTP_TTL_MS must be positive')
  if (!Number.isInteger(config.otpMaxAttempts) || config.otpMaxAttempts < 1) throw new Error('OTP_MAX_ATTEMPTS must be a positive integer')
}
