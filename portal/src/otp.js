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

/** Persist delivered codes atomically, replacing previous values only after
 * every corresponding mail delivery succeeds. */
export function storeOtpCodes(entries) {
  const now = Date.now()
  const rows = entries.map(({ email, purpose, code }) => {
    const salt = randomBytes(16).toString('hex')
    return { email, purpose, codeHash: `${salt}:${hashCode(code, salt)}` }
  })
  db.transaction(() => {
    for (const row of rows) {
      db.prepare('DELETE FROM otps WHERE email = ? AND purpose = ?').run(row.email, row.purpose)
      db.prepare(
        'INSERT INTO otps (email, purpose, code_hash, expires_at, attempts, created_at) VALUES (?,?,?,?,0,?)',
      ).run(row.email, row.purpose, row.codeHash, now + config.otpTtlMs, now)
    }
  })()
}

export function storeOtpCode(email, purpose, code) {
  storeOtpCodes([{ email, purpose, code }])
}

/** Issue synchronously for tests/internal callers. Network routes send first. */
export function issueOtp(email, purpose) {
  const code = generateOtpCode()
  storeOtpCode(email, purpose, code)
  return code
}

function evaluateOtp(row, code, now) {
  if (!row) return { ok: false, failure: 'missing' }
  if (now > row.expires_at) return { ok: false, failure: 'expired', row }
  if (row.attempts >= config.otpMaxAttempts) return { ok: false, failure: 'attempts', row }
  const [salt, expected] = String(row.code_hash).split(':')
  const actual = Buffer.from(hashCode(String(code), salt), 'hex')
  const want = Buffer.from(expected, 'hex')
  if (actual.length !== want.length || !timingSafeEqual(actual, want)) {
    return { ok: false, failure: 'incorrect', row }
  }
  return { ok: true, row }
}

/** Atomically validate multiple independently bound proofs. Invalid proofs
 * accrue attempts without consuming valid counterparts; all proofs are
 * consumed only if commit() and every verification succeed. */
export function consumeOtpProofs(proofs, commit = () => undefined) {
  return db.transaction(() => {
    const now = Date.now()
    const checked = proofs.map((proof) => {
      const row = db.prepare(
        'SELECT * FROM otps WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
      ).get(proof.email, proof.purpose)
      return evaluateOtp(row, proof.code, now)
    })
    if (checked.some((item) => !item.ok)) {
      for (const item of checked) {
        if (item.failure === 'expired') db.prepare('DELETE FROM otps WHERE id = ?').run(item.row.id)
        if (item.failure === 'incorrect') db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').run(item.row.id)
      }
      return { ok: false }
    }
    const result = commit()
    for (const item of checked) db.prepare('DELETE FROM otps WHERE id = ?').run(item.row.id)
    return { ok: true, result }
  })()
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
