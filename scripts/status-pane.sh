#!/usr/bin/env bash
# Status pane entrypoint: resolve session context once in bash (ws id, state
# paths, repo root from the manifest), export it, exec the zero-dep Node
# renderer. Every early failure routes through pane_fatal (lib.sh) — a pane
# whose process exits immediately closes before the user can read anything,
# which reads as a crash.
set -uo pipefail

cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	# lib.sh (and pane_fatal with it) is unreachable without the plugin root,
	# so this one failure lingers inline.
	echo "herdr-swarm: cannot resolve the plugin root"
	sleep 600
	exit 1
}
. scripts/lib.sh

pane_require_node "status pane"

mf="$(manifest_path)"
[ -f "$mf" ] ||
	pane_fatal "herdr-swarm: no active swarm run for this workspace (no manifest at $mf). Run the fan-out action first."

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

# Spawn-time env via the shared contract; "status" is the U6 seam —
# harvest-pane.sh exports "harvest" into the same renderer.
pane_export_context status "$mf"
if [ -n "$repo_root" ]; then
	export HERDR_SWARM_REPO_ROOT="$repo_root"
fi

exec node bin/renderer.mjs
