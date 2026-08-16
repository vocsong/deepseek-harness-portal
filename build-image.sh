#!/bin/bash
# Build the dsh:latest image from the fresh upstream clone in ./dsh.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f dsh/package.json ]; then
  echo "error: dsh/ clone missing. Run: git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git dsh" >&2
  exit 1
fi

# Fail before contacting the builder if the deny-by-default context policy was
# removed. .gitignore is not a container-build security boundary.
required_dockerignore=(
  '*' '!dsh/' '!dsh/**' '!image/' '!image/Dockerfile' '!image/start.sh'
  'dsh/.git' 'dsh/**/.git' 'dsh/**/node_modules' 'dsh/**/.env' 'dsh/**/.env.*'
)
for pattern in "${required_dockerignore[@]}"; do
  grep -Fqx -- "$pattern" .dockerignore || {
    echo "error: .dockerignore is missing required security rule: $pattern" >&2
    exit 1
  }
done

podman build -t dsh:latest -f image/Dockerfile .
echo "built dsh:latest"
