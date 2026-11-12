# Copyright © The Daybrite Project
# SPDX-License-Identifier: MPL-2.0
#
# The license service as a Cloudflare Container (linux/amd64, Cloudflare Containers' platform:
# Apple's App License Delivery SDK ships its native library for x86_64 Linux only).
#
# The image only wraps dist/appfair-license, which scripts/build-linux.sh cross-compiles first: a
# fully static binary that makes no outgoing connections, so the image needs nothing else.

FROM --platform=linux/amd64 scratch
COPY dist/appfair-license /appfair-license
EXPOSE 8080
USER 65534:65534
ENTRYPOINT ["/appfair-license", "serve", "--hostname", "0.0.0.0", "--port", "8080"]
