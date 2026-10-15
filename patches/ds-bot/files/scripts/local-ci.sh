#!/usr/bin/env bash
# Local compatibility CI for a Mac: the PR gate plus the plugin suites, with no
# GitHub-hosted runner. Run it from anywhere: ds-bot/scripts/local-ci.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

step="(start)"

on_exit() {
  local status=$?
  if [ "$status" -eq 0 ]; then
    echo "PASS: $(git rev-parse --short HEAD)"
  else
    echo "FAIL: $step (exit $status)"
  fi
}
trap on_exit EXIT

echo "FlyBot local CI"
echo "tip: $(git rev-parse --short HEAD) ($(git rev-parse HEAD))"
echo "branch: $(git branch --show-current)"

step="node -v (require major >= 22)"
echo "=== $step ==="
node -v
node_version="$(node -v)"
node_version="${node_version#v}"
if [ "${node_version%%.*}" -lt 22 ]; then
  exit 1
fi

step="npm ci"
echo "=== $step ==="
npm ci --no-fund --no-audit

step="Install DSH 0.2.0-rc.2"
echo "=== $step ==="
npm run harness -- --no-save @deepseek-ai/dsh@0.2.0-rc.2

step="lint"
echo "=== $step ==="
npm run lint

step="Build (client bundle is up to date)"
echo "=== $step ==="
node scripts/build-client.mjs --check

step="tests"
echo "=== $step ==="
npm test

step="plugin tests (social)"
echo "=== $step ==="
(cd ../plugins/social && npm test)

step="plugin tests (tree)"
echo "=== $step ==="
(cd ../plugins/tree && npm test)
