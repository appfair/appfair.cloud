#!/bin/sh
# Copyright © The Daybrite Project
# SPDX-License-Identifier: MPL-2.0
#
# Unpack Apple's App License Delivery SDK (downloaded from
# https://developer.apple.com/download/all/?q=license%20delivery) into vendor/aldsdk.
#
# The SDK links its prebuilt static library by a path relative to the package being built
# (Sources/SDKInterface/<platform>-libSDKInterface.a), so this also links Sources/SDKInterface here
# to the SDK's copy. Both are git-ignored: the SDK is Apple's and not redistributable.
#
# usage: scripts/setup-ald-sdk.sh path/to/aldsdk1.0.1.tgz
set -eu
archive=${1:?usage: $0 path/to/aldsdk1.0.1.tgz}
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xzf "$archive" -C "$work"
sdk=$(find "$work" -maxdepth 2 -name Package.swift -exec dirname {} \; | head -1)
[ -n "$sdk" ] || { echo "no Package.swift in $archive" >&2; exit 1; }
rm -rf "$root/vendor/aldsdk"
mkdir -p "$root/vendor"
cp -R "$sdk" "$root/vendor/aldsdk"
ln -sfn ../vendor/aldsdk/Sources/SDKInterface "$root/Sources/SDKInterface"
echo "App License Delivery SDK installed at vendor/aldsdk"
