#!/usr/bin/env bash
# harvest-step-merge.sh — Merge, resume, and abort-merge: the merge locus, the journaled base swap, and recovery.
#
# Sourced by harvest-step.sh, the one entry point; not run on its own. The
# globals used here (RUN_ID, REPO_ROOT, DOC, SLOT_*, HS_EC_*, …) are set there.
# shellcheck disable=SC2154,SC2153

# Path of the worktree that has the base branch checked out, or nothing.
# Porcelain parse, not positional awk fields — paths may contain spaces.
base_checkout_path() {
	git -C "$REPO_ROOT" worktree list --porcelain | awk -v ref="branch $BASE_REF" '
		/^worktree /{p=substr($0,10)} $0==ref{print p}'
}

# Harvest refuses while ANY worktree has sequencer state in flight (KTD): a
# finishing rebase moves the base ref without an expected-old check and would
# silently discard a mid-rebase harvest merge. Scans the common git dir plus
# every worktrees/* private dir.
sequencer_scan() {
	local common d f
	common="$(git -C "$REPO_ROOT" rev-parse --git-common-dir)" || return 1
	case "$common" in /*) ;; *) common="$REPO_ROOT/$common" ;; esac
	local dirs=("$common")
	for d in "$common"/worktrees/*; do
		[ -d "$d" ] && dirs+=("$d")
	done
	for d in "${dirs[@]}"; do
		for f in rebase-merge rebase-apply CHERRY_PICK_HEAD MERGE_HEAD BISECT_LOG; do
			if [ -e "$d/$f" ]; then
				echo "herdr-swarm: git operation in flight ($d/$f) — finish or abort it, then harvest." >&2
				return "$HS_EC_SEQUENCER"
			fi
		done
	done
	return 0
}

# classify_merge_failure <tree-dir> <slot>: conflict = unmerged paths present;
# anything else nonzero is hook-or-other (hook-policy KTD: the message names
# the likely fresh-worktree cause instead of leaving the user to guess).
# Both are recoverable via git merge --abort — the abort-merge verb.
classify_merge_failure() {
	local d="$1" slot="$2"
	printf 'merge_tree\t%s\n' "$d"
	if [ -n "$(git -C "$d" ls-files -u)" ]; then
		git -C "$d" diff --name-only --diff-filter=U | sed $'s/^/conflict_file\t/'
		echo "herdr-swarm: merge of slot $slot hit CONFLICTS — shell into the merge tree to resolve, or abort (git merge --abort recovers cleanly)." >&2
		return "$HS_EC_CONFLICT"
	fi
	echo "herdr-swarm: merge of slot $slot failed WITHOUT conflicts — likely a repo hook (fresh worktrees lack node_modules/deps, so hooks that shell into node_modules/.bin fail there; HERDR_SWARM_HARVEST_WT_NO_HOOKS=1 disables hooks in the plugin-owned worktree only). Recoverable via the abort action." >&2
	return "$HS_EC_HOOK"
}

# run_merge <tree-dir> <slot>: the one place `git merge` runs. Two spellings
# instead of an optional-args array because empty-array expansion under
# `set -u` breaks on macOS's bash 3.2.
run_merge() {
	local d="$1" slot="$2" msg="swarm: merge $SLOT_BRANCH_LABEL (run $RUN_ID)"
	if [ "$3" = "nohooks" ]; then
		# core.hooksPath at an empty dir: hooks off for THIS worktree's merge
		# only — never a global or user-tree setting (hook-policy KTD).
		local hooks_off
		hooks_off="$(state_dir)/no-hooks"
		mkdir -p "$hooks_off"
		git -C "$d" -c "core.hooksPath=$hooks_off" merge --no-ff -m "$msg" "${SLOT_MERGE_REF:-$SLOT_BRANCH}"
	else
		git -C "$d" merge --no-ff -m "$msg" "${SLOT_MERGE_REF:-$SLOT_BRANCH}"
	fi
}

# swap_base <slot> <expected> <new> <harvest-wt>: the atomic tail shared by
# merge and resume-complete. Three-arg update-ref IS the guarantee (KTD): a
# check-then-plain-write has exactly the clobber window this exists to close.
swap_base() {
	local slot="$1" expected="$2" new="$3" hwt="$4" lp cleanup_rc=0
	# A resumed journal must prove the exact detached resource before it can
	# advance the base ref. This prevents a forged worktree pointer from being
	# treated as trusted merely because its merge commit is plausible.
	if [ -n "$hwt" ]; then
		verify_harvest_resource "$RUN_ID" "$slot" "$hwt" "$SLOT_JOURNAL" >/dev/null || {
			echo "herdr-swarm: harvest resource identity failed before base swap; base unchanged and resource kept." >&2
			return "$HS_EC_REFUSED"
		}
	fi
	# Millisecond guard (KTD): the locus decision can go stale between the
	# merge and this write — a base checked out NOW means update-ref would
	# desync that checkout's index; refuse and let resume finish the swap.
	lp="$(base_checkout_path)"
	if [ -n "$lp" ]; then
		echo "herdr-swarm: $BASE_BRANCH was checked out (at $lp) during the merge — swap refused, base unchanged. The merge commit is journaled; reopen harvest to resume." >&2
		return "$HS_EC_SWAP"
	fi
	if ! git -C "$REPO_ROOT" update-ref --create-reflog \
		-m "swarm: harvest merge $slot (run $RUN_ID)" \
		"$BASE_REF" "$new" "$expected"; then
		echo "herdr-swarm: base $BASE_REF moved during the merge — swap FAILED, base unchanged. Merge commit $new is journaled and kept${hwt:+ in $hwt}; reopen harvest to re-preview." >&2
		return "$HS_EC_SWAP"
	fi
	# Record the landed merge while retaining the exact resource journal until
	# deletion succeeds. A crash or approval refusal therefore remains safely
	# resumable instead of creating an unverifiable leftover path.
	manifest_update_slot "$slot" '{"status":"merged"}' || return 1
	if [ -n "$hwt" ] && [ -d "$hwt" ]; then
		remove_harvest_resource "$RUN_ID" "$slot" "$hwt" "$SLOT_JOURNAL" || cleanup_rc=$?
		case "$cleanup_rc" in
		0) journal_clear "$slot" || return 1 ;;
		"$HS_EC_IGNORED") echo "herdr-swarm: merge landed; harvest worktree kept until the emitted ignored-file approval is applied via resume." >&2 ;;
		*) echo "herdr-swarm: merge landed; harvest worktree kept because exact cleanup verification/removal failed." >&2 ;;
		esac
	else
		journal_clear "$slot" || return 1
	fi
	printf 'merged\t%s\n' "$new"
}

# A squash- or cherry-pick-merged slot leaves no ancestry trail, but its
# CONTENT is already in base: a real merge of tip into base would change
# nothing. `git merge-tree --write-tree` (git >= 2.38) proves that without
# touching any worktree — the merged tree equals base's own tree exactly when
# the slot has nothing left to contribute. Conflicts and older gits exit
# nonzero here, which callers treat as "not proven": those slots fall through
# to the normal clean flow and the documented sharp edge still applies.
squash_merged_into_base() {
	local tip="$1" base="$2" merged
	merged="$(git -C "$REPO_ROOT" merge-tree --write-tree "$base" "$tip" 2>/dev/null)" || return 1
	[ "$(git -C "$REPO_ROOT" rev-parse --verify --quiet "$merged^{tree}" 2>/dev/null)" = \
		"$(git -C "$REPO_ROOT" rev-parse "$base^{tree}")" ]
}

# merge <slot> <expected-base-sha> [expected-slot-tip]: the optional third
# argument pins WHAT is merged, not just where. The compare view passes the
# tip its ranking and validation described; if the agent committed since,
# the merge refuses instead of landing a commit nobody compared, and when it
# matches, the exact SHA is merged (not the branch name, which could move
# between this check and git merge — the same rule publish follows).
do_merge() {
	require_slot_arg "${1-}" || return 1
	local expected="${2-}" want_tip="${3-}" tip
	if [ -z "$expected" ]; then
		echo "herdr-swarm: merge needs the previewed base SHA (drift guard input)" >&2
		return 1
	fi
	read_slot "$1" || return $?
	if [ -n "$want_tip" ]; then
		case "$want_tip" in
		*[!0-9a-f]*)
			echo "herdr-swarm: expected slot tip '$want_tip' is not a full SHA." >&2
			return "$HS_EC_REFUSED"
			;;
		esac
		if [ "${#want_tip}" -ne 40 ] && [ "${#want_tip}" -ne 64 ]; then
			echo "herdr-swarm: expected slot tip '$want_tip' is not a full SHA." >&2
			return "$HS_EC_REFUSED"
		fi
		tip="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/heads/$SLOT_BRANCH")" || tip=""
		if [ "$tip" != "$want_tip" ]; then
			echo "herdr-swarm: slot $1 moved since it was compared (${want_tip:0:7} -> ${tip:0:7}) — nothing merged; re-open compare and pick again." >&2
			return "$HS_EC_REFUSED"
		fi
		SLOT_MERGE_REF="$want_tip"
	fi
	if [ "$SLOT_JOURNAL" != "null" ]; then
		echo "herdr-swarm: slot $1 has an unfinished merge journaled — resume or abort-merge first." >&2
		return "$HS_EC_REFUSED"
	fi
	[ -d "$SLOT_PATH" ] || {
		echo "herdr-swarm: slot $1 worktree is gone ($SLOT_PATH)" >&2
		return "$HS_EC_REFUSED"
	}
	# SLOT_BRANCH_LABEL feeds the templated commit message via run_merge.
	SLOT_BRANCH_LABEL="$SLOT_LABEL"
	# Guard order is load-bearing (plan): sequencer -> drift -> locus.
	sequencer_scan || return $?
	local cur
	cur="$(base_sha)" || return 1
	if [ "$cur" != "$expected" ]; then
		echo "herdr-swarm: base $BASE_BRANCH moved since preview ($expected -> $cur) — re-preview and retry." >&2
		return "$HS_EC_DRIFT"
	fi
	local lp
	lp="$(base_checkout_path)"
	if [ -n "$lp" ]; then
		merge_in_user_tree "$1" "$expected" "$lp"
	else
		merge_detached "$1" "$expected"
	fi
}

merge_detached() {
	local slot="$1" expected="$2" hwt generation rc=0 new
	generation="$(cleanup_operation_id)" || return 1
	hwt="$(state_dir)/harvest-$RUN_ID-s$slot-$generation"
	if [ -e "$hwt" ]; then
		echo "herdr-swarm: harvest generation path already exists at $hwt — refused." >&2
		return "$HS_EC_REFUSED"
	fi
	# Intent journaled BEFORE the worktree exists: abort/resume must always
	# over-approximate what might be on disk (manifest KTD). The generation is
	# part of both the exact path and the resource identity.
	journal_set "$slot" detached "$expected" "" "$hwt" "$generation" || return 1
	# Plain git worktree add --detach, never `herdr worktree create` — that
	# would mint a branch and open a workspace (merge-locus KTD).
	if ! git -C "$REPO_ROOT" worktree add --detach "$hwt" "$expected"; then
		journal_clear "$slot" || true
		echo "herdr-swarm: could not create the harvest worktree." >&2
		return 1
	fi
	local hooks="hooks"
	[ "${HERDR_SWARM_HARVEST_WT_NO_HOOKS:-0}" = "1" ] && hooks="nohooks"
	if ! run_merge "$hwt" "$slot" "$hooks"; then
		# Worktree + journal left in place for inspection; conflict vs hook
		# classified for the renderer's distinct views. The exact commit being
		# merged is journaled so a later `conclude` can pin the second parent.
		local tip
		tip="$(git -C "$hwt" rev-parse -q --verify MERGE_HEAD 2>/dev/null)" || tip=""
		if [ -n "$tip" ]; then
			journal_set "$slot" detached "$expected" "" "$hwt" "$generation" "$tip" || return 1
		fi
		classify_merge_failure "$hwt" "$slot"
		return $?
	fi
	new="$(git -C "$hwt" rev-parse HEAD)" || return 1
	# The merge commit's SHA lands in the journal the moment it exists: a
	# crash between here and the swap is detected by resume, never silent.
	journal_set "$slot" detached "$expected" "$new" "$hwt" "$generation" || return 1
	# Test seams for the crash window — see file header.
	if [ -n "${HERDR_SWARM_TEST_DIE_BEFORE_SWAP:-}" ]; then exit 99; fi
	if [ -n "${HERDR_SWARM_TEST_PAUSE_BEFORE_SWAP:-}" ]; then
		sleep "$HERDR_SWARM_TEST_PAUSE_BEFORE_SWAP"
	fi
	swap_base "$slot" "$expected" "$new" "$hwt" || rc=$?
	return "$rc"
}

merge_in_user_tree() {
	local slot="$1" expected="$2" utree="$3" new first
	# Sparse checkout can hide conflicting paths — refuse (preflight noted it
	# at fan-out; this is where the refusal bites).
	local sc
	sc="$(git -C "$utree" rev-parse --git-path info/sparse-checkout 2>/dev/null || true)"
	if [ "$(git -C "$utree" config --bool core.sparseCheckout 2>/dev/null)" = "true" ] ||
		{ [ -n "$sc" ] && [ -f "$sc" ]; }; then
		echo "herdr-swarm: $BASE_BRANCH is checked out in a SPARSE tree at $utree — merging there is refused. Escape hatch: check out any other branch and re-run harvest (the merge then happens in a plugin-owned worktree)." >&2
		return "$HS_EC_LOCUS"
	fi
	# Clean-tree check runs HERE, after the renderer's confirm — the prompt
	# can sit for minutes, so the pre-confirm state proves nothing (KTD).
	if [ -n "$(git -C "$utree" status --porcelain)" ]; then
		echo "herdr-swarm: $BASE_BRANCH is checked out at $utree and that tree is DIRTY — merging there is refused. Commit or stash it, or check out any other branch and re-run harvest (that converts this into the safe detached-worktree case)." >&2
		return "$HS_EC_LOCUS"
	fi
	journal_set "$slot" user-tree "$expected" "" "$utree" || return 1
	# Test seam: the window between verification and merge — see file header.
	if [ -n "${HERDR_SWARM_TEST_PAUSE_BEFORE_MERGE:-}" ]; then
		sleep "$HERDR_SWARM_TEST_PAUSE_BEFORE_MERGE"
	fi
	# Hooks always run in the user's tree — never silently suppressed (KTD).
	if ! run_merge "$utree" "$slot" "hooks"; then
		classify_merge_failure "$utree" "$slot"
		return $?
	fi
	new="$(git -C "$utree" rev-parse HEAD)" || return 1
	journal_set "$slot" user-tree "$expected" "$new" "$utree" || return 1
	# No expected-old form exists in this locus (`git merge` moves the ref
	# through HEAD), so the guard is post-merge: first parent must be the
	# SHA the user reviewed (KTD).
	first="$(git -C "$utree" rev-parse "$new^1")" || return 1
	if [ "$first" != "$expected" ]; then
		git -C "$utree" reset --hard ORIG_HEAD >/dev/null || {
			echo "herdr-swarm: FIRST-PARENT MISMATCH AND reset --hard ORIG_HEAD FAILED in $utree — resolve by hand; merge commit $new." >&2
			return 1
		}
		journal_clear "$slot" || true
		echo "herdr-swarm: base moved between verification and merge — merge commit $new ABANDONED (first parent $first != expected $expected); your tree was restored via reset --hard ORIG_HEAD. Base unchanged by the harvest; re-preview and retry." >&2
		return "$HS_EC_SWAP"
	fi
	manifest_update_slot "$slot" '{"status":"merged","journal":null}' || return 1
	printf 'merged\t%s\n' "$new"
}

do_resume() {
	local action="${1-}" target="${2-}" cur
	cur="$(base_sha)" || return 1
	if [ "$action" = "complete" ]; then
		require_slot_arg "$target" || return 1
		read_slot "$target" || return $?
		local expected msha hwt jlocus
		expected="$(journal_field "$SLOT_JOURNAL" expected_base_sha)"
		msha="$(journal_field "$SLOT_JOURNAL" merge_commit_sha)"
		hwt="$(journal_field "$SLOT_JOURNAL" worktree)"
		jlocus="$(journal_field "$SLOT_JOURNAL" locus)"
		# Only the detached locus owns a plugin worktree; the user-tree locus
		# journals the USER's own checkout, which must NEVER reach swap_base's
		# removal tail (abort.sh:235 encodes the same rule). Base having since
		# been checked out elsewhere makes that tail reachable, and git deletes
		# a linked-worktree checkout without complaint — user work, gone.
		if [ "$jlocus" != "detached" ]; then
			hwt=""
		fi
		if [ -z "$msha" ]; then
			echo "herdr-swarm: slot $target has no journaled merge commit — nothing to complete (abort-merge clears stale intents)." >&2
			return "$HS_EC_REFUSED"
		fi
		swap_base "$target" "$expected" "$msha" "$hwt"
		return $?
	fi
	# Scan every journaled slot; each line is a typed fact for the renderer.
	local slot locus expected msha hwt journal cleanup_rc
	while IFS="$US" read -r slot locus expected msha hwt journal; do
		[ -n "$slot" ] || continue
		SLOT_JOURNAL="$journal"
		if [ -z "$msha" ]; then
			# Crash (or conflict-stall) before a merge commit existed.
			printf 'resume_stale\t%s\n' "$slot"
			echo "herdr-swarm: slot $slot has a journaled merge intent with no commit — abort-merge cleans it up." >&2
		elif [ "$cur" = "$msha" ]; then
			# The swap itself landed before the crash; retain the journal until
			# the exact generation is removed (or prove it is already absent).
			manifest_update_slot "$slot" '{"status":"merged"}' || return 1
			cleanup_rc=0
			if [ "$locus" = "detached" ] && [ -n "$hwt" ] && [ -d "$hwt" ]; then
				remove_harvest_resource "$RUN_ID" "$slot" "$hwt" "$journal" || cleanup_rc=$?
				if [ "$cleanup_rc" -eq 0 ]; then
					journal_clear "$slot" || return 1
				else
					echo "herdr-swarm: slot $slot landed merge remains journaled; exact harvest cleanup was refused or needs approval." >&2
				fi
			else
				journal_clear "$slot" || return 1
			fi
			printf 'resume_completed\t%s\t%s\n' "$slot" "$msha"
		elif [ "$cur" = "$expected" ]; then
			printf 'resume_offer\t%s\t%s\n' "$slot" "$msha"
		else
			# Base moved past the journaled expectation: the merge commit
			# dangles. Report loudly; the worktree holding it is NEVER deleted
			# (plan risk: never silently unreachable).
			printf 'resume_dangling\t%s\t%s\t%s\n' "$slot" "$msha" "$hwt"
			echo "herdr-swarm: slot $slot has merge commit $msha for a base that has since moved — kept${hwt:+ in $hwt} for manual recovery; it will not be auto-deleted." >&2
		fi
	done <<<"$(printf '%s' "$DOC" | node -e '
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			for (const s of JSON.parse(d).slots || []) {
				if (!s.journal) continue;
				const j = s.journal;
				console.log([s.slot, j.locus ?? "", j.expected_base_sha ?? "",
					j.merge_commit_sha ?? "", j.worktree ?? "", JSON.stringify(j)].join("\x1f"));
			}
		});
	')"
	return 0
}

do_abort_merge() {
	read_slot "$1" || return $?
	if [ "$SLOT_JOURNAL" = "null" ]; then
		echo "herdr-swarm: no merge in flight for slot $1." >&2
		return "$HS_EC_REFUSED"
	fi
	local locus wt msha cur
	locus="$(journal_field "$SLOT_JOURNAL" locus)"
	wt="$(journal_field "$SLOT_JOURNAL" worktree)"
	msha="$(journal_field "$SLOT_JOURNAL" merge_commit_sha)"
	cur="$(base_sha)" || return 1
	if [ "$locus" = "detached" ]; then
		if [ -n "$msha" ] && [ "$cur" = "$msha" ]; then
			# The swap already landed — settle only after exact cleanup succeeds.
			manifest_update_slot "$1" '{"status":"merged"}' || return 1
			if [ -d "$wt" ]; then
				remove_harvest_resource "$RUN_ID" "$1" "$wt" "$SLOT_JOURNAL" || return $?
			fi
			journal_clear "$1" || return 1
			printf 'aborted\talready-swapped\n'
			return 0
		fi
		# A running conflict resolver is working IN this tree: merge --abort and
		# removal would reset its edits and pull the directory out from under it.
		local rstate
		rstate="$(resolver_state "$(slot_row_json "$1")")"
		if [ "$rstate" != gone ]; then
			echo "herdr-swarm: slot $1 conflict resolver is $rstate in $wt — exit the agent in its pane (or close the pane) before aborting the merge. If you know it stopped, HERDR_SWARM_RESOLVER_STOPPED=yes." >&2
			return "$HS_EC_REFUSED"
		fi
		if [ -n "$msha" ]; then
			# An un-swapped merge commit lives here: the worktree is its only
			# obvious anchor — never delete it out from under the user (plan
			# risk: dangling commit must stay surfaced, not become archaeology).
			echo "herdr-swarm: slot $1 has un-swapped merge commit $msha in $wt — resume offers completing it; abort refused." >&2
			return "$HS_EC_REFUSED"
		fi
		if [ -d "$wt" ]; then
			local head_sha
			head_sha="$(git -C "$wt" rev-parse --verify HEAD 2>/dev/null || true)"
			if [ -n "$head_sha" ] &&
				! git -C "$REPO_ROOT" merge-base --is-ancestor "$head_sha" "$BASE_REF" 2>/dev/null; then
				echo "herdr-swarm: slot $1 worktree $wt has HEAD $head_sha, which is NOT on $BASE_BRANCH — possibly an un-swapped merge commit the journal lost. KEPT for recovery." >&2
				return "$HS_EC_REFUSED"
			fi
			# Verify before aborting the merge: merge --abort itself resets tracked
			# state and must never run against a forged foreign journal.
			verify_harvest_resource "$RUN_ID" "$1" "$wt" "$SLOT_JOURNAL" >/dev/null || {
				echo "herdr-swarm: slot $1 harvest resource identity failed — kept untouched." >&2
				return "$HS_EC_REFUSED"
			}
			git -C "$wt" merge --abort 2>/dev/null || true
			remove_harvest_resource "$RUN_ID" "$1" "$wt" "$SLOT_JOURNAL" || return $?
		fi
		journal_clear "$1" || return 1
		printf 'aborted\t%s\n' "$1"
	else
		# --absolute-git-dir, not --git-path: --git-path answers relative to
		# the worktree while this test runs from the script's own cwd.
		if [ -e "$(git -C "$wt" rev-parse --absolute-git-dir)/MERGE_HEAD" ]; then
			git -C "$wt" merge --abort || {
				echo "herdr-swarm: git merge --abort failed in $wt — resolve by hand." >&2
				return 1
			}
		fi
		journal_clear "$1" || return 1
		printf 'aborted\t%s\n' "$1"
	fi
}
