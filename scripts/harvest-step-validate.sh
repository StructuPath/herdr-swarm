#!/usr/bin/env bash
# harvest-step-validate.sh — validate: run validate.sh against a slot's clean HEAD and record SHA-bound checks.
#
# Sourced by harvest-step.sh, the one entry point; not run on its own. The
# globals used here (RUN_ID, REPO_ROOT, DOC, SLOT_*, HS_EC_*, …) are set there.
# shellcheck disable=SC2154,SC2153

# validation_result_path <slot>: the one Swarm-produced checks file per slot.
# Latest run wins; the file carries its head_sha, so a result for an older
# commit reads as stale downstream rather than being trusted.
validation_result_path() {
	printf '%s/validation-%s-s%s.json\n' "$(state_dir)" "$RUN_ID" "$1"
}

# slot_clean_head <slot>: print the slot worktree's HEAD when it is exactly
# the slot branch tip with no tracked or untracked changes. Validation binds
# its result to that SHA, so anything else would record evidence for a tree
# that is not the commit.
slot_clean_head() {
	local head tip dirty
	if [ -z "$SLOT_PATH" ] || [ ! -d "$SLOT_PATH" ]; then
		echo "herdr-swarm: slot $1 has no worktree on disk — nothing to validate." >&2
		return "$HS_EC_REFUSED"
	fi
	if ! head="$(git -C "$SLOT_PATH" rev-parse --verify --quiet HEAD)" ||
		! tip="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/heads/$SLOT_BRANCH")"; then
		echo "herdr-swarm: slot $1 HEAD or branch is unreadable — validate refused." >&2
		return "$HS_EC_REFUSED"
	fi
	if [ "$head" != "$tip" ]; then
		echo "herdr-swarm: slot $1 worktree HEAD $head is not its branch tip $tip — validate refused." >&2
		return "$HS_EC_REFUSED"
	fi
	dirty="$(git -C "$SLOT_PATH" status --porcelain 2>/dev/null)" || return "$HS_EC_REFUSED"
	if [ -n "$dirty" ]; then
		echo "herdr-swarm: slot $1 has uncommitted changes — validation must describe a commit; commit-WIP or discard first." >&2
		return "$HS_EC_REFUSED"
	fi
	printf '%s\n' "$head"
}

# validating_lock_take / _drop <dir>: one validate per slot at a time. The
# repo lock is released while the hook runs, so without this a pane and a CLI
# could run two suites in one worktree, interleave one log, and let the
# loser's spurious failure overwrite the winner's pass. Taken while holding
# the repo lock, so take itself never races; a dead holder's dir is stale.
validating_lock_take() {
	local d="$1" holder
	if ! mkdir "$d" 2>/dev/null; then
		holder="$(cat "$d/pid" 2>/dev/null || true)"
		if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then return 1; fi
		rm -f "$d/pid"
		rmdir "$d" 2>/dev/null
		mkdir "$d" 2>/dev/null || return 1
	fi
	printf '%s\n' "$$" >"$d/pid"
}

validating_lock_drop() {
	[ -n "${1-}" ] || return 0
	if [ "$(cat "$1/pid" 2>/dev/null)" = "$$" ]; then
		rm -f "$1/pid"
		rmdir "$1" 2>/dev/null
	fi
	return 0
}

# A signal while the hook runs — renderer timeout (TERM), Ctrl-C, or the pane
# closing (HUP) — must take the hook's process group with it: the group is a
# background job, so a hangup aimed at the pane never reaches it, and this
# script's polling loop is the only thing enforcing its deadline.
validate_on_signal() {
	reap_group "${SWARM_GROUP_PID:-}"
	rm -f "${VALIDATE_CHECKS:-}"
	validating_lock_drop "${VALIDATE_LOCK:-}"
	exit 143
}

# validate <slot>: run the operator's validate.sh hook in the slot worktree
# against its clean HEAD and record a SHA-bound checks file in the format the
# strict candidate handoff already reads. The repo lock is NOT held while the
# hook runs — a 15-minute test suite must never block abort or another
# harvest — so the run, slot ownership, HEAD, and cleanliness are all
# re-verified under a fresh lock before anything is written. Passing and
# failing hooks both exit 0 with a `validated` record; only an unrecordable
# result is a refusal.
do_validate() {
	read_slot "$1" || return $?
	local hook="${HERDR_PLUGIN_CONFIG_DIR:-}/validate.sh" secs head checks log rc started elapsed recorded
	if [ -z "${HERDR_PLUGIN_CONFIG_DIR:-}" ] || [ ! -f "$hook" ]; then
		echo "herdr-swarm: no validate.sh in the plugin config dir — add one to run checks per slot (see README: Validating slots)." >&2
		return "$HS_EC_REFUSED"
	fi
	case "${HERDR_SWARM_VALIDATE_TIMEOUT:-900}" in
	'' | *[!0-9]* | 0)
		echo "herdr-swarm: HERDR_SWARM_VALIDATE_TIMEOUT must be a positive number of seconds." >&2
		return "$HS_EC_REFUSED"
		;;
	*) secs="${HERDR_SWARM_VALIDATE_TIMEOUT:-900}" ;;
	esac
	head="$(slot_clean_head "$1")" || return $?
	VALIDATE_LOCK="$(state_dir)/validating-$RUN_ID-s$1"
	trap 'release_lock "$MUTATION_LOCK"; validating_lock_drop "${VALIDATE_LOCK:-}"' EXIT
	if ! validating_lock_take "$VALIDATE_LOCK"; then
		VALIDATE_LOCK=""
		echo "herdr-swarm: slot $1 is already being validated — wait for that run to finish." >&2
		return "$HS_EC_REFUSED"
	fi
	log="$(state_dir)/validation-$RUN_ID-s$1.log"
	VALIDATE_CHECKS="$(mktemp "$(state_dir)/validation-checks.XXXXXX")" || return 1
	checks="$VALIDATE_CHECKS"
	release_lock "$MUTATION_LOCK"
	trap validate_on_signal TERM INT HUP QUIT
	started="$(date +%s)"
	# Run in THIS shell (cd happens inside the hook's own bash) so the trap
	# above sees SWARM_GROUP_PID and the timeout flag survives the call.
	# stdin is /dev/null: the hook's group is a background job, and a read
	# from a controlling tty would stop it (SIGTTIN) until the timeout.
	# shellcheck disable=SC2016 # $1/$2 expand in the inner bash, on purpose
	HERDR_SWARM_RUN_ID="$RUN_ID" HERDR_SWARM_SLOT="$1" HERDR_SWARM_HEAD_SHA="$head" \
		HERDR_SWARM_CHECKS_FILE="$checks" \
		with_group_timeout "$secs" bash -c 'cd "$1" && exec bash "$2"' validate "$SLOT_PATH" "$hook" </dev/null >"$log" 2>&1
	rc=$?
	elapsed=$(($(date +%s) - started))
	trap - TERM INT HUP QUIT
	recorded=""
	validate_record "$1" "$head" "$rc" "$secs" "$elapsed" "$checks" "$log"
	rc=$?
	rm -f "$checks"
	validating_lock_drop "$VALIDATE_LOCK"
	[ "$rc" -eq 0 ] || return "$rc"
	printf 'validated\t%s\t%s\t%s\t%s\n' "$1" "$head" "$recorded" "$(validation_result_path "$1")"
}

# validate_record <slot> <head> <rc> <secs> <elapsed> <checks> <log>: the
# re-verify-then-write half of validate, run under a re-acquired lock. Sets
# `recorded` to the overall status on success.
validate_record() {
	local slot="$1" head="$2" rc="$3" secs="$4" elapsed="$5" checks="$6" log="$7" after live_run ec
	acquire_lock "$MUTATION_LOCK" || return 1
	# Re-bind under the fresh lock: the run may have been aborted, harvested,
	# or replaced while the hook ran, and the slot may have moved.
	bind_live_manifest_locked "$REPO_HINT" || return $?
	DOC="$(manifest_read)" || return $?
	IFS="$US" read -r live_run _ <<<"$(manifest_run_context "$DOC")"
	if [ "$live_run" != "$RUN_ID" ]; then
		echo "herdr-swarm: run $RUN_ID is no longer the live run — validation result discarded." >&2
		return "$HS_EC_REFUSED"
	fi
	read_slot "$slot" || return $?
	after="$(slot_clean_head "$slot")" || {
		ec=$?
		echo "herdr-swarm: slot $slot changed while validate.sh ran (see $log) — result not recorded; a hook that leaves untracked files needs them gitignored." >&2
		return "$ec"
	}
	if [ "$after" != "$head" ]; then
		echo "herdr-swarm: slot $slot moved from $head to $after while validate.sh ran — result not recorded; re-run validate." >&2
		return "$HS_EC_DRIFT"
	fi
	recorded="$(node -e '
		const fs = require("fs");
		const [checksFile, dest, runId, slot, sha, rc, secs, elapsed, killed] = process.argv.slice(1);
		const timedOut = killed === "1";
		let checks = [];
		let note = "";
		const lines = fs.readFileSync(checksFile, "utf8").split("\n").filter((l) => l.trim() !== "");
		const names = new Set(["validate"]);
		for (const line of lines) {
			const m = line.trim().match(/^([a-z][a-z0-9_-]{0,47})\s+(passed|failed|not_run)$/);
			if (!m || names.has(m[1]) || checks.length >= 29) {
				note = "malformed, duplicate, reserved, or excess check line: " + JSON.stringify(line.slice(0, 80));
				checks = [];
				break;
			}
			names.add(m[1]);
			checks.push({ name: m[1], status: m[2] });
		}
		const ok = Number(rc) === 0 && note === "";
		checks.push({ name: "validate", status: ok ? "passed" : "failed" });
		const status = checks.every((c) => c.status === "passed") ? "passed" : "failed";
		const result = {
			schema_version: 1, kind: "herdr-swarm-validation", run_id: runId, slot: Number(slot),
			head_sha: sha, status, exit_code: Number(rc), timed_out: timedOut,
			timeout_seconds: Number(secs), duration_seconds: Number(elapsed), checks,
		};
		const tmp = dest + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, dest);
		if (note) process.stderr.write("herdr-swarm: validate.sh wrote a " + note + " — recorded as failed.\n");
		if (timedOut) process.stderr.write("herdr-swarm: validate.sh exceeded " + secs + "s and was killed — recorded as failed.\n");
		process.stdout.write(status);
	' "$checks" "$(validation_result_path "$slot")" "$RUN_ID" "$slot" "$head" "$rc" "$secs" "$elapsed" "$SWARM_GROUP_TIMED_OUT")" || return 1
}
