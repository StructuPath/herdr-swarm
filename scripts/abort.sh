#!/usr/bin/env bash
# abort.sh — abandon the active run, mid-flight or post-crash (U7 of
# docs/plans/2026-07-22-001). This is an ACTION: zero argv, no TTY, ZERO
# prompts — every decision must resolve non-interactively. Anything that
# would need a prompt (dirty worktree, un-swapped merge commit, MERGE_HEAD
# in the user's tree) is KEPT and reported instead, never asked about.
#
# Ownership before destruction (KTD): only manifest-tracked resources plus
# panes matching this plugin's own pane titles are touched; removal is never
# --force (R11 — the wrapper refuses it anyway); branches are NEVER deleted
# here — teardown is decoupled from branch deletion (R10; prune owns it).
set -uo pipefail

PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck source=scripts/preflight.sh
. "$PLUGIN_ROOT/scripts/preflight.sh" # sources lib.sh; provides report_only_discovery + remove_exclude_pattern

require_node || exit 1

# R13 intersection call: above the max tested version this warns and proceeds
# — abort is mostly git and must keep working on a herdr this plugin has not
# been exercised against. Never fatal (|| true): a herdr whose version cannot
# even be read must not strand a run the user is trying to abandon.
version_gate intersection || true

# Distinct nonzero exit for "aborted, but work was deliberately KEPT": the run
# is still ACTIVE and the caller must not treat this as a clean teardown.
ABORT_EC_KEPT=4

closed=0 removed=0 kept=0 gone=0 branches_remaining=0 failures=0
# Human-readable inventory of everything KEPT — printed with the ACTIVE-run
# notice below, because the summary counter alone does not say WHERE the work
# survived.
kept_paths=""
note_kept() {
	kept=$((kept + 1))
	kept_paths="$kept_paths  $1"$'\n'
}
note_failure() {
	failures=$((failures + 1))
	echo "herdr-swarm: abort bookkeeping failure — $1" >&2
}

# Always printed — success, refusal, corrupt, nothing-to-do (R11: cleanup
# always reports what was closed/removed/kept; sibling close.sh convention).
print_summary() {
	echo "herdr-swarm: abort summary — panes closed $closed, worktrees removed $removed, kept $kept, already gone $gone, swarm branches remaining $branches_remaining (branches are deleted only by prune — R10)."
}

# The workspace manifest is a repository-discovery hint only. Select the exact
# live generation across aliases while holding the physical-repository lock.
US=$'\x1f'
REPO_HINT="$(discover_live_repo 2>/dev/null || true)"
if [ -z "$REPO_HINT" ]; then
	echo "herdr-swarm: no active swarm run for this repository — nothing to abort."
	print_summary
	exit 0
fi
SWARM_REPO="$REPO_HINT"
export SWARM_REPO
MUTATION_LOCK="$(repo_mutation_lock_name "$REPO_HINT")" || exit 1
acquire_lock "$MUTATION_LOCK" || exit 1
trap 'release_lock "$MUTATION_LOCK"' EXIT
rc=0
bind_live_manifest_locked "$REPO_HINT" || rc=$?
case "$rc" in
0) ;;
"$MANIFEST_EC_MISSING")
	echo "herdr-swarm: no active swarm run for this repository — nothing to abort."
	print_summary
	exit 0
	;;
*)
	echo "herdr-swarm: repository live-run bookkeeping is unknown — abort REFUSES all destruction." >&2
	echo "herdr-swarm: report-only discovery — what an abort WOULD act on:"
	report_only_discovery | while IFS=$'\t' read -r kind a b; do
		case "$kind" in
		branch) echo "  branch   $a (kept either way — abort never deletes branches)" ;;
		worktree) echo "  worktree $a ($b)" ;;
		pane) echo "  pane     $a ($b)" ;;
		esac
	done
	print_summary
	exit "$rc"
	;;
esac
DOC="$(manifest_read)" || {
	rc=$?
	echo "herdr-swarm: exact live manifest is unreadable — abort REFUSES all destruction." >&2
	print_summary
	exit "$rc"
}

# --- Run context -------------------------------------------------------------
CTX="$(manifest_run_context "$DOC")" || {
	echo "herdr-swarm: manifest has no usable run_id/repo_root — abort refused." >&2
	print_summary
	exit 1
}
# Field 4 (fork_sha) is ignored: teardown never needs the fork point.
IFS="$US" read -r RUN_ID REPO_ROOT BASE_REF _ <<<"$CTX"
# run_id is interpolated into state-dir paths (harvest-worktree glob, archive
# name) — charset-restrict at the edge (ownership KTD: rm -rf-class inputs
# never pass unvalidated).
if ! run_id_safe="$(sanitize_slug "$RUN_ID")" || [ "$run_id_safe" != "$RUN_ID" ]; then
	echo "herdr-swarm: manifest run_id '$RUN_ID' fails the path charset — abort refused." >&2
	print_summary
	exit 1
fi

SWARM_REPO="$REPO_ROOT"
export SWARM_REPO

# --- Optional read-only cleanup preview -------------------------------------
# Preview inventories every owned slot and exits before pane close, worktree
# removal, manifest update, exclude edit, or archival. One operation id is
# expanded per slot so each approval is exact and one-use.
if [ "${HERDR_SWARM_ABORT_PREVIEW:-}" = "yes" ]; then
	PREVIEW_BASE="${HERDR_SWARM_CLEANUP_OPERATION_ID:-$(cleanup_operation_id)}"
	printf '%s' "$DOC" | node -e '
		let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
			for(const s of JSON.parse(d).slots||[]) if(s.status!=="archived")
				console.log([s.slot,s.branch??"",s.path??""].join("\x1f"));
		});
	' | while IFS="$US" read -r pslot pbranch ppath; do
		[ -n "$pslot" ] && [ -n "$ppath" ] && [ -d "$ppath" ] || continue
		if verify_slot_ownership "$RUN_ID" "$pbranch" "$ppath" >/dev/null; then
			pinv="$(slot_ignored_inventory "$REPO_ROOT" "$RUN_ID" "$pslot" "$ppath" "$PREVIEW_BASE-s$pslot")" || exit 1
			print_cleanup_inventory "$pinv"
		fi
	done
	printf '%s' "$DOC" | node -e '
		let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
			for(const s of JSON.parse(d).slots||[]) {
				const j=s.journal;
				if(j?.locus==="detached"&&j.worktree)
					console.log([s.slot,j.worktree,JSON.stringify(j)].join("\x1f"));
			}
		});
	' | while IFS="$US" read -r pslot ppath pjournal; do
		[ -d "$ppath" ] || continue
		if verify_harvest_resource "$RUN_ID" "$pslot" "$ppath" "$pjournal" >/dev/null; then
			pinv="$(harvest_ignored_inventory "$REPO_ROOT" "$RUN_ID" "$pslot" "$ppath" "$pjournal" "$PREVIEW_BASE-hs$pslot")" || exit 1
			print_cleanup_inventory "$pinv"
		fi
	done
	echo "herdr-swarm: abort cleanup preview only — zero resources removed."
	print_summary
	exit 0
fi

# --- (1) Panes: tracked records first, then the label sweep ------------------

closed_ids=" " # space-delimited seen-set: the pidfile pane usually reappears in the sweep
close_pane() {
	# Nonzero on duplicate or failed close so callers only report real closes.
	case "$closed_ids" in *" $1 "*) return 1 ;; esac
	herdr_pane_close "$1" >/dev/null 2>&1 || return 1
	closed=$((closed + 1))
	closed_ids="$closed_ids$1 "
}

# Tracked plugin panes (status.sh / harvest.sh record their pane ids for
# exactly this sweep). Close unconditionally — a dead pane just fails the
# close, which is fine; the stale record is dropped either way.
for kind in status harvest; do
	pf="$(state_dir)/$kind-pane-$(ws_id)"
	[ -f "$pf" ] || continue
	pid="$(cat "$pf" 2>/dev/null || true)"
	if [ -n "$pid" ]; then
		close_pane "$pid" || true
	fi
	rm -f "$pf"
done

# Label sweep, scoped to this workspace and this plugin's three pane titles —
# reuses report_only_discovery's matching (preflight.sh) so the sweep and the
# corrupt-manifest report can never disagree about what counts as ours. Its git
# side targets SWARM_REPO (pinned above), so no cwd juggling is needed.
while IFS=$'\t' read -r kind pid label; do
	if [ "$kind" = "pane" ] && [ -n "$pid" ]; then
		close_pane "$pid" && echo "herdr-swarm: closed pane $pid ($label)"
	fi
done <<<"$(report_only_discovery 2>/dev/null || true)"

# --- (2) Slot worktrees + (4) harvest worktrees ------------------------------

# One line per slot that still has ordinary resources to reap, plus archived
# rows carrying an exact detached journal from an older interrupted cleanup.
# New cleanups defer terminal slot archival until detached generation removal
# succeeds, but retaining the archived+journal case keeps old recovery state
# reachable instead of demoting it to an unauthenticated leftover.
SLOT_LINES="$(printf '%s' "$DOC" | node -e '
	let d = "";
	process.stdin.on("data", (c) => (d += c)).on("end", () => {
		for (const s of JSON.parse(d).slots || []) {
			const j = s.journal || {};
			if (s.status === "archived" && j.locus !== "detached") continue;
			console.log([s.slot, s.status ?? "", s.branch ?? "", s.path ?? "",
				s.workspace_id ?? "", j.locus ?? "", j.merge_commit_sha ?? "",
				j.worktree ?? "", JSON.stringify(s.journal ?? null)].join("\x1f"));
		}
	});
')"

reap_slot_worktree() {
	local slot="$1" branch="$2" wtpath="$3" wsid="$4" defer_archive="$5" wt="" herdr_ok=0 why operation inventory count used rechecked before_digest after_digest
	# Ownership before destruction, same shared verifier harvest-step.sh's
	# read_slot uses (lib.sh) — the third instance of the drift pattern in
	# docs/solutions/best-practices/cross-script-invariant-drift.md, closed in
	# one helper instead of two hand-copied checks. Abort's posture differs on
	# purpose: a mismatch KEEPS the worktree and reports it rather than
	# refusing the run, because abort never destroys what it cannot verify and
	# the rest of the teardown (panes, other slots, the branch inventory) is
	# still worth doing.
	#
	# The branch is checked FIRST, alone: it drives the reconciliation lookup
	# below, so a foreign branch name must never even be used to find a path.
	if ! why="$(verify_slot_ownership "$RUN_ID" "$branch" "")"; then
		echo "herdr-swarm: slot $slot KEPT — ownership check failed: $why. Nothing was removed for this slot." >&2
		note_kept "slot $slot (ownership check failed: $why)"
		return 0
	fi
	if [ -n "$wtpath" ] && [ -d "$wtpath" ]; then
		wt="$wtpath"
	elif [ -n "$branch" ]; then
		# Reconcile by run-unique branch name: a crash between `worktree
		# create` returning and the path being recorded leaves a null-path
		# pending row whose worktree is findable only this way. Porcelain
		# parse, not positional fields — paths may contain spaces.
		wt="$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | awk -v ref="branch refs/heads/$branch" '
			/^worktree /{p=substr($0,10)} $0==ref{print p; exit}')"
	fi
	if [ -z "$wt" ] || [ ! -d "$wt" ]; then
		# Nothing on disk: prune stale registrations (a manually deleted path
		# would otherwise read as a live worktree forever) and settle the row.
		git -C "$REPO_ROOT" worktree prune 2>/dev/null || true
		echo "herdr-swarm: slot $slot: worktree already gone."
		gone=$((gone + 1))
		slot_reaped=1
		if [ "$defer_archive" != "yes" ]; then
			manifest_update_slot "$slot" '{"status":"archived"}' ||
				note_failure "slot $slot was already gone but could not be marked archived"
		fi
		return 0
	fi
	# Re-verify the RESOLVED path, whichever route produced it. The
	# reconciliation branch above already pairs by branch, but the recorded-path
	# branch does not — and a second call through the same helper is cheaper
	# than two routes that have to agree by inspection.
	if ! why="$(verify_slot_ownership "$RUN_ID" "$branch" "$wt")"; then
		echo "herdr-swarm: slot $slot KEPT — ownership check failed: $why. The worktree was left untouched." >&2
		note_kept "slot $slot worktree $wt (ownership check failed: $why)"
		return 0
	fi
	if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
		# Dirty is KEPT, never prompted (no TTY) and never forced (R11); the
		# commit/skip/discard flow belongs to harvest (R9), not abort.
		echo "herdr-swarm: slot $slot KEPT — uncommitted work in $wt (its agent, if alive, is still running; use Harvest to commit-WIP/skip/discard, then abort again)." >&2
		note_kept "slot $slot worktree $wt (uncommitted work)"
		return 0
	fi
	operation="$(printf '%s' "${HERDR_SWARM_CLEANUP_APPROVAL:-}" | node -e '
		let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d);if(a.operation_id)process.stdout.write(String(a.operation_id));}catch{}});
	')"
	[ -n "$operation" ] || operation="$(cleanup_operation_id)" || return 1
	inventory="$(slot_ignored_inventory "$REPO_ROOT" "$RUN_ID" "$slot" "$wt" "$operation")" || {
		note_kept "slot $slot worktree $wt (ignored inventory failed)"
		return 0
	}
	count="$(cleanup_inventory_count "$inventory")" || return 1
	if [ "$count" -gt 0 ]; then
		used="$(cleanup_approval_validate "$inventory")" || {
			print_cleanup_inventory "$inventory"
			echo "herdr-swarm: slot $slot KEPT — ignored files require the exact one-use cleanup approval emitted by preview." >&2
			note_kept "slot $slot worktree $wt (ignored files; cleanup digest not approved)"
			return 0
		}
	fi
	if [ -n "${HERDR_SWARM_TEST_PAUSE_BEFORE_CLEANUP_RECHECK:-}" ]; then sleep "$HERDR_SWARM_TEST_PAUSE_BEFORE_CLEANUP_RECHECK"; fi
	if ! why="$(verify_slot_ownership "$RUN_ID" "$branch" "$wt")"; then
		echo "herdr-swarm: slot $slot KEPT — ownership changed immediately before removal: $why." >&2
		note_kept "slot $slot worktree $wt (ownership changed before removal)"
		return 0
	fi
	rechecked="$(slot_ignored_inventory "$REPO_ROOT" "$RUN_ID" "$slot" "$wt" "$operation")" || {
		note_kept "slot $slot worktree $wt (ignored inventory recheck failed)"
		return 0
	}
	before_digest="$(printf '%s' "$inventory" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).digest))')"
	after_digest="$(printf '%s' "$rechecked" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).digest))')"
	if [ "$before_digest" != "$after_digest" ]; then
		print_cleanup_inventory "$rechecked"
		echo "herdr-swarm: slot $slot KEPT — cleanup inventory changed after preview; zero removal performed." >&2
		note_kept "slot $slot worktree $wt (cleanup inventory changed)"
		return 0
	fi
	if [ "$count" -gt 0 ]; then
		cleanup_approval_consume "$used" || {
			note_kept "slot $slot worktree $wt (cleanup approval already consumed)"
			return 0
		}
	fi
	if [ -n "$wsid" ]; then
		# The one-shot verb IS the stop mechanism here (spike (a)): it kills
		# the agent, closes the grouped workspace, and removes the worktree.
		if herdr_worktree_remove --workspace "$wsid" >/dev/null 2>&1; then
			herdr_ok=1
		else
			echo "herdr-swarm: slot $slot: Herdr removal refused (stale workspace id after a restart?) — falling back to plain git." >&2
		fi
	fi
	if [ -d "$wt" ]; then
		# Verify-then-fallback: trust the verb only as far as the disk agrees.
		if git -C "$REPO_ROOT" worktree remove "$wt" >/dev/null 2>&1; then
			if [ -n "$wsid" ] && [ "$herdr_ok" -eq 0 ]; then
				# Fallback path only: close the workspace ourselves (its close
				# cascade also kills a surviving agent — spike (b)); best-effort
				# because the workspace may already be gone with the server state.
				herdr_workspace_close "$wsid" >/dev/null 2>&1 || true
			fi
		else
			echo "herdr-swarm: slot $slot KEPT — git worktree remove refused for $wt (never --force, R11); inspect by hand." >&2
			note_kept "slot $slot worktree $wt (removal refused)"
			return 0
		fi
	fi
	removed=$((removed + 1))
	slot_reaped=1
	echo "herdr-swarm: slot $slot: removed worktree $wt (branch $branch kept — prune deletes merged branches)."
	if [ "$defer_archive" != "yes" ]; then
		manifest_update_slot "$slot" '{"status":"archived"}' ||
			note_failure "slot $slot was removed but could not be marked archived"
	fi
}

handled_hwts=" " # journaled harvest worktrees, so the leftover glob below skips them

# A harvest worktree with unmerged index entries is a LIVE conflict-resolution
# session: the harvest pane holds no mutation lock while the user edits
# conflicted files (that can take minutes), so `git merge --abort` here would
# hard-reset work in progress. Unmerged paths present => hands off entirely.
harvest_wt_in_conflict() {
	[ -n "$(git -C "$1" ls-files -u 2>/dev/null)" ]
}
reap_harvest_worktree() {
	local slot="$1" jmsha="$2" jwt="$3" journal="$4" archive_after="$5" cur cleanup_rc=0
	[ -n "$jwt" ] || return 0
	handled_hwts="$handled_hwts$jwt "
	if [ ! -d "$jwt" ]; then
		# A crash may occur after verified removal but before journal clear. No
		# deletion is attempted; settle the exact slot update strictly.
		if [ "$archive_after" = "1" ]; then
			manifest_update_slot "$slot" '{"status":"archived","journal":null}' || note_failure "slot $slot harvest resource was absent but its journal/final status could not be settled"
		else
			manifest_update_slot "$slot" '{"journal":null}' || note_failure "slot $slot harvest resource was absent but its journal could not be cleared"
		fi
		return 0
	fi
	cur="$(git -C "$REPO_ROOT" rev-parse --verify "$BASE_REF^{commit}" 2>/dev/null || true)"
	if [ -n "$jmsha" ] && [ "$cur" != "$jmsha" ]; then
		echo "herdr-swarm: slot $slot has UN-SWAPPED merge commit $jmsha in $jwt — KEPT for recovery." >&2
		note_kept "harvest worktree $jwt (un-swapped merge commit $jmsha)"
		return 0
	fi
	if harvest_wt_in_conflict "$jwt"; then
		echo "herdr-swarm: slot $slot has a LIVE conflict resolution in $jwt — KEPT untouched." >&2
		note_kept "harvest worktree $jwt (live conflict resolution)"
		return 0
	fi
	if ! verify_harvest_resource "$RUN_ID" "$slot" "$jwt" "$journal" >/dev/null; then
		echo "herdr-swarm: slot $slot harvest resource identity FAILED — KEPT untouched." >&2
		note_kept "harvest worktree $jwt (exact resource identity failed)"
		return 0
	fi
	if [ -z "$jmsha" ]; then
		# Verification precedes merge --abort because it resets tracked state.
		git -C "$jwt" merge --abort >/dev/null 2>&1 || true
	fi
	remove_harvest_resource "$RUN_ID" "$slot" "$jwt" "$journal" || cleanup_rc=$?
	if [ "$cleanup_rc" -ne 0 ]; then
		echo "herdr-swarm: KEPT harvest worktree $jwt (exact cleanup refused or needs approval)." >&2
		note_kept "harvest worktree $jwt (cleanup refused or approval required)"
		return 0
	fi
	removed=$((removed + 1))
	echo "herdr-swarm: removed harvest worktree $jwt."
	if [ "$archive_after" = "1" ]; then
		manifest_update_slot "$slot" '{"status":"archived","journal":null}' || note_failure "slot $slot harvest worktree was removed but its journal/final status update failed"
	else
		manifest_update_slot "$slot" '{"journal":null}' || note_failure "slot $slot harvest worktree was removed but journal clear failed"
	fi
}

while IFS="$US" read -r slot slot_status branch wtpath wsid jlocus jmsha jwt journal; do
	[ -n "$slot" ] || continue
	slot_reaped=0
	defer_archive=no
	[ "$jlocus" = "detached" ] && defer_archive=yes
	if [ "$slot_status" = "archived" ]; then
		# Recovery compatibility for the old broken transition: the ordinary
		# slot resource was already declared gone, but its exact harvest journal
		# remains authoritative and must stay reachable.
		slot_reaped=1
	else
		reap_slot_worktree "$slot" "$branch" "$wtpath" "$wsid" "$defer_archive"
	fi
	# Only the detached locus owns a plugin worktree; the user-tree locus
	# journals the USER's checkout, which abort never touches (MERGE_HEAD
	# detection below is the only user-tree interaction, and it is read-only).
	if [ "$jlocus" = "detached" ]; then
		reap_harvest_worktree "$slot" "$jmsha" "$jwt" "$journal" "$slot_reaped"
	fi
done <<<"$SLOT_LINES"

# A harvest-looking path with no exact live journal has no generation/HEAD/
# slot ownership proof. Route it through the shared verifier, which must fail,
# and quarantine it in place rather than resurrecting the old prefix-only rm.
for d in "$(state_dir)"/harvest-"$RUN_ID"-s*; do
	[ -d "$d" ] || continue
	case "$handled_hwts" in *" $d "*) continue ;; esac
	if verify_harvest_resource "$RUN_ID" "0" "$d" "null" >/dev/null 2>&1; then
		echo "herdr-swarm: internal error: unjournaled harvest resource unexpectedly verified — KEPT." >&2
	else
		echo "herdr-swarm: KEPT leftover harvest-looking worktree $d — no exact live resource journal owns it." >&2
	fi
	note_kept "leftover harvest-looking worktree $d (unresolved generation ownership)"
done

# --- (5) MERGE_HEAD in the user's tree: offer, never run ---------------------
# No prompts and no mutation of the user's checkout — print the exact command
# and leave the decision (and the residual state) to the user (R8 recovery).
ugit="$(git -C "$REPO_ROOT" rev-parse --absolute-git-dir 2>/dev/null || true)"
if [ -n "$ugit" ] && [ -e "$ugit/MERGE_HEAD" ]; then
	echo "herdr-swarm: a merge is IN PROGRESS in your tree at $REPO_ROOT — abort never runs this for you. To abandon that merge, run:"
	echo "  git -C $REPO_ROOT merge --abort"
fi

# --- (6) Exclude pattern -----------------------------------------------------
# Only when NOTHING was kept: a kept worktree still holds its $SWARM_TASK_FILE,
# and the exclude file is shared repo-wide — dropping the pattern would make
# that file visible to `git status` in the kept worktree and committable into
# history. The pattern is idempotent to re-add and removed by the next clean
# abort, so leaving it is the cheap side of the trade.
# remove_exclude_pattern resolves --git-path through repo_git, so it lands in
# SWARM_REPO's exclude file regardless of abort's own cwd.
if [ "$kept" -eq 0 ] && [ "$failures" -eq 0 ]; then
	remove_exclude_pattern || {
		note_failure "could not remove the $SWARM_TASK_FILE exclude pattern"
	}
else
	echo "herdr-swarm: kept the $SWARM_TASK_FILE exclude pattern — kept worktrees still contain that file, and un-excluding it would expose it to git status."
fi

# --- (3) Branch inventory: list-only, never deleted (R10) --------------------
# Includes branches leaked by errored creates (spike (d): a failed create can
# leave its new branch behind with no rollback).
blist="$(git -C "$REPO_ROOT" for-each-ref --format='%(refname:short)' 'refs/heads/swarm' 2>/dev/null || true)"
if [ -n "$blist" ]; then
	branches_remaining="$(printf '%s\n' "$blist" | grep -c .)"
	echo "herdr-swarm: swarm branches remaining (kept — run Prune to delete fully-merged ones):"
	printf '%s\n' "$blist" | sed 's/^/  /'
fi

# --- (7) Archive the manifest ------------------------------------------------
# Archiving is for a run that is FINISHED. Anything KEPT above is live work,
# and the recovery route abort itself prints — Harvest — reads the LIVE
# manifest at $(manifest_path); archiving it would leave the kept worktrees
# unreachable through the tool that is supposed to rescue them. So when
# kept > 0 the manifest stays exactly where it is and the run stays ACTIVE.
if [ "$failures" -gt 0 ]; then
	echo "herdr-swarm: run $RUN_ID stays ACTIVE — $failures authoritative slot/bookkeeping update(s) failed after cleanup; Abort is incomplete." >&2
	print_summary
	exit 1
fi
if [ "$kept" -gt 0 ]; then
	echo "herdr-swarm: run $RUN_ID stays ACTIVE — $kept item(s) were KEPT and the manifest is NOT archived, so Harvest can still reach them:"
	printf '%s' "$kept_paths"
	echo "herdr-swarm: resolve them (Harvest: commit-WIP / skip / discard, or finish the merge), then run Abort again to finish teardown."
	print_summary
	exit "$ABORT_EC_KEPT"
fi

# Abort requires a complete slot set and the exact immutable archive. Partial
# Harvest's benign no-op finalization mode is explicitly not accepted here.
if ! final_out="$(finalize_run "$REPO_ROOT" "$RUN_ID" require-complete)"; then
	echo "herdr-swarm: abort cleanup finished but run finalization/archive FAILED; the run remains recoverable and this abort is incomplete." >&2
	print_summary
	exit 1
fi
[ -n "$final_out" ] && printf '%s\n' "$final_out"
if ! exact_run_archive_exists "$RUN_ID"; then
	echo "herdr-swarm: abort finalization did not leave the exact completed archive; Abort is incomplete." >&2
	print_summary
	exit 1
fi

print_summary
exit 0
