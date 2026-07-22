#!/usr/bin/env bash
# Harvest pane entrypoint: resolve session context once in bash, export it,
# exec the zero-dep Node renderer in harvest mode. Mirrors status-pane.sh;
# every early failure prints a friendly message and sleeps — a pane whose
# process exits immediately closes before the user can read anything, which
# reads as a crash.
set -uo pipefail

linger() {
	echo "$1"
	sleep 600
	exit 1
}

cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	echo "herdr-swarm: cannot resolve the plugin root"
	sleep 600
	exit 1
}
. scripts/lib.sh

command -v node >/dev/null 2>&1 ||
	linger "herdr-swarm: node not found on PATH (node >=20 is required for the harvest pane)."

mf="$(manifest_path)"
[ -f "$mf" ] ||
	linger "herdr-swarm: no active swarm run for this workspace (no manifest at $mf) — nothing to harvest."

# Spawn-time env is the only channel into the pane process (state-dir rule).
# A corrupt manifest is NOT fatal here: the renderer treats corrupt as a
# first-class display state, and every destructive verb re-reads and refuses
# on corruption itself.
ws="$(ws_id)"
export HERDR_SWARM_PANE_MODE="harvest"
export HERDR_SWARM_MANIFEST="$mf"
export HERDR_SWARM_WS_ID="$ws"

exec node bin/renderer.mjs
