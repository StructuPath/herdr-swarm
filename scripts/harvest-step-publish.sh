#!/usr/bin/env bash
# harvest-step-publish.sh — Forge handoff: publish, draft PRs, strict candidate handoff, CI status.
#
# Sourced by harvest-step.sh, the one entry point; not run on its own. The
# globals used here (RUN_ID, REPO_ROOT, DOC, SLOT_*, HS_EC_*, …) are set there.
# shellcheck disable=SC2154,SC2153

# do_publish: PR-based harvest — hand the slot's committed work to the forge
# instead of merging locally. A plain same-name push of the slot branch to the
# configured remote, NEVER --force: a rejected non-fast-forward means the
# remote branch moved under someone else's hands, which needs a human, not a
# flag. Publish mutates no local ref and touches no worktree, so it composes
# with the rest of the flow: once the forge merge lands and base is updated,
# the next preview detects it (ancestry for merge commits, tree containment
# for squashes) and the slot proceeds to archive as usual — no new terminal
# state exists on purpose.
do_publish() {
	read_slot "$1" || return $?
	local remote="${HERDR_SWARM_PUBLISH_REMOTE:-origin}" tip out patch dirty
	local expected="${2-}" destination="${3:-${HERDR_SWARM_PUBLISH_REMOTE:-origin}}" require_clean="${4-}"
	if ! git -C "$REPO_ROOT" remote get-url "$remote" >/dev/null 2>&1; then
		echo "herdr-swarm: remote '$remote' is not configured in this repository — add it, or point HERDR_SWARM_PUBLISH_REMOTE at the remote to publish to." >&2
		return "$HS_EC_REFUSED"
	fi
	tip="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/heads/$SLOT_BRANCH")" || {
		echo "herdr-swarm: slot $1 has no branch to publish." >&2
		return "$HS_EC_REFUSED"
	}
	if [ "$tip" = "$FORK_SHA" ]; then
		echo "herdr-swarm: slot $1 has no commits past the fork point — nothing to publish." >&2
		return "$HS_EC_REFUSED"
	fi
	if [ -n "$expected" ] && [ "$tip" != "$expected" ]; then
		echo "herdr-swarm: slot head moved after PR/evidence preparation — re-run the selected handoff." >&2
		return "$HS_EC_DRIFT"
	fi
	# The branch must still contain the recorded fork point: a rewritten slot
	# branch (reset onto foreign history) would otherwise publish commits this
	# run never audited. Same authority prune uses — ancestry, not bookkeeping.
	if ! git -C "$REPO_ROOT" merge-base --is-ancestor "$FORK_SHA" "$tip"; then
		echo "herdr-swarm: slot $1 branch no longer contains the recorded fork point $FORK_SHA — its history was rewritten; publish refused." >&2
		return "$HS_EC_REFUSED"
	fi
	# Ordinary publish remains commit-only and warns about uncommitted work.
	# Strict candidate handoff requires the selected worktree to remain clean.
	dirty=""
	if [ -n "$SLOT_PATH" ] && [ -d "$SLOT_PATH" ]; then
		dirty="$(git -C "$SLOT_PATH" status --porcelain 2>/dev/null)" || return "$HS_EC_REFUSED"
	fi
	if [ "$require_clean" = "strict" ] && { [ -z "$SLOT_PATH" ] || [ ! -d "$SLOT_PATH" ] || [ -n "$dirty" ]; }; then
		echo "herdr-swarm: candidate handoff requires the selected slot worktree to remain clean — commit or discard changes, regenerate evidence, and retry." >&2
		return "$HS_EC_REFUSED"
	elif [ -n "$dirty" ]; then
		echo "herdr-swarm: note — slot $1 has uncommitted work; only committed work is published. Commit-WIP first to include it." >&2
	fi
	# Push the AUDITED SHA, not the branch name: if the agent commits again
	# between the checks above and the push, the remote still receives exactly
	# the tip that passed them (the branch-name form would race). The seam
	# below holds the verb in that window so the race is testable.
	if [ -n "${HERDR_SWARM_TEST_PUBLISH_READY_FILE:-}" ]; then : >"$HERDR_SWARM_TEST_PUBLISH_READY_FILE"; fi
	if [ -n "${HERDR_SWARM_TEST_PAUSE_BEFORE_PUBLISH:-}" ]; then
		sleep "$HERDR_SWARM_TEST_PAUSE_BEFORE_PUBLISH"
	fi
	if ! out="$(git -C "$REPO_ROOT" push "$destination" "$tip:refs/heads/$SLOT_BRANCH" 2>&1)"; then
		printf '%s\n' "$out" >&2
		echo "herdr-swarm: publish of slot $1 to '$remote' was rejected — nothing was force-pushed; resolve the refusal above and retry." >&2
		return "$HS_EC_REFUSED"
	fi
	patch="$(node -e '
		const [remote, sha] = process.argv.slice(1);
		process.stdout.write(JSON.stringify({ published: { remote, sha } }));
	' "$remote" "$tip")" || return 1
	manifest_update_slot "$1" "$patch" || return 1
	printf 'published\t%s\t%s\t%s\n' "$1" "$remote" "$tip"
}

do_publish_pr() {
	read_slot "$1" || return $?
	local plan expected destination
	plan="$(node "$PLUGIN_ROOT/scripts/pr-handoff.mjs" prepare "$REPO_ROOT" "$RUN_ID" "$1" "$SLOT_BRANCH" "$BASE_BRANCH" "$FORK_SHA")" || return "$HS_EC_REFUSED"
	expected="$(printf '%s' "$plan" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).sha));')" || return 1
	destination="$(printf '%s' "$plan" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).push_url));')" || return 1
	do_publish "$1" "$expected" "$destination" || return $?
	printf '%s' "$plan" | node "$PLUGIN_ROOT/scripts/pr-handoff.mjs" handoff
}

do_publish_candidate_pr() {
	read_slot "$1" || return $?
	local plan expected destination
	default_candidate_validation "$1"
	plan="$(node "$PLUGIN_ROOT/scripts/pr-handoff.mjs" prepare-candidate "$REPO_ROOT" "$RUN_ID" "$1" "$SLOT_BRANCH" "$BASE_BRANCH" "$FORK_SHA" "$SLOT_PATH")" || return "$HS_EC_REFUSED"
	expected="$(printf '%s' "$plan" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).sha));')" || return 1
	destination="$(printf '%s' "$plan" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).push_url));')" || return 1
	do_publish "$1" "$expected" "$destination" strict || return $?
	printf '%s' "$plan" | node "$PLUGIN_ROOT/scripts/pr-handoff.mjs" handoff
}

do_candidate_status() {
	read_slot "$1" || return $?
	default_candidate_validation "$1"
	node "$PLUGIN_ROOT/scripts/pr-handoff.mjs" candidate-status "$REPO_ROOT" "$RUN_ID" "$1" "$SLOT_BRANCH" "$BASE_BRANCH" "$FORK_SHA" "$SLOT_PATH"
}

do_pr_status() {
	read_slot "$1" || return $?
	node "$PLUGIN_ROOT/scripts/pr-handoff.mjs" status "$REPO_ROOT" "$RUN_ID" "$1" "$SLOT_BRANCH" "$BASE_BRANCH" "$FORK_SHA"
}

# An explicitly supplied candidate validation file always wins; otherwise the
# strict handoff reads what `validate` recorded for this slot, if anything.
default_candidate_validation() {
	local produced
	# Only this function may mark a file as the Swarm-produced default; an
	# inherited marker would hold an explicit file to the wrong identity.
	unset HERDR_SWARM_CANDIDATE_VALIDATION_PRODUCED
	[ -z "${HERDR_SWARM_CANDIDATE_VALIDATION_FILE:-}" ] || return 0
	produced="$(validation_result_path "$1")"
	[ -f "$produced" ] || return 0
	export HERDR_SWARM_CANDIDATE_VALIDATION_FILE="$produced" HERDR_SWARM_CANDIDATE_VALIDATION_PRODUCED=1
}
