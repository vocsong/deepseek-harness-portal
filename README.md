# DeepSeek Harness Portal

A multi-tenant platform that provisions and routes isolated [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) instances — one container per user — behind a single Cloudflare Tunnel.

```
Internet
  │  <your-domain>                    (portal: login, admin, user dashboard)
  │  <slug>.<instance-domain>         (one instance per user)
  ▼
Cloudflare Tunnel (cloudflared, one named tunnel)
  │
  ▼
Portal (Node + Fastify + SQLite) ── auth + reverse proxy + orchestrator
  │
  ├─► container dsh-<slug>   (dsh web on :3000 inside, published 127.0.0.1:18xxx)
  ├─► container dsh-<slug2>  ...
  └─► ...
```

The portal is the **only** authentication entry point. It owns registration, login, roles, and per-instance access control.

## Authentication model

- **Registration**: email + one-time code (OTP), with **optional username + password** set during signup (so a new user can log in with credentials right away). An invite code is enforced when the admin has set one.
- **After registering**: Profile can change name, username, password, and email. Email replacement requires separate codes from both the current and proposed mailboxes and revokes all other sessions.
- **Login**: username/password **or** "email me a code" (OTP fallback).
- **Admin controls** (Settings tab): email-domain whitelist, invite code, toggle OTP registration, toggle password login.

OTP delivery uses SMTP (nodemailer), which is required in production. Code logging is available only with the explicit localhost-only development combination `NODE_ENV=development`, `DOMAIN=localhost`, and `OTP_DEV_MODE=true`; OTP values are never returned by the API.

## Architecture

| Component | Location | Role |
|---|---|---|
| Portal app | `portal/` | Fastify server: auth (OTP + password, bcrypt, session cookie), admin/user JSON API, static dashboard, subdomain reverse proxy |
| Orchestrator | `portal/src/orchestrator.js` | `podman` CLI wrappers: run/start/stop/rm/logs, port allocation, health polling, background provisioning |
| Storage | `portal/data/portal.db` | SQLite (better-sqlite3): users, otps, settings, instances, sessions |
| dsh image | `image/Dockerfile` | Builds the reviewed dsh image from an approved upstream commit, a dependency-security patch, and two documented source patches; tagged `dsh:47f9438-node24` (Node 24 LTS on Debian 13 trixie) and deployed by its `sha256:` digest |
| dsh clone | `dsh/` | Fresh `deepseek-harness` checkout (build context, gitignored) |

### Per-instance model

Each user gets exactly one instance (`1 user : 1 instance`):

- **Container** `dsh-<slug>`, CPU/memory/swap/PID limits, read-only root + bounded tmpfs/logs, no capabilities, no-new-privileges, explicit isolated `pasta` networking, `--restart unless-stopped`
- **Two volumes**: `<name>-home` (mounted at `/home/dsh` — the user's writable home, including `$DSH_HOME=/home/dsh/.dsh` for sessions, settings, and credentials) and `<name>-workspace` (mounted at `/workspace` — the agent's persistent cwd)
- **Published** on `127.0.0.1:<port>` (never exposed beyond the host); the portal proxies to it
- The proxy presents traffic to the instance **as loopback** (`changeOrigin` rewrites `Host` to `127.0.0.1:<port>` and the browser's `Origin` is dropped) so dsh's loopback-only settings/credentials methods work; `TRUSTED_HOST=<slug>.<instanceDomain>` is still passed as a fallback
- The user's DeepSeek API key is entered inside their instance (Settings → Models) and lives only in that instance's home volume

### Build-time changes to dsh (see `image/Dockerfile`)

- `image/dsh-security.patch` applies reviewed transitive dependency floors and a matching frozen lockfile (production audit: zero known advisories at review time).
- Identity opener → `"You are an AI agent."` (branding).
- Allow `--host 0.0.0.0` → required so the published port reaches dsh inside the container (its CLI refuses `0.0.0.0` by default for LAN safety; inside the container only the loopback-published port is reachable).

The build script requires the exact approved upstream commit and fails if source/patch checks drift.

### Subdomains, not paths

Instances use **one-level subdomains** (`<slug>.<instance-domain>`), not `<your-domain>/<slug>`. Two reasons:

1. dsh's SPA calls `/api` and loads `/assets` with absolute paths baked at build time — path-based routing would require rewriting HTML and intercepting the SPA's absolute `/api` calls (fragile with multiple tabs).
2. Cloudflare's free-tier Universal SSL wildcard covers only **one** label (`*.example.com`), so `<slug>.<sub>.<your-domain>` has no valid TLS certificate. A `-deepseek` slug suffix keeps the brand while staying one label.

## Prerequisites

- **Podman** with a running machine: `podman machine start <machine-name>`
- **Node.js 22+** and **npm**
- **cloudflared** (`cloudflared tunnel --version`)
- A Cloudflare zone on your account, with the tunnel already authenticated

## Setup

### 1. Clone dsh (fresh upstream)

```sh
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git dsh
git -C dsh fetch --depth 1 origin 47f943859bef60e4160492346772ded9b24f765a
git -C dsh checkout --detach 47f943859bef60e4160492346772ded9b24f765a
```

### 2. Build the dsh image

```sh
./build-image.sh
```

Always use the script: it verifies the approved commit and patch, validates the context policy, and builds from a clean `git archive`. A direct `podman build` bypasses those controls. Copy the script's printed `DSH_IMAGE=sha256:...` line into `.env`; production rejects mutable image tags.

First build is slow (pnpm install + full harness build); result is ~2.5 GB.

### 3. Install portal deps

```sh
cd portal && npm install && cd ..
```

### 4. Configure

```sh
cp .env.example .env   # then edit .env (DOMAIN, INSTANCE_DOMAIN, ADMIN_*, SMTP_*)
```

### 5. Cloudflare routing (once)

```sh
cloudflared tunnel route dns <tunnel-name> '*.<instance-domain>'
cloudflared tunnel route dns <tunnel-name> <your-domain>
```

Tunnel config (`~/.cloudflared/<tunnel-name>.yml`):

```yaml
tunnel: <tunnel-id>
credentials-file: '~/.cloudflared/<tunnel-id>.json'
ingress:
  - hostname: <your-domain>
    service: http://127.0.0.1:8080
  - hostname: '*.<instance-domain>'
    service: http://127.0.0.1:8080
  - service: http_status:404
```

```sh
cloudflared tunnel --config ~/.cloudflared/<tunnel-name>.yml run <tunnel-name>
```

### 6. Run the portal

```sh
./run-portal.sh
```

Seeds an admin account on first boot from `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD`. The password must be explicitly set, non-placeholder, and at least 16 characters; startup refuses an unsafe bootstrap.

`run-portal.sh` first applies the tenant egress firewall (`firewall/apply.sh`) and fails closed if the Podman machine is not running.

## Configuration (environment variables)

See `.env.example`. The important ones:

| Var | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `production` | Use `development` only for localhost testing |
| `DOMAIN` | `example.com` | Portal apex domain |
| `PORTAL_ORIGIN` | `https://<DOMAIN>` | Exact trusted browser origin for mutation/CSRF checks |
| `INSTANCE_DOMAIN` | `example.com` | Base for `<slug>.<instanceDomain>` |
| `INSTANCE_SLUG_SUFFIX` | `-deepseek` | Appended to the slug |
| `COOKIE_DOMAIN` | *(empty)* | Session cookie domain (must cover apex + instances) |
| `SESSION_ABSOLUTE_TTL_MS` / `SESSION_IDLE_TTL_MS` | 7 days / 24 hours | Server-enforced session lifetime and idle expiry |
| `PORT` | `8080` | Portal listen port (cloudflared connects here) |
| `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD` | *(empty)* | First-boot admin; password must be explicit and at least 16 characters |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | *(empty)* | Production OTP delivery; host/from required, auth values paired |
| `OTP_TTL_MS` / `OTP_MAX_ATTEMPTS` | 10 min / 5 | OTP lifetime and per-code attempt cap |
| `AUTH_RATE_WINDOW_MS` / `AUTH_RATE_BLOCK_MS` | 15 min / 15 min | Persistent authentication throttling window/block |
| `OTP_RESEND_COOLDOWN_MS` | `60000` | Minimum interval between OTP requests per address/purpose |
| `PORT_RANGE_START` / `END` | `18000` / `18100` | Host loopback port pool |
| `DSH_IMAGE` | required | Immutable `sha256:...` image ID printed by `./build-image.sh`; mutable tags are rejected in production |
| `PODMAN_COMMAND_TIMEOUT_MS` | `60000` | Per-subprocess timeout for every `podman` call |
| `INSTANCE_CPUS` / `INSTANCE_MEMORY` / `INSTANCE_MEMORY_SWAP` | `2` / `2g` / `2g` | Per-instance compute limits |
| `INSTANCE_PIDS_LIMIT` | `512` | Per-container process limit |
| `INSTANCE_NETWORK` | `pasta` | Required isolated rootless network mode |
| `INSTANCE_LOG_SIZE` / `INSTANCE_TMPFS_SIZE` | `10mb` / `64m` | Bounded runtime log and temporary storage |
| `INSTANCE_READ_ONLY_ROOT` | `true` | Run tenant containers with a read-only root filesystem |

## Testing

```sh
cd portal && npm test
```

Runs the isolated transactional regression suite (email-change proof binding, attempt accounting, and uniqueness/session rollback) against a temporary SQLite database in `portal/test/`. It does not touch live data, send email, or require Podman.

## Operations

- **Admin**: log in as admin → Settings tab → email-domain whitelist, invite code, auth toggles. Instances tab → reprovision/delete, view logs, usage (requests + last-active). Users tab → list users.
- **User**: register (email OTP, optionally setting username/password) → instance auto-provisions → dashboard shows URL + status. Instances auto-start on launch and auto-stop after the idle timeout.
- **Launch**: `https://<slug>.<instance-domain>` — the portal authenticates + authorizes, then proxies to the container.
- **API key**: set per-instance inside dsh (Settings → Models).

## Restart after a reboot

```sh
podman machine start <machine-name>   # 1) container runtime
cloudflared tunnel --config ~/.cloudflared/<tunnel-name>.yml run <tunnel-name>
./run-portal.sh                      # 2) portal (foreground; wrap in nohup/& for background)
```

Containers carry `--restart unless-stopped`; platform behavior after a WSL machine restart can still leave them stopped. The portal auto-starts the authorized user's container on launch and re-queues any instance left `provisioning` at boot. `run-portal.sh` re-applies the tenant egress firewall on every start (idempotent); if you restart the Podman machine while the portal is already running, run `firewall/apply.sh` manually.

## Troubleshooting

**Symptom:** a tenant subdomain won't load, the container shows `Up` in `podman ps`, but `curl http://127.0.0.1:<port>` from Windows fails (while it returns 200 from inside the distro via `podman machine ssh <machine> 'curl http://127.0.0.1:<port>/'`).

**Cause:** WSL2's localhost forwarder (`wslrelay.exe`) can wedge a stale port-forward entry after many container stop/start cycles (idle-stop + auto-start). A stale `wslrelay` process and orphaned `pasta` processes accumulate.

**Fix:** restart the WSL2 VM and re-provision the stopped tenants:

```sh
wsl.exe --shutdown
podman machine start <machine-name>
# re-provision (or just launch each tenant; the portal auto-starts on access)
./run-portal.sh
```

Updating the WSL engine to the latest release (currently blocked by a Windows Installer reboot) is the durable fix for the underlying `wslrelay` staleness.

## Security model

- Session cookie: `HttpOnly`, `SameSite=Lax`, `Secure` when `COOKIE_DOMAIN` is set; bearer tokens are SHA-256-digested in SQLite with server-enforced 7-day absolute and 24-hour idle expiry.
- Passwords: bcrypt. OTP codes: salted SHA-256, 10-minute expiry, attempt-capped, constant-time compare; login/OTP/invite flows use persistent per-IP and per-account throttles.
- Every subdomain request is authenticated (session) and authorized (owner or admin) **before** reaching a container; portal cookies and gateway identity headers are stripped before HTTP/WebSocket forwarding.
- Portal mutations require the exact portal Origin and a per-session CSRF token; tenant sibling subdomains are treated as untrusted.
- Instances are isolated: private home + workspace volumes, CPU/memory caps, dsh's own sandbox.
- **Tenant egress firewall**: containers cannot reach RFC1918 private ranges (your LAN, `10/8`, `172.16/12`); only public internet egress is allowed. Enforced by nftables on the Podman machine (`firewall/tenant-egress.nft`), applied automatically by `run-portal.sh`.
- The portal is the sole auth layer (no Cloudflare Access).

## Files

```
deepseek-portal/
  portal/            Fastify app + static dashboard
    src/             backend modules (auth, db, otp, mailer, proxy, orchestrator, email-change)
    test/            transactional regression suite (npm test)
  image/             Dockerfile + start.sh + dsh-security.patch (dsh image)
  firewall/          tenant egress firewall (nftables) + apply.sh
  dsh/               fresh upstream clone (build context, gitignored)
  build-image.sh
  run-portal.sh      applies the egress firewall, then starts the portal
  .env.example
  README.md
  SECURITY_AUDIT.md  full audit, findings, and remediation status
  SECURITY.md        vulnerability disclosure policy
```
