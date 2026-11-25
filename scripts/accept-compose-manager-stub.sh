#!/bin/sh
# Creates temporary SQLite/loopback HTTP/subprocess stub fixtures only. NOT DOCKER.
set -eu
cd "$(dirname "$0")/.."
printf '%s\n' 'Compose manager tests use local stubs. Docker images and volumes are covered by the runtime image workflow.'
PYTHONPATH=tests python3 -m unittest test_compose_manager -v
