import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import http from 'node:http'
import { config } from './config.js'
import { db, getInstanceById } from './db.js'

const run = promisify(execFile)

function podman(args, opts = {}) {
  return run('podman', args, { ...opts, windowsHide: true, maxBuffer: 10 * 1024 * 1024 })
}

export function containerName(slug) {
  return `dsh-${slug}`
}

export async function ensureImage() {
  try {
    await podman(['image', 'exists', config.image])
  } catch {
    throw new Error(`image "${config.image}" not found; build it first (podman build -t ${config.image} ...)`)
  }
}

export async function createContainer({ slug, hostPort }) {
  const name = containerName(slug)
  await podman([
    'run', '-d', '--name', name,
    '--cpus', config.instanceCpus,
    '--memory', config.instanceMemory,
    '-p', `127.0.0.1:${hostPort}:3000`,
    '-v', `${name}-home:/home/dsh/.dsh`,
    '-v', `${name}-workspace:/workspace`,
    '-e', 'DSH_HOME=/home/dsh/.dsh',
    '-e', `TRUSTED_HOST=${slug}.${config.instanceDomain}`,
    '--restart', 'unless-stopped',
    config.image,
  ])
}

export async function startContainer(name) {
  await podman(['start', name])
}

export async function stopContainer(name) {
  await podman(['stop', '-t', '15', name])
}

export async function removeContainer(name) {
  try { await podman(['rm', '-f', name]) } catch { /* already gone */ }
  try { await podman(['volume', 'rm', '-f', `${name}-home`, `${name}-workspace`]) } catch { /* ignore */ }
}

/** Remove a stale container but keep its volumes (idempotent re-provision). */
export async function removeContainerKeepVolumes(name) {
  try { await podman(['rm', '-f', name]) } catch { /* already gone */ }
}

export async function containerRunning(name) {
  try {
    const { stdout } = await podman(['inspect', '-f', '{{.State.Running}}', name])
    return stdout.trim() === 'true'
  } catch {
    return false
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

/**
 * Provision one instance end-to-end: ensure image, run container, wait healthy,
 * and record the outcome on the instance row. Safe to call in the background.
 */
export async function provision(instanceId) {
  const inst = getInstanceById(instanceId)
  if (!inst) return
  try {
    await removeContainerKeepVolumes(containerName(inst.slug))
    await ensureImage()
    await createContainer({ slug: inst.slug, hostPort: inst.host_port })
    const healthy = await waitHealthy(inst.host_port, config.instanceStartTimeoutMs)
    if (healthy) {
      const { updateInstance } = await import('./db.js')
      updateInstance(inst.id, { status: 'running', error: null })
    } else {
      await stopContainer(containerName(inst.slug))
      const { updateInstance } = await import('./db.js')
      updateInstance(inst.id, { status: 'stopped', error: 'health check timed out' })
    }
  } catch (error) {
    const { updateInstance } = await import('./db.js')
    updateInstance(inst.id, {
      status: 'failed',
      error: String(error?.stderr ?? error?.message ?? error),
    })
  }
}
