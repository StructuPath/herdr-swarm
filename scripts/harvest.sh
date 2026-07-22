#!/usr/bin/env bash
# Harvest action: open the Swarm Harvest pane (or no-op when it is already
# open). Thin by design — the whole review-first merge flow lives in
# bin/renderer.mjs (harvest mode) behind scripts/harvest-pane.sh; this script
# only guards single-instance and opens. Mirrors status.sh line for line.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

require_herdr

# Serialize concurrent invokes: pane open is not idempotent (sibling spike),
# so two racing actions would each open a harvest pane. Same mkdir+PID lock
# every launcher uses; scoped per workspace like the pane itself.
lock_name="harvest-open-$(ws_id)"
acquire_lock "$lock_name" || exit 1
trap 'release_lock "$lock_name"' EXIT

# Single-instance guard: recorded pane id + liveness. A recorded id whose
# pane died (herdr restart, user closed it) is a stale record — drop it and
# open fresh instead of silently doing nothing.
pidfile="$(state_dir)/harvest-pane-$(ws_id)"
existing=""
[ -f "$pidfile" ] && existing="$(cat "$pidfile")"
if pane_alive "$existing"; then
	echo "herdr-swarm: harvest pane already open ($existing)."
	exit 0
fi
rm -f "$pidfile"

out="$(herdr_pane_open --entrypoint harvest-pane --placement split --direction right --focus)" || {
	echo "herdr-swarm: failed to open the harvest pane" >&2
	exit 4
}
pane_id="$(parse_pane_id "$out")"
if [ -n "$pane_id" ]; then
	# Recorded so the next invoke can find (and not duplicate) this pane, and
	# so abort's manifest-tracked pane sweep can close it.
	printf '%s\n' "$pane_id" >"$pidfile"
else
	echo "herdr-swarm: warning: could not parse pane id from pane-open output" >&2
	rm -f "$pidfile"
fi
