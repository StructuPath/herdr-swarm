#!/usr/bin/env bash
# Harvest pane entrypoint: resolve session context once in bash, export it,
# exec the zero-dep Node renderer in harvest mode. Mirrors status-pane.sh;
# every early failure routes through pane_fatal (lib.sh) — a pane whose
# process exits immediately closes before the user can read anything, which
# reads as a crash.
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

pane_require_node "harvest pane"

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
acquire_lock "$lock" || pane_fatal "herdr-swarm: repository is busy; reopen Harvest."
rc=0
bind_live_manifest_locked "$repo_hint" || rc=$?
release_lock "$lock"
[ "$rc" -eq 0 ] || pane_fatal "herdr-swarm: no single validated active run exists for this repository (resolution exit $rc) — nothing to harvest."
mf="$(manifest_path)"

# Spawn-time env via the shared contract (state-dir rule). A corrupt manifest
# is NOT fatal here: the renderer treats corrupt as a first-class display
# state, and every destructive verb re-reads and refuses on corruption itself.
pane_export_context harvest "$mf"

exec node bin/renderer.mjs
