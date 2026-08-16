import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-email-change-'))
Object.assign(process.env, {
  NODE_ENV: 'development',
  DOMAIN: 'localhost',
  PORTAL_ORIGIN: 'http://localhost',
  HOST: '127.0.0.1',
  OTP_DEV_MODE: 'true',
  DATA_DIR: dataDir,
})

const { db, createUser, getUserById, sessionForToken } = await import('../src/db.js')
const { createSession } = await import('../src/auth.js')
const { storeOtpCodes } = await import('../src/otp.js')
const { completeEmailChange, emailChangePurposes } = await import('../src/email-change.js')

function storePair(userId, currentEmail, newEmail, currentCode = '111111', newCode = '222222') {
  const purpose = emailChangePurposes(userId, newEmail)
  storeOtpCodes([
    { email: currentEmail, purpose: purpose.current, code: currentCode },
    { email: newEmail, purpose: purpose.next, code: newCode },
  ])
  return purpose
}

function otpRow(email, purpose) {
  return db.prepare('SELECT * FROM otps WHERE email=? AND purpose=?').get(email, purpose)
}

test('dual email proofs are bound, atomic, and rotate sessions', () => {
  const userId = createUser({ email: 'old@example.test', username: 'email-user', name: 'Email User' })
  const oldSession = createSession(userId)
  const purpose = storePair(userId, 'old@example.test', 'new@example.test')

  const typo = completeEmailChange({
    userId, currentEmail: 'old@example.test', newEmail: 'new@example.test',
    currentCode: '111111', newCode: '999999',
  })
  assert.equal(typo.ok, false)
  assert.equal(otpRow('old@example.test', purpose.current).attempts, 0)
  assert.equal(otpRow('new@example.test', purpose.next).attempts, 1)
  assert.equal(getUserById(userId).email, 'old@example.test')

  const changed = completeEmailChange({
    userId, currentEmail: 'old@example.test', newEmail: 'new@example.test',
    currentCode: '111111', newCode: '222222',
  })
  assert.equal(changed.ok, true)
  assert.equal(getUserById(userId).email, 'new@example.test')
  assert.equal(otpRow('old@example.test', purpose.current), undefined)
  assert.equal(otpRow('new@example.test', purpose.next), undefined)
  assert.equal(sessionForToken(oldSession.token), null)
  assert.equal(sessionForToken(changed.result.token)?.user.id, userId)
  assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(userId).n, 1)
})

test('target binding prevents proof reuse', () => {
  const userId = createUser({ email: 'bound-old@example.test', username: 'bound-user', name: 'Bound User' })
  const purpose = storePair(userId, 'bound-old@example.test', 'target-a@example.test')
  const result = completeEmailChange({
    userId, currentEmail: 'bound-old@example.test', newEmail: 'target-b@example.test',
    currentCode: '111111', newCode: '222222',
  })
  assert.equal(result.ok, false)
  assert.equal(getUserById(userId).email, 'bound-old@example.test')
  assert.ok(otpRow('bound-old@example.test', purpose.current))
  assert.ok(otpRow('target-a@example.test', purpose.next))
})

test('unique-address race rolls back proofs, email, and sessions', () => {
  const userId = createUser({ email: 'race-old@example.test', username: 'race-email', name: 'Race Email' })
  createUser({ email: 'occupied@example.test', username: 'occupied-email', name: 'Occupied' })
  const oldSession = createSession(userId)
  const purpose = storePair(userId, 'race-old@example.test', 'occupied@example.test')

  assert.throws(() => completeEmailChange({
    userId, currentEmail: 'race-old@example.test', newEmail: 'occupied@example.test',
    currentCode: '111111', newCode: '222222',
  }), /UNIQUE constraint/)
  assert.equal(getUserById(userId).email, 'race-old@example.test')
  assert.ok(otpRow('race-old@example.test', purpose.current))
  assert.ok(otpRow('occupied@example.test', purpose.next))
  assert.equal(sessionForToken(oldSession.token)?.user.id, userId)
})

test.after(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})
