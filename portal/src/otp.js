import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { config } from './config.js'
import { db } from './db.js'

/** 6-digit numeric code. */
export function generateOtpCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function hashCode(code, salt) {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex')
}

/** Persist a delivered code, replacing the previous one only after mail
 * delivery succeeds so a transport failure cannot destroy a usable OTP. */
export function storeOtpCode(email, purpose, code) {
  const salt = randomBytes(16).toString('hex')
  const now = Date.now()
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM otps WHERE email = ? AND purpose = ?').run(email, purpose)
    db.prepare(
      'INSERT INTO otps (email, purpose, code_hash, expires_at, attempts, created_at) VALUES (?,?,?,?,0,?)',
    ).run(email, purpose, `${salt}:${hashCode(code, salt)}`, now + config.otpTtlMs, now)
  })
  replace()
}

/** Issue synchronously for tests/internal callers. Network routes send first. */
export function issueOtp(email, purpose) {
  const code = generateOtpCode()
  storeOtpCode(email, purpose, code)
  return code
}

/** Constant-time verify with expiry + attempt cap. Consumes the code on success. */
export function verifyOtp(email, purpose, code) {
  const row = db.prepare(
    'SELECT * FROM otps WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
  ).get(email, purpose)
  if (!row) return { ok: false, error: 'No verification code found. Request a new one.' }
  if (Date.now() > row.expires_at) {
    db.prepare('DELETE FROM otps WHERE id = ?').run(row.id)
    return { ok: false, error: 'Code expired. Request a new one.' }
  }
  if (row.attempts >= config.otpMaxAttempts) {
    return { ok: false, error: 'Too many attempts. Request a new code.' }
  }
  const [salt, expected] = String(row.code_hash).split(':')
  const actual = Buffer.from(hashCode(String(code), salt), 'hex')
  const want = Buffer.from(expected, 'hex')
  if (actual.length !== want.length || !timingSafeEqual(actual, want)) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').run(row.id)
    return { ok: false, error: 'Incorrect code.' }
  }
  db.prepare('DELETE FROM otps WHERE id = ?').run(row.id)
  return { ok: true }
}
