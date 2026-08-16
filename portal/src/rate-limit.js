import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { config } from './config.js'
import { db } from './db.js'

export const RATE_POLICIES = Object.freeze({
  passwordIp: { scope: 'password-ip', limit: 20 },
  passwordAccount: { scope: 'password-account', limit: 5 },
  otpRequestIp: { scope: 'otp-request-ip', limit: 10 },
  otpRequestAccount: { scope: 'otp-request-account', limit: 3 },
  otpResendAccount: { scope: 'otp-resend-account', limit: 1 },
  otpVerifyIp: { scope: 'otp-verify-ip', limit: 20 },
  otpVerifyAccount: { scope: 'otp-verify-account', limit: 5 },
  registerIp: { scope: 'register-ip', limit: 10 },
  registerAccount: { scope: 'register-account', limit: 5 },
  inviteIp: { scope: 'invite-ip', limit: 5 },
  inviteGlobal: { scope: 'invite-global', limit: 30, windowMs: 60 * 60 * 1000, blockMs: 60 * 60 * 1000 },
  smtpGlobal: { scope: 'smtp-global', limit: 100, windowMs: 60 * 60 * 1000 },
})

function hashSubject(subject) {
  return createHash('sha256').update(String(subject ?? '')).digest('hex')
}

const consumeTx = db.transaction(({ scope, subject, limit, windowMs, blockMs, now }) => {
  const subjectHash = hashSubject(subject)
  const row = db.prepare(
    'SELECT * FROM auth_rate_limits WHERE scope = ? AND subject_hash = ?',
  ).get(scope, subjectHash)

  // A block may extend beyond its original counting window; never reset the
  // row before honoring blocked_until.
  if (row?.blocked_until > now) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((row.blocked_until - now) / 1000)) }
  }

  if (!row || row.window_started_at + windowMs <= now) {
    db.prepare(`INSERT INTO auth_rate_limits
        (scope, subject_hash, window_started_at, attempts, blocked_until, updated_at)
        VALUES (?,?,?,1,0,?)
        ON CONFLICT(scope, subject_hash) DO UPDATE SET
          window_started_at=excluded.window_started_at, attempts=1,
          blocked_until=0, updated_at=excluded.updated_at`)
      .run(scope, subjectHash, now, now)
    return { allowed: true, retryAfterSeconds: 0 }
  }

  const attempts = row.attempts + 1
  if (attempts > limit) {
    const blockedUntil = now + blockMs
    db.prepare(`UPDATE auth_rate_limits SET attempts=?, blocked_until=?, updated_at=?
                WHERE scope=? AND subject_hash=?`)
      .run(attempts, blockedUntil, now, scope, subjectHash)
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(blockMs / 1000)) }
  }

  db.prepare(`UPDATE auth_rate_limits SET attempts=?, updated_at=?
              WHERE scope=? AND subject_hash=?`)
    .run(attempts, now, scope, subjectHash)
  return { allowed: true, retryAfterSeconds: 0 }
})

let cleanupCounter = 0
export function consumeRateLimit(policy, subject, overrides = {}) {
  const result = consumeTx({
    scope: policy.scope,
    subject,
    limit: overrides.limit ?? policy.limit,
    windowMs: overrides.windowMs ?? policy.windowMs ?? config.authRateWindowMs,
    blockMs: overrides.blockMs ?? policy.blockMs ?? config.authRateBlockMs,
    now: overrides.now ?? Date.now(),
  })
  cleanupCounter += 1
  if (cleanupCounter % 200 === 0) {
    db.prepare('DELETE FROM auth_rate_limits WHERE updated_at < ?').run(Date.now() - 7 * 24 * 60 * 60 * 1000)
  }
  return result
}

export function clearRateLimit(policy, subject) {
  db.prepare('DELETE FROM auth_rate_limits WHERE scope=? AND subject_hash=?')
    .run(policy.scope, hashSubject(subject))
}

function normalizeAddress(value) {
  const raw = String(value ?? '').trim()
  if (raw.startsWith('::ffff:') && isIP(raw.slice(7)) === 4) return raw.slice(7)
  return isIP(raw) ? raw : ''
}

function isLoopback(address) {
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.')
}

export function clientIp(req) {
  const remote = normalizeAddress(req.raw?.socket?.remoteAddress)
  const forwardedRaw = Array.isArray(req.headers?.['cf-connecting-ip'])
    ? req.headers['cf-connecting-ip'][0]
    : req.headers?.['cf-connecting-ip']
  const forwarded = normalizeAddress(String(forwardedRaw ?? '').split(',')[0])
  if (isLoopback(remote) && forwarded) return forwarded
  return remote || 'unknown'
}
