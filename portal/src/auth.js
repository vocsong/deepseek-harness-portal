import bcrypt from 'bcryptjs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { deleteSession, insertSession } from './db.js'

export function hashPassword(password) {
  return bcrypt.hashSync(password, 10)
}

export function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash)
}

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase()
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function createSession(userId) {
  const token = randomBytes(32).toString('hex')
  const csrfToken = randomBytes(32).toString('hex')
  insertSession(token, userId, csrfToken)
  return { token, csrfToken }
}

export function verifyCsrfToken(actual, expected) {
  if (!/^[a-f0-9]{64}$/.test(String(actual ?? '')) || !/^[a-f0-9]{64}$/.test(String(expected ?? ''))) return false
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

export function destroySession(token) {
  deleteSession(token)
}

export const SESSION_COOKIE = 'portal_session'

// Cookie names used by earlier releases. Cleared on logout so browsers
// don't accumulate dead cookies; the server never reads them.
export const LEGACY_SESSION_COOKIES = ['dsp_session']
