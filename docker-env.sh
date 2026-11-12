# Copyright © The Daybrite Project
# SPDX-License-Identifier: MPL-2.0
#
# Source before `wrangler deploy` (which builds the license container image) on a Mac running
# Colima: a Docker configuration of its own (.docker/, git-ignored) with Homebrew's buildx plugin and
# no Docker Desktop credential helper, pointed at Colima's socket.
#   . ./docker-env.sh
export DOCKER_CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/.docker"
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
mkdir -p "$DOCKER_CONFIG"
[ -f "$DOCKER_CONFIG/config.json" ] || printf '{\n  "cliPluginsExtraDirs": ["%s"]\n}\n' \
  "$(brew --prefix)/lib/docker/cli-plugins" > "$DOCKER_CONFIG/config.json"
