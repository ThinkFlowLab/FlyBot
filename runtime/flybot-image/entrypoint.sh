#!/bin/sh
# Non-root entrypoint. The compose manager starts this image as UID/GID 1000
# with a read-only rootfs, so this script must not call groupmod, usermod,
# chown, or gosu, and must not write outside /data and the tmpfs /tmp.
# Prefer /data/tmp for TMPDIR: the manager's /tmp is mounted noexec.
set -eu

if [ ! -d /data/profiles/web ]; then
  mkdir -p /data
  cp -a /opt/dsh-template/. /data/
fi
mkdir -p /data/workspace /data/home /data/tmp /data/cache

HOST=${DSH_HOST:-0.0.0.0}
LISTEN_PORT=${DSH_LISTEN_PORT:-8080}
if [ "$HOST" = "0.0.0.0" ]; then
  # DSH 0.2.2 binds one concrete address and rejects the wildcard. Prefer the
  # container address so a published 127.0.0.1:port->8080 mapping can reach it.
  HOST=$(hostname -i 2>/dev/null | awk '{print $1}')
  HOST=${HOST:-127.0.0.1}
fi
case "$LISTEN_PORT" in
  ''|*[!0-9]*) echo "entrypoint: DSH_LISTEN_PORT must be a port number (got '$LISTEN_PORT')" >&2; exit 1 ;;
esac

export DSH_HOME=/data
export HOME="${HOME:-/data/home}"
export TMPDIR=/data/tmp
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/data/cache}"
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"
export DSH_TELEMETRY_DISABLED="${DSH_TELEMETRY_DISABLED:-1}"

cd /data/workspace
exec node /opt/flybot-workspace/runtime/flybot-image/launch.mjs --profile web \
  --patch /opt/flybot-workspace/runtime/flybot-image/docker.patch.yml \
  --no-open \
  --host "$HOST" --port "$LISTEN_PORT" \
  "$@"
