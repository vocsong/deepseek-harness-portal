#!/bin/bash
# Build the dsh:latest image from the fresh upstream clone in ./dsh.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f dsh/package.json ]; then
  echo "error: dsh/ clone missing. Run: git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git dsh" >&2
  exit 1
fi

podman build -t dsh:latest -f image/Dockerfile .
echo "built dsh:latest"
