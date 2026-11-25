#!/bin/sh
# Creates temporary SQLite/loopback HTTP/subprocess stub fixtures only. NOT DOCKER.
set -eu
cd "$(dirname "$0")/.."
printf '%s\n' 'STUB ACCEPTANCE ONLY: no real Docker, runtime image, volume, FlyBot or Teamily acceptance.'
PYTHONPATH=tests python3 -m unittest test_compose_manager -v
