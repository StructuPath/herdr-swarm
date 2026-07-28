#!/usr/bin/env bash
# Status pane entrypoint: resolve session context once in bash (ws id, state
# paths, repo root from the manifest), export it, exec the zero-dep Node
# renderer. Every early failure routes through pane_fatal (lib.sh) — a pane
# whose process exits immediately closes before the user can read anything,
# which reads as a crash.
set -uo pipefail

INVOCATION_CWD="$PWD"
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || {
	# lib.sh (and pane_fatal with it) is unreachable without the plugin root,
	# so this one failure lingers inline.
	echo "herdr-swarm: cannot resolve the plugin root"
	sleep 600
	exit 1
}
. scripts/lib.sh

pane_require_node "status pane"

repo_hint=""
if [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ] || [ -f "$(state_dir)/run-$(ws_id).json" ]; then
	repo_hint="$(discover_live_repo 2>/dev/null || true)"
else
	repo_hint="$(git -C "$INVOCATION_CWD" rev-parse --show-toplevel 2>/dev/null || true)"
fi
[ -n "$repo_hint" ] || pane_fatal "herdr-swarm: cannot resolve this workspace repository."
SWARM_REPO="$repo_hint"
export SWARM_REPO
lock="$(repo_mutation_lock_name "$repo_hint")" || pane_fatal "herdr-swarm: cannot resolve repository identity."
acquire_lock "$lock" || pane_fatal "herdr-swarm: repository is busy; reopen Status."
rc=0
bind_live_manifest_locked "$repo_hint" || rc=$?
release_lock "$lock"
[ "$rc" -eq 0 ] || pane_fatal "herdr-swarm: no single validated active run exists for this repository (resolution exit $rc)."
mf="$(manifest_path)"

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
