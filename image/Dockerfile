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

FROM node:22-bookworm-slim

# corepack (for pnpm) + git (lefthook postinstall) + curl (health checks)
# + python3/build-essential (node-pty native addon compile)
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/dsh

# Full upstream checkout (shallow clone placed here by the build context).
COPY dsh/ ./

# Apply the two build-time patches.
RUN sed -i "s/text: 'You are an AI agent powered by DeepSeek Harness.'/text: 'You are an AI agent.'/" \
      packages/core/system-prompt/src/index.ts \
 && sed -i "s/options.host === '0.0.0.0'/false/" \
      packages/bundle/web-app/src/startup.ts \
 && grep -n "You are an AI agent\." packages/core/system-prompt/src/index.ts | head -1 \
 && grep -n "options.host === '0.0.0.0'" packages/bundle/web-app/src/startup.ts | head -1 || true

# Install + build the harness (produces apps/web/dist and package lib/*).
# `git init .` satisfies lefthook's postinstall (the copy is not a git checkout).
RUN corepack enable \
 && git init . \
 && pnpm install --frozen-lockfile \
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
