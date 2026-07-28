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
#        discard <slot> | skip <slot> | merge <slot> <expected-base-sha> |
#        resume [complete <slot>] | archive <slot> | abort-merge <slot>
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
journal_set() {
	local slot="$1" locus="$2" expected="$3" merge_sha="$4" wt="$5" generation="${6-}" patch identity
	identity="$(repo_identity_json "$REPO_ROOT")" || return 1
	patch="$(node -e '
		const [locus,expected,mergeSha,wt,generation,identity,runId,slot]=process.argv.slice(1);
		const journal={locus,expected_base_sha:expected,merge_commit_sha:mergeSha||null,worktree:wt||null};
		if(locus==="detached") {
			const id=JSON.parse(identity);
			if(!generation) process.exit(2);
			journal.resource={type:"harvest",repo_key:id.repo_key,git_common_dir:id.git_common_dir,
				run_id:runId,slot,path:wt,generation,head:mergeSha||expected};
		}
		process.stdout.write(JSON.stringify({journal}));
	' "$locus" "$expected" "$merge_sha" "$wt" "$generation" "$identity" "$RUN_ID" "$slot")" || return 1
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
		git -C "$d" -c "core.hooksPath=$hooks_off" merge --no-ff -m "$msg" "$SLOT_BRANCH"
	else
		git -C "$d" merge --no-ff -m "$msg" "$SLOT_BRANCH"
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

do_merge() {
	require_slot_arg "${1-}" || return 1
	local expected="${2-}"
	if [ -z "$expected" ]; then
		echo "herdr-swarm: merge needs the previewed base SHA (drift guard input)" >&2
		return 1
	fi
	read_slot "$1" || return $?
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
		# classified for the renderer's distinct views.
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
	# agent, so archiving is allowed only when the agent is absent or idle.
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
	absent | idle) ;;
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
	do_merge "${1-}" "${2-}"
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
*)
	echo "herdr-swarm: unknown harvest verb '$VERB'" >&2
	exit 1
	;;
esac
