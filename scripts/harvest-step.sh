#!/usr/bin/env bash
# harvest-step.sh — the ONE destructive surface of the harvest flow (U6 of
# docs/plans/2026-07-22-001). The harvest renderer is UI, state machine, and
# orchestration only; EVERY state-mutating git/herdr command it needs runs
# through a verb here, so all rm -rf-class and ref-mutating code stays in
# bash, under the stub-CLI harness, behind one grep-able audit line
# (tests/harvest.test.mjs asserts no git-mutation strings in bin/).
#
#   bash scripts/harvest-step.sh <verb> [args…]
#
# Verbs: preview <slot> | commit-wip <slot> | snapshot <slot> |
#        discard <slot> | skip <slot> |
#        merge <slot> <expected-base-sha> [expected-slot-tip] |
#        resume [complete <slot>] | archive <slot> | abort-merge <slot> |
#        publish <slot> | publish-pr <slot> | publish-candidate-pr <slot> |
#        candidate-status <slot> | pr-status <slot> | validate <slot> |
#        settle | compare | broadcast | resolve <slot> |
#        conclude <slot> [apply <sha>]
#
# Output protocol: machine-readable "key<TAB>value…" lines on stdout, human
# messages on stderr, typed exit codes (HS_EC_*) so the renderer branches on
# codes, never on prose. Every invocation takes the physical-repository
# mutation lock every launcher uses, so workspace aliases cannot race and an
# abort can never reap a worktree mid-merge.
#
# Env contract (all optional):
#   HERDR_SWARM_CONFIRM               discard's confirmation token; must equal
#                                     the slot's branch name (typed by the
#                                     user in the renderer, re-verified here —
#                                     the renderer's prompt alone is UI, not a
#                                     guard)
#   HERDR_SWARM_CLEANUP_APPROVAL      archive: exact one-use JSON approval
#                                     emitted by the ignored inventory preview
#   HERDR_SWARM_PUBLISH_REMOTE        publish: remote to push the slot branch
#                                     to (default: origin)
#   HERDR_SWARM_CANDIDATE_VALIDATION_FILE / _BROWSER_QA_FILE /
#   _REVIEW_FILE                       strict candidate handoff evidence; an
#                                     unset validation file defaults to the
#                                     slot's Swarm-produced validate result
#   HERDR_SWARM_VALIDATE_TIMEOUT      validate: hook budget in seconds
#                                     (default 900)
#   HERDR_SWARM_HARVEST_WT_NO_HOOKS=1 disable repo hooks in the plugin-owned
#                                     harvest worktree ONLY (hook-policy KTD:
#                                     fresh worktrees lack node_modules, so
#                                     hooks that shell into node_modules/.bin
#                                     fail there; hooks are never suppressed
#                                     in the user's tree)
#   HERDR_SWARM_TEST_PAUSE_BEFORE_SWAP / _PAUSE_BEFORE_MERGE /
#   _DIE_BEFORE_SWAP                  test seams for the crash windows the
#                                     journal exists to survive; a real crash
#                                     is a kill at the same points
set -uo pipefail

PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck source=scripts/preflight.sh
. "$PLUGIN_ROOT/scripts/preflight.sh" # sources lib.sh; provides SWARM_TASK_FILE
# shellcheck source=scripts/presets.sh
. "$PLUGIN_ROOT/scripts/presets.sh" # preset_argv, for the conflict resolver

# Typed refusal codes, 30+ to stay clear of preflight's 10-20 band and the
# manifest codes (2/3, which propagate as-is when the manifest is missing or
# corrupt — a destructive verb must refuse on unreadable bookkeeping). The
# renderer branches on these (STEP_EC in bin/renderer.mjs is lockstep-tested).
HS_EC_DRIFT=30     # base moved since preview — re-preview and retry
HS_EC_SEQUENCER=31 # rebase/cherry-pick/merge/bisect in flight somewhere
HS_EC_LOCUS=32     # user-tree locus precondition failed (dirty/sparse)
HS_EC_CONFLICT=33  # merge conflict — merge tree left for inspection
HS_EC_HOOK=34      # merge failed without conflicts (hook or other)
HS_EC_SWAP=35      # ref swap failed or was abandoned — base unchanged
HS_EC_REFUSED=36   # verb precondition failed (no snapshot, bad token, …)
HS_EC_IGNORED=37   # archive: ignored files present, ack required
HS_EC_DIRTY=38     # archive: dirty worktree — route to uncommitted-work flow

require_node || exit 1

VERB="${1-}"
[ -n "$VERB" ] || {
	echo "usage: harvest-step.sh <verb> [args…]" >&2
	exit 1
}
shift

case "$VERB" in publish-pr | publish-candidate-pr | candidate-status | pr-status | validate | compare) clear_git_routing_env ;; esac

# --- Run + slot context ------------------------------------------------------

# Internal field separator is ASCII unit separator (\x1f), NOT tab: tab is
# IFS *whitespace*, so bash collapses runs of it and empty fields silently
# shift every later field left — exactly the bug for nullable columns.
US=$'\x1f'

# The workspace-named manifest is only a repository-discovery hint. Select the
# one exact live generation for that physical repository under its lock, so a
# reopened/aliased workspace reaches the same run and multiples fail closed.
REPO_HINT="$(discover_live_repo)" || {
	echo "herdr-swarm: cannot resolve the workspace repository — cannot harvest." >&2
	exit "$MANIFEST_EC_MISSING"
}
SWARM_REPO="$REPO_HINT"
export SWARM_REPO
MUTATION_LOCK="$(repo_mutation_lock_name "$REPO_HINT")" || exit 1
acquire_lock "$MUTATION_LOCK" || exit 1
trap 'release_lock "$MUTATION_LOCK"' EXIT
bind_live_manifest_locked "$REPO_HINT" || exit $?
DOC="$(manifest_read)" || exit $?
CTX="$(manifest_run_context "$DOC")" || {
	echo "herdr-swarm: manifest has no usable run_id/repo_root — cannot harvest." >&2
	exit 1
}
IFS="$US" read -r RUN_ID REPO_ROOT BASE_REF FORK_SHA <<<"$CTX"
SWARM_REPO="$REPO_ROOT"
export SWARM_REPO
# run_id is interpolated into the harvest worktree path ($(state_dir)/harvest-
# $RUN_ID-s<slot>, fed straight to `git worktree add`/`remove`) and into the
# backup ref namespace (refs/swarm-backups/$RUN_ID/<slot>). A run_id carrying
# '../' or a slash would escape the state dir into an rm -rf-class removal of
# a foreign path, or mint refs outside the plugin's namespace — charset-
# restrict at the edge, before ANY git call, exactly as abort.sh does
# (ownership KTD). Same guard, harvest's own refusal wording.
if ! RUN_ID_SAFE="$(sanitize_slug "$RUN_ID")" || [ "$RUN_ID_SAFE" != "$RUN_ID" ]; then
	echo "herdr-swarm: manifest run_id '$RUN_ID' fails the path charset — harvest refused." >&2
	exit 1
fi
BASE_BRANCH="${BASE_REF#refs/heads/}"

# read_slot <slot>: populate SLOT_* globals from the manifest row. Journal is
# passed through as compact JSON (JSON.stringify escapes control chars, so a
# raw \x1f can never appear inside the field and split it).
#
# This is also where slot ownership is asserted: EVERY slot-consuming verb
# passes through here, so the guard is one shared checkpoint rather than a
# check each verb must remember (cross-script-invariant-drift, countermeasure
# 1). Without it a manifest slot's branch and path reach `worktree remove`,
# `reset --hard`, and `clean -fd` behind only a `[ -d ]` — the third instance
# of the drift pattern that produced this repo's two P0s.
read_slot() {
	local slot="$1" line why
	line="$(printf '%s' "$DOC" | node -e '
		const slot = process.argv[1];
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const r = (JSON.parse(d).slots || []).find((x) => String(x.slot) === slot);
			if (!r) {
				console.error("herdr-swarm: no slot " + slot + " in manifest");
				process.exit(1);
			}
			process.stdout.write([
				r.label ?? "", r.branch ?? "", r.path ?? "", r.status ?? "",
				r.backup_ref ?? "", r.terminal_id ?? "", r.pane_id ?? "",
				r.workspace_id ?? "", r.agent_name ?? "",
				JSON.stringify(r.journal ?? null),
			].join("\x1f"));
		});
	' "$slot")" || return 1
	# Journal stays LAST: `read` gives the final variable everything that is
	# left, so a field added after it would be swallowed into the JSON.
	IFS="$US" read -r SLOT_LABEL SLOT_BRANCH SLOT_PATH SLOT_STATUS SLOT_BACKUP \
		SLOT_TERMINAL SLOT_PANE SLOT_WS SLOT_AGENT SLOT_JOURNAL <<<"$line"
	# Refuse BEFORE returning, so no verb can run a git mutation against a row
	# this run does not own. Harvest is interactive and has somewhere to route
	# the user, so it refuses outright; abort keeps and reports instead.
	if ! why="$(verify_slot_ownership "$RUN_ID" "$SLOT_BRANCH" "$SLOT_PATH")"; then
		echo "herdr-swarm: slot $slot ownership check FAILED — $why. Harvest refused; the manifest at $(manifest_path) does not describe this repo's run." >&2
		return "$HS_EC_REFUSED"
	fi
}

# _preview_report_idle: mirror "this slot has stopped working" into its
# plugin-reported agent state. Preview is the ONE place the plugin re-inspects
# a live slot after fan-out, so it is the only non-daemon hook available — and
# a 0.7.5 slot, being plugin-reported rather than natively detected, would
# otherwise sit at "working" in `agent list` forever after it was harvested.
# No-op on 0.7.4 (herdr's own detection owns state there) and best-effort
# always: see report_slot_agent_state in lib.sh.
_preview_report_idle() {
	report_slot_agent_state "$SLOT_PANE" "$SLOT_AGENT" idle
}

# journal_field <json> <field> — empty string for null/absent.
journal_field() {
	node -e '
		let j = null;
		try { j = JSON.parse(process.argv[1]); } catch {}
		const v = j && j[process.argv[2]];
		process.stdout.write(v == null ? "" : String(v));
	' "$1" "$2"
}

# journal_set <slot> <locus> <expected> <merge_sha> <worktree> — the intent
# record written BEFORE git mutates anything, so a crash inside the merge
# critical section is detected and resumable on the next open (manifest KTD).
# Optional 7th arg: merge_tip, the exact slot commit being merged (MERGE_HEAD).
# `conclude` requires a resolved merge's second parent to be this commit, so
# a slot tip nobody compared can never ride in through a re-done merge.
journal_set() {
	local slot="$1" locus="$2" expected="$3" merge_sha="$4" wt="$5" generation="${6-}" merge_tip="${7-}" patch identity
	identity="$(repo_identity_json "$REPO_ROOT")" || return 1
	patch="$(node -e '
		const [locus,expected,mergeSha,wt,generation,identity,runId,slot,mergeTip]=process.argv.slice(1);
		const journal={locus,expected_base_sha:expected,merge_commit_sha:mergeSha||null,worktree:wt||null};
		if(mergeTip) journal.merge_tip=mergeTip;
		if(locus==="detached") {
			const id=JSON.parse(identity);
			if(!generation) process.exit(2);
			journal.resource={type:"harvest",repo_key:id.repo_key,git_common_dir:id.git_common_dir,
				run_id:runId,slot,path:wt,generation,head:mergeSha||expected};
		}
		process.stdout.write(JSON.stringify({journal}));
	' "$locus" "$expected" "$merge_sha" "$wt" "$generation" "$identity" "$RUN_ID" "$slot" "$merge_tip")" || return 1
	manifest_update_slot "$slot" "$patch" || return $?
	SLOT_JOURNAL="$(printf '%s' "$patch" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(d).journal)))')"
}

journal_clear() {
	manifest_update_slot "$1" '{"journal":null}'
}

base_sha() {
	git -C "$REPO_ROOT" rev-parse --verify "$BASE_REF^{commit}"
}

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

require_slot_arg() {
	case "${1-}" in
	'' | *[!0-9]*)
		echo "herdr-swarm: '$VERB' needs a numeric slot argument" >&2
		return 1
		;;
	esac
}

# --- Verbs -------------------------------------------------------------------

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

# broadcast: type one message into every targeted slot's agent and submit it.
# The message comes from HERDR_SWARM_MESSAGE_FILE or HERDR_SWARM_MESSAGE and
# must be ONE line of printable text: a newline inside send-text arrives as a
# real line break (live-verified), so a TUI agent would submit half of it, and
# control characters are keystrokes (Ctrl-C, escape sequences), not text.
# Targets: HERDR_SWARM_TARGETS=1,3 or, by default, every running slot.
#
# Typing into the wrong program could RUN the message — a shell executes it,
# `less` runs `!…`, vim reads it as commands, an approval dialog takes it as
# option keys and Enter as "yes". So a slot receives it only when, checked
# right before typing:
#   1. its pane still holds the slot's own terminal (result.pane.terminal_id);
#   2. Herdr does not report the agent `blocked` (waiting on the user);
#   3. the foreground process GROUP LEADER is the slot's own agent program
#      (agent_command, recorded at fan-out) — not the shell, and not anything
#      the user or the agent started in the pane;
#   4. it has not finished by exiting (the shell owns that pane again).
# The program is checked again between typing and Enter; if it changed, Enter
# is withheld (text left unsent is inert). Records: broadcast_sent<TAB>slot,
# broadcast_skipped<TAB>slot<TAB>why, broadcast_partial<TAB>slot<TAB>why
# (typed but not submitted). Exits 36 unless every target was sent.
do_broadcast() {
	local msg rows s want_cmd finished got term status fg sent=0 failed=0
	# Validated in node, not with [[:cntrl:]]: that class depends on the
	# caller's locale (under LC_ALL=C it passes C1 controls like U+009B CSI).
	msg="$(HERDR_SWARM_MESSAGE="${HERDR_SWARM_MESSAGE:-}" node -e '
		const fs = require("fs");
		const file = process.argv[1];
		const fail = (why) => { console.error("herdr-swarm: " + why); process.exit(1); };
		let msg;
		if (file) {
			let bytes;
			try { bytes = fs.readFileSync(file); } catch { fail("HERDR_SWARM_MESSAGE_FILE \x27" + file + "\x27 is not a readable file."); }
			try { msg = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("broadcast message file is not valid UTF-8."); }
			msg = msg.replace(/\r?\n$/, "");
		} else msg = process.env.HERDR_SWARM_MESSAGE;
		if (!msg || !msg.trim()) fail("broadcast needs a message — set HERDR_SWARM_MESSAGE or HERDR_SWARM_MESSAGE_FILE.");
		const banned = (c) => c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x200e || c === 0x200f || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff || c === 0xfffd;
		if ([...msg].some((ch) => banned(ch.codePointAt(0))))
			fail("broadcast message must be one line of plain text (no newlines, tabs, control or direction-override characters) — an agent would receive a newline as \x27submit\x27.");
		if (msg.startsWith("-")) fail("broadcast message must not start with \x27-\x27 — the Herdr CLI would parse it as a flag; rephrase the start.");
		if ([...msg].length > 4000) fail("broadcast message is over 4000 characters — put longer instructions in a file and tell the agents to read it.");
		process.stdout.write(msg);
	' "${HERDR_SWARM_MESSAGE_FILE:-}")" || return "$HS_EC_REFUSED"
	rows="$(printf '%s' "$DOC" | node -e '
		const want = process.argv[1];
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const slots = JSON.parse(d).slots || [];
			const row = (n) => slots.find((r) => String(r.slot) === n);
			const line = (n) => {
				const r = row(n);
				console.log([n, r?.agent_command || "-", r?.finished?.reason || "-"].join("\t"));
			};
			if (!want) { for (const r of slots) if (r.status === "running") line(String(r.slot)); return; }
			const seen = new Set();
			for (const t of want.split(",")) {
				const n = t.trim();
				if (!/^[1-9][0-9]*$/.test(n)) { console.error("herdr-swarm: HERDR_SWARM_TARGETS entry \x27" + n + "\x27 is not a slot number"); process.exit(1); }
				// A repeat would type the same instruction into one agent twice.
				if (seen.has(n)) { console.error("herdr-swarm: HERDR_SWARM_TARGETS names slot " + n + " twice"); process.exit(1); }
				seen.add(n);
			}
			for (const n of seen) line(n);
		});
	' "${HERDR_SWARM_TARGETS:-}")" || return "$HS_EC_REFUSED"
	while IFS=$'\t' read -r s want_cmd finished; do
		[ -n "$s" ] || continue
		if ! read_slot "$s" 2>/dev/null; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "not a slot of this run, or its ownership check failed"
			failed=$((failed + 1))
			continue
		fi
		if [ "$SLOT_STATUS" != running ]; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "slot is '$SLOT_STATUS'"
			failed=$((failed + 1))
			continue
		fi
		if [ "$finished" = exited ]; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "its agent exited — the pane belongs to the shell again"
			failed=$((failed + 1))
			continue
		fi
		if [ -z "$SLOT_PANE" ] || [ -z "$SLOT_TERMINAL" ] || [ "$want_cmd" = "-" ]; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "no recorded pane, terminal, or agent program (a run started before broadcast existed)"
			failed=$((failed + 1))
			continue
		fi
		got="$(herdr_pane_get "$SLOT_PANE" 2>/dev/null)" || got=""
		IFS=$'\t' read -r term status <<<"$(printf '%s' "$got" | node -e '
			let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
				let p; try { p = JSON.parse(d).result.pane; } catch {}
				process.stdout.write([p?.terminal_id ?? "", p?.agent_status ?? ""].join("\t"));
			});' 2>/dev/null)"
		if [ "$term" != "$SLOT_TERMINAL" ]; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "its pane no longer holds this slot's terminal"
			failed=$((failed + 1))
			continue
		fi
		if [ "$status" = blocked ]; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "the agent is blocked waiting on you — keystrokes would answer its prompt"
			failed=$((failed + 1))
			continue
		fi
		fg="$(pane_foreground_program "$SLOT_PANE")"
		if ! _foreground_is "$fg" "$want_cmd"; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "the foreground is not its agent '$want_cmd' ($(_foreground_label "$fg"))"
			failed=$((failed + 1))
			continue
		fi
		if ! herdr_pane_send_text "$SLOT_PANE" "$msg" >/dev/null 2>&1; then
			printf 'broadcast_skipped\t%s\t%s\n' "$s" "typing was refused (send-text failed)"
			failed=$((failed + 1))
			continue
		fi
		# Narrow the check-then-act window: if the agent exited while the text
		# was typed, the shell would run it on Enter. Unsubmitted text is inert.
		fg="$(pane_foreground_program "$SLOT_PANE")"
		if ! _foreground_is "$fg" "$want_cmd"; then
			printf 'broadcast_partial\t%s\t%s\n' "$s" "typed, NOT submitted — the foreground changed to $(_foreground_label "$fg"); clear that pane's input line"
			failed=$((failed + 1))
			continue
		fi
		if ! herdr_pane_send_keys "$SLOT_PANE" Enter >/dev/null 2>&1; then
			printf 'broadcast_partial\t%s\t%s\n' "$s" "typed, NOT submitted — the Enter key was refused; press Enter in that pane or clear it (do not just re-run)"
			failed=$((failed + 1))
			continue
		fi
		printf 'broadcast_sent\t%s\n' "$s"
		sent=$((sent + 1))
	done <<<"$rows"
	if [ "$sent" -eq 0 ]; then
		echo "herdr-swarm: broadcast reached no slot (reasons above)." >&2
		return "$HS_EC_REFUSED"
	fi
	if [ "$failed" -gt 0 ]; then
		echo "herdr-swarm: broadcast reached $sent slot(s); $failed did not get it (reasons above)." >&2
		return "$HS_EC_REFUSED"
	fi
}

# _foreground_is <pane_foreground_program output> <agent_command>
_foreground_is() {
	local kind a b
	IFS=$'\t' read -r kind a b <<<"$1"
	[ "$kind" = program ] && { [ "$a" = "$2" ] || [ "$b" = "$2" ]; }
}

_foreground_label() {
	local kind a b
	IFS=$'\t' read -r kind a b <<<"$1"
	case "$kind" in
	program) printf '%s' "${b:+$a $b}${b:-$a}" ;;
	*) printf '%s' "$kind" ;;
	esac
}

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

# slot_row_json <slot>: the slot's whole manifest row, compact JSON.
slot_row_json() {
	printf '%s' "$DOC" | node -e '
		let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const r = (JSON.parse(d).slots || []).find((x) => String(x.slot) === process.argv[1]);
			process.stdout.write(JSON.stringify(r ?? null));
		});' "$1"
}

# detached_conflict_context <slot>: shared preconditions of resolve and
# conclude. Sets CX_EXPECTED, CX_TREE, CX_GENERATION. The merge must be the
# plugin-owned DETACHED kind (a user-tree conflict is the user's own checkout,
# outside what the plugin may hand to an agent or conclude on its behalf),
# still un-concluded, and its tree must be the exact journaled resource.
detached_conflict_context() {
	local slot="$1" locus msha
	if [ "$SLOT_JOURNAL" = "null" ]; then
		echo "herdr-swarm: slot $slot has no merge in flight." >&2
		return "$HS_EC_REFUSED"
	fi
	locus="$(journal_field "$SLOT_JOURNAL" locus)"
	msha="$(journal_field "$SLOT_JOURNAL" merge_commit_sha)"
	CX_EXPECTED="$(journal_field "$SLOT_JOURNAL" expected_base_sha)"
	CX_TREE="$(journal_field "$SLOT_JOURNAL" worktree)"
	CX_GENERATION="$(printf '%s' "$SLOT_JOURNAL" | node -e '
		let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
			try { process.stdout.write(String(JSON.parse(d)?.resource?.generation ?? "")); } catch {}
		});')"
	if [ "$locus" != detached ]; then
		echo "herdr-swarm: slot $slot is conflicted in YOUR checked-out branch ($CX_TREE) — resolve it there yourself; Swarm only hands its own detached merge trees to a resolver or concludes them." >&2
		return "$HS_EC_LOCUS"
	fi
	# A journaled-but-unlanded commit may be re-adopted (conclude), e.g. after
	# a landing that failed; one already ON the base is resume's business.
	CX_MSHA="$msha"
	if [ -n "$msha" ] && [ "$(base_sha 2>/dev/null)" = "$msha" ]; then
		echo "herdr-swarm: slot $slot merge $msha has already landed — re-open harvest to settle it." >&2
		return "$HS_EC_REFUSED"
	fi
	CX_TIP="$(journal_field "$SLOT_JOURNAL" merge_tip)"
	if [ -z "$CX_TREE" ] || [ ! -d "$CX_TREE" ]; then
		echo "herdr-swarm: slot $slot merge tree is missing — refused." >&2
		return "$HS_EC_REFUSED"
	fi
	# Identity is verified in full (repository, run/slot binding, exact
	# generation path, real directory, registration). Only HEAD is allowed to
	# have moved, and only by committing the merge: still the journaled base,
	# or a commit whose FIRST parent is it. Anything else is not this merge.
	local head first allowed=""
	head="$(git -C "$CX_TREE" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || head=""
	if [ -n "$head" ] && [ "$head" != "$CX_EXPECTED" ]; then
		first="$(git -C "$CX_TREE" rev-parse --verify "$head^1" 2>/dev/null)" || first=""
		if [ "$first" != "$CX_EXPECTED" ]; then
			echo "herdr-swarm: slot $slot merge tree HEAD moved off the journaled base $CX_EXPECTED — it is not this merge any more; refused." >&2
			return "$HS_EC_REFUSED"
		fi
		allowed="$head"
	fi
	if ! verify_harvest_resource "$RUN_ID" "$slot" "$CX_TREE" "$SLOT_JOURNAL" "$allowed" >/dev/null; then
		echo "herdr-swarm: slot $slot merge tree is not the exact journaled resource — refused." >&2
		return "$HS_EC_REFUSED"
	fi
}

# conclude <slot> [apply <sha>]: adopt a conflicted detached merge that was
# resolved IN its merge tree — by a person who shelled in, or by a resolver
# agent. Until now such a commit was unrecorded: resume called the journal
# stale and abort-merge refused it as an unknown merge commit.
#
# Two steps, so nothing is recorded before the operator has reviewed it:
#   conclude <slot>            READ-ONLY. Checks the tree holds exactly one
#                              finished merge of THIS slot's merged tip onto
#                              the journaled base, and prints what it changes:
#                              conclude_ready, outside_conflict (paths the
#                              resolution changed beyond git's own automatic
#                              merge — the "evil merge" surface), stat (full).
#   conclude <slot> apply SHA  Re-runs every check, requires HEAD == SHA (the
#                              commit reviewed), and only then journals it.
# Landing stays `resume complete`, behind the compare-and-swap; the pane runs
# apply and land together on the operator's `y`.
do_conclude() {
	local slot="$1" mode="${2-}" want="${3-}" head parents p1 p2 extra row rpane ragent rstate auto conflicted path
	read_slot "$slot" || return $?
	detached_conflict_context "$slot" || return $?
	if [ -z "$CX_TIP" ]; then
		echo "herdr-swarm: slot $slot merge was journaled before the merged tip was recorded — abort-merge and merge again to use conclude." >&2
		return "$HS_EC_REFUSED"
	fi
	# A resolver still in its tree could amend after review, or lose its cwd
	# when landing removes the tree: it must be proven gone first.
	row="$(slot_row_json "$slot")"
	rstate="$(resolver_state "$row")"
	if [ "$rstate" != gone ]; then
		echo "herdr-swarm: slot $slot conflict resolver is $rstate — exit the agent in its pane (it should have committed), then conclude. If you know it stopped, HERDR_SWARM_RESOLVER_STOPPED=yes." >&2
		return "$HS_EC_REFUSED"
	fi
	if git -C "$CX_TREE" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
		if [ -n "$(git -C "$CX_TREE" ls-files -u)" ]; then
			echo "herdr-swarm: slot $slot still has conflicted files in $CX_TREE — resolve them, git add, and commit." >&2
		else
			echo "herdr-swarm: slot $slot conflicts are resolved but the merge is not committed — run git commit in $CX_TREE." >&2
		fi
		return "$HS_EC_REFUSED"
	fi
	if [ -n "$(git -C "$CX_TREE" status --porcelain)" ]; then
		echo "herdr-swarm: slot $slot merge tree has uncommitted changes beyond the merge commit — commit or discard them first; nothing outside the merge may ride along." >&2
		return "$HS_EC_REFUSED"
	fi
	head="$(git -C "$CX_TREE" rev-parse --verify 'HEAD^{commit}')" || return "$HS_EC_REFUSED"
	parents="$(git -C "$CX_TREE" rev-list --parents -n 1 "$head")" || return "$HS_EC_REFUSED"
	read -r _ p1 p2 extra <<<"$parents"
	if [ -z "$p2" ] || [ -n "$extra" ]; then
		echo "herdr-swarm: slot $slot merge tree HEAD $head is not a two-parent merge commit — it must conclude the merge in one commit (no extra commits, rebases, or octopus merges)." >&2
		return "$HS_EC_REFUSED"
	fi
	if [ "$p1" != "$CX_EXPECTED" ]; then
		echo "herdr-swarm: slot $slot merge commit's first parent $p1 is not the journaled base $CX_EXPECTED — refused." >&2
		return "$HS_EC_REFUSED"
	fi
	# The second parent must be EXACTLY the slot commit this merge started
	# with (journaled MERGE_HEAD) — the tip that was compared and validated —
	# never a newer slot commit swapped in by redoing the merge.
	if [ "$p2" != "$CX_TIP" ]; then
		echo "herdr-swarm: slot $slot merge commit's second parent $p2 is not the merged slot tip $CX_TIP — refused (a different slot commit was merged)." >&2
		return "$HS_EC_REFUSED"
	fi
	if [ "$mode" = apply ]; then
		if [ "$head" != "$want" ]; then
			echo "herdr-swarm: slot $slot merge tree HEAD is $head, not the reviewed $want — conclude again and review the new commit." >&2
			return "$HS_EC_DRIFT"
		fi
		journal_set "$slot" detached "$CX_EXPECTED" "$head" "$CX_TREE" "$CX_GENERATION" "$CX_TIP" || return 1
		IFS=$'\t' read -r rpane ragent <<<"$(printf '%s' "$row" | node -e '
			let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
				const v = JSON.parse(d)?.resolver; if (v) process.stdout.write([v.pane_id ?? "", v.agent_name ?? ""].join("\t"));
			});')"
		[ -z "$rpane" ] || report_slot_agent_state "$rpane" "$ragent" idle
		printf 'concluded\t%s\t%s\n' "$slot" "$head"
		return 0
	elif [ -n "$mode" ]; then
		echo "usage: harvest-step.sh conclude <slot> [apply <sha>]" >&2
		return 1
	fi
	printf 'conclude_ready\t%s\t%s\n' "$slot" "$head"
	# What the resolution changed BEYOND git's own automatic merge of the same
	# two commits: the conflicted files are expected to differ; anything else
	# is a change the slot never made and nobody compared. merge-tree prints
	# the automatic result's tree, then its conflicted paths.
	auto="$(git -C "$REPO_ROOT" merge-tree --write-tree --name-only --no-messages "$p1" "$p2" 2>/dev/null)"
	if [ -z "$auto" ]; then
		printf 'outside_conflict_unknown\t%s\n' "git merge-tree --write-tree is unavailable (git < 2.38)"
	else
		conflicted="$(printf '%s\n' "$auto" | tail -n +2)"
		while IFS= read -r path; do
			[ -n "$path" ] || continue
			printf '%s\n' "$conflicted" | grep -qxF -- "$path" || printf 'outside_conflict\t%s\n' "$path"
		done < <(git -C "$REPO_ROOT" diff --name-only "$(printf '%s\n' "$auto" | head -n 1)" "$head")
	fi
	git -C "$REPO_ROOT" diff --stat "$CX_EXPECTED" "$head" | sed $'s/^/stat\t/'
}

# resolve <slot>: hand a conflicted DETACHED merge to a resolver agent. Merges
# nothing — it only writes a brief into the merge tree and starts the agent
# beside the slot's own agent (split from the slot pane, into the merge tree).
# The agent's commit is then adopted by `conclude` and landed by `resume`,
# exactly like a human resolution. Preset: HERDR_SWARM_RESOLVER_PRESET, else
# the slot's own. Needs herdr 0.7.5+ (the pane-built start; 0.7.4's native
# start path was never verified against an existing conflicted tree).
do_resolve() {
	local slot="$1" v preset argv conflicted tip out pane term ws name patch row rstate
	local -a argv_arr
	read_slot "$slot" || return $?
	detached_conflict_context "$slot" || return $?
	if [ -n "$CX_MSHA" ]; then
		echo "herdr-swarm: slot $slot merge is already concluded ($CX_MSHA) — nothing left for a resolver." >&2
		return "$HS_EC_REFUSED"
	fi
	conflicted="$(git -C "$CX_TREE" diff --name-only --diff-filter=U)"
	if [ -z "$conflicted" ]; then
		echo "herdr-swarm: slot $slot merge tree has no conflicted files left — nothing to hand to a resolver (conclude it once committed)." >&2
		return "$HS_EC_REFUSED"
	fi
	v="$(herdr_version 2>/dev/null)" || v=""
	if [ -z "$v" ] || ! version_ge "$v" "0.7.5"; then
		echo "herdr-swarm: the conflict resolver needs Herdr 0.7.5 or newer (found ${v:-unknown}) — shell into the merge tree instead." >&2
		return "$HS_EC_REFUSED"
	fi
	row="$(slot_row_json "$slot")"
	rstate="$(resolver_state "$row")"
	if [ "$rstate" != gone ]; then
		echo "herdr-swarm: slot $slot already has a conflict resolver ($rstate) — wait for it, or exit it first." >&2
		return "$HS_EC_REFUSED"
	fi
	if [ -z "$SLOT_PANE" ]; then
		echo "herdr-swarm: slot $slot has no recorded pane to start the resolver beside." >&2
		return "$HS_EC_REFUSED"
	fi
	# Label is s<N>-<preset> (fan-out); its preset is the default resolver.
	preset="${HERDR_SWARM_RESOLVER_PRESET:-${SLOT_LABEL#s*-}}"
	argv="$(preset_argv "$preset")" || {
		echo "herdr-swarm: resolver preset '$preset' is unusable (set HERDR_SWARM_RESOLVER_PRESET)." >&2
		return "$HS_EC_REFUSED"
	}
	read -ra argv_arr <<<"$argv"
	command -v "${argv_arr[0]}" >/dev/null 2>&1 || {
		echo "herdr-swarm: resolver command '${argv_arr[0]}' is not on PATH." >&2
		return "$HS_EC_REFUSED"
	}
	tip="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/heads/$SLOT_BRANCH")" || tip="?"
	# The brief (scripts/resolver-brief.md, filled in) becomes the merge tree's
	# task file: excluded from git, skipped by the ignored-file inventory.
	# shellcheck disable=SC2016 # ${f} is a JS template literal, not bash
	node -e '
		const fs = require("fs");
		const [tpl, out, slotBranch, slotTip, baseBranch, baseSha, conflicted] = process.argv.slice(1);
		const vals = { SLOT_BRANCH: slotBranch, SLOT_TIP: slotTip, BASE_BRANCH: baseBranch, BASE_SHA: baseSha,
			CONFLICTED: conflicted.split("\n").filter(Boolean).map((f) => `- ${f}`).join("\n") };
		fs.writeFileSync(out, fs.readFileSync(tpl, "utf8").replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => vals[k] ?? m));
	' "$PLUGIN_ROOT/scripts/resolver-brief.md" "$CX_TREE/$SWARM_TASK_FILE" "$SLOT_BRANCH" "${tip:0:12}" \
		"$BASE_BRANCH" "${CX_EXPECTED:0:12}" "$conflicted" || return 1
	name="swarm-$RUN_ID-s$slot-resolve"
	out="$(herdr_agent_start "$name" --split-from "$SLOT_PANE" --cwd "$CX_TREE" --no-focus \
		--env "HERDR_SWARM_RUN_ID=$RUN_ID" --env "HERDR_SWARM_SLOT=$slot" -- "${argv_arr[@]}")" || {
		echo "herdr-swarm: could not start the resolver agent." >&2
		return 1
	}
	pane="$(parse_json_field pane_id "$out")"
	term="$(parse_json_field terminal_id "$out")"
	ws="$(parse_json_field workspace_id "$out")"
	# Without its pane, terminal, and workspace the resolver could never be
	# proven gone, and its merge tree would be stuck: say so now, not later.
	if [ -z "$pane" ] || [ -z "$term" ] || [ -z "$ws" ]; then
		echo "herdr-swarm: the resolver started, but its pane/terminal/workspace id came back empty — exit it by hand; its merge tree stays until HERDR_SWARM_RESOLVER_STOPPED=yes." >&2
	fi
	patch="$(node -e '
		const [pane, term, ws, name, cmd, gen] = process.argv.slice(1);
		process.stdout.write(JSON.stringify({ resolver: { pane_id: pane || null, terminal_id: term || null,
			workspace_id: ws || null, agent_name: name, agent_command: require("path").basename(cmd), generation: gen,
			started_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") } }));
	' "$pane" "$term" "$ws" "$name" "${argv_arr[0]}" "$CX_GENERATION")" || return 1
	manifest_update_slot "$slot" "$patch" || return 1
	printf 'resolver_started\t%s\t%s\n' "$slot" "$pane"
}

# validation_result_path <slot>: the one Swarm-produced checks file per slot.
# Latest run wins; the file carries its head_sha, so a result for an older
# commit reads as stale downstream rather than being trusted.
validation_result_path() {
	printf '%s/validation-%s-s%s.json\n' "$(state_dir)" "$RUN_ID" "$1"
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

# --- Dispatch ----------------------------------------------------------------

case "$VERB" in
preview)
	require_slot_arg "${1-}" || exit 1
	do_preview "$1"
	;;
commit-wip)
	require_slot_arg "${1-}" || exit 1
	do_commit_wip "$1"
	;;
snapshot)
	require_slot_arg "${1-}" || exit 1
	do_snapshot "$1"
	;;
discard)
	require_slot_arg "${1-}" || exit 1
	do_discard "$1"
	;;
skip)
	require_slot_arg "${1-}" || exit 1
	do_skip "$1"
	;;
merge)
	do_merge "${1-}" "${2-}" "${3-}"
	;;
resume)
	do_resume "${1-}" "${2-}"
	;;
archive)
	require_slot_arg "${1-}" || exit 1
	do_archive "$1"
	;;
abort-merge)
	require_slot_arg "${1-}" || exit 1
	do_abort_merge "$1"
	;;
publish)
	require_slot_arg "${1-}" || exit 1
	do_publish "$1"
	;;
publish-pr)
	require_slot_arg "${1-}" || exit 1
	do_publish_pr "$1"
	;;
publish-candidate-pr)
	require_slot_arg "${1-}" || exit 1
	do_publish_candidate_pr "$1"
	;;
candidate-status)
	require_slot_arg "${1-}" || exit 1
	do_candidate_status "$1"
	;;
pr-status)
	require_slot_arg "${1-}" || exit 1
	do_pr_status "$1"
	;;
validate)
	require_slot_arg "${1-}" || exit 1
	do_validate "$1"
	;;
settle)
	do_settle
	;;
compare)
	do_compare
	;;
broadcast)
	do_broadcast
	;;
resolve)
	require_slot_arg "${1-}" || exit 1
	do_resolve "$1"
	;;
conclude)
	require_slot_arg "${1-}" || exit 1
	do_conclude "$1" "${2-}" "${3-}"
	;;
*)
	echo "herdr-swarm: unknown harvest verb '$VERB'" >&2
	exit 1
	;;
esac
