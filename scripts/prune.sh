#!/usr/bin/env bash
# prune.sh — delete fully-merged swarm/* branches and backup refs (U7 of
# docs/plans/2026-07-22-001). This is an ACTION with no TTY, so it is a DRY
# RUN by default; deletion requires HERDR_SWARM_PRUNE_CONFIRM=yes in the
# environment (env is the only confirmation channel an action has).
#
# The merged check is an explicit ancestry test against the MANIFEST-RECORDED
# base ref (current AND archived manifests) — never `git branch -d`'s
# HEAD-relative semantics, never manifest status alone: bookkeeping and HEAD
# can both diverge from reality after user resets/rebases/reverts, and git
# ancestry is the single authority for deletion (plan risk note). -d is still
# the deletion tool (belt and braces — never -D); a -d refusal is reported
# and skipped, never escalated.
#
# Scope: refs/heads/swarm/* and refs/swarm-backups/* only. Non-swarm
# branches, foreign worktrees, and unmerged branches are never listed or
# touched; archived manifests are counted, never deleted (recovery records).
set -uo pipefail

PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck source=scripts/lib.sh
. "$PLUGIN_ROOT/scripts/lib.sh"

require_node || exit 1

# Same ambient-cwd trap the fan-out hit: an action inherits the herdr server's
# cwd, so the repo comes from the workspace context (lib.sh), not `git` here.
REPO_ROOT="$(resolve_repo_root)" || exit 1
SWARM_REPO="$REPO_ROOT"
export SWARM_REPO

# R13 intersection call: warn (never refuse) above the max tested version —
# prune is pure git and must keep working there. Never fatal: an unreadable
# herdr version must not block branch hygiene.
version_gate intersection || true

confirm=0
[ "${HERDR_SWARM_PRUNE_CONFIRM:-}" = "yes" ] && confirm=1
ack_reverted=0
[ "${HERDR_SWARM_PRUNE_ACK_REVERTED:-}" = "yes" ] && ack_reverted=1
# Backup refs get their OWN gate. PRUNE_CONFIRM is a branch gate, and a branch
# is recoverable from the merge it was merged into; a discard snapshot is the
# LAST copy of work that exists nowhere else, so one flag must never authorize
# both. Deleting a snapshot is unrecoverable — it deserves its own keystroke.
prune_backups=0
[ "${HERDR_SWARM_PRUNE_BACKUPS:-}" = "yes" ] && prune_backups=1

# The live run's snapshots are never deletable at all — not even under
# PRUNE_BACKUPS: harvest may still be running and its discards are the only
# undo the active run has. A missing/corrupt manifest yields an empty id, so
# the guard simply does not fire (nothing claims to be active).
ACTIVE_RUN_ID="$(manifest_read 2>/dev/null | node -e '
	let d = "";
	process.stdin.on("data", (c) => (d += c)).on("end", () => {
		try { process.stdout.write(String(JSON.parse(d).run_id || "")); } catch {}
	});
' 2>/dev/null || true)"

# Same per-repo mutation lock as fan-out/harvest/abort: branch deletion must
# never interleave with a merge in flight (destructive-surface KTD).
acquire_lock "mutate-$(ws_id)" || exit 1
trap 'release_lock "mutate-$(ws_id)"' EXIT

US=$'\x1f'

# branch -> recorded base_ref, harvested from the current manifest plus every
# archived one (abort archives, never deletes, precisely so prune can still
# see which base a finished run forked from). A corrupt file contributes
# nothing — its branches then take the loudly-labeled fallback below, which
# beats refusing prune outright over one unreadable record.
collect_bases() {
	local f
	for f in "$(manifest_path)" "$(state_dir)"/archived-*.json; do
		[ -f "$f" ] || continue
		node -e '
			const fs = require("fs");
			let doc;
			try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
			catch { process.exit(0); }
			for (const s of doc.slots || []) {
				if (s.branch && doc.base_ref) console.log(s.branch + "\x1f" + doc.base_ref);
			}
		' "$f"
	done
}
BASES="$(collect_bases)"

recorded_base() {
	local hit
	[ -n "$BASES" ] || return 1
	hit="$(printf '%s\n' "$BASES" | awk -F"$US" -v b="$1" '$1 == b { print $2; exit }')"
	[ -n "$hit" ] || return 1
	printf '%s\n' "$hit"
}

# Fallback base when no manifest mentions a branch: the repo's CURRENT branch
# — said out loud on every such line, because a wrong implicit base is
# exactly how a not-actually-merged branch gets deleted.
cur_branch="$(git -C "$REPO_ROOT" symbolic-ref -q --short HEAD || echo HEAD)"

# The merge commit in base whose SECOND parent is the branch tip — the commit
# a revert of the merge would name. Empty for ff/squash merges (then the
# revert scan has nothing to match; coarse by design, per plan).
merge_commit_of() {
	git -C "$REPO_ROOT" log "$2" --merges --format='%H %P' 2>/dev/null |
		awk -v t="$1" '$3 == t { print $1; exit }'
}

n_merged=0 n_deleted=0 n_unmerged=0 n_skipped=0 n_refs=0 n_refs_deleted=0 n_manifests=0
n_refs_active=0

# --- (a) swarm/* branches ----------------------------------------------------
# Literal-prefix pattern, not 'refs/heads/swarm/*' — for-each-ref's fnmatch
# star stops at '/', and swarm branches are two levels deep (see preflight.sh).
while IFS= read -r b; do
	[ -n "$b" ] || continue
	tip="$(git -C "$REPO_ROOT" rev-parse --verify -q "refs/heads/$b^{commit}")" || continue
	note=""
	if base="$(recorded_base "$b")"; then
		:
	else
		base="refs/heads/$cur_branch"
		[ "$cur_branch" = "HEAD" ] && base="HEAD" # detached: only HEAD itself is usable
		note=" [no manifest records this branch — using current branch '$cur_branch' as base]"
	fi
	if ! git -C "$REPO_ROOT" rev-parse --verify -q "$base^{commit}" >/dev/null; then
		# A vanished base proves nothing about merged-ness — keep the branch.
		echo "kept     $b — recorded base $base no longer resolves$note"
		n_unmerged=$((n_unmerged + 1))
		continue
	fi
	if git -C "$REPO_ROOT" merge-base --is-ancestor "$tip" "$base"; then
		flag=""
		mc="$(merge_commit_of "$tip" "$base")"
		if [ -n "$mc" ] && [ -n "$(git -C "$REPO_ROOT" log "$base" --grep="This reverts commit $mc" --format=%H -n 1 2>/dev/null)" ]; then
			# Merged-then-reverted: ancestry still says merged, but deleting the
			# branch would strand the only easy re-merge handle — flag it (and
			# require the extra ack below); the dry-run listing is never blocked.
			flag=" [MERGED-THEN-REVERTED]"
		fi
		n_merged=$((n_merged + 1))
		echo "merged   $b (base $base)$note$flag"
		if [ "$confirm" -eq 1 ]; then
			if [ -n "$flag" ] && [ "$ack_reverted" -ne 1 ]; then
				echo "skipped  $b — merged then reverted; set HERDR_SWARM_PRUNE_ACK_REVERTED=yes as well to delete it." >&2
				n_skipped=$((n_skipped + 1))
			elif git -C "$REPO_ROOT" branch -d "$b" >/dev/null 2>&1; then
				echo "deleted  $b"
				n_deleted=$((n_deleted + 1))
			else
				# -d refuses when the branch is checked out in a worktree or not
				# merged into HEAD's view — report and skip, never -D (spec).
				echo "skipped  $b — git branch -d refused (checked out in a worktree, or HEAD disagrees); never -D." >&2
				n_skipped=$((n_skipped + 1))
			fi
		fi
	else
		echo "unmerged $b (base $base)$note — kept"
		n_unmerged=$((n_unmerged + 1))
	fi
done <<<"$(git -C "$REPO_ROOT" for-each-ref --format='%(refname:short)' 'refs/heads/swarm' 2>/dev/null || true)"

# --- (b) backup refs ---------------------------------------------------------
# Discard snapshots (refs/swarm-backups/<run>/<slot>) are listed always and
# deleted only under the dedicated HERDR_SWARM_PRUNE_BACKUPS gate — they are
# the last copy of discarded work, and no timed GC ever touches them (R12).
while IFS= read -r ref; do
	[ -n "$ref" ] || continue
	n_refs=$((n_refs + 1))
	# Run id is the path component after the namespace: refs/swarm-backups/<run>/<slot>.
	ref_run="${ref#refs/swarm-backups/}"
	ref_run="${ref_run%%/*}"
	if [ -n "$ACTIVE_RUN_ID" ] && [ "$ref_run" = "$ACTIVE_RUN_ID" ]; then
		echo "backup   $ref [ACTIVE RUN — kept; abort or harvest the run first]"
		n_refs_active=$((n_refs_active + 1))
		continue
	fi
	echo "backup   $ref"
	if [ "$prune_backups" -eq 1 ]; then
		if git -C "$REPO_ROOT" update-ref -d "$ref" 2>/dev/null; then
			echo "deleted  $ref"
			n_refs_deleted=$((n_refs_deleted + 1))
		else
			echo "skipped  $ref — update-ref -d refused." >&2
		fi
	fi
done <<<"$(git -C "$REPO_ROOT" for-each-ref --format='%(refname)' 'refs/swarm-backups' 2>/dev/null || true)"

# --- (c) archived manifests: counted, never deleted --------------------------
for f in "$(state_dir)"/archived-*.json; do
	[ -f "$f" ] && n_manifests=$((n_manifests + 1))
done
echo "archived manifests: $n_manifests (recovery records — prune never deletes them)"

if [ "$confirm" -eq 0 ]; then
	echo "herdr-swarm: DRY RUN — nothing was deleted. Set HERDR_SWARM_PRUNE_CONFIRM=yes to delete the listed merged branches."
fi
if [ "$prune_backups" -eq 0 ] && [ "$n_refs" -gt 0 ]; then
	echo "herdr-swarm: backup refs were LISTED ONLY — set HERDR_SWARM_PRUNE_BACKUPS=yes to delete them (they are the last copy of discarded work)."
fi
echo "herdr-swarm: prune summary — merged $n_merged (deleted $n_deleted), unmerged kept $n_unmerged, skipped $n_skipped, backup refs $n_refs (deleted $n_refs_deleted, active-run kept $n_refs_active), archived manifests $n_manifests."
exit 0
