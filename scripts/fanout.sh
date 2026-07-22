#!/usr/bin/env bash
# Fan-out action — deliberately thin (U4): plugin actions receive zero argv
# and have no TTY (sibling spike fact), so every prompt and the whole
# create/start loop live in the fan-out PANE. This script only gates the
# version early and opens that pane; the pane owns the mutation lock.
set -uo pipefail

PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck source=scripts/lib.sh
. "$PLUGIN_ROOT/scripts/lib.sh"

require_herdr

# Gate before any pane exists: on 0.7.5+ the refusal lands in the action's
# own output instead of a pane that opens only to die (R13). The pane
# re-checks — this early copy is UX, not the guarantee.
version_gate gated || exit 1

# Serialize the OPEN only (sibling open-race pattern): two action invokes
# racing would each open a pane, because plugin pane open is not idempotent.
# The per-repo mutation lock is the pane's job, not ours — holding it here
# would deadlock against the pane we are about to spawn.
acquire_lock "fanout-open-$(ws_id)" || exit 1
trap 'release_lock "fanout-open-$(ws_id)"' EXIT

if ! herdr_pane_open --entrypoint fanout-pane --placement split --direction right --focus >/dev/null; then
	echo "herdr-swarm: failed to open the Swarm Fan-out pane" >&2
	exit 2
fi
echo "herdr-swarm: Swarm Fan-out pane opened."
