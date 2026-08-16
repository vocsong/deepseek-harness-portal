const $ = (sel) => document.querySelector(sel)

let me = null
let authMode = 'login' // 'login' | 'register'
let otpStep = 'send'   // 'send' | 'verify'
let pendingEmail = ''
let cfg = { domain: '', instanceDomain: '', otpRegistrationEnabled: true, passwordLoginEnabled: true, inviteCodeRequired: false }

async function api(path, opts = {}) {
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  const res = await fetch(path, {
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' } } : {}),
    credentials: 'same-origin',
    cache: 'no-store',
    ...opts,
    body,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// Run fn with the button disabled + a loading label, always restoring it.
async function withButtonLoading(btn, loadingText, fn) {
  const originalText = btn.textContent
  btn.disabled = true
  btn.textContent = loadingText
  try {
    return await fn()
  } finally {
    btn.disabled = false
    btn.textContent = originalText
  }
}

// ---- views ----

function show(view) {
  for (const id of ['auth-view', 'user-view', 'admin-view', 'profile-view']) $(`#${id}`).classList.add('hidden')
  if (view) $(`#${view}`).classList.remove('hidden')
  $('#topbar').classList.toggle('hidden', !view || view === 'auth-view')
}

function statusBadge(status) {
  return `<span class="status-badge status-${status}">${status}</span>`
}

function fmtTime(ms) {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

function instanceUrl(slug) {
  return `https://${slug}.${cfg.instanceDomain}`
}

// ---- auth ----

function resetAuth() {
  otpStep = 'send'
  $('#auth-msg').textContent = ''
  $('#login-form').reset()
  $('#login-otp-form').reset()
  $('#register-form').reset()
  $('#login-otp-code-row').classList.add('hidden')
  $('#register-otp-row').classList.add('hidden')
  $('#register-invite-row').classList.toggle('hidden', !cfg.inviteCodeRequired)
  $('#login-otp-submit').textContent = 'Send code'
  $('#register-submit').textContent = 'Send code'
  renderAuthTabs()
}

function renderAuthTabs() {
  const login = authMode === 'login'
  $('#tab-login').classList.toggle('primary', login)
  $('#tab-register').classList.toggle('primary', !login)
  $('#login-form').classList.toggle('hidden', !login)
  $('#login-otp-form').classList.add('hidden') // only revealed via "Email me a code instead"
  $('#register-form').classList.toggle('hidden', login)
}

$('#tab-login').addEventListener('click', () => { authMode = 'login'; resetAuth() })
$('#tab-register').addEventListener('click', () => { authMode = 'register'; resetAuth() })

// password login
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  $('#auth-msg').textContent = ''
  try {
    await api('/api/auth/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } })
    await boot()
  } catch (err) { $('#auth-msg').textContent = err.message }
})

$('#login-via-otp').addEventListener('click', () => {
  $('#login-form').classList.add('hidden')
  $('#login-otp-form').classList.remove('hidden')
})

// OTP login
$('#login-otp-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  const email = fd.get('email')
  $('#auth-msg').textContent = ''
  try {
    if (otpStep === 'send' || email !== pendingEmail) {
      await withButtonLoading($('#login-otp-submit'), 'Sending…', () =>
        api('/api/auth/login/request', { method: 'POST', body: { email } }))
      pendingEmail = email
      otpStep = 'verify'
      $('#login-otp-code-row').classList.remove('hidden')
      $('#login-otp-submit').textContent = 'Verify code'
      $('#auth-msg').textContent = 'Code sent — check your email.'
      return
    }
    await withButtonLoading($('#login-otp-submit'), 'Verifying…', () =>
      api('/api/auth/login/verify', { method: 'POST', body: { email, otp: fd.get('otp') } }))
    await boot()
  } catch (err) {
    $('#auth-msg').textContent = err.message
    if (otpStep === 'verify') { otpStep = 'send'; $('#login-otp-submit').textContent = 'Send code' }
  }
})

// registration (email OTP)
$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  const email = fd.get('email')
  const name = fd.get('name')
  const inviteCode = fd.get('inviteCode')
  $('#auth-msg').textContent = ''
  try {
    if (otpStep === 'send' || email !== pendingEmail) {
      await withButtonLoading($('#register-submit'), 'Sending…', () =>
        api('/api/auth/register/request', { method: 'POST', body: { email, inviteCode } }))
      pendingEmail = email
      otpStep = 'verify'
      $('#register-otp-row').classList.remove('hidden')
      $('#register-submit').textContent = 'Verify & create account'
      $('#auth-msg').textContent = 'Code sent — check your email.'
      return
    }
    await withButtonLoading($('#register-submit'), 'Creating account…', () =>
      api('/api/auth/register/verify', { method: 'POST', body: { email, otp: fd.get('otp'), name, inviteCode } }))
    await boot()
  } catch (err) {
    $('#auth-msg').textContent = err.message
    if (otpStep === 'verify') { otpStep = 'send'; $('#register-submit').textContent = 'Send code' }
  }
})

// Logout is a plain link (GET /api/auth/logout) — full browser navigation,
// no fetch/JS dependency, so no cache or in-memory state can survive it.
// (No handler needed for #logout.)

// ---- profile ----

async function renderProfile() {
  const p = await api('/api/profile')
  $('#profile-form').elements.name.value = p.name ?? ''
  $('#profile-form').elements.username.value = p.username ?? ''
  $('#profile-form').elements.email.value = p.email ?? ''
}

$('#profile-btn').addEventListener('click', async () => {
  show('profile-view')
  $('#profile-msg').textContent = ''
  try { await renderProfile() } catch (err) { $('#profile-msg').textContent = err.message }
})

$('#profile-back').addEventListener('click', () => { boot() })

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  $('#profile-msg').textContent = ''
  try {
    await api('/api/profile', { method: 'POST', body: {
      name: fd.get('name'),
      username: fd.get('username') || undefined,
      email: fd.get('email'),
      newPassword: fd.get('newPassword') || undefined,
      currentPassword: fd.get('currentPassword') || undefined,
    }})
    $('#profile-msg').textContent = 'Saved ✓'
    await boot()
  } catch (err) { $('#profile-msg').textContent = err.message }
})

// ---- user view ----

async function renderUser() {
  try {
    const { instance } = await api('/api/instance')
    const body = $('#instance-body')
    const empty = $('#instance-empty')
    if (!instance) {
      body.classList.add('hidden')
      empty.classList.remove('hidden')
      empty.textContent = 'No instance provisioned yet. Contact your admin.'
      return
    }
    empty.classList.add('hidden')
    body.classList.remove('hidden')
    $('#i-slug').textContent = instance.slug
    $('#i-status').innerHTML = statusBadge(instance.status)
    const url = instanceUrl(instance.slug)
    $('#i-url').textContent = url
    $('#i-url').href = url
    $('#i-launch').href = url
    $('#i-requests').textContent = instance.request_count ?? 0
    $('#i-active').textContent = fmtTime(instance.last_active)
    $('#i-error').textContent = instance.error || ''
    // Launch always works: the proxy auto-starts a stopped instance.
    $('#i-launch').classList.remove('hidden')
  } catch (err) {
    $('#instance-empty').textContent = err.message
  }
}

// ---- admin view ----

let adminTab = 'instances'

async function renderStats() {
  try {
    const { stats } = await api('/api/admin/stats')
    $('#stats').innerHTML =
      `Users: <b>${stats.users}</b> &nbsp; Instances: <b>${stats.instances}</b> &nbsp; ` +
      `Running: <b>${stats.running}</b> &nbsp; Total requests: <b>${stats.totalRequests}</b>`
  } catch { /* ignore */ }
}

async function renderInstances() {
  const { instances } = await api('/api/admin/instances')
  const rows = instances.map((i) => {
    const url = instanceUrl(i.slug)
    const id = i.username ?? i.email ?? i.user_name
    return `<tr>
      <td>${i.slug}</td>
      <td>${id}</td>
      <td>${statusBadge(i.status)}</td>
      <td>${i.host_port}</td>
      <td>${i.request_count ?? 0}</td>
      <td>${fmtTime(i.last_active)}</td>
      <td>
        <button class="btn" data-act="reprovision" data-id="${i.id}">Reprovision</button>
        <button class="btn" data-act="logs" data-id="${i.id}">Logs</button>
        <button class="btn" data-act="delete" data-id="${i.id}">Delete</button>
        <a class="btn" href="${url}" target="_blank" rel="noopener">Open</a>
      </td>
    </tr>`
  }).join('')
  $('#instances-table').innerHTML =
    `<table><thead><tr><th>Slug</th><th>User</th><th>Status</th><th>Port</th><th>Req</th><th>Last active</th><th>Actions</th></tr></thead>
     <tbody>${rows || '<tr><td colspan="7">none</td></tr>'}</tbody></table>`
}

async function renderUsers() {
  const { users } = await api('/api/admin/users')
  const rows = users.map((u) => `<tr>
    <td>${u.username ?? '—'}</td><td>${u.email ?? '—'}</td><td>${u.name ?? ''}</td>
    <td>${u.role}</td><td>${fmtTime(u.created_at)}</td>
    <td>${u.role !== 'admin' ? `<button class="btn" data-uid="${u.id}" data-act="deluser">Delete</button>` : ''}</td></tr>`).join('')
  $('#users-table').innerHTML =
    `<table><thead><tr><th>Username</th><th>Email</th><th>Name</th><th>Role</th><th>Created</th><th></th></tr></thead>
     <tbody>${rows || '<tr><td colspan="6">none</td></tr>'}</tbody></table>`
}

async function renderSettings() {
  const s = await api('/api/admin/settings')
  $('#settings-form').elements.emailDomains.value = s.emailDomains ?? ''
  $('#settings-form').elements.inviteCode.value = s.inviteCode ?? ''
  $('#settings-form').elements.otpRegistrationEnabled.checked = s.otpRegistrationEnabled
  $('#settings-form').elements.passwordLoginEnabled.checked = s.passwordLoginEnabled
}

function renderAdmin() {
  renderStats()
  const tab = adminTab
  $('#instances-table').classList.toggle('hidden', tab !== 'instances')
  $('#users-table').classList.toggle('hidden', tab !== 'users')
  $('#settings-panel').classList.toggle('hidden', tab !== 'settings')
  if (tab === 'instances') renderInstances()
  else if (tab === 'users') renderUsers()
  else renderSettings()
}

$('#tab-instances').addEventListener('click', () => { adminTab = 'instances'; renderAdmin() })
$('#tab-users').addEventListener('click', () => { adminTab = 'users'; renderAdmin() })
$('#tab-settings').addEventListener('click', () => { adminTab = 'settings'; renderAdmin() })

$('#users-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act="deluser"]')
  if (!btn) return
  if (!confirm('Delete this user, their instance, and all its data?')) return
  try {
    await api(`/api/admin/users/${btn.dataset.uid}/delete`, { method: 'POST' })
    renderAdmin()
  } catch (err) { alert(err.message) }
})

$('#instances-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  const { act, id } = btn.dataset
  if (act === 'delete' && !confirm('Delete instance and its volumes?')) return
  try {
    if (act === 'logs') {
      const { logs } = await api(`/api/admin/instances/${id}/logs`)
      const w = window.open('', '_blank')
      w.document.write(`<pre style="white-space:pre-wrap;font:12px monospace">${escapeHtml(logs)}</pre>`)
      return
    }
    await api(`/api/admin/instances/${id}/${act}`, { method: 'POST' })
    renderAdmin()
  } catch (err) { alert(err.message) }
})

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  $('#settings-msg').textContent = ''
  try {
    await api('/api/admin/settings', { method: 'POST', body: {
      emailDomains: fd.get('emailDomains'),
      inviteCode: fd.get('inviteCode'),
      otpRegistrationEnabled: fd.get('otpRegistrationEnabled') === 'on',
      passwordLoginEnabled: fd.get('passwordLoginEnabled') === 'on',
    }})
    $('#settings-msg').textContent = 'Saved ✓'
    await renderSettings()
  } catch (err) { $('#settings-msg').textContent = err.message }
})

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

// ---- boot ----

async function boot() {
  try {
    const c = await api('/api/config')
    cfg = { ...cfg, ...c }
  } catch { /* defaults */ }

  try {
    const { user } = await api('/api/auth/me')
    me = user
    $('#whoami').textContent = `${user.username || user.email} (${user.role})`
    if (user.role === 'admin') {
      show('admin-view')
      renderAdmin()
    } else {
      show('user-view')
      await renderUser()
    }
  } catch {
    me = null
    show('auth-view')
    resetAuth()
  }
}

setInterval(async () => {
  if (!me) return
  if (me.role === 'admin') { renderStats(); if (adminTab === 'instances') renderInstances() }
  else renderUser()
}, 6000)

boot()
