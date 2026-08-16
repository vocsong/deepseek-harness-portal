import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { config, validateConfig } from './config.js'
import {
  createInstanceRow, createUser, deleteAllSessionsForUser, deleteInstance,
  deleteUser, ensureAdmin, getEmailDomains, getInstanceById, getInstanceByUserId,
  getInstanceBySlug, getInviteCode, getUserByEmail, getUserById,
  getUserByUsername, listInstancesWithUsers, listUsers, otpRegistrationEnabled,
  passwordLoginEnabled, setInviteCode, setSetting, setUserPassword,
  sessionForToken, updateInstance, updateUser, userForSession,
} from './db.js'
import {
  createSession, destroySession, hashPassword, isValidEmail, LEGACY_SESSION_COOKIES,
  normalizeEmail, verifyCsrfToken, verifyPassword, SESSION_COOKIE,
} from './auth.js'
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
fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
  try { done(null, Object.fromEntries(new URLSearchParams(body))) }
  catch (err) { done(err) }
})
await fastify.register(fastifyStatic, {
  root: join(__dirname, '..', 'public'),
  prefix: '/',
  setHeaders: (reply) => {
    reply.header('Cache-Control', 'no-store')
  },
})

validateConfig()
ensureAdmin()
setupProxy(fastify)

// Re-queue instances left mid-provisioning by a previous process exit.
for (const inst of listInstancesWithUsers()) {
  if (inst.status === 'provisioning') {
    console.log(`[portal] re-queuing provisioning for "${inst.slug}"`)
    provision(inst.id).catch((err) => console.error('[provision]', err))
  }
}

// Portal browser hardening. Instance responses are hijacked by setupProxy
// before onSend and intentionally keep dsh's own content policy.
fastify.addHook('onSend', async (req, reply) => {
  reply.headers({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  })
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

function requireSession(req, reply) {
  const session = sessionForToken(req.cookies?.[SESSION_COOKIE])
  if (!session) {
    reply.code(401).send({ error: 'not authenticated' })
    return null
  }
  return session
}

function requireUser(req, reply) {
  return requireSession(req, reply)?.user ?? null
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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const PREAUTH_MUTATIONS = new Set([
  '/api/auth/register/request', '/api/auth/register/verify',
  '/api/auth/login', '/api/auth/login/request', '/api/auth/login/verify',
])

// Tenant subdomains are same-site with the portal, so SameSite cookies alone do
// not stop CSRF. Require the exact configured portal origin for every API
// mutation, JSON for API calls, and a per-session secret after authentication.
fastify.addHook('preHandler', async (req, reply) => {
  if (SAFE_METHODS.has(req.method) || !req.raw.url?.startsWith('/api/')) return

  const path = req.raw.url.split('?')[0]
  const host = String(req.headers.host ?? '').split(':')[0].toLowerCase()
  if (host !== config.domain.toLowerCase()) {
    return reply.code(403).send({ error: 'invalid request host' })
  }
  if (req.headers.origin !== config.portalOrigin) {
    return reply.code(403).send({ error: 'invalid request origin' })
  }
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    return reply.code(403).send({ error: 'cross-site request rejected' })
  }

  const isLogout = path === '/api/auth/logout'
  if (!isLogout && String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return reply.code(415).send({ error: 'application/json required' })
  }
  if (PREAUTH_MUTATIONS.has(path)) return

  const session = sessionForToken(req.cookies?.[SESSION_COOKIE])
  if (!session) return // The route's normal authorization returns 401.
  const presented = isLogout ? req.body?._csrf : req.headers['x-csrf-token']
  if (!verifyCsrfToken(presented, session.csrfToken)) {
    return reply.code(403).send({ error: 'invalid CSRF token' })
  }
})

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
  const base = typeof name === 'string' && name.trim() !== ''
    ? name
    : (email ?? '').split('@')[0]
  return slugify(base || 'user')
}

// ---- auth: register (email OTP) -------------------------------------------

fastify.post('/api/auth/register/request', async (req, reply) => {
  if (!otpRegistrationEnabled()) {
    return reply.code(403).send({ error: 'registration is disabled' })
  }
  const invite = getInviteCode()
  if (invite !== '' && String(req.body?.inviteCode ?? '').trim() !== invite) {
    return reply.code(403).send({ error: 'invalid invitation code' })
  }
  const email = normalizeEmail(req.body?.email)
  if (!isValidEmail(email)) return reply.code(400).send({ error: 'enter a valid email address' })
  if (!emailAllowed(email)) return reply.code(403).send({ error: 'this email domain is not allowed to register' })
  if (getUserByEmail(email)) return reply.code(409).send({ error: 'an account with this email already exists' })

  const code = issueOtp(email, 'register')
  await sendOtpCode(email, code)
  return { ok: true }
})

fastify.post('/api/auth/register/verify', async (req, reply) => {
  if (!otpRegistrationEnabled()) {
    return reply.code(403).send({ error: 'registration is disabled' })
  }
  const invite = getInviteCode()
  if (invite !== '' && String(req.body?.inviteCode ?? '').trim() !== invite) {
    return reply.code(403).send({ error: 'invalid invitation code' })
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

  const username = typeof req.body?.username === 'string' && req.body.username.trim() !== ''
    ? req.body.username.trim().toLowerCase().slice(0, 32)
    : null
  if (username !== null) {
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      return reply.code(400).send({ error: 'username: 3-32 chars (letters, digits, . _ -)' })
    }
    if (getUserByUsername(username)) {
      return reply.code(409).send({ error: 'username already taken' })
    }
  }
  const password = typeof req.body?.password === 'string' && req.body.password !== '' ? req.body.password : null
  if (password !== null && password.length < 8) {
    return reply.code(400).send({ error: 'password must be at least 8 characters' })
  }

  const userId = createUser({ email, username, name, passwordHash: password !== null ? hashPassword(password) : null, role: 'user' })
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

  const session = createSession(userId)
  setSessionCookie(reply, session.token)
  return { user: publicUser(getUserById(userId)), instance, csrfToken: session.csrfToken }
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
  const session = createSession(user.id)
  setSessionCookie(reply, session.token)
  return { user: publicUser(user), csrfToken: session.csrfToken }
})

fastify.post('/api/auth/login/request', async (req, reply) => {
  const email = normalizeEmail(req.body?.email)
  const user = getUserByEmail(email)
  if (!user) return reply.code(401).send({ error: 'no account found for this email' })
  const code = issueOtp(email, 'login')
  await sendOtpCode(email, code)
  return { ok: true }
})

fastify.post('/api/auth/login/verify', async (req, reply) => {
  const email = normalizeEmail(req.body?.email)
  const otp = String(req.body?.otp ?? '')
  const user = getUserByEmail(email)
  if (!user) return reply.code(401).send({ error: 'no account found for this email' })
  const v = verifyOtp(email, 'login', otp)
  if (!v.ok) return reply.code(400).send({ error: v.error })
  const session = createSession(user.id)
  setSessionCookie(reply, session.token)
  return { user: publicUser(user), csrfToken: session.csrfToken }
})

function clearSessionAndCookies(req, reply) {
  // A browser may carry several session cookies scoped to different domains
  // (host-only, .vocsong.com, .deepseek.vocsong.com, ...) accumulated across
  // config changes and cookie-name changes. fastify collapses duplicate names,
  // so parse the RAW Cookie header and kill every session token server-side.
  const raw = String(req.raw.headers.cookie ?? '')
  const tokens = new Set()
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE || LEGACY_SESSION_COOKIES.includes(name)) {
      tokens.add(part.slice(eq + 1).trim())
    }
  }
  if (req.cookies?.[SESSION_COOKIE]) tokens.add(req.cookies[SESSION_COOKIE])

  for (const token of tokens) {
    const user = userForSession(token)
    if (user) deleteAllSessionsForUser(user.id)
    else destroySession(token)
  }

  // Clear the cookie across every scope and every cookie name we may have used.
  const names = [SESSION_COOKIE, ...LEGACY_SESSION_COOKIES]
  const scopes = [undefined, config.cookieDomain, config.domain, `.${config.domain}`]
  for (const name of names) {
    for (const scope of scopes) {
      reply.clearCookie(name, {
        path: '/',
        sameSite: 'lax',
        secure: config.cookieDomain !== '',
        ...(scope ? { domain: scope } : {}),
      })
    }
  }
}

// Native POST navigation avoids fetch/cache logout issues while Origin + the
// hidden per-session token prevent logout and sibling-subdomain CSRF.
fastify.post('/api/auth/logout', async (req, reply) => {
  clearSessionAndCookies(req, reply)
  return reply.code(303).redirect('/')
})

fastify.get('/api/auth/me', async (req, reply) => {
  const session = requireSession(req, reply)
  if (!session) return
  return { user: publicUser(session.user), csrfToken: session.csrfToken }
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
    inviteCode: getInviteCode(),
    otpRegistrationEnabled: otpRegistrationEnabled(),
    passwordLoginEnabled: passwordLoginEnabled(),
  }
})

fastify.post('/api/admin/settings', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const { emailDomains, inviteCode, otpRegistrationEnabled: regEnabled, passwordLoginEnabled: pwEnabled } = req.body ?? {}
  if (emailDomains !== undefined) {
    const cleaned = String(emailDomains).split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('.') && !s.includes('@') && !s.startsWith('.'))
    setSetting('email_domains', cleaned.join(','))
  }
  if (inviteCode !== undefined) setInviteCode(inviteCode)
  if (regEnabled !== undefined) setSetting('otp_registration_enabled', regEnabled ? 'true' : 'false')
  if (pwEnabled !== undefined) setSetting('password_login_enabled', pwEnabled ? 'true' : 'false')
  return {
    emailDomains: getEmailDomains().join(', '),
    inviteCode: getInviteCode(),
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

fastify.post('/api/admin/users/:id/delete', async (req, reply) => {
  if (!requireAdmin(req, reply)) return
  const user = getUserById(Number(req.params.id))
  if (!user) return reply.code(404).send({ error: 'not found' })
  if (user.role === 'admin') return reply.code(400).send({ error: 'cannot delete an admin account' })
  const inst = getInstanceByUserId(user.id)
  if (inst) await removeContainer(inst.container_name)
  deleteUser(user.id)
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
  inviteCodeRequired: getInviteCode() !== '',
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

// Stop running instances that have received no proxied requests within the
// idle window. `last_active` is bumped by every proxied request/upgrade.
function idleSweep() {
  const deadline = Date.now() - config.idleTimeoutMs
  for (const inst of listInstancesWithUsers()) {
    if (inst.status !== 'running') continue
    const last = inst.last_active ?? inst.created_at
    if (last > deadline) continue
    stopContainer(inst.container_name)
      .then(() => {
        updateInstance(inst.id, { status: 'stopped', error: null })
        console.log(`[portal] idle: stopped instance "${inst.slug}"`)
      })
      .catch((err) => console.error(`[portal] idle: failed to stop "${inst.slug}"`, err))
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
  console.log(`[portal] idle stop after ${Math.round(config.idleTimeoutMs / 60000)}m (sweep every ${Math.round(config.idleSweepIntervalMs / 1000)}s)`)

  // Periodic idle sweep. Keep the handle so the timer isn't GC'd; unref so it
  // never blocks process shutdown.
  const sweepTimer = setInterval(idleSweep, config.idleSweepIntervalMs)
  sweepTimer.unref?.()
})
