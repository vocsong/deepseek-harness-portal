#!/bin/bash
# Build the dsh image from the approved upstream revision and tracked image patches.
set -euo pipefail
cd "$(dirname "$0")"

APPROVED_DSH_COMMIT='47f943859bef60e4160492346772ded9b24f765a'
IMAGE_TAG='dsh:47f9438-node24'
if [ ! -f dsh/package.json ]; then
  echo "error: dsh/ clone missing. See README.md for the pinned clone commands." >&2
  exit 1
fi
ACTUAL_DSH_COMMIT=$(git -C dsh rev-parse HEAD)
if [ "$ACTUAL_DSH_COMMIT" != "$APPROVED_DSH_COMMIT" ]; then
  echo "error: dsh commit $ACTUAL_DSH_COMMIT is not approved $APPROVED_DSH_COMMIT" >&2
  exit 1
fi
if [ -n "$(git -C dsh status --porcelain --untracked-files=all)" ]; then
  echo "error: dsh contains tracked or untracked changes; reset to the approved commit" >&2
  exit 1
fi
[ -s image/dsh-security.patch ] || { echo 'error: image/dsh-security.patch missing' >&2; exit 1; }
git -C dsh apply --check ../image/dsh-security.patch

# The deny-by-default file may contain only these build-context re-inclusions.
expected_includes=(
  '!dsh/' '!dsh/**' '!image/' '!image/Dockerfile' '!image/start.sh' '!image/dsh-security.patch'
)
mapfile -t actual_includes < <(grep '^!' .dockerignore)
if [ "${#actual_includes[@]}" -ne "${#expected_includes[@]}" ]; then
  echo 'error: .dockerignore contains an unexpected build-context inclusion' >&2
  exit 1
fi
for i in "${!expected_includes[@]}"; do
  if [ "${actual_includes[$i]}" != "${expected_includes[$i]}" ]; then
    echo "error: unexpected .dockerignore inclusion: ${actual_includes[$i]}" >&2
    exit 1
  fi
done

# Build from a clean git archive, never from the working dsh directory. Ignored
# package-manager hooks, generated files, or local credentials cannot enter the
# context even if a future .dockerignore edit is mistaken.
CONTEXT=$(mktemp -d)
cleanup() { rm -rf "$CONTEXT"; }
trap cleanup EXIT
mkdir -p "$CONTEXT/dsh" "$CONTEXT/image"
git -C dsh archive "$APPROVED_DSH_COMMIT" | tar -x -C "$CONTEXT/dsh"
cp image/Dockerfile image/start.sh image/dsh-security.patch "$CONTEXT/image/"
cp .dockerignore "$CONTEXT/.dockerignore"

podman build --pull=always -t "$IMAGE_TAG" -f "$CONTEXT/image/Dockerfile" "$CONTEXT"
# Convenience tag for local inspection only; production orchestration uses the
# immutable sha256 digest printed below.
podman tag "$IMAGE_TAG" dsh:latest
IMAGE_ID="$(podman image inspect "$IMAGE_TAG" --format '{{.Id}}')"
echo "built $IMAGE_TAG from $APPROVED_DSH_COMMIT"
echo "set this immutable deployment reference in .env:"
echo "DSH_IMAGE=$IMAGE_ID"
