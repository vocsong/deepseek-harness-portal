/* DeepSeek Harness Portal — client */
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

let me = null
let csrfToken = ''
let authMode = 'login' // 'login' | 'register'
let otpStep = 'send'   // 'send' | 'verify'
let pendingEmail = ''
let instancesCache = []
let usersCache = []
let cfg = { domain: '', instanceDomain: '', otpRegistrationEnabled: true, passwordLoginEnabled: true, inviteCodeRequired: false }

// ---- inline icons (feather-style) ----
const ICONS = {
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
}

function icon(name, size = 16) {
  const body = ICONS[name] || ''
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

// inject icons into [data-icon] placeholders
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon) })
}

async function api(path, opts = {}) {
  const method = String(opts.method ?? 'GET').toUpperCase()
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : (unsafe ? '{}' : undefined)
  const headers = { ...(opts.headers ?? {}) }
  if (unsafe) headers['content-type'] = 'application/json'
  if (unsafe && csrfToken) headers['x-csrf-token'] = csrfToken
  const { body: _body, headers: _headers, ...rest } = opts
  const res = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...rest,
    headers,
    body,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function withButtonLoading(btn, loadingText, fn) {
  const original = btn.innerHTML
  btn.disabled = true
  btn.innerHTML = `<span class="spinner"></span> ${loadingText}`
  try { return await fn() } finally { btn.disabled = false; btn.innerHTML = original }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ---- toasts ----
function toast(message, type = 'info') {
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.innerHTML = `${icon(type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info')}<span>${escapeHtml(message)}</span>`
  $('#toasts').appendChild(el)
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 250) }, 3200)
}

// ---- modal ----
function openModal({ title, body, footer, wide = false }) {
  const root = $('#modal-root')
  root.classList.remove('hidden')
  root.innerHTML = `<div class="modal ${wide ? 'modal-wide' : ''}">
    <div class="modal-head"><span class="modal-title">${escapeHtml(title)}</span>
      <button class="modal-x" data-close>&times;</button></div>
    <div class="modal-body">${body}</div>
    ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
  </div>`
  hydrateIcons(root)
  root.querySelector('[data-close]')?.addEventListener('click', closeModal)
  root.addEventListener('click', (e) => { if (e.target === root) closeModal() })
  document.addEventListener('keydown', escHandler)
  return root
}
function closeModal() {
  $('#modal-root').classList.add('hidden')
  $('#modal-root').innerHTML = ''
  document.removeEventListener('keydown', escHandler)
}
function escHandler(e) { if (e.key === 'Escape') closeModal() }

// delegated password visibility toggle (works for static + modal fields)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.pw-toggle')
  if (!btn) return
  const input = btn.closest('.pw-row')?.querySelector('input')
  if (!input) return
  const show = input.type === 'password'
  input.type = show ? 'text' : 'password'
  btn.querySelector('.nav-icon').innerHTML = icon(show ? 'eye-off' : 'eye')
  btn.title = show ? 'Hide password' : 'Show password'
})

function confirmModal(title, message, actionLabel = 'Delete', danger = true) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p>${escapeHtml(message)}</p>`,
      footer: `<button class="btn" data-no>Cancel</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${escapeHtml(actionLabel)}</button>`,
    })
    const root = $('#modal-root')
    root.querySelector('[data-no]').addEventListener('click', () => { closeModal(); resolve(false) })
    root.querySelector('[data-yes]').addEventListener('click', () => { closeModal(); resolve(true) })
  })
}

// ---- formatting ----
function statusBadge(status) {
  const label = { running: 'Running', stopped: 'Stopped', provisioning: 'Provisioning', failed: 'Failed' }[status] || status
  return `<span class="badge badge-${status}"><span class="dot"></span>${label}</span>`
}
function relTime(ms) {
  if (!ms) return '—'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
function fmtDate(ms) { return ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—' }
function fmtNum(n) {
  if (n == null) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}
function instanceUrl(slug) { return `https://${slug}.${cfg.instanceDomain}` }

// ---- views ----
function showApp() { $('#auth-view').classList.add('hidden'); $('#app-view').classList.remove('hidden') }
function showAuth() { $('#app-view').classList.add('hidden'); $('#auth-view').classList.remove('hidden') }

function setAdminTab(tab) {
  $$('#admin-nav .nav-item, #mobile-admin-nav .nav-item').forEach((n) => n.classList.toggle('active', n.dataset.tab === tab))
  $('#panel-instances').classList.toggle('hidden', tab !== 'instances')
  $('#panel-users').classList.toggle('hidden', tab !== 'users')
  $('#panel-settings').classList.toggle('hidden', tab !== 'settings')
  const titles = { instances: 'Instances', users: 'Users', settings: 'Settings' }
  $('#topbar-title').textContent = titles[tab] || 'Overview'
  if (tab === 'instances') renderInstances()
  else if (tab === 'users') renderUsers()
  else if (tab === 'settings') renderSettings()
}

// ---- auth ----
function resetAuth() {
  otpStep = 'send'
  pendingEmail = ''
  $('#auth-msg').textContent = ''
  $('#login-form').reset()
  $('#login-otp-form').reset()
  $('#register-form').reset()
  $('#login-otp-code-row').classList.add('hidden')
  $('#register-otp-row').classList.add('hidden')
  $('#register-invite-row').classList.toggle('hidden', !cfg.inviteCodeRequired)
  $('#login-otp-submit').textContent = 'Send code'
  $('#register-submit').textContent = 'Send code'
  $('#login-otp-form').classList.add('hidden')
  $('#login-form').classList.remove('hidden')
  renderAuthTabs()
}

function renderAuthTabs() {
  const login = authMode === 'login'
  $('#tab-login').classList.toggle('active', login)
  $('#tab-register').classList.toggle('active', !login)
  $('#login-form').classList.toggle('hidden', !login)
  $('#register-form').classList.toggle('hidden', login)
  $('#login-otp-form').classList.add('hidden')
}

$('#tab-login').addEventListener('click', () => { authMode = 'login'; resetAuth() })
$('#tab-register').addEventListener('click', () => { authMode = 'register'; resetAuth() })

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  $('#auth-msg').textContent = ''
  const btn = e.target.querySelector('button[type="submit"]')
  try {
    await withButtonLoading(btn, 'Logging in…', () =>
      api('/api/auth/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } }))
    await boot()
  } catch (err) { $('#auth-msg').textContent = err.message }
})

$('#login-via-otp').addEventListener('click', () => {
  $('#login-form').classList.add('hidden')
  $('#login-otp-form').classList.remove('hidden')
})
$('#login-otp-back').addEventListener('click', () => {
  otpStep = 'send'
  $('#login-otp-form').classList.add('hidden')
  $('#login-form').classList.remove('hidden')
})

$('#login-otp-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  const email = fd.get('email')
  $('#auth-msg').textContent = ''
  const btn = $('#login-otp-submit')
  try {
    if (otpStep === 'send' || email !== pendingEmail) {
      await withButtonLoading(btn, 'Sending…', () =>
        api('/api/auth/login/request', { method: 'POST', body: { email } }))
      pendingEmail = email
      otpStep = 'verify'
      $('#login-otp-code-row').classList.remove('hidden')
      $('#login-otp-submit').textContent = 'Verify code'
      $('#auth-msg').textContent = 'Code sent — check your email.'
      return
    }
    await withButtonLoading(btn, 'Verifying…', () =>
      api('/api/auth/login/verify', { method: 'POST', body: { email, otp: fd.get('otp') } }))
    await boot()
  } catch (err) {
    $('#auth-msg').textContent = err.message
    if (otpStep === 'verify') { otpStep = 'send'; $('#login-otp-submit').textContent = 'Send code' }
  }
})

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  const email = fd.get('email')
  const name = fd.get('name')
  const username = fd.get('username')
  const password = fd.get('password')
  const inviteCode = fd.get('inviteCode')
  $('#auth-msg').textContent = ''
  const btn = $('#register-submit')
  try {
    if (otpStep === 'send' || email !== pendingEmail) {
      await withButtonLoading(btn, 'Sending…', () =>
        api('/api/auth/register/request', { method: 'POST', body: { email, inviteCode } }))
      pendingEmail = email
      otpStep = 'verify'
      $('#register-otp-row').classList.remove('hidden')
      $('#register-submit').textContent = 'Verify & create account'
      $('#auth-msg').textContent = 'Code sent — check your email.'
      return
    }
    await withButtonLoading(btn, 'Creating account…', () =>
      api('/api/auth/register/verify', { method: 'POST', body: { email, otp: fd.get('otp'), name, username, password, inviteCode } }))
    await boot()
  } catch (err) {
    $('#auth-msg').textContent = err.message
    if (otpStep === 'verify') { otpStep = 'send'; $('#register-submit').textContent = 'Send code' }
  }
})

// ---- profile (modal) ----
async function openProfile() {
  try {
    const p = await api('/api/profile')
    openModal({
      title: 'Profile',
      body: `<form id="profile-form" class="form">
        <div class="field"><label>Name</label><input name="name" value="${escapeHtml(p.name ?? '')}" /></div>
        <div class="field"><label>Username (used to log in)</label><input name="username" value="${escapeHtml(p.username ?? '')}" autocomplete="username" /></div>
        <div class="field"><label>Email</label><input name="email" type="email" value="${escapeHtml(p.email ?? '')}" /></div>
        <div class="field"><label>New password (leave blank to keep)</label><div class="pw-row"><input name="newPassword" type="password" autocomplete="new-password" /><button type="button" class="pw-toggle" title="Show password"><span class="nav-icon" data-icon="eye"></span></button></div></div>
        <div class="field"><label>Current password (required to change password)</label><div class="pw-row"><input name="currentPassword" type="password" autocomplete="current-password" /><button type="button" class="pw-toggle" title="Show password"><span class="nav-icon" data-icon="eye"></span></button></div></div>
        <p id="profile-msg" class="form-msg"></p>
      </form>`,
      footer: `<button class="btn" id="profile-save">Save</button>`,
    })
    $('#profile-save').addEventListener('click', async () => {
      const fd = new FormData($('#profile-form'))
      const msg = $('#profile-msg')
      msg.textContent = ''
      try {
        await api('/api/profile', { method: 'POST', body: {
          name: fd.get('name'),
          username: fd.get('username') || undefined,
          email: fd.get('email'),
          newPassword: fd.get('newPassword') || undefined,
          currentPassword: fd.get('currentPassword') || undefined,
        }})
        msg.textContent = 'Saved'
        msg.className = 'form-msg ok'
        setTimeout(() => { closeModal(); boot() }, 600)
      } catch (err) { msg.textContent = err.message; msg.className = 'form-msg err' }
    })
  } catch (err) { toast(err.message, 'err') }
}

// ---- user view ----
async function renderUser() {
  try {
    const { instance } = await api('/api/instance')
    const body = $('#instance-body'), empty = $('#instance-empty')
    if (!instance) {
      body.classList.add('hidden'); empty.classList.remove('hidden')
      empty.textContent = 'No instance provisioned yet. Contact your admin.'
      return
    }
    empty.classList.add('hidden'); body.classList.remove('hidden')
    $('#i-slug').textContent = instance.slug
    $('#i-status').innerHTML = statusBadge(instance.status)
    const url = instanceUrl(instance.slug)
    $('#i-url').textContent = url
    $('#i-url').href = url
    $('#i-launch').href = url
    $('#i-requests').textContent = fmtNum(instance.request_count ?? 0)
    $('#i-active').textContent = relTime(instance.last_active)
    $('#i-error').textContent = instance.error || ''
    $('#i-error').style.display = instance.error ? '' : 'none'
  } catch (err) {
    $('#instance-empty').textContent = err.message
  }
}

$('#i-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#i-url').textContent); toast('URL copied', 'ok') }
  catch { toast('Copy failed', 'err') }
})

// ---- admin ----
async function renderStats() {
  try {
    const { stats } = await api('/api/admin/stats')
    const cards = [
      ['Users', stats.users, 'users'],
      ['Instances', stats.instances, 'server'],
      ['Running', stats.running, 'play'],
      ['Total requests', fmtNum(stats.totalRequests), 'refresh'],
    ]
    $('#admin-stats').innerHTML = cards.map(([label, value, ic]) => `<div class="stat-card">
      <div class="stat-label"><span class="nav-icon" data-icon="${ic}"></span> ${label}</div>
      <div class="stat-value">${value}</div>
    </div>`).join('')
    hydrateIcons($('#admin-stats'))
  } catch { /* ignore */ }
}

async function renderInstances() {
  try {
    const { instances } = await api('/api/admin/instances')
    instancesCache = instances
    drawInstances()
  } catch (err) { $('#instances-table').innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>` }
}

function drawInstances() {
  const q = ($('#search-instances').value || '').toLowerCase()
  const rows = instancesCache
    .filter((i) => !q || [i.slug, i.username, i.email, i.user_name, i.status].some((v) => String(v ?? '').toLowerCase().includes(q)))
    .map((i) => {
      const url = instanceUrl(i.slug)
      const id = i.username || i.email || i.user_name || '—'
      return `<tr>
        <td class="cell-mono">${escapeHtml(i.slug)}</td>
        <td>${escapeHtml(id)}</td>
        <td>${statusBadge(i.status)}</td>
        <td class="cell-mono">${i.host_port}</td>
        <td>${fmtNum(i.request_count ?? 0)}</td>
        <td>${relTime(i.last_active)}</td>
        <td><div class="cell-actions">
          <a class="btn btn-ghost btn-sm" href="${url}" target="_blank" rel="noopener">${icon('external', 14)} Open</a>
          <button class="btn btn-ghost btn-sm" data-act="logs" data-id="${i.id}">${icon('terminal', 14)} Logs</button>
          <button class="btn btn-ghost btn-sm" data-act="reprovision" data-id="${i.id}">${icon('refresh', 14)} Reprovision</button>
          <button class="btn btn-danger btn-sm" data-act="delete" data-id="${i.id}">${icon('trash', 14)} Delete</button>
        </div></td>
      </tr>`
    }).join('')
  $('#instances-table').innerHTML = rows
    ? `<div class="table-wrap"><table><thead><tr><th>Instance</th><th>User</th><th>Status</th><th>Port</th><th>Req</th><th>Last active</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="empty">No instances found.</p>`
}

async function renderUsers() {
  try {
    const { users } = await api('/api/admin/users')
    usersCache = users
    drawUsers()
  } catch (err) { $('#users-table').innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>` }
}

function drawUsers() {
  const q = ($('#search-users').value || '').toLowerCase()
  const rows = usersCache
    .filter((u) => !q || [u.username, u.email, u.name, u.role].some((v) => String(v ?? '').toLowerCase().includes(q)))
    .map((u) => `<tr>
      <td>${escapeHtml(u.username || '—')}</td>
      <td>${escapeHtml(u.email || '—')}</td>
      <td>${escapeHtml(u.name || '')}</td>
      <td><span class="badge ${u.role === 'admin' ? 'badge-running' : 'badge-stopped'}">${u.role}</span></td>
      <td>${fmtDate(u.created_at)}</td>
      <td>${u.role !== 'admin' ? `<button class="btn btn-danger btn-sm" data-uid="${u.id}" data-act="deluser">${icon('trash', 14)} Delete</button>` : ''}</td>
    </tr>`).join('')
  $('#users-table').innerHTML = rows
    ? `<div class="table-wrap"><table><thead><tr><th>Username</th><th>Email</th><th>Name</th><th>Role</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="empty">No users found.</p>`
}

async function renderSettings() {
  try {
    const s = await api('/api/admin/settings')
    $('#set-domains').value = s.emailDomains ?? ''
    $('#set-invite').value = s.inviteCode ?? ''
    $('#settings-form').elements.otpRegistrationEnabled.checked = s.otpRegistrationEnabled
    $('#settings-form').elements.passwordLoginEnabled.checked = s.passwordLoginEnabled
  } catch (err) { $('#settings-msg').textContent = err.message; $('#settings-msg').className = 'form-msg err' }
}

$('#gen-invite').addEventListener('click', () => {
  const code = 'dsh-' + Math.random().toString(36).slice(2, 8).toUpperCase()
  $('#set-invite').value = code
})
$('#copy-invite').addEventListener('click', async () => {
  const v = $('#set-invite').value
  if (!v) { toast('Invitation code is empty', 'err'); return }
  try { await navigator.clipboard.writeText(v); toast('Invitation code copied', 'ok') }
  catch { toast('Copy failed', 'err') }
})

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  const msg = $('#settings-msg')
  msg.textContent = ''
  const btn = e.target.querySelector('button[type="submit"]')
  try {
    await withButtonLoading(btn, 'Saving…', () => api('/api/admin/settings', { method: 'POST', body: {
      emailDomains: fd.get('emailDomains'),
      inviteCode: fd.get('inviteCode'),
      otpRegistrationEnabled: fd.get('otpRegistrationEnabled') === 'on',
      passwordLoginEnabled: fd.get('passwordLoginEnabled') === 'on',
    }}))
    msg.textContent = 'Saved'
    msg.className = 'form-msg ok'
    await boot()
    setTimeout(() => { msg.textContent = '' }, 2000)
  } catch (err) { msg.textContent = err.message; msg.className = 'form-msg err' }
})

// ---- admin actions ----
$('#instances-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  const { act, id } = btn.dataset
  try {
    if (act === 'logs') {
      openModal({ title: 'Container logs', body: '<p><span class="spinner"></span> Loading…</p>', wide: true })
      const { logs } = await api(`/api/admin/instances/${id}/logs`)
      $('#modal-root .modal-body').innerHTML = `<pre class="log-view">${escapeHtml(logs || '(empty)')}</pre>`
      return
    }
    if (act === 'delete') {
      const ok = await confirmModal('Delete instance', 'Delete this instance and its volumes? This cannot be undone.')
      if (!ok) return
    }
    if (act === 'reprovision') {
      const ok = await confirmModal('Reprovision instance', 'Rebuild the container from the image? User data (volumes) is kept.', 'Reprovision', false)
      if (!ok) return
    }
    await api(`/api/admin/instances/${id}/${act}`, { method: 'POST' })
    toast(act === 'delete' ? 'Instance deleted' : 'Instance reprovisioning', 'ok')
    renderStats(); renderInstances()
  } catch (err) { toast(err.message, 'err') }
})

$('#users-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="deluser"]')
  if (!btn) return
  const ok = await confirmModal('Delete user', 'Delete this user, their instance, and all its data? This cannot be undone.')
  if (!ok) return
  try {
    await api(`/api/admin/users/${btn.dataset.uid}/delete`, { method: 'POST' })
    toast('User deleted', 'ok')
    renderStats(); renderUsers()
  } catch (err) { toast(err.message, 'err') }
})

$('#search-instances').addEventListener('input', drawInstances)
$('#search-users').addEventListener('input', drawUsers)

// ---- nav ----
$$('#admin-nav .nav-item, #mobile-admin-nav .nav-item').forEach((n) => n.addEventListener('click', () => setAdminTab(n.dataset.tab)))
$('#profile-btn').addEventListener('click', openProfile)
$('#mobile-profile-btn').addEventListener('click', openProfile)
$('#refresh-btn').addEventListener('click', () => { boot() })

// ---- boot ----
async function boot() {
  try {
    const c = await api('/api/config')
    cfg = { ...cfg, ...c }
  } catch { /* defaults */ }

  try {
    const { user, csrfToken: sessionCsrfToken } = await api('/api/auth/me')
    me = user
    csrfToken = sessionCsrfToken
    $$('.csrf-token').forEach((input) => { input.value = csrfToken })
    $('#whoami').textContent = user.username || user.email || user.name
    showApp()
    $('#admin-nav').classList.toggle('hidden', user.role !== 'admin')
    $('#mobile-admin-nav').classList.toggle('hidden', user.role !== 'admin')
    $('#user-view').classList.toggle('hidden', user.role === 'admin')
    $('#admin-view').classList.toggle('hidden', user.role !== 'admin')
    if (user.role === 'admin') {
      setAdminTab('instances')
      renderStats()
    } else {
      $('#topbar-title').textContent = 'Your instance'
      await renderUser()
    }
  } catch {
    me = null
    csrfToken = ''
    $$('.csrf-token').forEach((input) => { input.value = '' })
    showAuth()
    resetAuth()
  }
}

setInterval(async () => {
  if (!me) return
  if (me.role === 'admin') { renderStats(); if (!$('#panel-instances').classList.contains('hidden')) renderInstances() }
  else renderUser()
}, 6000)

hydrateIcons()
boot()
