#!/usr/bin/env bash
# Run collect.mjs against an already-built FlyBot runtime image and
# validate the output. Does not push or publish the image. Requires Docker
# only on the machine that already built the image (CI).
set -euo pipefail

IMAGE=${1:?usage: run-in-image.sh <image> <output-dir>}
OUT=${2:?usage: run-in-image.sh <image> <output-dir>}
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
COLLECT="$SCRIPT_DIR/collect.mjs"

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

if [[ "$(id -u)" -eq 0 ]]; then
  chown 1000:1000 "$OUT"
elif command -v sudo >/dev/null 2>&1; then
  sudo chown 1000:1000 "$OUT"
else
  echo "need to chown $OUT to 1000:1000 so the image user can write" >&2
  exit 1
fi

docker run --rm \
  --user 1000:1000 \
  --read-only \
  --network none \
  --tmpfs /tmp:rw,noexec,nosuid,size=67108864 \
  --mount "type=bind,src=${COLLECT},dst=/inventory/collect.mjs,readonly" \
  --mount "type=bind,src=${OUT},dst=/out" \
  --entrypoint node \
  "$IMAGE" \
  /inventory/collect.mjs --out /out

test -s "$OUT/inventory.json"
test -s "$OUT/inventory.md"
test -s "$OUT/summary.json"
node "$SCRIPT_DIR/validate.mjs" --expect-image --inventory "$OUT/inventory.json"

# The container wrote as uid 1000. Give the host runner the directory back
# so debian-source-offer.py can add files beside the inventory.
if [[ "$(id -u)" -eq 0 ]]; then
  chown -R "$(id -u):$(id -g)" "$OUT"
elif command -v sudo >/dev/null 2>&1; then
  sudo chown -R "$(id -u):$(id -g)" "$OUT"
else
  echo "need to chown $OUT back to $(id -u):$(id -g) to write the Debian offer" >&2
  exit 1
fi

repo_root=$(cd "$SCRIPT_DIR/../../.." && pwd)
if [[ -f "$repo_root/scripts/debian-source-offer.py" ]]; then
  python3 "$repo_root/scripts/debian-source-offer.py" --inventory "$OUT/inventory.json" --out "$OUT"
  test -s "$OUT/debian-source-offer.md"
  test -s "$OUT/debian-packages.json"
fi
