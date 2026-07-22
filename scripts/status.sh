#!/usr/bin/env bash
# Status action: open the Swarm Status pane (or no-op when it is already
# open). Thin by design — all rendering lives in bin/renderer.mjs behind
# scripts/status-pane.sh; this script only guards single-instance and opens.
set -uo pipefail
cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}" || exit 1
. scripts/lib.sh

require_herdr

# Serialize concurrent invokes: pane open is not idempotent (sibling spike),
# so two racing actions would each open a status pane. Same mkdir+PID lock
# every launcher uses; scoped per workspace like the pane itself.
lock_name="status-open-$(ws_id)"
acquire_lock "$lock_name" || exit 1
trap 'release_lock "$lock_name"' EXIT

# Single-instance guard: recorded pane id + liveness. A recorded id whose
# pane died (herdr restart, user closed it) is a stale record — drop it and
# open fresh instead of silently doing nothing.
pidfile="$(state_dir)/status-pane-$(ws_id)"
existing=""
[ -f "$pidfile" ] && existing="$(cat "$pidfile")"
if pane_alive "$existing"; then
	echo "herdr-swarm: status pane already open ($existing)."
	exit 0
fi
rm -f "$pidfile"

out="$(herdr_pane_open --entrypoint status-pane --placement split --direction right --focus)" || {
	echo "herdr-swarm: failed to open the status pane" >&2
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
