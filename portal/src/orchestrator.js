import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import http from 'node:http'
import { config } from './config.js'
import { db, getInstanceById, updateInstanceUnlessDeleting } from './db.js'

const run = promisify(execFile)
const runningCache = new Map()
const lifecycleLocks = new Map()
const RUNNING_CACHE_TTL_MS = 2000

function podman(args, opts = {}) {
  return run('podman', args, {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout: config.podmanCommandTimeoutMs,
    ...opts,
  })
}

function withLifecycleLock(name, operation) {
  const previous = lifecycleLocks.get(name) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  lifecycleLocks.set(name, current)
  return current.finally(() => {
    if (lifecycleLocks.get(name) === current) lifecycleLocks.delete(name)
  })
}

function invalidateRunning(name) {
  runningCache.delete(name)
}

function isMissingContainerError(error) {
  const text = String(error?.stderr ?? error?.message ?? '').toLowerCase()
  return text.includes('no such container')
    || text.includes('no container with name or id')
    || text.includes('no such object')
}

export function containerName(slug) {
  return `dsh-${slug}`
}

export async function ensureImage() {
  try {
    await podman(['image', 'exists', config.image])
  } catch {
    throw new Error(`approved image "${config.image}" not found; run ./build-image.sh and configure its sha256 ID`)
  }
}

export async function verifyPodmanRuntime() {
  const { stdout } = await podman(['info', '--format', '{{.Host.Security.Rootless}}'])
  if (stdout.trim() !== 'true') throw new Error('Podman must run rootless')
  await ensureImage()
  // This is the definitive network-driver check and performs no persistent
  // writes or mounts. It fails portal startup if pasta is unavailable.
  await podman(['run', '--rm', '--network', config.instanceNetwork, '--entrypoint', '/bin/true', config.image])
}

async function createContainerUnlocked({ slug, hostPort }) {
  const name = containerName(slug)
  invalidateRunning(name)
  const args = [
    'run', '-d', '--name', name,
    '--cpus', config.instanceCpus,
    '--memory', config.instanceMemory,
    '--memory-swap', config.instanceMemorySwap,
    '--pids-limit', String(config.instancePidsLimit),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--network', config.instanceNetwork,
    '--log-driver', 'k8s-file', '--log-opt', `max-size=${config.instanceLogSize}`,
    '-p', `127.0.0.1:${hostPort}:3000`,
    '-v', `${name}-home:/home/dsh/.dsh`,
    '-v', `${name}-workspace:/workspace`,
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=${config.instanceTmpfsSize}`,
    '-e', 'DSH_HOME=/home/dsh/.dsh',
    '-e', `TRUSTED_HOST=${slug}.${config.instanceDomain}`,
    '--restart', 'unless-stopped',
  ]
  if (config.instanceReadOnlyRoot) args.push('--read-only')
  args.push(config.image)
  await podman(args)
  invalidateRunning(name)
}

export function createContainer({ slug, hostPort }) {
  const name = containerName(slug)
  return withLifecycleLock(name, () => createContainerUnlocked({ slug, hostPort }))
}

async function startContainerUnlocked(name) {
  invalidateRunning(name)
  await podman(['start', name])
  invalidateRunning(name)
}

export function startContainer(name) {
  return withLifecycleLock(name, () => startContainerUnlocked(name))
}

async function stopContainerUnlocked(name) {
  invalidateRunning(name)
  await podman(['stop', '-t', '15', name], { timeout: Math.max(config.podmanCommandTimeoutMs, 30000) })
  invalidateRunning(name)
}

export function stopContainer(name) {
  return withLifecycleLock(name, () => stopContainerUnlocked(name))
}

async function objectExists(kind, name) {
  try {
    await podman([kind, 'exists', name])
    return true
  } catch (err) {
    if (err?.code === 1 || err?.code === '1') return false
    throw err
  }
}

async function removeExistingContainerUnlocked(name) {
  if (await objectExists('container', name)) await podman(['rm', '-f', name])
  if (await objectExists('container', name)) throw new Error(`container "${name}" still exists after removal`)
  invalidateRunning(name)
}

export function removeContainer(name) {
  return withLifecycleLock(name, async () => {
    await removeExistingContainerUnlocked(name)
    for (const volume of [`${name}-home`, `${name}-workspace`]) {
      // Never force-remove tenant data. If anything reattaches the volume,
      // Podman must fail and the deleting DB tombstone remains for retry.
      if (await objectExists('volume', volume)) await podman(['volume', 'rm', volume])
      if (await objectExists('volume', volume)) throw new Error(`volume "${volume}" still exists after removal`)
    }
  })
}

/** Remove a stale container but keep its volumes (idempotent re-provision). */
export function removeContainerKeepVolumes(name) {
  return withLifecycleLock(name, () => removeExistingContainerUnlocked(name))
}

export async function containerRunning(name, { fresh = false } = {}) {
  const now = Date.now()
  const cached = runningCache.get(name)
  if (cached?.pending) return cached.pending
  if (!fresh && cached && cached.expiresAt > now) return cached.value

  const pending = podman(['inspect', '-f', '{{.State.Running}}', name])
    .then(({ stdout }) => stdout.trim() === 'true')
    .catch((error) => {
      if (isMissingContainerError(error)) return false
      throw error
    })
  const entry = { pending }
  runningCache.set(name, entry)
  try {
    const value = await pending
    // A lifecycle operation may have invalidated this inspection while it was
    // pending. Never let that stale result replace a newer entry.
    if (runningCache.get(name) === entry) {
      runningCache.set(name, { value, expiresAt: Date.now() + RUNNING_CACHE_TTL_MS })
    }
    return value
  } catch (error) {
    if (runningCache.get(name) === entry) runningCache.delete(name)
    throw error
  }
}

export async function containerLogs(name, tail = 200) {
  try {
    const { stdout } = await podman(['logs', '--tail', String(tail), name])
    return stdout
  } catch (error) {
    return String(error?.stderr ?? error?.message ?? error)
  }
}

/** Find a free 127.0.0.1 port in the configured range, avoiding DB-claimed ports. */
export async function allocatePort() {
  const used = new Set(
    db.prepare('SELECT host_port FROM instances').all().map((r) => r.host_port),
  )
  for (let p = config.portRangeStart; p <= config.portRangeEnd; p++) {
    if (used.has(p)) continue
    if (await isPortFree(p)) return p
  }
  throw new Error('no free ports in instance port range')
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/** Poll the instance's HTTP root until 200 or timeout. */
export function waitHealthy(hostPort, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      const req = http.get(
        { host: '127.0.0.1', port: hostPort, path: '/', timeout: 5000 },
        (res) => {
          res.resume()
          if (res.statusCode === 200) return resolve(true)
          schedule()
        },
      )
      req.on('error', schedule)
      req.on('timeout', () => { req.destroy(); schedule() })
      function schedule() {
        if (Date.now() >= deadline) return resolve(false)
        setTimeout(check, 2000)
      }
    }
    check()
  })
}

/** Provision one instance under a per-container lock. */
export async function provision(instanceId) {
  const initial = getInstanceById(instanceId)
  if (!initial) return
  const name = containerName(initial.slug)

  return withLifecycleLock(name, async () => {
    const inst = getInstanceById(instanceId)
    if (!inst || inst.status === 'deleting') return
    try {
      await removeExistingContainerUnlocked(name)
      await ensureImage()
      await createContainerUnlocked({ slug: inst.slug, hostPort: inst.host_port })
      const healthy = await waitHealthy(inst.host_port, config.instanceStartTimeoutMs)

      // Deletion may set its tombstone while health polling is in progress.
      const current = getInstanceById(instanceId)
      if (!current || current.status === 'deleting') {
        await removeExistingContainerUnlocked(name)
        return
      }
      if (healthy) {
        updateInstanceUnlessDeleting(inst.id, { status: 'running', error: null })
      } else {
        await stopContainerUnlocked(name)
        updateInstanceUnlessDeleting(inst.id, { status: 'stopped', error: 'health check timed out' })
      }
    } catch (error) {
      const current = getInstanceById(instanceId)
      if (current && current.status !== 'deleting') {
        updateInstanceUnlessDeleting(inst.id, {
          status: 'failed',
          error: String(error?.stderr ?? error?.message ?? error),
        })
      }
    }
  })
}
