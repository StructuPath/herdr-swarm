#!/usr/bin/env bash
# Harvest action: open the Swarm Harvest pane (or no-op when it is already
# open). Thin by design — the whole review-first merge flow lives in
# bin/renderer.mjs (harvest mode) behind scripts/harvest-pane.sh, and the
# single-instance/open/record flow is open_singleton_pane (lib.sh), shared
# with status.sh.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

require_herdr
version_gate intersection || true # R13: warn above max tested, never refuse

open_singleton_pane harvest harvest-pane
