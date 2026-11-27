#!/bin/sh
set -eu

version=0.64.0
case "$(dpkg --print-architecture)" in
    amd64) arch=x86_64; checksum=1b7b61a9350b595bba57e73f240cf26583f0c7fc1cd067a43ba79bca1ce9bf42 ;;
    arm64) arch=arm64; checksum=eb8f928e8fe34eeb08f77a4862dcf2acee73e3892bb320c58ce9bda828412ffd ;;
    *) exit 0 ;;
esac

temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
archive=${1:-"$temp_dir/driver.tgz"}
if [ "$#" -eq 0 ]; then
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 -o "$archive" \
        "https://github.com/trycua/cua/releases/download/cua-driver-rs-v$version/cua-driver-rs-$version-linux-$arch-binary.tar.gz"
fi
printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
tar -xzf "$archive" -C "$temp_dir" cua-driver
install -m 0755 "$temp_dir/cua-driver" /usr/local/bin/cua-driver
