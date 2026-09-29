#!/bin/sh
set -eu
# Railway mounts its volume at startup. Hand this dedicated data directory to
# the application user, then drop root before accepting any HTTP requests.
if [ "$(id -u)" = 0 ]; then
  chown node:node /data
  chmod 700 /data
  for file in /data/rove.sqlite /data/rove.sqlite-wal /data/rove.sqlite-shm; do
    if [ -f "$file" ]; then chown node:node "$file"; fi
  done
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
