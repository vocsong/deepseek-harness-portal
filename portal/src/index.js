import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { config } from './config.js'
import {
  createInstanceRow, createUser, deleteAllSessionsForUser, deleteInstance,
  ensureAdmin, getEmailDomains, getInstanceById, getInstanceByUserId,
  getInstanceBySlug, getUserByEmail, getUserById, getUserByUsername,
  listInstancesWithUsers, listUsers, otpRegistrationEnabled,
  passwordLoginEnabled, setSetting, setUserPassword, updateInstance,
  updateUser, userForSession,
} from './db.js'
import { createSession, destroySession, hashPassword, isValidEmail, normalizeEmail, verifyPassword, SESSION_COOKIE } from './auth.js'
import { issueOtp, verifyOtp } from './otp.js'
import { sendOtpCode } from './mailer.js'
import {
  allocatePort, containerLogs, containerName, containerRunning, provision,
  removeContainer, startContainer, stopContainer,
} from './orchestrator.js'
import { setupProxy } from './proxy.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const fastify = Fastify({ logger: false })

await fastify.register(cookie)
await fastify.register(fastifyStatic, {
  root: join(__dirname, '..', 'public'),
  prefix: '/',
})

ensureAdmin()
setupProxy(fastify)

// Re-queue instances left mid-provisioning by a previous process exit.
for (const inst of listInstancesWithUsers()) {
  if (inst.status === 'provisioning') {
    console.log(`[portal] re-queuing provisioning for "${inst.slug}"`)
    provision(inst.id).catch((err) => console.error('[provision]', err))
  }
}

// Never cache API responses (the session state must always be fresh).
fastify.addHook('onSend', async (req, reply) => {
  if (req.raw.url?.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
})

// ---- helpers ---------------------------------------------------------------

const publicUser = (u) => (u ? { id: u.id, email: u.email, username: u.username, name: u.name, role: u.role } : null)

function setSessionCookie(reply, token) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieDomain !== '',
    path: '/',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
    maxAge: 7 * 24 * 60 * 60,
  })
}

function requireUser(req, reply) {
  const user = userForSession(req.cookies?.[SESSION_COOKIE])
  if (!user) {
    reply.code(401).send({ error: 'not authenticated' })
    return null
  }
  return user
}

function requireAdmin(req, reply) {
  const user = requireUser(req, reply)
  if (!user) return null
  if (user.role !== 'admin') {
    reply.code(403).send({ error: 'admin only' })
    return null
  }
  return user
}

function slugify(value) {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (s || 'user').slice(0, 40)
}

const RESERVED_SLUGS = new Set([
  config.domain.split('.')[0].toLowerCase(), 'www', 'admin', 'portal', 'api', 'app', 'dsh',
])

function emailAllowed(email) {
  const domains = getEmailDomains()
  if (domains.length === 0) return true
  const domain = email.split('@')[1]
  return domain !== undefined && domains.includes(domain.toLowerCase())
}

async function uniqueSlug(base) {
  let slug = RESERVED_SLUGS.has(base) ? `${base}-1` : base
  for (let i = 2; getInstanceBySlug(slug) !== null; i++) slug = `${base}-${i}`
  return slug
}

function slugBaseFor(email, name) {
  const local = (email ?? '').split('@')[0]
  return slugify(local || name || 'user')
}

// ---- auth: register (email OTP) -------------------------------------------

fastify.post('/api/auth/register/request', async (req, reply) => {
  if (!otpRegistrationEnabled()) {
    return reply.code(403).send({ error: 'registration is disabled' })
  }
  const email = normalizeEmail(req.body?.email)
  if (!isValidEmail(email)) return reply.code(400).send({ error: 'enter a valid email address' })
  if (!emailAllowed(email)) return reply.code(403).send({ error: 'this email domain is not allowed to register' })
  if (getUserByEmail(email)) return reply.code(409).send({ error: 'an account with this email already exists' })

  const code = issueOtp(email, 'register')
  const sent = await sendOtpCode(email, code)
  return { ok: true, ...(sent.devCode !== undefined ? { devCode: sent.devCode } : {}) }
})

fastify.post('/api/auth/register/verify', async (req, reply) => {
  if (!otpRegistrationEnabled()) {
    return reply.code(403).send({ error: 'registration is disabled' })
  }
  const email = normalizeEmail(req.body?.email)
  const otp = String(req.body?.otp ?? '')
  if (!isValidEmail(email)) return reply.code(400).send({ error: 'enter a valid email address' })
  if (getUserByEmail(email)) return reply.code(409).send({ error: 'an account with this email already exists' })

  const v = verifyOtp(email, 'register', otp)
  if (!v.ok) return reply.code(400).send({ error: v.error })

  const name = typeof req.body?.name === 'string' && req.body.name.trim() !== ''
    ? req.body.name.trim().slice(0, 64)
    : email.split('@')[0]

  const userId = createUser({ email, name, role: 'user' })
  let instance = null
  try {
    const slug = await uniqueSlug(`${slugBaseFor(email, name)}${config.instanceSlugSuffix}`)
    const hostPort = await allocatePort()
    const cname = containerName(slug)
    const instId = createInstanceRow({ userId, slug, containerName: cname, hostPort })
    instance = getInstanceById(instId)
    provision(instId).catch((err) => console.error('[provision]', err))
  } catch (err) {
    console.error('[register] instance provisioning setup failed:', err)
  }

  const token = createSession(userId)
  setSessionCookie(reply, token)
  return { user: publicUser(getUserById(userId)), instance }
})

// ---- auth: login (password OR OTP) ----------------------------------------

fastify.post('/api/auth/login', async (req, reply) => {
  if (!passwordLoginEnabled()) {
    return reply.code(403).send({ error: 'password login is disabled; use email verification' })
  }
  const identifier = String(req.body?.username ?? '').trim().toLowerCase()
  const password = String(req.body?.password ?? '')
  const user = getUserByUsername(identifier) ?? getUserByEmail(identifier)
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    return reply.code(401).send({ error: 'invalid username or password' })
  }
  const token = createSession(user.id)
  setSessionCookie(reply, token)
  return { user: publicUser(user) }
})

fastify.post('/api/auth/login/request', async (req, reply) => {
  const email = normalizeEmail(req.body?.email)
  const user = getUserByEmail(email)
  if (!user) return reply.code(401).send({ error: 'no account found for this email' })
  const code = issueOtp(email, 'login')
  const sent = await sendOtpCode(email, code)
  return { ok: true, ...(sent.devCode !== undefined ? { devCode: sent.devCode } : {}) }
})

fastify.post('/api/auth/login/verify', async (req, reply) => {
  const email = normalizeEmail(req.body?.email)
  const otp = String(req.body?.otp ?? '')
  const user = getUserByEmail(email)
  if (!user) return reply.code(401).send({ error: 'no account found for this email' })
  const v = verifyOtp(email, 'login', otp)
  if (!v.ok) return reply.code(400).send({ error: v.error })
  const token = createSession(user.id)
  setSessionCookie(reply, token)
  return { user: publicUser(user) }
})

fastify.post('/api/auth/logout', async (req, reply) => {
  const token = req.cookies?.[SESSION_COOKIE]
  const user = token ? userForSession(token) : null
  if (user) {
    // Kill every session for this user, not just the presented cookie — a
    // browser may carry stale duplicate session cookies (host-only vs domain).
    deleteAllSessionsForUser(user.id)
  } else if (token) {
    destroySession(token)
  }
  // Clear the cookie in both scopes and with the same flags it was set with.
  const base = { path: '/', sameSite: 'lax', secure: config.cookieDomain !== '' }
  reply.clearCookie(SESSION_COOKIE, { ...base, ...(config.cookieDomain ? { domain: config.cookieDomain } : {}) })
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
  return { ok: true }
})

fastify.get('/api/auth/me', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return
  return { user: publicUser(user) }
})

// ---- profile ---------------------------------------------------------------

fastify.get('/api/profile', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return
  return { name: user.name, email: user.email, username: user.username, hasPassword: Boolean(user.password_hash) }
})

fastify.post('/api/profile', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return

  const fields = {}
  const { username, name, email, currentPassword, newPassword } = req.body ?? {}

  if (username !== undefined) {
    const u = String(username).trim().toLowerCase()
    if (!/^[a-z0-9._-]{3,32}$/.test(u)) {
      return reply.code(400).send({ error: 'username: 3-32 chars (letters, digits, . _ -)' })
    }
    if (u !== user.username && getUserByUsername(u)) {
      return reply.code(409).send({ error: 'username already taken' })
    }
    fields.username = u
  }
  if (name !== undefined) {
    const n = String(name).trim()
    if (n.length < 1 || n.length > 64) return reply.code(400).send({ error: 'name must be 1-64 characters' })
    fields.name = n
  }
  if (email !== undefined) {
    const e = normalizeEmail(email)
    if (!isValidEmail(e)) return reply.code(400).send({ error: 'enter a valid email address' })
    if (!emailAllowed(e)) return reply.code(403).send({ error: 'this email domain is not allowed' })
    if (e !== user.email && getUserByEmail(e)) return reply.code(409).send({ error: 'that email is already in use' })
    fields.email = e
  }
  if (newPassword !== undefined && newPassword !== '') {
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return reply.code(400).send({ error: 'password must be at least 8 characters' })
    }
    if (user.password_hash) {
      if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, user.password_hash)) {
        return reply.code(400).send({ error: 'current password is incorrect' })
      }
    }
    fields.password_hash = hashPassword(newPassword)
  }

  if (Object.keys(fields).length === 0) return reply.code(400).send({ error: 'nothing to update' })
  updateUser(user.id, fields)
  const fresh = getUserById(user.id)
  return { name: fresh.name, email: fresh.email, username: fresh.username, hasPassword: Boolean(fresh.password_hash) }
})

// ---- instance (user self-service) -----------------------------------------

fastify.get('/api/instance', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return
  const instance = getInstanceByUserId(user.id)
  return { instance: instance ? await withLiveState(instance) : null }
})

fastify.post('/api/instance/start', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return
  const inst = getInstanceByUserId(user.id)
  if (!inst) return reply.code(404).send({ error: 'no instance' })
  if (inst.status === 'failed') return reply.code(400).send({ error: 'instance failed; contact admin' })
  await startContainer(inst.container_name)
  await waitUntilRunning(inst)
  updateInstance(inst.id, { status: 'running', error: null })
  return { instance: getInstanceByUserId(user.id) }
})

fastify.post('/api/instance/stop', async (req, reply) => {
  const user = requireUser(req, reply)
  if (!user) return
  const inst = getInstanceByUserId(user.id)
  if (!inst) return reply.code(404).send({ error: 'no instance' })
  await stopContainer(inst.container_name)
  updateInstance(inst.id, { status: 'stopped', error: null })
  return { instance: getInstanceByUserId(user.id) }
})

// ---- admin: settings -------------------------------------------------------

fastify.get('/api/admin/settings', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  return {
    emailDomains: getEmailDomains().join(', '),
    otpRegistrationEnabled: otpRegistrationEnabled(),
    passwordLoginEnabled: passwordLoginEnabled(),
  }
})

fastify.post('/api/admin/settings', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const { emailDomains, otpRegistrationEnabled: regEnabled, passwordLoginEnabled: pwEnabled } = req.body ?? {}
  if (emailDomains !== undefined) {
    const cleaned = String(emailDomains).split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('.') && !s.includes('@') && !s.startsWith('.'))
    setSetting('email_domains', cleaned.join(','))
  }
  if (regEnabled !== undefined) setSetting('otp_registration_enabled', regEnabled ? 'true' : 'false')
  if (pwEnabled !== undefined) setSetting('password_login_enabled', pwEnabled ? 'true' : 'false')
  return {
    emailDomains: getEmailDomains().join(', '),
    otpRegistrationEnabled: otpRegistrationEnabled(),
    passwordLoginEnabled: passwordLoginEnabled(),
  }
})

// ---- admin: users + instances ---------------------------------------------

fastify.get('/api/admin/users', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  return { users: listUsers() }
})

fastify.post('/api/admin/users/:id/reset-password', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const user = getUserById(Number(req.params.id))
  if (!user) return reply.code(404).send({ error: 'not found' })
  const { password } = req.body ?? {}
  if (typeof password !== 'string' || password.length < 8) {
    return reply.code(400).send({ error: 'password must be at least 8 characters' })
  }
  setUserPassword(user.id, hashPassword(password))
  return { ok: true }
})

fastify.get('/api/admin/instances', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const out = []
  for (const row of listInstancesWithUsers()) out.push(await withLiveState(row))
  return { instances: out }
})

fastify.post('/api/admin/instances/:id/start', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const inst = getInstanceById(Number(req.params.id))
  if (!inst) return reply.code(404).send({ error: 'not found' })
  await startContainer(inst.container_name)
  await waitUntilRunning(inst)
  updateInstance(inst.id, { status: 'running', error: null })
  return { ok: true }
})

fastify.post('/api/admin/instances/:id/stop', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const inst = getInstanceById(Number(req.params.id))
  if (!inst) return reply.code(404).send({ error: 'not found' })
  await stopContainer(inst.container_name)
  updateInstance(inst.id, { status: 'stopped', error: null })
  return { ok: true }
})

fastify.post('/api/admin/instances/:id/delete', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const inst = getInstanceById(Number(req.params.id))
  if (!inst) return reply.code(404).send({ error: 'not found' })
  await removeContainer(inst.container_name)
  deleteInstance(inst.id)
  return { ok: true }
})

fastify.post('/api/admin/instances/:id/reprovision', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const inst = getInstanceById(Number(req.params.id))
  if (!inst) return reply.code(404).send({ error: 'not found' })
  updateInstance(inst.id, { status: 'provisioning', error: null })
  provision(inst.id).catch((err) => console.error('[provision]', err))
  return { ok: true }
})

fastify.get('/api/admin/instances/:id/logs', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const inst = getInstanceById(Number(req.params.id))
  if (!inst) return reply.code(404).send({ error: 'not found' })
  return { logs: await containerLogs(inst.container_name, 200) }
})

fastify.get('/api/admin/stats', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const rows = listInstancesWithUsers()
  return {
    stats: {
      users: listUsers().length,
      instances: rows.length,
      running: rows.filter((r) => r.status === 'running').length,
      totalRequests: rows.reduce((n, r) => n + (r.request_count ?? 0), 0),
    },
  }
})

// ---- public config ---------------------------------------------------------

fastify.get('/api/config', async () => ({
  domain: config.domain,
  instanceDomain: config.instanceDomain,
  otpRegistrationEnabled: otpRegistrationEnabled(),
  passwordLoginEnabled: passwordLoginEnabled(),
}))

// ---- helpers ---------------------------------------------------------------

async function withLiveState(inst) {
  const live = await containerRunning(inst.container_name)
  return { ...inst, live }
}

async function waitUntilRunning(inst) {
  const deadline = Date.now() + config.instanceStartTimeoutMs
  while (Date.now() < deadline) {
    if (await containerRunning(inst.container_name)) {
      const { waitHealthy } = await import('./orchestrator.js')
      if (await waitHealthy(inst.host_port, 30000)) return
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

// ---- boot ------------------------------------------------------------------

fastify.listen({ port: config.port, host: config.host }, (err) => {
  if (err) {
    console.error('[portal] failed to start:', err)
    process.exit(1)
  }
  console.log(`[portal] listening on http://${config.host}:${config.port}`)
  console.log(`[portal] apex domain: ${config.domain}`)
  console.log(`[portal] cookie domain: ${config.cookieDomain || '(host-only)'}`)
  console.log(`[portal] otp dev mode: ${config.otpDevMode}`)
})
