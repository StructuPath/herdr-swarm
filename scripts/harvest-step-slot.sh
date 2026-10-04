#!/usr/bin/env bash
# harvest-step-slot.sh — Per-slot preview and the uncommitted-work flow: preview, commit-wip, snapshot, discard, skip, archive.
#
# Sourced by harvest-step.sh, the one entry point; not run on its own. The
# globals used here (RUN_ID, REPO_ROOT, DOC, SLOT_*, HS_EC_*, …) are set there.
# shellcheck disable=SC2154,SC2153

do_preview() {
	read_slot "$1" || return $?
	printf 'slot\t%s\n' "$1"
	printf 'branch\t%s\n' "$SLOT_BRANCH"
	case "$SLOT_STATUS" in
	merged | skipped | archived | failed)
		printf 'state\t%s\n' "$SLOT_STATUS"
		_preview_report_idle
		return 0
		;;
	esac
	if [ -z "$SLOT_PATH" ] || [ ! -d "$SLOT_PATH" ]; then
		printf 'state\tmissing\n'
		return 0
	fi
	local base tip dirty n=0 lp
	base="$(base_sha)" || return 1
	tip="$(git -C "$SLOT_PATH" rev-parse --verify HEAD 2>/dev/null)" || {
		printf 'state\tmissing\n'
		return 0
	}
	printf 'base_sha\t%s\n' "$base"
	printf 'tip_sha\t%s\n' "$tip"
	dirty="$(git -C "$SLOT_PATH" status --porcelain)"
	[ -n "$dirty" ] && n="$(printf '%s\n' "$dirty" | grep -c .)"
	printf 'dirty\t%s\n' "$n"
	# Locus reported at preview time so the renderer can run its user-tree
	# confirm BEFORE invoking merge; the merge verb re-decides authoritatively.
	lp="$(base_checkout_path)"
	if [ -n "$lp" ]; then
		printf 'locus\tuser-tree\t%s\n' "$lp"
	else
		printf 'locus\tdetached\n'
	fi
	if [ "$tip" = "$FORK_SHA" ] && [ "$n" -eq 0 ]; then
		# Nothing to harvest: auto-skip (plan flowchart) so the slot reaches
		# the archivable band without a pointless "merge nothing" prompt.
		printf 'state\tempty\n'
		manifest_update_slot "$1" '{"status":"skipped"}' || return 1
		_preview_report_idle
		return 0
	fi
	if [ "$tip" != "$FORK_SHA" ] &&
		git -C "$REPO_ROOT" merge-base --is-ancestor "$tip" "$base"; then
		# The user merged this slot themselves — mark merged instead of
		# re-merging into "Already up to date" (plan: externally-merged detect).
		printf 'state\texternal_merged\n'
		manifest_update_slot "$1" '{"status":"merged"}' || return 1
		_preview_report_idle
		return 0
	fi
	if [ "$n" -eq 0 ] && [ "$tip" != "$FORK_SHA" ] &&
		squash_merged_into_base "$tip" "$base"; then
		# The user squash- or cherry-pick-merged this slot themselves: no
		# ancestry, but a merge would change nothing. Detected, not re-merged —
		# re-merging a squashed slot is exactly the conflict the sharp edge
		# used to warn about. Prune still keeps the branch (its ancestry test
		# cannot see squashes); that remains the conservative call.
		printf 'state\tsquash_merged\n'
		manifest_update_slot "$1" '{"status":"merged"}' || return 1
		_preview_report_idle
		return 0
	fi
	if [ "$n" -gt 0 ]; then
		printf 'state\tdirty\n'
	else
		printf 'state\tclean\n'
	fi
	# Three-dot against the recorded fork SHA — same R5 contract as status.
	git -C "$SLOT_PATH" diff --stat "$FORK_SHA...HEAD" | sed $'s/^/stat\t/'
}

do_commit_wip() {
	read_slot "$1" || return $?
	[ -d "$SLOT_PATH" ] || {
		echo "herdr-swarm: slot $1 worktree is gone ($SLOT_PATH)" >&2
		return "$HS_EC_REFUSED"
	}
	# add -A stages tracked + untracked; the task file stays out via the
	# shared info/exclude pattern fan-out added.
	git -C "$SLOT_PATH" add -A || return 1
	git -C "$SLOT_PATH" commit -m "swarm: WIP $SLOT_LABEL (run $RUN_ID)" || return 1
	printf 'wip\t%s\n' "$(git -C "$SLOT_PATH" rev-parse HEAD)"
}

do_snapshot() {
	read_slot "$1" || return $?
	[ -d "$SLOT_PATH" ] || {
		echo "herdr-swarm: slot $1 worktree is gone ($SLOT_PATH)" >&2
		return "$HS_EC_REFUSED"
	}
	local ref="refs/swarm-backups/$RUN_ID/$1" tmpidx tree head sha
	# Dirty tree INCLUDING untracked, via a temporary index: `git stash
	# create` skips untracked files without an add, and adding to the REAL
	# index would mutate state the user (or a hook) can see — so stage
	# everything into a throwaway index, write-tree, and commit-tree against
	# HEAD. The real index is never touched (asserted by tests).
	tmpidx="$(mktemp "${TMPDIR:-/tmp}/hs-snap-idx.XXXXXX")" || return 1
	if ! GIT_INDEX_FILE="$tmpidx" git -C "$SLOT_PATH" read-tree HEAD ||
		! GIT_INDEX_FILE="$tmpidx" git -C "$SLOT_PATH" add -A ||
		! tree="$(GIT_INDEX_FILE="$tmpidx" git -C "$SLOT_PATH" write-tree)"; then
		rm -f "$tmpidx"
		return 1
	fi
	rm -f "$tmpidx"
	head="$(git -C "$SLOT_PATH" rev-parse HEAD)" || return 1
	sha="$(git -C "$SLOT_PATH" commit-tree "$tree" -p "$head" \
		-m "swarm: snapshot $SLOT_LABEL before discard (run $RUN_ID)")" || return 1
	git -C "$REPO_ROOT" update-ref "$ref" "$sha" || return 1
	# Manifest records the SHA BEFORE any destructive step can run (KTD:
	# discard refuses unless this record exists).
	manifest_update_slot "$1" "{\"backup_ref\":\"$sha\"}" || return 1
	printf 'snapshot\t%s\t%s\n' "$ref" "$sha"
}

do_discard() {
	read_slot "$1" || return $?
	# Snapshot-before-discard (KTD): no recorded backup ref, no discard.
	if [ -z "$SLOT_BACKUP" ]; then
		echo "herdr-swarm: slot $1 has no recorded snapshot — run snapshot first; discard refused." >&2
		return "$HS_EC_REFUSED"
	fi
	if ! git -C "$REPO_ROOT" rev-parse -q --verify "$SLOT_BACKUP^{commit}" >/dev/null; then
		echo "herdr-swarm: recorded snapshot $SLOT_BACKUP is missing from the object store — discard refused." >&2
		return "$HS_EC_REFUSED"
	fi
	# The typed confirmation is checked by the renderer for UX, but re-verified
	# here: a UI bug must never be able to discard work on its own.
	if [ "${HERDR_SWARM_CONFIRM:-}" != "$SLOT_BRANCH" ]; then
		echo "herdr-swarm: discard confirmation mismatch (expected the slot branch name) — refused." >&2
		return "$HS_EC_REFUSED"
	fi
	[ -d "$SLOT_PATH" ] || {
		echo "herdr-swarm: slot $1 worktree is gone ($SLOT_PATH)" >&2
		return "$HS_EC_REFUSED"
	}
	# reset --hard, not `checkout -- .`: checkout restores the working tree FROM
	# the index, so STAGED changes survive it. The verb then reports "discarded"
	# while the slot is still dirty, and every later archive fails HS_EC_DIRTY
	# with no way out. reset --hard drops index and worktree together.
	git -C "$SLOT_PATH" reset --hard HEAD >/dev/null || return 1
	# -fd, deliberately not -fdx: ignored files stay (they are outside every
	# safety net — plan risk — so we never delete them here either).
	git -C "$SLOT_PATH" clean -fd || return 1
	printf 'discarded\t%s\n' "$SLOT_BACKUP"
}

do_skip() {
	read_slot "$1" || return $?
	manifest_update_slot "$1" '{"status":"skipped"}' || return 1
	printf 'skipped\t%s\n' "$1"
}

do_archive() {
	read_slot "$1" || return $?
	case "$SLOT_STATUS" in
	merged | skipped | failed) ;;
	archived)
		finalize_run "$REPO_ROOT" "$RUN_ID" || return $?
		printf 'archived\t%s\n' "$1"
		return 0
		;;
	*)
		echo "herdr-swarm: slot $1 is '$SLOT_STATUS' — only merged/skipped/failed slots can be archived." >&2
		return "$HS_EC_REFUSED"
		;;
	esac
	# Settled check: spike (a) — the herdr remove verb silently KILLS a live
	# agent, so archiving is allowed only when absent or settled. Herdr 0.8.2
	# reports unseen background idle agents as done (same underlying state).
	local agents st
	# shellcheck disable=SC2119  # wrapper takes optional args; none needed here
	agents="$(herdr_agent_list 2>/dev/null || true)"
	st="$(printf '%s' "$agents" | node -e '
		const [term, pane] = process.argv.slice(1);
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			let j = null;
			try { j = JSON.parse(d); } catch {}
			const a = (j?.result?.agents || []).find(
				(x) => (term && x.terminal_id === term) || (pane && x.pane_id === pane));
			process.stdout.write(a ? String(a.agent_status || "unknown") : "absent");
		});
	' "$SLOT_TERMINAL" "$SLOT_PANE")"
	case "$st" in
	absent | idle | done) ;;
	*)
		echo "herdr-swarm: slot $1 agent is '$st' — archiving would kill it (worktree removal stops live agents, spike (a)); wait for idle or stop it first." >&2
		return "$HS_EC_REFUSED"
		;;
	esac
	if [ -z "$SLOT_PATH" ] || [ ! -d "$SLOT_PATH" ]; then
		# Failed slots may never have gotten a worktree; nothing on disk to
		# remove is not an error — just settle the bookkeeping.
		manifest_update_slot "$1" '{"status":"archived"}' || return 1
		printf 'archived\t%s\n' "$1"
		finalize_run "$REPO_ROOT" "$RUN_ID" || return $?
		return 0
	fi
	# Cleanup is preview/apply, not a process-global boolean. The recursive
	# inventory is canonicalized as NUL-delimited path bytes and its digest is
	# bound to repo/run/slot/physical worktree/operation. Apply re-verifies
	# ownership and recomputes immediately before the first removal call.
	local operation inventory count used rechecked why
	operation="$(printf '%s' "${HERDR_SWARM_CLEANUP_APPROVAL:-}" | node -e '
		let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d);if(a.operation_id)process.stdout.write(String(a.operation_id));}catch{}});
	')"
	[ -n "$operation" ] || operation="$(cleanup_operation_id)" || return 1
	inventory="$(slot_ignored_inventory "$REPO_ROOT" "$RUN_ID" "$1" "$SLOT_PATH" "$operation")" || return 1
	count="$(cleanup_inventory_count "$inventory")" || return 1
	if [ "$count" -gt 0 ]; then
		used="$(cleanup_approval_validate "$inventory")" || {
			print_cleanup_inventory "$inventory"
			echo "herdr-swarm: slot $1 worktree holds ignored files; apply requires the exact one-use cleanup approval emitted by this preview." >&2
			return "$HS_EC_IGNORED"
		}
	fi
	if [ -n "${HERDR_SWARM_TEST_CLEANUP_READY_FILE:-}" ]; then : >"$HERDR_SWARM_TEST_CLEANUP_READY_FILE"; fi
	if [ -n "${HERDR_SWARM_TEST_PAUSE_BEFORE_CLEANUP_RECHECK:-}" ]; then
		sleep "$HERDR_SWARM_TEST_PAUSE_BEFORE_CLEANUP_RECHECK"
	fi
	if ! why="$(verify_slot_ownership "$RUN_ID" "$SLOT_BRANCH" "$SLOT_PATH")"; then
		echo "herdr-swarm: slot $1 ownership changed before cleanup — $why; removal refused." >&2
		return "$HS_EC_REFUSED"
	fi
	rechecked="$(slot_ignored_inventory "$REPO_ROOT" "$RUN_ID" "$1" "$SLOT_PATH" "$operation")" || return 1
	if [ "$(printf '%s' "$inventory" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).digest))')" != \
		"$(printf '%s' "$rechecked" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).digest))')" ]; then
		print_cleanup_inventory "$rechecked"
		echo "herdr-swarm: cleanup inventory changed after preview — zero removal performed; review the new digest." >&2
		return "$HS_EC_IGNORED"
	fi
	if [ "$count" -gt 0 ]; then
		cleanup_approval_consume "$used" || return "$HS_EC_REFUSED"
	fi
	local out rc=0
	if [ -n "$SLOT_WS" ]; then
		# The herdr verb stops the (idle) agent, closes the grouped workspace,
		# and removes the worktree in one shot (spike (a)); no --force is
		# enforced by the wrapper itself (R11).
		out="$(herdr_worktree_remove --workspace "$SLOT_WS" 2>&1)" || rc=$?
		if [ "$rc" -ne 0 ]; then
			# Machine-readable error code, never message parsing (spike (a)).
			if printf '%s' "$out" | grep -q '"code":"dirty_worktree_requires_force"'; then
				echo "herdr-swarm: slot $1 worktree has uncommitted work — commit-WIP, skip, or discard it first." >&2
				return "$HS_EC_DIRTY"
			fi
			printf '%s\n' "$out" >&2
			return 1
		fi
	else
		# No workspace recorded (herdr state lost): plain git removal, same
		# no-force policy — dirty refusals route to the uncommitted-work flow.
		# Capture, never `2>&1` bare: this verb's stdout IS the machine-readable
		# "key<TAB>value" protocol parseStepOutput consumes, so git's stderr
		# leaking there corrupts the parse — and the error text is lost besides.
		out="$(git -C "$REPO_ROOT" worktree remove "$SLOT_PATH" 2>&1)" || rc=$?
		if [ "$rc" -ne 0 ]; then
			if [ -n "$(git -C "$SLOT_PATH" status --porcelain 2>/dev/null)" ]; then
				echo "herdr-swarm: slot $1 worktree has uncommitted work — commit-WIP, skip, or discard it first." >&2
				return "$HS_EC_DIRTY"
			fi
			printf '%s\n' "$out" >&2
			return 1
		fi
	fi
	# Herdr success is not the disk authority (stale server responses and test
	# doubles can leave the registered worktree behind). Re-verify and reconcile
	# with plain git before declaring the slot archived/finalizable.
	if [ -d "$SLOT_PATH" ]; then
		if ! why="$(verify_slot_ownership "$RUN_ID" "$SLOT_BRANCH" "$SLOT_PATH")"; then
			echo "herdr-swarm: slot $1 still exists after Herdr removal and ownership no longer matches — kept, not archived: $why" >&2
			return "$HS_EC_REFUSED"
		fi
		out="$(git -C "$REPO_ROOT" worktree remove "$SLOT_PATH" 2>&1)" || {
			if [ -n "$(git -C "$SLOT_PATH" status --porcelain 2>/dev/null)" ]; then return "$HS_EC_DIRTY"; fi
			printf '%s\n' "$out" >&2
			return 1
		}
	fi
	manifest_update_slot "$1" '{"status":"archived"}' || return 1
	printf 'archived\t%s\n' "$1"
	finalize_run "$REPO_ROOT" "$RUN_ID" || return $?
}
