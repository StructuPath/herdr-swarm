#!/usr/bin/env bash
# Fan-out preflight — sourced (not exec'd) by the fan-out pane. Sourcing is
# the point: each check is a function returning a distinct PF_EC_* code, and
# the pane prompts per code (harvest/delete/rename on detritus, base pick on
# detached HEAD, …); an exec'd script would flatten everything behind one
# exit status and force stderr parsing.
#
# Contract: checks never create anything (R3 — refuse before creating), never
# mutate the repo (sole exception: preflight_check_detritus runs `git
# worktree prune`, which only drops stale registrations of already-deleted
# paths), and never take the mutation lock — the caller owns lock scope. No
# `set -e/-u/-o` here either: a sourced file setting shell options would
# change the caller's semantics behind its back.

# Idempotent lib load, so callers only need to source this one file.
if ! type state_dir >/dev/null 2>&1; then
	# shellcheck source=scripts/lib.sh
	. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fi

# CALLER CONTRACT: every git call below targets $SWARM_REPO through repo_git
# (lib.sh) — never the ambient cwd — so the caller exports SWARM_REPO before
# invoking any check. fanout-pane resolves it (resolve_repo_root); abort and
# harvest-step take it from the manifest's repo_root. Resolving it HERE at
# source time would be the tidier-looking choice and is deliberately not done:
# sourcing this file must stay side-effect-free, because harvest-step refuses a
# charset-escaping run_id BEFORE any git command runs and a discovery rev-parse
# at load would break that guard. An unset SWARM_REPO fails loudly in repo_git;
# an empty one is reported as PF_EC_NOT_REPO by preflight_check_repo.

# Stable, distinct refusal codes — 10+ to stay clear of bash's generic 1/2
# and the manifest codes (2 missing / 3 corrupt, which preflight propagates
# as-is). The fan-out pane branches on these, so renumbering is a breaking
# change.
PF_EC_NOT_REPO=10
PF_EC_DETACHED=11
PF_EC_UNBORN=12
PF_EC_SYMREF_BASE=13
PF_EC_DETRITUS=14
PF_EC_ARGV_MISSING=15
PF_EC_SUBMODULES=16
PF_EC_ACTIVE_RUN=17
PF_EC_VERSION=18
PF_EC_SLOT_CAP=19
PF_EC_SPARSE=20

# The per-worktree task file name (input-channel KTD). The dotted, prefixed
# name IS the namespace: the exclude pattern must be one bare line, because
# gitignore syntax treats a trailing " # comment" as part of the pattern —
# there is no way to tag the line itself.
SWARM_TASK_FILE=".swarm-task.md"

# Also the validation that SWARM_REPO itself is usable: it is resolved before
# this runs (see above), and an empty value means resolution already failed.
preflight_check_repo() {
	if [ -z "${SWARM_REPO:-}" ] || ! repo_git rev-parse --git-dir >/dev/null 2>&1; then
		echo "herdr-swarm: not a git repository — run fan-out from a repo workspace." >&2
		return "$PF_EC_NOT_REPO"
	fi
}

# On success prints the fully-qualified base ref (refs/heads/<branch>) —
# fully qualified because every later ref mutation (harvest's three-arg
# update-ref compare-and-swap) uses the qualified form, and a short name can
# ambiguously match a tag.
preflight_resolve_base() {
	local head_ref base
	# --no-recurse: one level only. Plain `symbolic-ref HEAD` dereferences a
	# chained symref to its final target (observed on git 2.55), which would
	# silently skip the symref-base refusal below — the user would fan out
	# from a branch name they never checked out.
	if ! head_ref="$(repo_git symbolic-ref -q --no-recurse HEAD)"; then
		echo "herdr-swarm: detached HEAD — check out the branch to fan out from (base selection prompt lands with the fan-out pane)." >&2
		return "$PF_EC_DETACHED"
	fi
	case "$head_ref" in
	refs/heads/*) ;;
	*)
		# HEAD pointing outside refs/heads/ (bisect refs, exotica) has no
		# branch to fork from — same remedy as detached, same code.
		echo "herdr-swarm: HEAD points at $head_ref, not a local branch — check out a branch first." >&2
		return "$PF_EC_DETACHED"
		;;
	esac
	if ! repo_git rev-parse -q --verify 'HEAD^{commit}' >/dev/null; then
		echo "herdr-swarm: unborn HEAD ($head_ref has no commits) — make an initial commit first; there is no fork point to record." >&2
		return "$PF_EC_UNBORN"
	fi
	base="${head_ref#refs/heads/}"
	# A base that is itself a symref (git symbolic-ref refs/heads/x …) breaks
	# the harvest compare-and-swap: update-ref would move the *target*, not
	# the name the manifest recorded — refuse now, not mid-merge (KTD).
	if repo_git symbolic-ref -q "refs/heads/$base" >/dev/null; then
		echo "herdr-swarm: base refs/heads/$base is a symbolic ref — fan out from a plain branch." >&2
		return "$PF_EC_SYMREF_BASE"
	fi
	printf '%s\n' "$head_ref"
}

# Worktrees checked out on swarm/* branches, one "path<TAB>short-branch"
# line each, parsed from the porcelain format (paths may contain spaces, so
# positional awk fields would mangle them).
_swarm_worktrees() {
	repo_git worktree list --porcelain 2>/dev/null | awk '
		/^worktree /{p=substr($0,10)}
		/^branch refs\/heads\/swarm\//{print p "\t" substr($0,19)}
	' || true
}

# `git worktree prune` first: stale registrations from crashed runs would
# otherwise read as live worktrees forever. Then surface leftover swarm/*
# branches and worktrees — `worktree create` silently reuses an existing
# branch (0.7.1 behavior), so with reused names a new agent would start from
# last run's half-finished code. Distinct code so the pane can prompt
# harvest / delete / rename instead of guessing.
preflight_check_detritus() {
	local branches wts
	repo_git worktree prune 2>/dev/null || true
	# Literal-prefix pattern, NOT 'refs/heads/swarm/*': for-each-ref's fnmatch
	# star stops at '/', and swarm branches are two levels deep
	# (swarm/<run-id>/<slot>) — the glob silently matches nothing.
	branches="$(repo_git for-each-ref --format='%(refname:short)' 'refs/heads/swarm' 2>/dev/null || true)"
	wts="$(_swarm_worktrees)"
	if [ -n "$branches" ] || [ -n "$wts" ]; then
		{
			echo "herdr-swarm: leftover swarm detritus from a previous run — harvest, delete, or rename it before fanning out:"
			[ -n "$branches" ] && printf '%s\n' "$branches" | sed 's/^/  branch /'
			[ -n "$wts" ] && printf '%s\n' "$wts" | awk -F'\t' '{print "  worktree " $1 " (" $2 ")"}'
		} >&2
		return "$PF_EC_DETRITUS"
	fi
	return 0
}

# preflight_check_argv <slot-argv>… — one string per slot; `command -v` on
# the first word of each. Every slot is checked before returning (a doubly
# broken preset surfaces in ONE refusal), and the whole check runs before
# any create — a missing binary discovered after `worktree create` would
# strand a half-built run (R3/R4).
preflight_check_argv() {
	local i=0 a first rest missing=""
	for a in "$@"; do
		i=$((i + 1))
		# First whitespace-delimited word only — read, not ${a%% *}, so tabs
		# split too; no glob expansion can occur on the unexpanded string.
		read -r first rest <<<"$a"
		: "$rest" # only the first word matters; named to keep read honest
		if [ -z "$first" ] || ! command -v "$first" >/dev/null 2>&1; then
			missing="${missing}  slot $i: '$first' not found (argv: $a)"$'\n'
		fi
	done
	if [ -n "$missing" ]; then
		{
			echo "herdr-swarm: agent binaries missing — install them or fix the preset:"
			printf '%s' "$missing"
		} >&2
		return "$PF_EC_ARGV_MISSING"
	fi
	return 0
}

# Submodules are out of scope in v1 (plan Scope Boundaries): worktrees share
# one .git/modules store and recursive checkout/merge semantics multiply
# every destructive path in harvest and abort.
preflight_check_submodules() {
	local top
	top="$(repo_git rev-parse --show-toplevel 2>/dev/null)" || top="$SWARM_REPO"
	if [ -f "$top/.gitmodules" ]; then
		echo "herdr-swarm: this repo uses submodules (.gitmodules present) — unsupported in v1, fan-out refused." >&2
		return "$PF_EC_SUBMODULES"
	fi
}

# Sparse checkout is a note, not a refusal: fan-out works, but in-user-tree
# merges are refused at harvest (a sparse tree can hide conflicting paths).
# Distinct code so the pane records the note without string-matching.
preflight_check_sparse() {
	local sc_file
	sc_file="$(repo_git_path info/sparse-checkout 2>/dev/null || true)"
	if [ "$(repo_git config --bool core.sparseCheckout 2>/dev/null)" = "true" ] ||
		{ [ -n "$sc_file" ] && [ -f "$sc_file" ]; }; then
		echo "herdr-swarm: note: sparse checkout detected — in-user-tree merges will be refused at harvest." >&2
		return "$PF_EC_SPARSE"
	fi
	return 0
}

# One active run per physical repository, regardless of Herdr workspace id.
# Every live/archived candidate is semantically validated first: unreadable or
# identity-ambiguous bookkeeping is unknown state, never permission to start a
# second run or resolve detritus destructively.
preflight_check_active_run() {
	local scan
	scan="$(bookkeeping_scan "$SWARM_REPO")" || return 1
	bookkeeping_assert_known "$scan" || return $?
	if printf '%s' "$scan" | node -e '
		let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>process.exit(JSON.parse(d).live.length>0?0:1));
	'; then
		echo "herdr-swarm: an active run exists for this repository (possibly in another workspace) — harvest or abort it first." >&2
		return "$PF_EC_ACTIVE_RUN"
	fi
	return 0
}

# Fan-out needs one of the two topology-creating paths (`agent start --cwd` on
# 0.7.4, pane split + pane run + report-agent on 0.7.5+) — reuse the lib gate,
# remapped into the preflight code space so the pane can tell "wrong herdr"
# from every other refusal.
preflight_check_version() {
	version_gate gated || return "$PF_EC_VERSION"
}

# Soft cap, default 6 (worktree churn and agent RAM scale per slot);
# HERDR_SWARM_MAX_SLOTS is the deliberate knob. Garbage in the override
# falls back to the default instead of refusing everything (same policy as
# the lock-tries override in lib.sh).
preflight_check_slot_cap() {
	local n="${1-}" cap
	case "${HERDR_SWARM_MAX_SLOTS:-6}" in
	'' | *[!0-9]* | 0) cap=6 ;;
	*) cap="${HERDR_SWARM_MAX_SLOTS:-6}" ;;
	esac
	case "$n" in
	'' | *[!0-9]* | 0)
		echo "herdr-swarm: slot count '$n' is not a positive integer." >&2
		return "$PF_EC_SLOT_CAP"
		;;
	esac
	if [ "$n" -gt "$cap" ]; then
		echo "herdr-swarm: $n slots exceeds the cap of $cap (raise with HERDR_SWARM_MAX_SLOTS)." >&2
		return "$PF_EC_SLOT_CAP"
	fi
	return 0
}

# --- Exclude-pattern helpers (input-channel KTD) ------------------------------

# Top-level manifest patch for the one field preflight owns. Private: slot
# rows go through manifest_update_slot; nothing else patches top-level yet.
_manifest_set_exclude_flag() {
	local val="$1" doc updated
	doc="$(manifest_read)" || return $?
	updated="$(printf '%s' "$doc" | node -e '
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const doc = JSON.parse(d);
			doc.exclude_pattern_added = process.argv[1] === "true";
			process.stdout.write(JSON.stringify(doc, null, 2));
		});
	' "$val")" || return 1
	printf '%s' "$updated" | manifest_write
}

# ensure_exclude_pattern: make the per-worktree task file invisible to git
# status in every slot. info/exclude, not .gitignore — it must never leak
# into the user's tree or commits; resolved via repo_git_path (lib.sh) because
# .git is a *file* in linked worktrees and the exclude file is shared repo-wide,
# so one append covers all slots. Exact-line idempotence: re-runs and
# multi-slot fan-outs never stack duplicates. The manifest flag is set
# BEFORE the append (write-ahead KTD: the manifest over-approximates —
# "flag set, line maybe absent" is safe because removal is idempotent, the
# reverse would leave an untracked mutation).
ensure_exclude_pattern() {
	local ex
	ex="$(repo_git_path info/exclude)" || return 1
	_manifest_set_exclude_flag true || return $?
	mkdir -p "$(dirname "$ex")" || return 1
	[ -f "$ex" ] || : >"$ex"
	if ! grep -qFx "$SWARM_TASK_FILE" "$ex"; then
		# A final line without \n would glue our pattern onto it, corrupting
		# both patterns — normalize first. $(tail -c1) is empty iff the last
		# byte is a newline (command substitution strips it).
		if [ -s "$ex" ] && [ -n "$(tail -c1 "$ex")" ]; then
			echo >>"$ex"
		fi
		printf '%s\n' "$SWARM_TASK_FILE" >>"$ex"
	fi
	return 0
}

# remove_exclude_pattern: removes ONLY the exact line we appended — a user's
# own patterns (even ones mentioning swarm) are untouched. Temp+rename in
# the same directory keeps a mid-write crash from truncating the user's
# exclude file. Flag clear comes AFTER the removal and is best-effort: at
# cleanup time the manifest may already be archived, and the removal is the
# part that must not fail (mirror-image of ensure's ordering).
remove_exclude_pattern() {
	local ex tmp
	ex="$(repo_git_path info/exclude)" || return 1
	if [ -f "$ex" ]; then
		tmp="$ex.tmp.$$"
		if ! awk -v p="$SWARM_TASK_FILE" '$0 != p' "$ex" >"$tmp"; then
			rm -f "$tmp"
			return 1
		fi
		mv "$tmp" "$ex" || {
			rm -f "$tmp"
			return 1
		}
	fi
	_manifest_set_exclude_flag false 2>/dev/null || true
	return 0
}

exact_run_archive_exists() {
	local run_id="$1" arch
	arch="$(state_dir)/archived-$run_id.json"
	[ -f "$arch" ] && [ ! -L "$arch" ] && node -e '
		const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
		process.exit(d.run_id===process.argv[2] && d.status==="completed" &&
			(d.slots||[]).every(s=>s.status==="archived"&&!s.journal) ? 0 : 1);
	' "$arch" "$run_id" 2>/dev/null
}

# finalize_run <repo-root> <run-id> [require-complete]: partial Harvest uses
# the default benign no-op; Abort passes require-complete and must fail unless
# every slot is archived/journal-free and the exact archive is durable.
finalize_run() {
	local repo_root="$1" run_id="$2" mode="${3-}" mf arch doc updated scan rc=0
	mf="$(manifest_path)" || return 1
	arch="$(state_dir)/archived-$run_id.json"
	if [ ! -e "$mf" ]; then
		if exact_run_archive_exists "$run_id"; then
			# Retry after the archive rename: finish only idempotent bookkeeping
			# tails, never rewrite the immutable archive.
			active_index_remove "$repo_root" "$run_id" 2>/dev/null || true
			if [ -f "$mf.bak" ] && [ ! -e "$arch.bak" ]; then mv "$mf.bak" "$arch.bak" || return 1; fi
			return 0
		fi
		echo "herdr-swarm: finalization refused — neither the live manifest nor the exact completed archive is available." >&2
		return 1
	fi
	[ ! -e "$arch" ] || {
		echo "herdr-swarm: finalization refused — archive $arch already exists; it will not be overwritten." >&2
		return 1
	}
	doc="$(manifest_read)" || return $?
	rc=0
	printf '%s' "$doc" | node -e '
		const fs=require("fs"); let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
			const m=JSON.parse(d);
			if (m.run_id !== process.argv[1] || !(m.slots||[]).every(s=>s.status==="archived" && !s.journal)) process.exit(1);
			const present=(m.slots||[]).find(s=>s.path && fs.existsSync(s.path));
			if (present) { console.error("herdr-swarm: finalization refused — archived slot resource still exists at " + JSON.stringify(present.path)); process.exit(2); }
		});
	' "$run_id" || rc=$?
	case "$rc" in
	0) ;;
	1)
		if [ "$mode" = "require-complete" ]; then
			echo "herdr-swarm: finalization refused — not every slot is archived and journal-free." >&2
			return 1
		fi
		return 0
		;;
	*) return "$rc" ;;
	esac
	for resource_path in "$(state_dir)"/harvest-"$run_id"-s*; do
		[ -e "$resource_path" ] || continue
		echo "herdr-swarm: finalization refused — harvest resource still exists at $resource_path." >&2
		return 1
	done
	updated="$(printf '%s' "$doc" | node -e '
		let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
			const m=JSON.parse(d), now=new Date().toISOString();
			if (m.status !== "completed") {
				m.status="completed"; m.completed_at=now; m.completion_reason="all_slots_archived";
				m.completion_events=Array.isArray(m.completion_events)?m.completion_events:[];
				m.completion_events.push({type:"run.completed",at:now});
			}
			process.stdout.write(JSON.stringify(m,null,2));
		});
	')" || return 1
	printf '%s' "$updated" | manifest_write || return 1
	[ "${HERDR_SWARM_TEST_FAIL_FINALIZE_STEP:-}" = "after-complete" ] && return 99
	# No other live manifest may still need the shared task-file exclusion.
	scan="$(bookkeeping_scan "$repo_root")" || return 1
	bookkeeping_assert_known "$scan" || return $?
	if printf '%s' "$scan" | node -e '
		let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
			const s=JSON.parse(d); process.exit(s.live.some(x=>x.run_id!==process.argv[1] && x.exclude_pattern_added)?1:0);
		});
	' "$run_id"; then
		remove_exclude_pattern || return 1
	fi
	[ "${HERDR_SWARM_TEST_FAIL_FINALIZE_STEP:-}" = "after-exclude" ] && return 99
	active_index_remove "$repo_root" "$run_id" || return 1
	[ "${HERDR_SWARM_TEST_FAIL_FINALIZE_STEP:-}" = "after-index" ] && return 99
	if ! mv "$mf" "$arch"; then
		active_index_write "$run_id" "$repo_root" 2>/dev/null || true
		echo "herdr-swarm: could not archive the completed manifest $mf to $arch." >&2
		return 1
	fi
	[ "${HERDR_SWARM_TEST_FAIL_FINALIZE_STEP:-}" = "after-archive" ] && return 99
	if [ -f "$mf.bak" ]; then
		mv "$mf.bak" "$arch.bak" || {
			echo "herdr-swarm: could not archive the manifest backup $mf.bak." >&2
			return 1
		}
	fi
	printf 'run_archived\t%s\n' "$arch"
	return 0
}

# --- Corrupt-manifest degradation (R6) ----------------------------------------

# report_only_discovery: what a destructive caller *would* act on, listed
# from live sources only — swarm/* branches, worktrees on swarm branches,
# and panes carrying this plugin's pane titles. This is the corrupt-manifest
# fallback: when bookkeeping is unreadable, over-approximate from reality
# and report — never guess-and-delete. Read-only by contract; output is
# machine-splittable "kind<TAB>detail…" lines so the pane renders it without
# re-parsing prose. Always exits 0: discovery reporting nothing is an
# answer, not a failure.
report_only_discovery() {
	# Literal-prefix pattern — see preflight_check_detritus for why not '/*'.
	repo_git for-each-ref --format='branch	%(refname:short)' 'refs/heads/swarm' 2>/dev/null || true
	_swarm_worktrees | awk -F'\t' '{print "worktree\t" $1 "\t" $2}'
	local panes=""
	if [ -n "${HERDR_WORKSPACE_ID:-}" ]; then
		panes="$(herdr_pane_list --workspace "$HERDR_WORKSPACE_ID" 2>/dev/null || true)"
	else
		panes="$(herdr_pane_list 2>/dev/null || true)"
	fi
	if [ -n "$panes" ] && command -v node >/dev/null 2>&1; then
		# Title set must track herdr-plugin.toml [[panes]] titles — they are
		# the sweep labels (pane list reports them as "label").
		printf '%s' "$panes" | node -e '
			let d = "";
			process.stdin.on("data", (c) => (d += c)).on("end", () => {
				let j;
				try { j = JSON.parse(d); } catch { return; }
				const titles = new Set(["Swarm Fan-out", "Swarm Status", "Swarm Harvest"]);
				for (const p of (j.result && j.result.panes) || []) {
					if (p.pane_id && titles.has(p.label)) {
						console.log("pane\t" + p.pane_id + "\t" + p.label);
					}
				}
			});
		'
	elif [ -n "$panes" ]; then
		# Same degradation the sibling's close.sh chose: without node the git
		# side still reports; say the pane sweep was skipped, don't hide it.
		echo "herdr-swarm: warning: pane sweep skipped (node not found)" >&2
	fi
	return 0
}
