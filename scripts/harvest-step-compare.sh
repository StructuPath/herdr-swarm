#!/usr/bin/env bash
# harvest-step-compare.sh — compare: read-only ranked facts for every slot (scripts/compare.mjs).
#
# Sourced by harvest-step.sh, the one entry point; not run on its own. The
# globals used here (RUN_ID, REPO_ROOT, DOC, SLOT_*, HS_EC_*, …) are set there.
# shellcheck disable=SC2154,SC2153

# compare: read-only side-by-side facts for every non-archived slot, ranked
# (see scripts/compare.mjs for the record format and the ranking rule). Rows
# failing the ownership check are left out with a warning, never compared:
# their branch/path are not provably this run's.
do_compare() {
	local slots s finished started_at finished_at rows=""
	slots="$(printf '%s' "$DOC" | node -e '
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const doc = JSON.parse(d);
			for (const r of doc.slots || []) {
				if (r.status === "archived") continue;
				// Start/finish times feed the elapsed column; timestamps only.
				const iso = (v) => (typeof v === "string" && /^[0-9T:.Z-]+$/.test(v) ? v : "-");
				console.log([r.slot, r.finished?.reason ?? "-", iso(r.started_at ?? doc.created_at), iso(r.finished?.at)].join("\t"));
			}
		});
	')" || return 1
	while IFS=$'\t' read -r s finished started_at finished_at; do
		[ -n "$s" ] || continue
		if ! read_slot "$s" 2>/dev/null; then
			echo "herdr-swarm: slot $s left out of compare — its ownership check failed." >&2
			continue
		fi
		[ "$finished" != "-" ] || finished=""
		# \x1f-separated like read_slot; a newline or \x1f inside a field would
		# split the record, so such a row is left out rather than misparsed.
		case "$SLOT_LABEL$SLOT_BRANCH$SLOT_PATH$SLOT_STATUS" in
		*$'\n'* | *"$US"*)
			echo "herdr-swarm: slot $s left out of compare — a field contains a record separator." >&2
			continue
			;;
		esac
		rows+="$s$US$SLOT_LABEL$US$SLOT_BRANCH$US$SLOT_PATH$US$SLOT_STATUS$US$finished$US$started_at$US$finished_at"$'\n'
	done <<<"$slots"
	printf '%s' "$rows" | node "$PLUGIN_ROOT/scripts/compare.mjs" "$REPO_ROOT" "$FORK_SHA" "$RUN_ID" "$(state_dir)"
}
