import { createHash } from 'node:crypto'
import { createSession } from './auth.js'
import { db, deleteAllSessionsForUser } from './db.js'
import { sendOtpCode } from './mailer.js'
import { consumeOtpProofs, generateOtpCode, storeOtpCodes } from './otp.js'

export function emailChangePurposes(userId, newEmail) {
  const target = createHash('sha256').update(String(newEmail)).digest('hex').slice(0, 32)
  const prefix = `profile-email:${userId}:${target}`
  return { current: `${prefix}:current`, next: `${prefix}:new` }
}

export async function requestEmailChangeProofs(user, newEmail) {
  const purpose = emailChangePurposes(user.id, newEmail)
  const currentCode = generateOtpCode()
  let newCode = generateOtpCode()
  while (newCode === currentCode) newCode = generateOtpCode()

  // SMTP cannot be transactional, but persistence can: if either delivery
  // fails, retain any previously usable pair and store neither new proof.
  await Promise.all([
    sendOtpCode(user.email, currentCode, 'email-change-current'),
    sendOtpCode(newEmail, newCode, 'email-change-new'),
  ])
  storeOtpCodes([
    { email: user.email, purpose: purpose.current, code: currentCode },
    { email: newEmail, purpose: purpose.next, code: newCode },
  ])
}

export function completeEmailChange({ userId, currentEmail, newEmail, currentCode, newCode }) {
  const purpose = emailChangePurposes(userId, newEmail)
  return consumeOtpProofs([
    { email: currentEmail, purpose: purpose.current, code: currentCode },
    { email: newEmail, purpose: purpose.next, code: newCode },
  ], () => {
    const changed = db.prepare(
      'UPDATE users SET email = ? WHERE id = ? AND email = ?',
    ).run(newEmail, userId, currentEmail).changes
    if (changed !== 1) throw new Error('email-change-state-conflict')
    deleteAllSessionsForUser(userId)
    return createSession(userId)
  })
}
