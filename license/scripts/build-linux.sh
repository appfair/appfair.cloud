#!/bin/sh
# Copyright © The Daybrite Project
# SPDX-License-Identifier: MPL-2.0
#
# Cross-compile the license service into dist/appfair-license: a fully static x86_64 Linux binary
# (musl), which the Dockerfile wraps. It builds natively on any machine, Apple silicon included,
# with Swift's Static Linux SDK, so no x86_64 emulation is involved (the Swift compiler crashes
# with SIGILL under QEMU). Apple's ALD library needs only malloc, free and time from the C
# library, so it links against musl as well as glibc.
#
# Needs: a swift.org toolchain (swiftly, not Xcode's) and the Static Linux SDK of the same version:
#   swiftly install 6.4.0 && swiftly use 6.4.0
#   swift sdk install https://download.swift.org/swift-6.4.0-release/static-sdk/swift-6.4.0-RELEASE/swift-6.4.0-RELEASE_static-linux-0.1.0.artifactbundle.tar.gz \
#     --checksum <from https://www.swift.org/install>
# and vendor/aldsdk (scripts/setup-ald-sdk.sh).
#
# usage: scripts/build-linux.sh
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
sdk=x86_64-swift-linux-musl
scratch=.build/linux
# -Dx86_64_linux_gnu_TRIPLE makes the ALD SDK's manifest pick its x86_64 Linux library.
swift build -c release --swift-sdk "$sdk" --scratch-path "$scratch" -Xbuild-tools-swiftc -Dx86_64_linux_gnu_TRIPLE
bin=$(swift build -c release --swift-sdk "$sdk" --scratch-path "$scratch" --show-bin-path)/appfair-license
mkdir -p dist
# Debug info is two thirds of the binary; llvm-objcopy (in the toolchain) strips ELF on macOS too.
objcopy=$(dirname "$(xcrun --toolchain swift -f swift 2>/dev/null || command -v swift)")/llvm-objcopy
[ -x "$objcopy" ] || objcopy=$(command -v llvm-objcopy || command -v objcopy)
"$objcopy" --strip-all "$bin" dist/appfair-license
ls -l dist/appfair-license
