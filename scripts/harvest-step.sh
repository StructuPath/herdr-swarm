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

require_slot_arg() {
	case "${1-}" in
	'' | *[!0-9]*)
		echo "herdr-swarm: '$VERB' needs a numeric slot argument" >&2
		return 1
		;;
	esac
}

# --- Verbs -------------------------------------------------------------------

# slot_row_json <slot>: the slot's whole manifest row, compact JSON.
slot_row_json() {
	printf '%s' "$DOC" | node -e '
		let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const r = (JSON.parse(d).slots || []).find((x) => String(x.slot) === process.argv[1]);
			process.stdout.write(JSON.stringify(r ?? null));
		});' "$1"
}

# --- Verb modules --------------------------------------------------------------

# The verbs live in harvest-step-<area>.sh beside this file, sourced here so
# they share this script's context, lock, and exit codes. They stay directly
# in scripts/ on purpose: CI's shellcheck/bash -n globs and the repo's
# invariant greps (raw herdr, ambient git, slot ownership) all scan it flat.
# shellcheck source=scripts/harvest-step-merge.sh
. "$PLUGIN_ROOT/scripts/harvest-step-merge.sh"
# shellcheck source=scripts/harvest-step-slot.sh
. "$PLUGIN_ROOT/scripts/harvest-step-slot.sh"
# shellcheck source=scripts/harvest-step-publish.sh
. "$PLUGIN_ROOT/scripts/harvest-step-publish.sh"
# shellcheck source=scripts/harvest-step-validate.sh
. "$PLUGIN_ROOT/scripts/harvest-step-validate.sh"
# shellcheck source=scripts/harvest-step-settle.sh
. "$PLUGIN_ROOT/scripts/harvest-step-settle.sh"
# shellcheck source=scripts/harvest-step-compare.sh
. "$PLUGIN_ROOT/scripts/harvest-step-compare.sh"
# shellcheck source=scripts/harvest-step-broadcast.sh
. "$PLUGIN_ROOT/scripts/harvest-step-broadcast.sh"
# shellcheck source=scripts/harvest-step-resolve.sh
. "$PLUGIN_ROOT/scripts/harvest-step-resolve.sh"

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
