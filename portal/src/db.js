import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { hashPassword } from './auth.js'

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
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
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

export function insertSession(token, userId) {
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)')
    .run(token, userId, Date.now())
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

export function deleteAllSessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}

export function userForSession(token) {
  if (!token) return null
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
  ).get(token)
  return row ?? null
}

// ---- seed admin ----

export function ensureAdmin() {
  const existing = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get()
  if (existing) return
  createUser({
    email: config.adminEmail,
    username: config.adminName.toLowerCase(),
    name: config.adminName,
    passwordHash: hashPassword(config.adminPassword),
    role: 'admin',
  })
  console.log(`[portal] seeded admin "${config.adminEmail}"`)
}
