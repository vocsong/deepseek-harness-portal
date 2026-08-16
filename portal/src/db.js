import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

mkdirSync(config.dataDir, { recursive: true })
export const db = new Database(join(config.dataDir, 'portal.db'))
db.pragma('journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  username TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  slug TEXT UNIQUE NOT NULL,
  container_name TEXT UNIQUE NOT NULL,
  host_port INTEGER UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning',
  error TEXT,
  created_at INTEGER NOT NULL,
  last_active INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  scope TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope, subject_hash)
);
`)

db.pragma('secure_delete = ON')

export function digestSessionToken(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex')
}

// Migrate the P0 plaintext-token table in one transaction. Browser cookies keep
// their raw random token; only the database representation changes to SHA-256.
const migrateSessions = db.transaction(() => {
  let columns = new Set(db.pragma('table_info(sessions)').map((row) => row.name))
  const hadPlaintextTokens = columns.has('token')
  if (hadPlaintextTokens) {
    db.prepare(`INSERT INTO settings(key,value) VALUES('session_token_cleanup_pending','true')
                ON CONFLICT(key) DO UPDATE SET value='true'`).run()
    db.exec('ALTER TABLE sessions RENAME COLUMN token TO token_hash')
    columns = new Set(db.pragma('table_info(sessions)').map((row) => row.name))
  }
  if (!columns.has('csrf_token')) db.exec('ALTER TABLE sessions ADD COLUMN csrf_token TEXT')
  if (!columns.has('last_seen_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER')
  if (!columns.has('absolute_expires_at')) db.exec('ALTER TABLE sessions ADD COLUMN absolute_expires_at INTEGER')

  if (hadPlaintextTokens) {
    const updateHash = db.prepare('UPDATE sessions SET token_hash = ? WHERE token_hash = ?')
    for (const row of db.prepare('SELECT token_hash FROM sessions').all()) {
      updateHash.run(digestSessionToken(row.token_hash), row.token_hash)
    }
  }
  const now = Date.now()
  db.prepare(`UPDATE sessions SET
      csrf_token = CASE WHEN csrf_token IS NULL OR length(csrf_token) != 64 THEN lower(hex(randomblob(32))) ELSE csrf_token END,
      last_seen_at = COALESCE(last_seen_at, ?),
      absolute_expires_at = COALESCE(absolute_expires_at, created_at + ?)`)
    .run(now, config.sessionAbsoluteTtlMs)
  db.prepare('DELETE FROM sessions WHERE absolute_expires_at <= ?').run(now)
  return hadPlaintextTokens
})
const migratedPlaintextSessions = migrateSessions()
const tokenCleanupPending = migratedPlaintextSessions
  || db.prepare("SELECT value FROM settings WHERE key='session_token_cleanup_pending'").get()?.value === 'true'
if (tokenCleanupPending) {
  const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)')
  if (!checkpoint || checkpoint.busy !== 0 || checkpoint.log !== 0) {
    throw new Error('session-token migration could not securely truncate the SQLite WAL; stop other database users and retry')
  }
  db.prepare(`INSERT INTO settings(key,value) VALUES('session_token_cleanup_pending','false')
              ON CONFLICT(key) DO UPDATE SET value='false'`).run()
}
db.exec(`
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(absolute_expires_at, last_seen_at);
  CREATE INDEX IF NOT EXISTS auth_rate_limits_cleanup_idx ON auth_rate_limits(updated_at);
`)

// ---- users ----

export function createUser({ email, username = null, name, passwordHash = null, role = 'user' }) {
  return db.prepare(
    'INSERT INTO users (email, username, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)',
  ).run(email, username, name, passwordHash, role, Date.now()).lastInsertRowid
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) ?? null
}

export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) ?? null
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null
}

export function updateUser(id, fields) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  const sets = keys.map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE users SET ${sets} WHERE id = @id`).run({ id, ...fields })
}

export function setUserPassword(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id)
}

export function listUsers() {
  return db.prepare('SELECT id, email, username, name, role, created_at FROM users ORDER BY id').all()
}

// ---- settings (admin controls) ----

export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row === undefined ? fallback : row.value
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value))
}

export function getEmailDomains() {
  return getSetting('email_domains', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function otpRegistrationEnabled() {
  return getSetting('otp_registration_enabled', 'true') === 'true'
}

export function passwordLoginEnabled() {
  return getSetting('password_login_enabled', 'true') === 'true'
}

export function getInviteCode() {
  return getSetting('invite_code', '').trim()
}

export function setInviteCode(code) {
  setSetting('invite_code', String(code ?? '').trim())
}

// ---- instances ----

export function createInstanceRow({ userId, slug, containerName, hostPort }) {
  return db.prepare(
    `INSERT INTO instances (user_id, slug, container_name, host_port, status, created_at)
     VALUES (?,?,?,?, 'provisioning', ?)`,
  ).run(userId, slug, containerName, hostPort, Date.now()).lastInsertRowid
}

export function getInstanceBySlug(slug) {
  return db.prepare('SELECT * FROM instances WHERE slug = ?').get(slug) ?? null
}

export function getInstanceByUserId(userId) {
  return db.prepare('SELECT * FROM instances WHERE user_id = ?').get(userId) ?? null
}

export function getInstanceById(id) {
  return db.prepare('SELECT * FROM instances WHERE id = ?').get(id) ?? null
}

export function updateInstance(id, fields) {
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  const sets = keys.map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE instances SET ${sets} WHERE id = @id`).run({ id, ...fields })
}

export function deleteInstance(id) {
  db.prepare('DELETE FROM instances WHERE id = ?').run(id)
}

export function deleteUser(id) {
  db.prepare('DELETE FROM instances WHERE user_id = ?').run(id)
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
  db.prepare('DELETE FROM users WHERE id = ?').run(id)
}

export function listInstancesWithUsers() {
  return db.prepare(
    `SELECT i.*, u.email, u.username, u.name AS user_name, u.role AS user_role
     FROM instances i JOIN users u ON u.id = i.user_id
     ORDER BY i.id`,
  ).all()
}

export function touchInstanceRequest(slug) {
  db.prepare(
    `UPDATE instances SET request_count = request_count + 1, last_active = ?
     WHERE slug = ?`,
  ).run(Date.now(), slug)
}

// ---- sessions ----

export function insertSession(token, userId, csrfToken) {
  const now = Date.now()
  db.prepare(`INSERT INTO sessions
      (token_hash, user_id, csrf_token, created_at, last_seen_at, absolute_expires_at)
      VALUES (?,?,?,?,?,?)`)
    .run(digestSessionToken(token), userId, csrfToken, now, now, now + config.sessionAbsoluteTtlMs)
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digestSessionToken(token))
}

export function deleteAllSessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}

export function purgeExpiredSessions(now = Date.now()) {
  db.prepare('DELETE FROM sessions WHERE absolute_expires_at <= ? OR last_seen_at + ? <= ?')
    .run(now, config.sessionIdleTtlMs, now)
}

export function sessionForToken(token, { touch = true } = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(token ?? ''))) return null
  const tokenHash = digestSessionToken(token)
  const row = db.prepare(
    `SELECT u.*, s.csrf_token AS _csrf_token, s.last_seen_at AS _last_seen_at,
            s.absolute_expires_at AS _absolute_expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).get(tokenHash)
  if (!row) return null

  const now = Date.now()
  if (row._absolute_expires_at <= now || row._last_seen_at + config.sessionIdleTtlMs <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    return null
  }
  if (touch && row._last_seen_at + config.sessionTouchIntervalMs <= now) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, tokenHash)
  }
  const {
    _csrf_token: csrfToken, _last_seen_at: _lastSeenAt,
    _absolute_expires_at: _absoluteExpiresAt, ...user
  } = row
  return { user, csrfToken }
}

export function userForSession(token, options) {
  return sessionForToken(token, options)?.user ?? null
}

// ---- seed admin ----

export function ensureAdmin() {
  const existing = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get()
  if (existing) return

  const password = String(config.adminPassword ?? '')
  const placeholder = /^(?:change-?me(?:-?now)?|password|admin|example)$/i.test(password)
  if (!config.adminEmail || !config.adminName || password.length < 16 || placeholder) {
    throw new Error('no admin exists: set ADMIN_EMAIL, ADMIN_NAME, and a non-placeholder ADMIN_PASSWORD of at least 16 characters')
  }
  createUser({
    email: config.adminEmail,
    username: config.adminName.toLowerCase(),
    name: config.adminName,
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'admin',
  })
  console.log(`[portal] seeded admin "${config.adminEmail}"`)
}
