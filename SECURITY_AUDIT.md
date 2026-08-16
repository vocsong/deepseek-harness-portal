# Security Audit Report

**Project:** DeepSeek Harness Portal  
**Audit date:** 2026-08-16  
**Portal commit:** `9eaa7be06fa1307d418b77f41747bd7641964fad`  
**dsh build input:** `47f943859bef60e4160492346772ded9b24f765a`

## Executive summary

The portal has sound foundations—prepared SQL, bcrypt password hashing, cryptographically random OTP/session values, server-side role and ownership checks, escaped frontend rendering, rootless/non-root containers, and loopback-only host publication. No SQL injection, authorization bypass, or stored/reflected XSS was verified. The portal's locked npm dependency tree has no known advisories, and no secret was found in tracked files or reachable Git history.

It is **not yet safe to treat tenant containers as an untrusted multi-tenant boundary**. The most urgent issues are:

1. The parent-domain portal bearer cookie is forwarded into tenant containers over HTTP and WebSocket.
2. Tenant subdomains are same-site with the portal and can submit destructive admin requests because mutations have no CSRF/Origin protection.
3. OTP authentication fails open if SMTP is absent: the OTP is returned to the unauthenticated caller.
4. Authentication/invitation endpoints have no rate limiting.
5. Local secret/database ACLs and the image build context expose ignored secrets beyond their intended boundary.
6. The dsh runtime dependency graph currently reports 25 production advisories.

The report recommends immediate containment and a small atomic portal hotfix before further production use, followed by session/authentication hardening, image remediation, and stronger tenant isolation.

## Scope and method

Reviewed:

- `portal/src/*.js`, `portal/public/*`, package manifest and lockfile
- `image/Dockerfile`, `image/start.sh`, build/run scripts, ignore files, README
- Current ignored dsh checkout as an image build input
- Git tracked files and reachable history for common secret patterns
- Live response headers, cookies, unauthorized access, logout invalidation, parser/body limits, authentication throttling, CSRF behavior, proxy header behavior, Podman runtime settings/network reachability, and Windows ACLs
- Dependency audits for both portal and dsh

Safe runtime probes were read-only or used nonexistent resource IDs. No destructive tenant/admin action was performed.

Not assessed in depth: Cloudflare account policy, SMTP provider security, Podman/Windows/VM vulnerabilities, model-provider APIs, or a complete source audit of upstream dsh. The dsh advisory count identifies vulnerable packages but does not prove every advisory is reachable through this deployment.

## Findings

### SEC-01 — Critical (configuration-dependent): OTP authentication fails open without SMTP

**Evidence**

- `portal/src/config.js:61-65` automatically enables development mode when `SMTP_HOST` is missing.
- `portal/src/mailer.js:18-21` logs and returns the OTP.
- `portal/src/index.js:132-134, 212-214` exposes that OTP as `devCode` from registration and login APIs.
- Registration defaults enabled and the invite code defaults empty (`portal/src/db.js:109,117`).

**Impact**

A fresh or misconfigured public deployment without SMTP lets an unauthenticated caller request an OTP for a known account and receive the code directly in the response. This is a direct account takeover path, including for administrators.

**Current mitigation**

The audited live configuration had SMTP configured and OTP development mode disabled, so this path was not active at audit time.

**Recommendation**

Never infer development mode from missing SMTP. Require an explicit development environment flag and permit it only while bound to loopback. Never return OTP values from network APIs. In production, fail startup or disable OTP authentication if delivery is unavailable.

---

### SEC-02 — High: portal bearer credentials cross into tenant containers

**Evidence**

- `portal/src/index.js:58-65` scopes `portal_session` to the configured parent cookie domain.
- `portal/src/proxy.js:15-19` removes only `Origin`.
- `portal/src/proxy.js:110,138` forwards the original raw HTTP/WebSocket request using `http-proxy`.
- `portal/src/proxy.js:54-58` allows administrators to open every tenant instance.
- An isolated reproduction with the exact proxy options confirmed that `Host` was rewritten and `Origin` removed while `Cookie: portal_session=...` reached the upstream unchanged.

**Impact**

A compromised, vulnerable, or instrumented tenant upstream receives the owner's portal bearer token. If an administrator opens that tenant, it receives an administrator token that can be replayed against portal admin APIs. `HttpOnly` does not help because the upstream server receives the HTTP header directly.

The proxy also deliberately represents requests as loopback to bypass dsh's privileged-method fence, increasing the importance of keeping portal credentials out of the upstream.

**Recommendation**

Before forwarding HTTP or WebSocket traffic, remove portal session/legacy cookies, `Authorization`, `Proxy-Authorization`, and other gateway-only credentials. Preserve only explicitly allowlisted headers. Strip upstream `Set-Cookie` responses. Longer term, replace the parent-domain bearer cookie with short-lived, instance-scoped launch grants or host-specific gateway credentials.

---

### SEC-03 — High: same-site tenant-origin CSRF reaches destructive admin routes

**Evidence**

- Parent-domain `SameSite=Lax` cookie: `portal/src/index.js:58-65`.
- No CSRF token, exact-Origin validation, or Fetch Metadata enforcement is registered.
- Bodyless destructive routes include user deletion (`portal/src/index.js:419-427`), instance start/stop/delete/reprovision (`:437-471`), and GET logout (`:267-275`).
- A live authenticated probe with `Origin: https://<tenant-subdomain>`, `Content-Type: text/plain`, and a nonexistent instance ID reached the route and returned its normal `404`, rather than being rejected as cross-origin.

**Impact**

Tenant subdomains are cross-origin but same-site, so `SameSite=Lax` does not isolate them. Malicious tenant content viewed by an authenticated administrator can auto-submit HTML forms to destructive portal endpoints. CORS does not stop form submission and does not protect server-side state changes.

**Recommendation**

Add centralized exact portal-Origin validation plus session-bound CSRF tokens to every mutation. Enforce JSON content type/custom CSRF header for JSON APIs and use Fetch Metadata as an additional signal. Make logout POST-only. Treat all tenant/sibling subdomains as untrusted.

---

### SEC-04 — High: authentication, OTP, and invite checks have no rate limiting

**Evidence**

- Registration/invite and OTP routes: `portal/src/index.js:119-151`.
- Password login: `portal/src/index.js:193-205`.
- Login OTP request/verify: `portal/src/index.js:208-225`.
- Requesting a new OTP deletes the previous record and resets attempts: `portal/src/otp.js:14-21`; the five-attempt cap applies only to the current code (`:35-43`).
- No rate-limit dependency or middleware exists in `portal/package.json`.
- A live burst of 25 invalid password attempts returned 25 `401` responses and no `429`.

**Impact**

Attackers can brute-force passwords/invite codes, repeatedly reset OTP attempt windows, enumerate accounts through distinct responses, email-bomb users, consume SMTP quota, and exhaust the Node event loop through synchronous bcrypt comparisons.

**Recommendation**

Add persistent per-IP and per-account/email limits, OTP resend cooldowns, failure windows that survive reissue, progressive backoff, global SMTP quotas, `Retry-After`, and monitoring. Use generic account-existence responses and dummy password work where appropriate. Trust forwarded client IPs only from the loopback tunnel ingress.

---

### SEC-05 — High: predictable administrator bootstrap password

**Evidence**

- `portal/src/config.js:41`, `run-portal.sh:25`, and `.env.example:12` fall back to `changeme`.
- `portal/src/db.js:202-212` seeds an administrator whenever no admin row exists.

**Impact**

A fresh deployment, database reset, or deletion of all admin rows can create a publicly predictable administrator account.

**Recommendation**

Remove all password fallbacks and reject placeholders. Require an explicit strong one-time bootstrap credential or generate a random one-time secret that must be rotated at first login. Refuse public startup when bootstrap requirements are not satisfied.

---

### SEC-06 — High: ignored secrets are included in the container build context

**Evidence**

- `build-image.sh:11` builds from the repository root.
- `.dockerignore:1-6` does not exclude root/portal `.env`, `.git`, generic logs, tunnel logs, or unrelated portal files.
- Current ignored environment files contain real service credentials (values intentionally omitted).

**Impact**

Every image build sends secret-bearing files and repository metadata to the Podman builder even though the Dockerfile does not currently `COPY` them into a layer. This exposes them to a remote/shared/compromised builder, diagnostics, or future broad `COPY` changes.

**Recommendation**

Use a minimal allowlisted build context containing only required `dsh` and `image` inputs. Explicitly exclude all `.env*`, `.git`, logs, databases/WAL/SHM, credentials, portal data, and unrelated source. Add a build-context preflight test.

---

### SEC-07 — High: known production advisories in the dsh image dependency graph

**Evidence**

`corepack pnpm audit --prod --json` against the actual dsh build input reported:

- **25 total:** 12 high, 12 moderate, 1 low
- Examples include `js-yaml` quadratic CPU DoS, `fast-uri` host-confusion issues, `ip-address` SSRF/trust-boundary bypass, `undici` disclosure/crash/desynchronization issues, `brace-expansion` resource exhaustion, and `postcss` path/file disclosure.

The portal audit reported zero known vulnerabilities.

**Impact**

The harness processes tenant-controlled files, URLs, configuration, and network activity. Not every advisory was proven reachable, but high-severity DoS, URL parsing, SSRF, and disclosure classes are relevant to this workload.

**Recommendation**

Update the approved dsh revision/lockfile to patched versions, rebuild, and rerun the production audit. Review high advisories for reachable paths rather than applying untested blanket overrides. Publish an SBOM and block image release on unapproved high/critical findings.

---

### DEP-01 — High (deployment): local ACLs expose secrets, sessions, and authorization state

**Evidence**

Windows ACL inspection showed inherited `Authenticated Users: Modify` and `Users: ReadAndExecute` on the repository, ignored `.env` files, SQLite database/WAL, and logs. The database stores plaintext bearer session tokens (`portal/src/db.js:46-49,179-197`) plus password hashes, roles, and routing state.

**Impact**

Any authenticated local Windows user can read active portal sessions and service credentials, modify roles/routing/database state, or alter portal source for execution after restart.

**Recommendation**

Run the portal under a dedicated non-interactive service identity. Remove broad inherited ACLs and grant only that identity, Administrators, and SYSTEM access to code, `.env`, database/WAL/SHM, logs, and backups. After correction, rotate service credentials and invalidate all active sessions.

---

### DEP-02 — High when the host is shared: loopback ports bypass portal authorization

**Evidence**

- Instances are published directly on `127.0.0.1:<port>` (`portal/src/orchestrator.js:28-38`).
- dsh binds `0.0.0.0` in the container (`image/start.sh:4-7`) and its privileged API trusts loopback.
- Direct safe probes to live host loopback instance ports returned HTTP 200 without portal authorization.

**Impact**

Any local process/account able to connect to host loopback bypasses portal ownership checks and reaches dsh's code-executing API. This is compatible with a single-user trusted host, but not a shared host security boundary.

**Recommendation**

Treat the host as single-user until an inner dsh authentication boundary exists. Prefer protected Unix/named sockets or an authenticated per-instance internal credential. Restrict local account access and firewall/ACL the service identity.

---

### SEC-08 — Medium: sessions do not expire server-side or revoke on security changes

**Evidence**

- Session rows contain only token, user, and creation time (`portal/src/db.js:46-50`).
- `userForSession` ignores age (`portal/src/db.js:192-197`).
- The seven-day limit exists only in the browser cookie (`portal/src/index.js:58-65`).
- Profile password/email changes and admin password reset do not revoke sessions (`portal/src/index.js:292-336,407-416`).

**Impact**

A copied token remains valid indefinitely when replayed manually, including after cookie expiry or a password reset.

**Recommendation**

Store only a digest of each bearer token plus `expires_at` and optional idle expiry. Enforce expiration on HTTP and WebSocket authorization, purge expired rows, rotate the current session after sensitive changes, and revoke all other sessions after password/email changes and resets.

---

### SEC-09 — Medium: email login identity changes without verification or recent authentication

**Evidence**

`portal/src/index.js:314-320` immediately assigns any unused syntactically valid allowed-domain email. Current-password verification applies only when changing a password (`:321-330`).

**Impact**

A stolen session can establish persistence by replacing the OTP/login email. Users can also claim an address they do not control.

**Recommendation**

Use a pending-email request/verify flow, send an OTP to the new address, require recent authentication, notify the old address, recheck uniqueness/policy at confirmation, and revoke sessions after success.

---

### SEC-10 — Medium: malformed WebSocket cookie can cause process-level denial of service

**Evidence**

- `portal/src/proxy.js:29-36` calls `decodeURIComponent` without error handling.
- It is called from an async raw EventEmitter upgrade listener (`portal/src/proxy.js:113-138`) without a surrounding rejection handler.

**Impact**

A malformed percent sequence sent to a known instance host can throw `URIError`; the resulting unhandled async-listener rejection can terminate the Node process under the current runtime policy.

**Recommendation**

Do not URI-decode the expected hex token; validate it against the exact format. Wrap the full upgrade path in `try/catch`, destroy the socket on all errors, and add a regression test that sends malformed cookies repeatedly while asserting process health.

---

### SEC-11 — Medium: tenant resource and network controls are incomplete/implicit

**Evidence**

`portal/src/orchestrator.js:28-39` sets CPU, memory, volumes, loopback publication, and restart policy, but no PID limit, disk/volume quota, bounded log driver, explicit network mode, read-only root, or `no-new-privileges` setting.

The current Windows/Podman deployment uses isolated `pasta`; an ephemeral tenant-equivalent container could not reach sibling published ports or the portal, and live containers run rootless/non-root with no effective capabilities. However, the orchestrator does not require that mode. A Linux/default bridge deployment may permit peer access.

**Impact**

A tenant can fork-bomb, fill storage/logs, or rely on platform-specific network defaults. Portable deployments may silently have a weaker tenant boundary than the audited host.

**Recommendation**

Add PID, writable-layer/volume, memory-swap, and bounded logging limits. Select and verify an explicit isolated rootless network mode that permits required internet egress but blocks host, metadata, and tenant peers. Add `no-new-privileges`, capability drops, and read-only filesystem/tmpfs controls where compatible.

---

### SEC-12 — Medium: deletion suppresses Podman failures before database removal

**Evidence**

`portal/src/orchestrator.js:50-58` ignores all container/volume removal errors. Callers then delete the user/instance database record (`portal/src/index.js:419-427,456-462`).

**Impact**

An apparent successful deletion can leave a running loopback service or credential-bearing volumes orphaned with no database record for cleanup.

**Recommendation**

Use a `deleting` state/tombstone, distinguish “already absent” from failure, verify container and volumes are gone, retain retryable errors, and delete the database record only after successful cleanup. Add periodic orphan reconciliation.

---

### SEC-13 — Medium: authenticated traffic can spawn unbounded Podman subprocesses

**Evidence**

`portal/src/proxy.js:100,129` calls `containerRunning` on each HTTP request/upgrade; `portal/src/orchestrator.js:60-66` runs `podman inspect` each time. Subprocesses have no explicit timeout.

**Impact**

An authenticated tenant can generate expensive Podman subprocesses and degrade the shared gateway/container engine.

**Recommendation**

Cache reconciled state briefly, serialize lifecycle changes per instance, reconcile in a background loop, add request limits, and apply subprocess timeouts/concurrency bounds.

---

### SEC-14 — Medium: browser hardening headers are missing

**Evidence**

`portal/src/index.js:30-35,49-52` sets only cache policy. Live responses lacked CSP/frame protection, `X-Content-Type-Options`, Referrer Policy, and HSTS.

**Impact**

The portal can be framed for UI redress/clickjacking, and the lack of CSP increases the impact of any future injection flaw.

**Recommendation**

Add a tested CSP with `frame-ancestors 'none'`, `object-src 'none'`, and restrictive script/base policies; `X-Content-Type-Options: nosniff`; a strict Referrer Policy; legacy `X-Frame-Options: DENY`; and HSTS at Cloudflare/origin.

---

### SEC-15 — Medium: image builds are mutable and patch validation fails open

**Evidence**

- Mutable base: `image/Dockerfile:13` (`node:22-bookworm-slim`).
- README clones the current upstream default branch rather than an approved commit.
- Runtime image is referenced as mutable `dsh:latest`.
- `image/Dockerfile:28-33` ends patch checks with `|| true`, masking failed substitutions/checks.

**Impact**

The deployed executable can change without a portal commit, builds are difficult to reproduce, and an upstream source change can silently invalidate documented security/routing patches.

**Recommendation**

Pin the base image by digest, pin/verify the dsh source commit, deploy immutable image digests, add revision labels/provenance, and make exact patch-count/replacement checks fail the build.

---

### SEC-16 — Medium: WebSocket authorization and activity are checked only at upgrade

**Evidence**

`portal/src/proxy.js:113-138` authorizes once and forwards the socket indefinitely. Logout/session deletion cannot close existing sockets. `last_active` is touched only at upgrade, while the idle sweep uses that value (`portal/src/index.js:522-535`).

**Impact**

A revoked session may retain an established channel until disconnect, and a genuinely active WebSocket session may be stopped as “idle.”

**Recommendation**

Track sockets by session/user and close them on revocation/expiry. Prefer short-lived scoped upgrade grants and update activity on frames/heartbeat.

---

### Low findings

- **GET logout CSRF:** `portal/src/index.js:267-271` allows forced logout; replace with protected POST only.
- **Internal proxy error disclosure:** `portal/src/proxy.js:21-25` returns `err.message`; return a generic 502 and log sanitized detail.
- **No disclosure/dependency automation policy:** no tracked `SECURITY.md`, Dependabot/Renovate config, or security CI was found.

## Operational observation requiring immediate private handling

A known testing administrator credential successfully authenticated against the live deployment during the audit. Account identifiers and credentials are intentionally omitted from this public-safe report. Remove/rotate all test administrator access and invalidate sessions before treating the deployment as production.

## Positive controls confirmed

- Admin APIs consistently require `requireAdmin`; instance proxy access enforces owner-or-admin.
- SQL values use prepared statements; no reachable SQL injection was found.
- Passwords use bcrypt; session tokens use 32 random bytes; OTP generation uses `crypto.randomInt`, salted hashes, constant-time comparison, expiry, and per-code attempt caps.
- Frontend user/log/error values are escaped before `innerHTML`; no concrete stored/reflected/DOM XSS or open redirect was found.
- API bodies have a default size limit; malformed JSON returns a generic 400 and a 1.1 MB body returned 413.
- Unauthorized portal admin routes returned 401; unauthorized instance access redirected to login; logout invalidated the tested session.
- Portal npm audit: 0 known vulnerabilities; lockfile entries use integrity hashes and HTTPS registry URLs.
- No private key/common provider token was found in tracked files or reachable Git history; `.env` was never tracked.
- Current containers are rootless, run as non-root `dsh`, have zero effective capabilities, use private named volumes, and publish only to host loopback.
- Current `pasta` networking blocked the tested container-to-container/host-port paths; the risk is that this is not explicitly enforced by code.

## Remediation plan

### P0 — Immediate containment and hotfix

1. Remove/rotate testing administrator credentials; invalidate every active session.
2. Restrict ACLs on code, `.env`, database/WAL/SHM, logs, and backups; rotate exposed service credentials.
3. Fix `.dockerignore`/build context before any new image build.
4. Deploy one atomic portal patch:
   - strip gateway credentials and upstream cookies in HTTP/WS proxying;
   - add exact-Origin + CSRF protection for mutations;
   - make logout POST-only;
   - safely reject malformed WS cookies and genericize proxy errors;
   - fail closed for SMTP/OTP production configuration;
   - remove bootstrap password defaults.

**P0 acceptance tests**

- Tenant-origin form/text POST with an admin cookie receives 403 and changes nothing.
- Same-origin mutation without CSRF receives 403; a valid token succeeds.
- HTTP/WS test upstream sees no portal cookie/auth headers and cannot set browser cookies.
- Repeated malformed WS cookies do not terminate the portal.
- Production startup fails without valid SMTP and a non-placeholder bootstrap secret.
- Build-context listing contains no `.env`, `.git`, database, or log.
- ACL inspection shows no broad user read/modify grants.

### P1 — Authentication, sessions, browser headers, and image dependencies

1. Add persistent layered rate limits, cooldowns, non-resetting OTP failure windows, generic enumeration-safe responses, and monitoring.
2. Migrate to hashed session tokens with server expiry/idle timestamps; force a global logout during migration and revoke sessions after security changes.
3. Add verified/re-authenticated email change workflow.
4. Add CSP/frame/HSTS/nosniff/referrer headers.
5. Update dsh dependencies, pin source/base/image digests, make patches fail closed, generate SBOM/provenance, and add portal+dsh dependency scanning CI.

**P1 acceptance tests**

- Limits return 429/`Retry-After`, persist across restart, and OTP reissue cannot reset failures.
- Database contains no usable bearer tokens; expired/revoked sessions fail HTTP and WS.
- Email cannot change without recent authentication and new-address OTP.
- Browser security-header tests pass without breaking the portal/dsh UI.
- No unapproved high/critical production advisories remain.

### P2 — Container/lifecycle resilience

1. Add explicit PID/disk/log/memory-swap limits and compatible no-new-privileges/read-only controls.
2. Require an explicit tested network mode that blocks host/metadata/sibling tenants while preserving required model-provider egress.
3. Replace per-request Podman inspection with bounded cached reconciliation and per-instance lifecycle locks.
4. Implement deletion tombstones, verified cleanup, retries, and orphan reconciliation.
5. Track/revoke WebSockets and update idle activity from frames/heartbeats.
6. Add automated security, proxy, orchestrator-failure, and isolation tests.

### P3 — Remove parent-domain bearer authority

Move the portal to a separate registrable site and use a host-only portal cookie. Authenticate tenant launches with short-lived, single-use grants scoped to the user, tenant slug, audience, and expiry; exchange them at the gateway for instance-specific authorization. This is a breaking DNS/cookie migration and should use staged dual validation and telemetry before removing `COOKIE_DOMAIN` support.

## Suggested implementation order by file

1. `portal/src/proxy.js` — credential stripping, upstream cookie filtering, WS error containment.
2. `portal/src/index.js` and `portal/public/app.js` — Origin/CSRF guard, POST logout, headers.
3. `portal/src/config.js`, `mailer.js`, `run-portal.sh` — fail-closed OTP/bootstrap configuration.
4. `.dockerignore`, `build-image.sh`, `image/Dockerfile` — context allowlist, provenance, patch checks.
5. `portal/src/db.js`, `auth.js`, `otp.js` — session migration, rate limits, OTP windows, verified email changes.
6. `portal/src/orchestrator.js` — resource/network limits, bounded reconciliation, reliable deletion.
7. CI/security policy — audits, SBOM/image scan, dependency updates, private vulnerability reporting.
