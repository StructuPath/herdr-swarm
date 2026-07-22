#!/usr/bin/env bash
# Status action: open the Swarm Status pane (or no-op when it is already
# open). Thin by design — all rendering lives in bin/renderer.mjs behind
# scripts/status-pane.sh, and the whole single-instance/open/record flow is
# open_singleton_pane (lib.sh), shared with harvest.sh.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

require_herdr

open_singleton_pane status status-pane
