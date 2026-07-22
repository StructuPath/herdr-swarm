#!/usr/bin/env bash
# Harvest pane entrypoint: resolve session context once in bash, export it,
# exec the zero-dep Node renderer in harvest mode. Mirrors status-pane.sh;
# every early failure routes through pane_fatal (lib.sh) — a pane whose
# process exits immediately closes before the user can read anything, which
# reads as a crash.
set -uo pipefail

cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	# lib.sh (and pane_fatal with it) is unreachable without the plugin root,
	# so this one failure lingers inline.
	echo "herdr-swarm: cannot resolve the plugin root"
	sleep 600
	exit 1
}
. scripts/lib.sh

pane_require_node "harvest pane"

mf="$(manifest_path)"
[ -f "$mf" ] ||
	pane_fatal "herdr-swarm: no active swarm run for this workspace (no manifest at $mf) — nothing to harvest."

# Spawn-time env via the shared contract (state-dir rule). A corrupt manifest
# is NOT fatal here: the renderer treats corrupt as a first-class display
# state, and every destructive verb re-reads and refuses on corruption itself.
pane_export_context harvest "$mf"

exec node bin/renderer.mjs
