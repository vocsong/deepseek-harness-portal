# DeepSeek Harness single-instance container.
#
# Two minimal, documented build-time patches are applied to the otherwise
# stock upstream checkout:
#   1. harness identity opener  -> "You are an AI agent." (branding)
#   2. allow `--host 0.0.0.0`   -> required so the container's published port
#      reaches dsh (its CLI refuses 0.0.0.0 by default for LAN safety; inside
#      this container only the podman-published loopback port is exposed).
#
# Each instance is launched with a private DSH_HOME and workspace volume, and
# trusts exactly its own subdomain (TRUSTED_HOST env).

FROM node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d

# corepack (for pnpm) + git (lefthook postinstall) + curl (health checks)
# + python3/build-essential (node-pty native addon compile)
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/dsh

# Full approved upstream checkout plus a reviewed, reproducible dependency-only
# security patch. build-image.sh verifies the exact upstream commit first.
COPY dsh/ ./
COPY image/dsh-security.patch /tmp/dsh-security.patch
RUN git init . \
 && git apply --check /tmp/dsh-security.patch \
 && git apply /tmp/dsh-security.patch \
 && rm /tmp/dsh-security.patch

# Apply the two build-time source patches, failing if upstream changed or either
# replacement did not happen exactly once.
RUN set -eux; \
    identity='packages/core/system-prompt/src/index.ts'; \
    startup='packages/bundle/web-app/src/startup.ts'; \
    test "$(grep -Fxc "        text: 'You are an AI agent powered by DeepSeek Harness.'," "$identity")" -eq 1; \
    test "$(grep -Fxc "    if (options.host === '0.0.0.0') {" "$startup")" -eq 1; \
    sed -i "s/text: 'You are an AI agent powered by DeepSeek Harness.'/text: 'You are an AI agent.'/" "$identity"; \
    sed -i "s/options.host === '0.0.0.0'/false/" "$startup"; \
    ! grep -Fq "You are an AI agent powered by DeepSeek Harness." "$identity"; \
    grep -Fq "text: 'You are an AI agent.'" "$identity"; \
    ! grep -Fq "options.host === '0.0.0.0'" "$startup"; \
    grep -Fq 'if (false) {' "$startup"

# Install + audit + build the harness (produces apps/web/dist and package lib/*).
RUN corepack enable \
 && pnpm install --frozen-lockfile \
 && pnpm audit --prod \
 && pnpm run build

# Non-root runtime user with a private home (DSH_HOME) and a workspace cwd.
RUN useradd -m -s /bin/bash dsh \
 && mkdir -p /workspace /home/dsh/.dsh \
 && chown -R dsh:dsh /workspace /home/dsh/.dsh

USER dsh
ENV HOME=/home/dsh \
    DSH_HOME=/home/dsh/.dsh
WORKDIR /workspace

EXPOSE 3000

COPY image/start.sh /start.sh
ENTRYPOINT ["/bin/bash", "/start.sh"]
