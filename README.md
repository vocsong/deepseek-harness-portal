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

- **Registration**: email + one-time code (OTP). No password required up front.
- **After registering**: the user sets a **username + password** (and can change name/email) in **Profile**, and uses those to log in next time.
- **Login**: username/password **or** "email me a code" (OTP fallback).
- **Admin controls** (Settings tab): email-domain whitelist, toggle OTP registration, toggle password login.

OTP delivery uses SMTP (nodemailer). With no `SMTP_HOST` configured (or `OTP_DEV_MODE=true`) the code is logged to the portal console for local testing.

## Architecture

| Component | Location | Role |
|---|---|---|
| Portal app | `portal/` | Fastify server: auth (OTP + password, bcrypt, session cookie), admin/user JSON API, static dashboard, subdomain reverse proxy |
| Orchestrator | `portal/src/orchestrator.js` | `podman` CLI wrappers: run/start/stop/rm/logs, port allocation, health polling, background provisioning |
| Storage | `portal/data/portal.db` | SQLite (better-sqlite3): users, otps, settings, instances, sessions |
| dsh image | `image/Dockerfile` | Builds `dsh:latest` from `dsh/` (fresh upstream clone) with two documented patches |
| dsh clone | `dsh/` | Fresh `deepseek-harness` checkout (build context, gitignored) |

### Per-instance model

Each user gets exactly one instance (`1 user : 1 instance`):

- **Container** `dsh-<slug>`, `--cpus 2 --memory 2g`, `--restart unless-stopped`
- **Two volumes**: `<name>-home` (mounted at `$DSH_HOME` — sessions, settings, credentials) and `<name>-workspace` (mounted at `/workspace` — the agent's persistent cwd)
- **Published** on `127.0.0.1:<port>` (never exposed beyond the host); the portal proxies to it
- Launched with `TRUSTED_HOST=<slug>.<instanceDomain>` so dsh's browser-trust fence accepts the subdomain
- The user's DeepSeek API key is entered inside their instance (Settings → Models) and lives only in that instance's home volume

### Two build-time patches to dsh (see `image/Dockerfile`)

1. Identity opener → `"You are an AI agent."` (branding)
2. Allow `--host 0.0.0.0` → required so the published port reaches dsh inside the container (its CLI refuses `0.0.0.0` by default for LAN safety; inside the container only the loopback-published port is reachable)

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
```

### 2. Build the dsh image

```sh
./build-image.sh
# or: podman build -t dsh:latest -f image/Dockerfile .
```

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

Seeds an admin account on first boot from `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD` (**change the password**).

## Configuration (environment variables)

See `.env.example`. The important ones:

| Var | Default | Meaning |
|---|---|---|
| `DOMAIN` | `example.com` | Portal apex domain |
| `INSTANCE_DOMAIN` | `example.com` | Base for `<slug>.<instanceDomain>` |
| `INSTANCE_SLUG_SUFFIX` | `-deepseek` | Appended to the slug |
| `COOKIE_DOMAIN` | *(empty)* | Session cookie domain (must cover apex + instances) |
| `PORT` | `8080` | Portal listen port (cloudflared connects here) |
| `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD` | placeholders | Seeded admin |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | *(empty)* | Email delivery for OTP (empty = dev mode, codes logged to console) |
| `PORT_RANGE_START` / `END` | `18000` / `18100` | Host loopback port pool |
| `INSTANCE_CPUS` / `INSTANCE_MEMORY` | `2` / `2g` | Per-instance limits |

## Operations

- **Admin**: log in as admin → Settings tab → email-domain whitelist + auth toggles. Instances tab → start/stop/reprovision/delete, view logs, usage (requests + last-active). Users tab → list users.
- **User**: register with email OTP → set username/password in Profile → instance auto-provisions → dashboard shows URL + status + Start/Stop.
- **Launch**: `https://<slug>.<instance-domain>` — the portal authenticates + authorizes, then proxies to the container.
- **API key**: set per-instance inside dsh (Settings → Models).

## Restart after a reboot

```sh
podman machine start <machine-name>   # 1) container runtime
cloudflared tunnel --config ~/.cloudflared/<tunnel-name>.yml run <tunnel-name>
./run-portal.sh                      # 2) portal (foreground; wrap in nohup/& for background)
```

Containers carry `--restart unless-stopped`, so running instances return on their own once the podman machine is back up. The portal re-queues any instance left `provisioning` at boot.

## Security model

- Session cookie: `HttpOnly`, `SameSite=Lax`, `Secure` when `COOKIE_DOMAIN` is set, 7-day expiry.
- Passwords: bcrypt. OTP codes: SHA-256 hashed, 10-minute expiry, attempt-capped, constant-time compare.
- Every subdomain request is authenticated (session) and authorized (owner or admin) **before** reaching a container; containers listen on host loopback only.
- Instances are isolated: private home + workspace volumes, CPU/memory caps, dsh's own sandbox.
- The portal is the sole auth layer (no Cloudflare Access).

## Files

```
deepseek-portal/
  portal/            Fastify app + static dashboard
  image/             Dockerfile + start.sh (dsh image)
  dsh/               fresh upstream clone (build context, gitignored)
  build-image.sh
  run-portal.sh
  .env.example
  README.md
```
