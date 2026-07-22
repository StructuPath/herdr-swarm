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

closed=0 removed=0 kept=0 gone=0 branches_remaining=0
# Human-readable inventory of everything KEPT — printed with the ACTIVE-run
# notice below, because the summary counter alone does not say WHERE the work
# survived.
kept_paths=""
note_kept() {
	kept=$((kept + 1))
	kept_paths="$kept_paths  $1"$'\n'
}

# Always printed — success, refusal, corrupt, nothing-to-do (R11: cleanup
# always reports what was closed/removed/kept; sibling close.sh convention).
print_summary() {
	echo "herdr-swarm: abort summary — panes closed $closed, worktrees removed $removed, kept $kept, already gone $gone, swarm branches remaining $branches_remaining (branches are deleted only by prune — R10)."
}

# The same per-repo mutation lock fan-out, harvest verbs, and prune contend
# on: an abort must never reap a worktree mid-merge (destructive-surface KTD).
acquire_lock "mutate-$(ws_id)" || exit 1
trap 'release_lock "mutate-$(ws_id)"' EXIT

rc=0
DOC="$(manifest_read)" || rc=$?
case "$rc" in
0) ;;
"$MANIFEST_EC_MISSING")
	echo "herdr-swarm: no active swarm run for this workspace ($(manifest_path)) — nothing to abort."
	print_summary
	exit 0
	;;
"$MANIFEST_EC_CORRUPT")
	# manifest_read already printed the .bak hint on stderr. Unknown state
	# must never be guess-deleted: degrade to report-only discovery (U3
	# fallback), refuse ALL destruction, and exit the distinct corrupt code
	# so a caller can branch without string-matching.
	echo "herdr-swarm: manifest is CORRUPT — abort REFUSES all destruction. Restore the manifest (see the .bak hint above) and re-run." >&2
	echo "herdr-swarm: report-only discovery — what an abort WOULD act on:"
	report_only_discovery | while IFS=$'\t' read -r kind a b; do
		case "$kind" in
		branch) echo "  branch   $a (kept either way — abort never deletes branches)" ;;
		worktree) echo "  worktree $a ($b)" ;;
		pane) echo "  pane     $a ($b)" ;;
		esac
	done
	print_summary
	exit "$MANIFEST_EC_CORRUPT"
	;;
*)
	echo "herdr-swarm: could not read the manifest (exit $rc) — abort refused." >&2
	print_summary
	exit "$rc"
	;;
esac

# --- Run context -------------------------------------------------------------
# \x1f-separated fields from the shared extractor (see lib.sh for why tab
# would silently shift nullable columns). The guard is the extractor's; the
# refusal wording is ours.
US=$'\x1f'
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
# corrupt-manifest report can never disagree about what counts as ours. The
# subshell cd gives discovery's git side the repo cwd it assumes.
while IFS=$'\t' read -r kind pid label; do
	if [ "$kind" = "pane" ] && [ -n "$pid" ]; then
		close_pane "$pid" && echo "herdr-swarm: closed pane $pid ($label)"
	fi
done <<<"$( (cd "$REPO_ROOT" && report_only_discovery) 2>/dev/null || true)"

# --- (2) Slot worktrees + (4) harvest worktrees ------------------------------

# One line per non-archived slot (pending/running/failed/settled/merged/
# skipped — abort over-approximates; the archived filter is the only one).
SLOT_LINES="$(printf '%s' "$DOC" | node -e '
	let d = "";
	process.stdin.on("data", (c) => (d += c)).on("end", () => {
		for (const s of JSON.parse(d).slots || []) {
			if (s.status === "archived") continue;
			const j = s.journal || {};
			console.log([s.slot, s.branch ?? "", s.path ?? "", s.workspace_id ?? "",
				j.locus ?? "", j.merge_commit_sha ?? "", j.worktree ?? ""].join("\x1f"));
		}
	});
')"

reap_slot_worktree() {
	local slot="$1" branch="$2" wtpath="$3" wsid="$4" wt="" herdr_ok=0
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
		manifest_update_slot "$slot" '{"status":"archived"}' 2>/dev/null || true
		return 0
	fi
	if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
		# Dirty is KEPT, never prompted (no TTY) and never forced (R11); the
		# commit/skip/discard flow belongs to harvest (R9), not abort.
		echo "herdr-swarm: slot $slot KEPT — uncommitted work in $wt (its agent, if alive, is still running; use Harvest to commit-WIP/skip/discard, then abort again)." >&2
		note_kept "slot $slot worktree $wt (uncommitted work)"
		return 0
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
	echo "herdr-swarm: slot $slot: removed worktree $wt (branch $branch kept — prune deletes merged branches)."
	manifest_update_slot "$slot" '{"status":"archived"}' 2>/dev/null || true
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
	local slot="$1" jmsha="$2" jwt="$3" cur
	[ -n "$jwt" ] || return 0
	handled_hwts="$handled_hwts$jwt "
	cur="$(git -C "$REPO_ROOT" rev-parse --verify "$BASE_REF^{commit}" 2>/dev/null || true)"
	if [ -n "$jmsha" ] && [ "$cur" != "$jmsha" ]; then
		# The abort-merge rule, reused: a worktree holding an un-swapped merge
		# commit is that commit's only obvious anchor — report the SHA loudly
		# and keep it (plan risk: never silently unreachable, never auto-deleted).
		echo "herdr-swarm: slot $slot has UN-SWAPPED merge commit $jmsha in $jwt — KEPT for recovery (reopen Harvest to resume the swap, or recover by hand)." >&2
		note_kept "harvest worktree $jwt (un-swapped merge commit $jmsha)"
		return 0
	fi
	if [ -d "$jwt" ] && harvest_wt_in_conflict "$jwt"; then
		# Checked BEFORE the journal is cleared: the conflict resolution the
		# user is in the middle of still belongs to that journaled merge.
		echo "herdr-swarm: slot $slot has a LIVE conflict resolution in $jwt (unmerged paths present) — KEPT untouched; finish or abandon it in Harvest." >&2
		note_kept "harvest worktree $jwt (live conflict resolution)"
		return 0
	fi
	if [ -n "$jmsha" ]; then
		# Base already equals the journaled commit: the swap landed before the
		# crash and only bookkeeping is missing (same as resume_completed).
		manifest_update_slot "$slot" '{"status":"merged","journal":null}' 2>/dev/null || true
	else
		manifest_update_slot "$slot" '{"journal":null}' 2>/dev/null || true
	fi
	if [ -d "$jwt" ]; then
		# May be mid-conflict or clean — merge --abort is best-effort, then a
		# no-force removal; a refusal keeps it and says so.
		git -C "$jwt" merge --abort >/dev/null 2>&1 || true
		if git -C "$REPO_ROOT" worktree remove "$jwt" >/dev/null 2>&1; then
			removed=$((removed + 1))
			echo "herdr-swarm: removed harvest worktree $jwt."
		else
			echo "herdr-swarm: KEPT harvest worktree $jwt (removal refused; inspect by hand)." >&2
			note_kept "harvest worktree $jwt (removal refused)"
		fi
	fi
}

while IFS="$US" read -r slot branch wtpath wsid jlocus jmsha jwt; do
	[ -n "$slot" ] || continue
	reap_slot_worktree "$slot" "$branch" "$wtpath" "$wsid"
	# Only the detached locus owns a plugin worktree; the user-tree locus
	# journals the USER's checkout, which abort never touches (MERGE_HEAD
	# detection below is the only user-tree interaction, and it is read-only).
	if [ "$jlocus" = "detached" ]; then
		reap_harvest_worktree "$slot" "$jmsha" "$jwt"
	fi
done <<<"$SLOT_LINES"

# Leftover harvest worktrees whose journal was already cleared (crash between
# journal_clear and removal). Guard even here: a HEAD that is not an ancestor
# of base could be an un-swapped merge commit the bookkeeping lost — keep it.
for d in "$(state_dir)"/harvest-"$RUN_ID"-s*; do
	[ -d "$d" ] || continue
	case "$handled_hwts" in *" $d "*) continue ;; esac
	head_sha="$(git -C "$d" rev-parse --verify HEAD 2>/dev/null || true)"
	if [ -n "$head_sha" ] && ! git -C "$REPO_ROOT" merge-base --is-ancestor "$head_sha" "$BASE_REF" 2>/dev/null; then
		echo "herdr-swarm: KEPT leftover harvest worktree $d — its HEAD $head_sha is not on $BASE_REF (possible un-swapped merge commit)." >&2
		note_kept "leftover harvest worktree $d (HEAD $head_sha not on $BASE_REF)"
		continue
	fi
	# Same live-conflict hazard as the journaled path: a mid-conflict merge
	# leaves HEAD at base (no merge commit yet), so the ancestry guard above
	# passes and only the unmerged-index check catches it.
	if harvest_wt_in_conflict "$d"; then
		echo "herdr-swarm: KEPT leftover harvest worktree $d — LIVE conflict resolution in progress (unmerged paths present)." >&2
		note_kept "leftover harvest worktree $d (live conflict resolution)"
		continue
	fi
	git -C "$d" merge --abort >/dev/null 2>&1 || true
	if git -C "$REPO_ROOT" worktree remove "$d" >/dev/null 2>&1; then
		removed=$((removed + 1))
		echo "herdr-swarm: removed leftover harvest worktree $d."
	else
		echo "herdr-swarm: KEPT leftover harvest worktree $d (removal refused)." >&2
		note_kept "leftover harvest worktree $d (removal refused)"
	fi
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
# Bare git in remove_exclude_pattern resolves --git-path from cwd; subshell cd
# keeps abort's own cwd (and any caller assumptions) untouched.
if [ "$kept" -eq 0 ]; then
	(cd "$REPO_ROOT" && remove_exclude_pattern) ||
		echo "herdr-swarm: warning: could not remove the $SWARM_TASK_FILE exclude pattern." >&2
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
if [ "$kept" -gt 0 ]; then
	echo "herdr-swarm: run $RUN_ID stays ACTIVE — $kept item(s) were KEPT and the manifest is NOT archived, so Harvest can still reach them:"
	printf '%s' "$kept_paths"
	echo "herdr-swarm: resolve them (Harvest: commit-WIP / skip / discard, or finish the merge), then run Abort again to finish teardown."
	print_summary
	exit "$ABORT_EC_KEPT"
fi

# Rename, never delete: the archived manifest is the recovery record (and
# prune's source for recorded base refs). The .bak follows its manifest.
mf="$(manifest_path)"
arch="$(state_dir)/archived-$RUN_ID.json"
# run_id contains a timestamp+nonce, so a collision means a re-abort of the
# same recovered run — keep both generations rather than clobbering.
[ -e "$arch" ] && arch="$(state_dir)/archived-$RUN_ID.$$.json"
if mv "$mf" "$arch" 2>/dev/null; then
	if [ -f "$mf.bak" ]; then
		mv "$mf.bak" "$arch.bak" 2>/dev/null || true
	fi
	echo "herdr-swarm: manifest archived to $arch."
else
	echo "herdr-swarm: warning: could not archive the manifest ($mf)." >&2
fi

print_summary
exit 0
