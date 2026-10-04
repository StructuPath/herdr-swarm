#!/usr/bin/env bash
# harvest-step-settle.sh — settle: finish detection, auto-validate, and the run-finished notification.
#
# Sourced by harvest-step.sh, the one entry point; not run on its own. The
# globals used here (RUN_ID, REPO_ROOT, DOC, SLOT_*, HS_EC_*, …) are set there.
# shellcheck disable=SC2154,SC2153

# Opt-in: HERDR_SWARM_AUTO_VALIDATE=1, or an `auto-validate` file in the
# plugin config dir. The file exists because action-invoked panes never
# inherit the caller's environment (README: Scripting fan-out), and the status
# pane — where settle normally runs — is exactly such a pane.
auto_validate_enabled() {
	[ "${HERDR_SWARM_AUTO_VALIDATE:-}" = 1 ] && return 0
	[ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ] && [ -f "$HERDR_PLUGIN_CONFIG_DIR/auto-validate" ]
}

# settle: detect slots whose agent has finished and record it, once per slot.
# Evidence, strongest first:
#   marker — the agent created $SWARM_DONE_FILE in its worktree root, as the
#            task file's standing instructions ask;
#   exited — the slot pane's foreground is its bare shell again (the argv
#            exited). Needs the pane seen busy first (right after fan-out
#            the shell has not started the argv yet, however old the run is)
#            AND a bare shell on two consecutive settles, so a reading taken
#            mid-restart does not count.
# A finished slot gets `finished: {at, reason}` (status stays `running`; the
# harvest state machine is untouched), with auto-validate on a detached
# `validate` is started for it, and its plugin-reported agent state flips to
# idle. `exited` is reversible: a later busy reading (Ctrl-Z then fg, an
# agent restarted by hand) clears it and reports working again. `marker` is
# the agent's own declaration and is final. When every running slot has
# finished, one Herdr notification per run.
# Read-only callers (the status pane) run this instead of writing anything.
do_settle() {
	local rows s seen pending was reason fg now summary
	rows="$(printf '%s' "$DOC" | node -e '
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			for (const r of JSON.parse(d).slots || []) {
				const was = r.finished?.reason ?? "";
				if (r.status !== "running" || was === "marker") continue;
				console.log([r.slot, r.seen_running ? 1 : 0, r.shell_pending ? 1 : 0, was || "-"].join("\t"));
			}
		});
	')" || return 1
	while IFS=$'\t' read -r s seen pending was; do
		[ -n "$s" ] || continue
		[ "$was" != "-" ] || was=""
		# An ownership refusal skips the row: settle never marks a row this run
		# does not own, and the status pane must keep rendering regardless.
		read_slot "$s" 2>/dev/null || continue
		now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		reason=""
		if [ -n "$SLOT_PATH" ] && [ -f "$SLOT_PATH/$SWARM_DONE_FILE" ]; then
			if [ "$was" = exited ]; then
				# Already finished (and validated, if on): only the reason firms up.
				manifest_update_slot "$s" "{\"finished\":{\"at\":\"$now\",\"reason\":\"marker\"}}" || return 1
				continue
			fi
			reason=marker
		elif [ -n "$SLOT_PANE" ]; then
			fg="$(pane_foreground "$SLOT_PANE")"
			if [ "$fg" = busy ] && [ "$was" = exited ]; then
				manifest_update_slot "$s" '{"finished":null,"shell_pending":null,"seen_running":true}' || return 1
				report_slot_agent_state "$SLOT_PANE" "$SLOT_AGENT" working
				printf 'resumed\t%s\n' "$s"
				continue
			elif [ "$fg" = busy ] && { [ "$seen" != 1 ] || [ "$pending" = 1 ]; }; then
				manifest_update_slot "$s" '{"seen_running":true,"shell_pending":null}' || return 1
			elif [ "$fg" = shell ] && [ -z "$was" ] && [ "$seen" = 1 ]; then
				if [ "$pending" = 1 ]; then
					reason=exited
				else
					manifest_update_slot "$s" '{"shell_pending":true}' || return 1
				fi
			fi
		fi
		[ -n "$reason" ] || continue
		manifest_update_slot "$s" "{\"finished\":{\"at\":\"$now\",\"reason\":\"$reason\"},\"shell_pending\":null}" || return 1
		printf 'settled\t%s\t%s\n' "$s" "$reason"
		# Spawned straight after the finished write, before the slow herdr
		# report below: a settle killed at its timeout must not have recorded
		# the finish yet skipped the validate that the finish was meant to start.
		if auto_validate_enabled && [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ] && [ -f "$HERDR_PLUGIN_CONFIG_DIR/validate.sh" ]; then
			# Detached and HUP-immune: it outlives this verb (and the pane that
			# called it), and waits for the repo lock this verb still holds.
			nohup bash "$PLUGIN_ROOT/scripts/harvest-step.sh" validate "$s" </dev/null \
				>>"$(state_dir)/auto-validate-$RUN_ID-s$s.log" 2>&1 &
			printf 'auto_validate\t%s\n' "$s"
		fi
		report_slot_agent_state "$SLOT_PANE" "$SLOT_AGENT" idle
	done <<<"$rows"

	DOC="$(manifest_read)" || return $?
	summary="$(printf '%s' "$DOC" | node -e '
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const doc = JSON.parse(d);
			const live = (doc.slots || []).filter((r) => r.status === "running");
			if (doc.finish_notified || live.length === 0 || !live.every((r) => r.finished)) return;
			process.stdout.write(String(live.length));
		});
	')" || return 1
	[ -n "$summary" ] || return 0
	# Recorded BEFORE showing: a notification lost to a herdr hiccup is better
	# than one re-shown on every poll for the rest of the run.
	now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	manifest_update_run "{\"finish_notified\":\"$now\"}" || return 1
	herdr_notification_show "Swarm: all $summary slots finished" \
		--body "Run $RUN_ID is ready to compare in Harvest." --sound "done" >/dev/null 2>&1 || true
	printf 'notified\t%s\n' "$summary"
}
