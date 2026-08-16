import httpProxy from 'http-proxy'
import { config } from './config.js'
import { getInstanceBySlug, touchInstanceRequest, updateInstanceUnlessDeleting, userForSession } from './db.js'
import { startContainer, containerRunning, waitHealthy } from './orchestrator.js'
import { SESSION_COOKIE } from './auth.js'

// changeOrigin: rewrite Host to the target (127.0.0.1:port) so the instance's
// trust fence sees loopback. dsh gates settings/credentials methods to loopback,
// and the portal is the authenticated, authorized gateway into the instance —
// so presenting proxied traffic as loopback is correct and required.
const proxy = httpProxy.createProxyServer({ xfwd: false, changeOrigin: true })
const activeWebSockets = new Set()
const ensureRunningPromises = new Map()

export function closeUserSockets(userId) {
  for (const tracked of activeWebSockets) {
    if (tracked.userId === userId && !tracked.socket.destroyed) tracked.socket.destroy()
  }
}

// The browser-to-portal hop carries gateway credentials and identity metadata.
// None of those values belong on the portal-to-tenant hop. Removing Cookie is
// intentional: dsh does not use browser cookies, while forwarding the parent-
// domain portal_session would expose a bearer token to the tenant container.
const STRIPPED_REQUEST_HEADERS = [
  'cookie', 'authorization', 'proxy-authorization', 'origin', 'x-csrf-token',
  'cf-access-jwt-assertion', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-forwarded-user', 'x-forwarded-email',
]

function hardenProxyRequest(proxyReq) {
  for (const name of STRIPPED_REQUEST_HEADERS) proxyReq.removeHeader(name)
}

function stripUpstreamCookies(headers) {
  if (!headers) return
  delete headers['set-cookie']
  delete headers['set-cookie2']
}

proxy.on('proxyReq', hardenProxyRequest)
proxy.on('proxyReqWs', (proxyReq) => {
  hardenProxyRequest(proxyReq)
  // http-proxy writes both successful 101 and rejected/non-upgrade handshake
  // headers after these listeners. Registering here removes Set-Cookie before
  // either response path reaches the browser.
  proxyReq.once('upgrade', (proxyRes) => stripUpstreamCookies(proxyRes.headers))
  proxyReq.once('response', (proxyRes) => stripUpstreamCookies(proxyRes.headers))
})
proxy.on('proxyRes', (proxyRes) => stripUpstreamCookies(proxyRes.headers))

proxy.on('error', (err, _req, res) => {
  console.error('[proxy] upstream error:', err?.message ?? err)
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('upstream unavailable')
  } else if (res && typeof res.destroy === 'function' && !res.destroyed) {
    res.destroy()
  }
})

/** Parse the session cookie from a raw Cookie header. */
function cookieToken(cookieHeader) {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name === SESSION_COOKIE) return /^[a-f0-9]{64}$/.test(value) ? value : null
  }
  return null
}

/** Host -> slug when the Host is a configured instance subdomain; null otherwise. */
function slugFromHost(hostHeader) {
  const host = String(hostHeader ?? '').split(':')[0].toLowerCase()
  const apex = config.domain.toLowerCase()
  const base = config.instanceDomain.toLowerCase()
  if (host === apex || host === base) return null
  const suffix = `.${base}`
  if (!host.endsWith(suffix)) return null
  const slug = host.slice(0, -suffix.length)
  if (slug.length === 0 || slug.includes('.')) return null // single label only
  return slug
}

/** Decide whether this user may reach this instance. */
function mayAccess(user, inst) {
  if (!user) return false
  if (user.role === 'admin') return true
  return user.id === inst.user_id
}

/**
 * Ensure an instance is running, starting it if it is stopped. Failed or
 * still-provisioning instances are not auto-started (those need admin).
 * After starting, waits until dsh actually serves HTTP before returning.
 * @returns true once the instance is running and healthy.
 */
async function ensureRunningInner(inst) {
  if (inst.status === 'failed' || inst.status === 'deleting') return false
  if (inst.status === 'provisioning') return await containerRunning(inst.container_name)
  if (inst.status === 'stopped' || !(await containerRunning(inst.container_name))) {
    await startContainer(inst.container_name)
  }
  if (!(await containerRunning(inst.container_name))) return false
  // Wait for the app to serve; a freshly started container isn't ready yet.
  const healthy = await waitHealthy(inst.host_port, 30000)
  if (healthy && !updateInstanceUnlessDeleting(inst.id, { status: 'running', error: null })) return false
  return healthy
}

function ensureRunning(inst) {
  const existing = ensureRunningPromises.get(inst.container_name)
  if (existing) return existing
  const pending = ensureRunningInner(inst)
    .finally(() => ensureRunningPromises.delete(inst.container_name))
  ensureRunningPromises.set(inst.container_name, pending)
  return pending
}

/**
 * Route subdomain traffic to the owning instance. Registered as a fastify
 * onRequest hook (HTTP) plus a raw server 'upgrade' listener (WebSocket).
 */
export function setupProxy(fastify) {
  fastify.addHook('onRequest', async (req, reply) => {
    const slug = slugFromHost(req.headers.host)
    if (slug === null) return // apex -> normal portal routing

    const inst = getInstanceBySlug(slug)
    if (inst === null) {
      reply.code(404).type('text/plain').send('instance not found')
      return
    }
    const user = userForSession(req.cookies?.[SESSION_COOKIE])
    if (!mayAccess(user, inst)) {
      reply.code(302).header('location', `https://${config.domain}/login`).send()
      return reply
    }
    // Auto-start on access (launch always works); start is fast for a stopped
    // container. If it fails, report not-running instead of a hung proxy.
    let running = inst.status === 'running' && (await containerRunning(inst.container_name))
    if (!running && !['failed', 'provisioning', 'deleting'].includes(inst.status)) {
      running = await ensureRunning(inst)
    }
    if (!running) {
      reply.code(503).type('text/plain').send('instance starting, try again in a moment')
      return reply
    }
    // Revalidate identity and routing after every startup/inspection await. A
    // deleted row must never forward to a port that may be allocated anew.
    const current = getInstanceBySlug(slug)
    const currentUser = userForSession(req.cookies?.[SESSION_COOKIE])
    if (!current || current.id !== inst.id || current.status !== 'running' || !mayAccess(currentUser, current)) {
      reply.code(503).type('text/plain').send('instance unavailable')
      return reply
    }
    touchInstanceRequest(slug)
    reply.hijack()
    proxy.web(req.raw, reply.raw, { target: `http://127.0.0.1:${current.host_port}` })
  })

  async function handleUpgrade(req, socket, head) {
    const slug = slugFromHost(req.headers.host)
    if (slug === null) {
      socket.destroy()
      return
    }
    const inst = getInstanceBySlug(slug)
    if (inst === null) {
      socket.destroy()
      return
    }
    const sessionToken = cookieToken(req.headers.cookie)
    const user = userForSession(sessionToken)
    if (!mayAccess(user, inst)) {
      socket.destroy()
      return
    }
    let running = inst.status === 'running' && (await containerRunning(inst.container_name))
    if (!running && !['failed', 'provisioning', 'deleting'].includes(inst.status)) {
      running = await ensureRunning(inst)
    }
    if (!running) {
      socket.destroy()
      return
    }
    // Container startup may take tens of seconds. Revalidate after the final
    // await so a password reset/logout during startup cannot escape revocation.
    const current = getInstanceBySlug(slug)
    const currentUser = userForSession(sessionToken)
    if (!current || current.id !== inst.id || current.status !== 'running' || !mayAccess(currentUser, current)) {
      socket.destroy()
      return
    }
    touchInstanceRequest(slug)
    const tracked = { socket, userId: currentUser.id, token: sessionToken, lastActivity: Date.now() }
    activeWebSockets.add(tracked)
    const markActivity = () => {
      const now = Date.now()
      if (now - tracked.lastActivity >= 60 * 1000) {
        tracked.lastActivity = now
        touchInstanceRequest(slug)
      }
    }
    const untrack = () => {
      activeWebSockets.delete(tracked)
      socket.off('data', markActivity)
    }
    socket.on('data', markActivity)
    socket.once('close', untrack)
    socket.once('error', untrack)
    proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${current.host_port}` })
  }

  // EventEmitter does not await async listeners. Convert rejections into a
  // closed socket so malformed input or Podman errors cannot become an
  // unhandled rejection that terminates the portal process.
  fastify.server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head).catch((err) => {
      console.error('[proxy] websocket upgrade failed:', err?.message ?? err)
      if (!socket.destroyed) socket.destroy()
    })
  })

  const sessionSweep = setInterval(() => {
    for (const tracked of activeWebSockets) {
      if (!userForSession(tracked.token, { touch: false }) && !tracked.socket.destroyed) {
        tracked.socket.destroy()
      }
    }
  }, 60 * 1000)
  sessionSweep.unref?.()
}
