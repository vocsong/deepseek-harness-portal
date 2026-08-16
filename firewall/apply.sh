#!/bin/bash
# Apply the tenant egress firewall to the active Podman machine (idempotent).
#
# Run directly, or it is invoked automatically by run-portal.sh. Requires the
# Podman machine to be running.
set -euo pipefail
cd "$(dirname "$0")"

MACHINE="${PODMAN_MACHINE:-$(podman machine list --format '{{.Name}}' 2>/dev/null | head -1 | tr -d '*' | xargs)}"
if [ -z "$MACHINE" ]; then
  echo 'firewall: no podman machine found; start one first' >&2
  exit 1
fi
RUNNING="$(podman machine list --format '{{.Name}} {{.Running}}' 2>/dev/null | grep -F "$MACHINE" | awk '{print $NF}')"
if [ "$RUNNING" != "true" ]; then
  echo "firewall: podman machine '$MACHINE' is not running; start it first" >&2
  exit 1
fi

echo "firewall: applying tenant egress rules to podman machine '$MACHINE'"

# Remove any prior instance so re-application is clean, then load the ruleset.
podman machine ssh "$MACHINE" 'sudo nft delete table inet tenant-egress 2>/dev/null || true'
cat tenant-egress.nft | podman machine ssh "$MACHINE" 'sudo nft -f -'

echo 'firewall: applied:'
podman machine ssh "$MACHINE" 'sudo nft list table inet tenant-egress'
