#!/usr/bin/env bash
# Status pane entrypoint: resolve session context once in bash (ws id, state
# paths, repo root from the manifest), export it, exec the zero-dep Node
# renderer. Every early failure prints a friendly message and sleeps — a pane
# whose process exits immediately closes before the user can read anything,
# which reads as a crash.
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
	linger "herdr-swarm: node not found on PATH (node >=20 is required for the status pane)."

mf="$(manifest_path)"
[ -f "$mf" ] ||
	linger "herdr-swarm: no active swarm run for this workspace (no manifest at $mf). Run the fan-out action first."

# repo_root for the renderer's branch-existence checks. A corrupt manifest is
# NOT fatal here: the renderer treats corrupt as a first-class display state
# (typed parseManifest result), so we still exec it and let it say so.
repo_root=""
doc="$(manifest_read 2>/dev/null)" || doc=""
if [ -n "$doc" ]; then
	repo_root="$(printf '%s' "$doc" | node -e '
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			try { process.stdout.write(String(JSON.parse(d).repo_root ?? "")); } catch {}
		});
	' 2>/dev/null)" || repo_root=""
fi

# Spawn-time env is the only channel into the pane process (state-dir rule);
# HERDR_SWARM_PANE_MODE is the U6 seam — harvest-pane.sh will export
# "harvest" into the same renderer.
ws="$(ws_id)"
export HERDR_SWARM_PANE_MODE="status"
export HERDR_SWARM_MANIFEST="$mf"
export HERDR_SWARM_WS_ID="$ws"
if [ -n "$repo_root" ]; then
	export HERDR_SWARM_REPO_ROOT="$repo_root"
fi

exec node bin/renderer.mjs
