# Security Policy

## Supported versions

The single `main` branch is the only supported line. The deployment in production always runs the latest tagged `main` commit; fixes are not backported to historical commits.

## Reporting a vulnerability

Please **do not** open a public issue for security-sensitive reports.

1. Open a private security advisory on GitHub: **Security → Report a vulnerability** (preferred).
2. If that is unavailable, email the maintainer directly. Do not include live credentials or tokens in the initial report; use placeholders and share secrets only through an agreed private channel.

Include, where possible:

- Affected component (`portal`, proxy, orchestrator, image build, dsh dependency patch) and version/commit.
- A short description of the impact and attack preconditions.
- Reproduction steps or a proof of concept.
- Whether the issue is already known or publicly disclosed.

## What to expect

- An initial acknowledgement within a few days.
- A fix or a coordinated disclosure plan before public release.
- Credit in the release notes and advisory unless you request otherwise.

## Scope

In-scope examples: authentication/authorization bypass, session or OTP handling flaws, CSRF/Origin enforcement gaps, tenant-container isolation breaks, credential leakage into tenant upstreams, image build/verification bypass, and dependency advisories with a reachable path.

Out of scope: issues in third-party services (Cloudflare, the SMTP provider), model-provider APIs, or the upstream `deepseek-harness` project itself — report those to their respective maintainers.

## Disclosure

After a fix is merged and the production deployment is updated, an advisory is published here and the `SECURITY_AUDIT.md` remediation status is updated. Advisories do not include live credentials, tokens, hostnames, or account identifiers.

See `SECURITY_AUDIT.md` for the full findings list and remediation status.
