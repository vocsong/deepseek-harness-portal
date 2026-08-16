import httpProxy from 'http-proxy'
import { config } from './config.js'
import { getInstanceBySlug, touchInstanceRequest, userForSession } from './db.js'
import { SESSION_COOKIE } from './auth.js'

const proxy = httpProxy.createProxyServer({ xfwd: false })

proxy.on('error', (err, _req, res) => {
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`upstream error: ${err.message}`)
  }
})

/** Parse the session cookie from a raw Cookie header. */
function cookieToken(cookieHeader) {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim())
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
    if (inst.status !== 'running') {
      reply.code(503).type('text/plain').send('instance not running')
      return
    }
    const user = userForSession(req.cookies?.[SESSION_COOKIE])
    if (!mayAccess(user, inst)) {
      reply.code(302).header('location', `https://${config.domain}/login`).send()
      return reply
    }
    touchInstanceRequest(slug)
    reply.hijack()
    proxy.web(req.raw, reply.raw, { target: `http://127.0.0.1:${inst.host_port}` })
  })

  fastify.server.on('upgrade', (req, socket, head) => {
    const slug = slugFromHost(req.headers.host)
    if (slug === null) {
      socket.destroy()
      return
    }
    const inst = getInstanceBySlug(slug)
    if (inst === null || inst.status !== 'running') {
      socket.destroy()
      return
    }
    const user = userForSession(cookieToken(req.headers.cookie))
    if (!mayAccess(user, inst)) {
      socket.destroy()
      return
    }
    touchInstanceRequest(slug)
    proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${inst.host_port}` })
  })
}
