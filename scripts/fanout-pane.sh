#!/usr/bin/env bash
# Swarm Fan-out pane — the real fan-out flow (U4 of
# docs/plans/2026-07-22-001). This is a PANE, not an action: plugin actions
# receive zero argv and have no TTY (sibling spike fact), so the interactive
# flow lives here.
#
# Every prompt reads line-wise from STDIN — deliberately, so tests can drive
# the whole flow by scripting stdin. Protocol, in order:
#   1. only if leftover swarm detritus exists: one choice line (d / r / q)
#   1b. only if [d] was chosen AND some leftover branch is unmerged: one
#      second confirmation line — the literal word "delete-unmerged"
#   2. slot count N (re-prompted until the cap check passes)
#   3. per slot 1..N: preset name (empty line = default = first preset)
#   4. shared task prompt: free lines, terminated by a lone "." line
#   5. per slot 1..N: "y" to give that slot its own task (then free lines
#      terminated by a lone "."), anything else keeps the shared prompt
#
# Every prompt above also has an ENV override (see the "Non-interactive input
# channel" block below), so an agent or CI job can start a run without a TTY.
#
# Per-slot ordering is pinned write-ahead (manifest KTD — the manifest must
# stay a superset of git/herdr reality at every instant):
#   pending row (branch known, path null) → worktree create → record
#   path/ids → task file → agent start (explicit --cwd) → row running.
# "agent start" here means herdr_agent_start, which is `agent start --cwd` on
# 0.7.4 and pane split + pane run + report-agent on 0.7.5+; this loop is
# deliberately blind to which (lib.sh owns the version seam).
set -uo pipefail

PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck source=scripts/preflight.sh
. "$PLUGIN_ROOT/scripts/preflight.sh" # sources lib.sh itself
# shellcheck source=scripts/presets.sh
. "$PLUGIN_ROOT/scripts/presets.sh"

require_herdr
require_node || exit 1

# Error paths linger via pane_linger (lib.sh, HERDR_SWARM_LINGER_SECS): the
# pane closes with this process, so without a linger a fatal message would
# flash and vanish before the user can read it. Tests set the override to 0.

fatal() {
	# fatal <exit-code> [message…]. Lock released BEFORE the linger: a pane
	# sitting on screen for 10 minutes must never keep holding the mutation
	# lock (abort/harvest would block behind it the whole time).
	local code="$1"
	shift || true
	[ $# -gt 0 ] && echo "$*" >&2
	[ -n "${MUTATION_LOCK:-}" ] && release_lock "$MUTATION_LOCK"
	pane_linger
	exit "$code"
}

prompt_line() {
	# prompt_line <var> <prompt> — one line from stdin; EOF is fatal (a
	# half-answered flow must never fan out on defaults the user never saw).
	local __var="$1" __line
	printf '%s' "$2"
	if ! IFS= read -r __line; then
		fatal 1 "herdr-swarm: input ended unexpectedly — fan-out cancelled."
	fi
	printf -v "$__var" '%s' "$__line"
}

read_task() {
	# read_task <var> — multi-line text until a lone "." (input-channel KTD
	# convention); EOF before "." is fatal so an interrupted paste can never
	# become a silently truncated task.
	local __var="$1" __line __buf=""
	while IFS= read -r __line; do
		if [ "$__line" = "." ]; then
			printf -v "$__var" '%s' "$__buf"
			return 0
		fi
		__buf+="$__line"$'\n'
	done
	fatal 1 "herdr-swarm: task input ended without the terminating '.' line."
}

# --- Non-interactive input channel (env) -------------------------------------
# Fan-out was the only capability with no scriptable path: abort and prune are
# zero-TTY env-gated actions and harvest-step.sh is a verb CLI with typed exit
# codes, so an agent could inspect, harvest, and clean up a run but never start
# one. Each variable below REPLACES exactly one prompt; anything unset falls
# back to the prompt, so the stdin protocol above is untouched.
#
#   HERDR_SWARM_SLOTS      slot count (same cap check the prompt runs)
#   HERDR_SWARM_PRESETS    comma-separated preset names, one per slot; a single
#                          name applies to every slot
#   HERDR_SWARM_TASK_FILE  file whose contents become the shared task — a FILE,
#                          not a var, because the task is normally multi-line
#                          and the stdin protocol's lone "." terminator has no
#                          environment equivalent
#   HERDR_SWARM_TASK       single-line shared task; the file wins if both are set
#   HERDR_SWARM_DETRITUS   delete | rename | abort — replaces the d/r/q prompt
#   HERDR_SWARM_DETRITUS_ACK_UNMERGED=yes
#                          replaces the typed "delete-unmerged" second gate.
#                          Without it a scripted `delete` that hits unmerged
#                          leftovers REFUSES: the P0 guard is not bypassable
#                          just because nobody is at the keyboard.
#
# Per-slot task overrides stay interactive-only. Encoding N free-form multi-line
# prompts into the environment buys nothing a caller cannot get by fanning out
# once per distinct task, and every encoding scheme reintroduces the terminator
# problem HERDR_SWARM_TASK_FILE exists to dodge.
SCRIPTED=0
if [ -n "${HERDR_SWARM_SLOTS:-}${HERDR_SWARM_PRESETS:-}${HERDR_SWARM_TASK:-}${HERDR_SWARM_TASK_FILE:-}${HERDR_SWARM_DETRITUS:-}" ]; then
	SCRIPTED=1
fi
# Prompting needs a terminal to prompt at. In a scripted run with no TTY every
# remaining prompt is a hang waiting to happen — an agent that pipes nothing and
# waits forever is worse than a refusal — so those prompts become fatal-by-name
# instead. Interactive runs (SCRIPTED=0, including the piped-stdin test suite)
# keep reading stdin exactly as before.
NO_PROMPTS=0
if [ "$SCRIPTED" -eq 1 ] && [ ! -t 0 ]; then
	NO_PROMPTS=1
fi
# Set once the corresponding value arrived from the environment; the flags gate
# the follow-up prompts those answers imply (per-slot overrides, the typed
# force-delete word), which have no meaning in a run nobody is watching.
TASK_FROM_ENV=0
DETRITUS_FROM_ENV=0

require_var() {
	# require_var <env-name> <what> — called at a prompt site with no env value
	# in a run that cannot prompt. Names the variable and dies; never reads.
	[ "$NO_PROMPTS" -eq 1 ] || return 0
	fatal 1 "herdr-swarm: non-interactive fan-out needs $1 ($2) — stdin is not a terminal, so there is nothing to prompt. Set it and rerun."
}

# --- JSON helpers (node is a plugin prereq; same choice as lib.sh) ----------

parse_create_json() {
	# stdin: worktree-create response → "path<TAB>ws<TAB>pane<TAB>terminal".
	# Fields come from the response, never derived: upstream #261 will move
	# the worktrees dir, so a derived path is a future bug.
	node -e '
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const j = JSON.parse(d);
			if (j.error) {
				console.error("herdr-swarm: " + j.error.code + ": " + j.error.message);
				process.exit(1);
			}
			const r = j.result || {};
			if (!r.worktree || !r.worktree.path) {
				console.error("herdr-swarm: worktree-create response has no worktree.path");
				process.exit(1);
			}
			process.stdout.write([
				r.worktree.path,
				r.worktree.open_workspace_id || "",
				(r.root_pane && r.root_pane.pane_id) || "",
				(r.root_pane && r.root_pane.terminal_id) || "",
			].join("\t") + "\n");
		});
	'
}

created_patch_json() {
	# argv: path ws pane terminal → slot patch recording what create returned.
	node -e '
		const [p, w, pi, ti] = process.argv.slice(1);
		process.stdout.write(JSON.stringify({
			path: p,
			workspace_id: w || null,
			pane_id: pi || null,
			terminal_id: ti || null,
		}));
	' "$@"
}

parse_start_json() {
	# stdin: agent-start response → "name<TAB>pane<TAB>terminal<TAB>ws".
	# Spike (k): the start JSON carries every id the manifest needs — no
	# agent-list correlation pass.
	node -e '
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const j = JSON.parse(d);
			if (j.error) {
				console.error("herdr-swarm: " + j.error.code + ": " + j.error.message);
				process.exit(1);
			}
			const a = (j.result || {}).agent;
			if (!a || !a.pane_id) {
				console.error("herdr-swarm: agent-start response has no agent.pane_id");
				process.exit(1);
			}
			process.stdout.write([
				a.name || "",
				a.pane_id,
				a.terminal_id || "",
				a.workspace_id || "",
			].join("\t") + "\n");
		});
	'
}

running_patch_json() {
	# argv: name pane terminal ws → the row-running patch.
	node -e '
		const [an, pi, ti, w] = process.argv.slice(1);
		process.stdout.write(JSON.stringify({
			status: "running",
			agent_name: an || null,
			pane_id: pi || null,
			terminal_id: ti || null,
			workspace_id: w || null,
		}));
	' "$@"
}

append_slot_row() {
	# append_slot_row <slot> <label> <branch> <agent> — the write-ahead
	# pending row: it lands on disk BEFORE worktree create runs, so a crash
	# mid-create leaves a findable row, never an untracked worktree. Full KTD
	# schema, null until reality fills each field.
	manifest_read | node -e '
		const [slot, label, branch, agent] = process.argv.slice(1);
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const doc = JSON.parse(d);
			doc.slots.push({
				slot: Number(slot),
				label,
				branch,
				path: null,
				workspace_id: null,
				pane_id: null,
				terminal_id: null,
				agent_name: agent,
				self_created: true,
				status: "pending",
				backup_ref: null,
				journal: null,
			});
			process.stdout.write(JSON.stringify(doc, null, 2));
		});
	' "$@" | manifest_write
}

# --- Detritus resolution (surface-and-choose, R3) ---------------------------
# Both walk the same live sources preflight_check_detritus scanned; the
# literal 'refs/heads/swarm' prefix (not a glob) is explained in preflight.sh.

# The second-gate word for force-deleting unmerged leftovers. A literal
# typed word, not y/n: it cannot be hit by a stray keystroke or by a scripted
# stdin stream that was written for the old one-answer protocol.
DETRITUS_FORCE_WORD="delete-unmerged"

# _archived_runs_for_branches: branch names on stdin → one stderr line per
# ARCHIVED run that still records any of them. Deleting such a branch throws
# away work the tool can otherwise still reach, so the recovery route is
# named before the destructive prompt, never after it.
_archived_runs_for_branches() {
	local names f
	names="$(cat)"
	for f in "$(state_dir)"/archived-*.json; do
		[ -f "$f" ] || continue
		printf '%s' "$names" | node -e '
			const fs = require("fs");
			let d = "";
			process.stdin.on("data", (c) => (d += c)).on("end", () => {
				const want = new Set(d.split("\n").filter(Boolean));
				let doc;
				try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
				catch { return; }
				const hit = (doc.slots || [])
					.filter((s) => s.branch && want.has(s.branch))
					.map((s) => s.branch);
				if (hit.length) {
					console.error("  run " + doc.run_id + " (" + process.argv[1] +
						") still records: " + hit.join(", "));
				}
			});
		' "$f"
	done
}

# force_delete_unmerged <newline-separated branches>: the ONLY path to
# `git branch -D` in this plugin. Everything else deletes with -d and reports
# refusals (prune.sh does exactly that), because a branch git refuses to
# delete holds committed agent work that exists nowhere else — the case the
# whole harvest flow exists to protect. The user's earlier [d] answer was a
# choice about detritus in general, made before this branch was known to be
# unmerged, so it is not informed consent for -D: show the tips, name the
# non-destructive routes, and require a second typed word.
force_delete_unmerged() {
	local names="$1" b tip subject reply
	{
		echo "herdr-swarm: these leftover branches are NOT merged into HEAD — git refused to delete them. They hold committed work that is not in your base branch:"
		while IFS= read -r b; do
			[ -n "$b" ] || continue
			tip="$(repo_git rev-parse --short --verify "refs/heads/$b" 2>/dev/null || echo '?')"
			subject="$(repo_git log -1 --format=%s "refs/heads/$b" 2>/dev/null || true)"
			printf '  %s  %s  %s\n' "$b" "$tip" "$subject"
		done <<<"$names"
	} >&2
	printf '%s' "$names" | _archived_runs_for_branches
	echo "herdr-swarm: non-destructive routes: run Harvest on that run to merge the work back, or answer [r] instead to rename these under swarm-kept/." >&2
	if [ "$DETRITUS_FROM_ENV" -eq 1 ]; then
		# The scripted mirror of the typed word, gated exactly like prune's
		# destructive classes: HERDR_SWARM_DETRITUS=delete authorized detritus
		# in general, before any of it was known to be unmerged, so it is no
		# more consent for -D than the interactive [d] keystroke was. Refusing
		# here leaves the branches behind, and the caller's re-check then fails
		# the whole fan-out non-zero — which is the point.
		if [ "${HERDR_SWARM_DETRITUS_ACK_UNMERGED:-}" != "yes" ]; then
			echo "herdr-swarm: REFUSED — HERDR_SWARM_DETRITUS=delete does not authorize force-deleting unmerged work. Set HERDR_SWARM_DETRITUS_ACK_UNMERGED=yes to authorize it, or HERDR_SWARM_DETRITUS=rename to keep the work under swarm-kept/." >&2
			echo "herdr-swarm: kept — nothing was force-deleted." >&2
			return 0
		fi
	else
		prompt_line reply "Type '$DETRITUS_FORCE_WORD' to force-delete the branches listed above, anything else to keep them: "
		if [ "$reply" != "$DETRITUS_FORCE_WORD" ]; then
			echo "herdr-swarm: kept — nothing was force-deleted." >&2
			return 0
		fi
	fi
	while IFS= read -r b; do
		[ -n "$b" ] || continue
		if repo_git branch -D "$b" >/dev/null 2>&1; then
			echo "  force-deleted branch $b"
		else
			echo "herdr-swarm: could not delete branch $b (still checked out somewhere?)" >&2
		fi
	done <<<"$names"
}

delete_detritus() {
	local p b unmerged=""
	# Worktrees first: a branch checked out in a worktree cannot be deleted.
	# _swarm_worktrees is preflight.sh's helper — shared on purpose so the
	# prompt acts on exactly the inventory the check reported.
	while IFS=$'\t' read -r p b; do
		[ -n "$p" ] || continue
		# No --force (R11): a dirty leftover refuses loudly here and then
		# blocks the fan-out at the re-check below.
		if repo_git worktree remove "$p"; then
			echo "  removed worktree $p ($b)"
		else
			echo "herdr-swarm: kept $p — dirty or busy; clean it by hand (no --force, R11)." >&2
		fi
	done < <(_swarm_worktrees)
	while IFS= read -r b; do
		[ -n "$b" ] || continue
		# -d first, always: a merged leftover deletes silently on this pass and
		# never reaches the second gate. Only branches git itself refuses are
		# collected for the typed-confirmation path below.
		if repo_git branch -d "$b" >/dev/null 2>&1; then
			echo "  deleted branch $b"
		else
			unmerged="$unmerged$b"$'\n'
		fi
	done < <(repo_git for-each-ref --format='%(refname:short)' 'refs/heads/swarm')
	[ -n "$unmerged" ] || return 0
	force_delete_unmerged "${unmerged%$'\n'}"
}

rename_detritus() {
	# Move leftovers out of the swarm/ namespace that preflight scans and the
	# reapers touch; the work stays reachable under swarm-kept/. git updates
	# a checked-out worktree's HEAD on rename, so worktrees survive intact.
	local b
	while IFS= read -r b; do
		[ -n "$b" ] || continue
		if repo_git branch -m "$b" "swarm-kept/${b#swarm/}"; then
			echo "  renamed $b -> swarm-kept/${b#swarm/}"
		else
			echo "herdr-swarm: could not rename branch $b" >&2
		fi
	done < <(repo_git for-each-ref --format='%(refname:short)' 'refs/heads/swarm')
}

# --- Main flow ---------------------------------------------------------------

# The repo every git call below targets, resolved from the herdr workspace
# context and NOT from this process's cwd (a pane inherits the server's cwd,
# which is routinely a different repo — lib.sh resolve_repo_root). Resolved
# BEFORE preflight because preflight_check_repo is the validation that this
# value is a real repository, and every later check runs against it.
SWARM_REPO="$(resolve_repo_root 2>/dev/null || true)"
export SWARM_REPO

preflight_check_repo || fatal $?
# The mutation lock spans the WHOLE fan-out including the repository-scoped
# active-run scan. Its key is the physical git common directory, never the
# Herdr workspace id, so aliased/reopened workspaces cannot race a second run.
MUTATION_LOCK="$(repo_mutation_lock_name "$SWARM_REPO")" || fatal 1
acquire_lock "$MUTATION_LOCK" || fatal 1
trap 'release_lock "$MUTATION_LOCK"' EXIT
# Version before anything herdr-shaped: below the 0.7.4 floor nothing may be
# created and nothing else is worth prompting for (R13).
preflight_check_version || fatal $?
base_ref="$(preflight_resolve_base)" || fatal $?
preflight_check_submodules || fatal $?
preflight_check_sparse || true # note-only: message printed, fan-out proceeds
# Active-run BEFORE detritus: a live run's own branches must read as "active
# run — harvest or abort first", never as detritus offered up for deletion.
preflight_check_active_run || fatal $?

# Prompt targets, assigned indirectly by prompt_line/read_task (printf -v);
# initialized here so the data flow is explicit (and shellcheck-visible).
choice="" n="" p="" ans="" shared_task="" t=""

rc=0
preflight_check_detritus || rc=$?
if [ "$rc" -eq "$PF_EC_DETRITUS" ]; then
	# Inventory already printed by the check; surface-and-choose (R3).
	if [ -n "${HERDR_SWARM_DETRITUS:-}" ]; then
		DETRITUS_FROM_ENV=1
		case "$HERDR_SWARM_DETRITUS" in
		delete) choice="d" ;;
		rename) choice="r" ;;
		abort) choice="q" ;;
		*) fatal 1 "herdr-swarm: HERDR_SWARM_DETRITUS='$HERDR_SWARM_DETRITUS' is not one of delete / rename / abort." ;;
		esac
	else
		require_var HERDR_SWARM_DETRITUS "leftover-branch handling: delete / rename / abort"
		prompt_line choice "Leftover swarm detritus: [d]elete / [r]ename to swarm-kept/ / [q]uit and harvest it first: "
	fi
	case "$choice" in
	d | D) delete_detritus ;;
	r | R) rename_detritus ;;
	*) fatal "$PF_EC_DETRITUS" "herdr-swarm: old run kept — run Harvest or Abort on it, then fan out again." ;;
	esac
	# Re-check instead of trusting the cleanup: anything that survived (e.g.
	# a dirty worktree we refused to remove) must still block the fan-out.
	preflight_check_detritus || fatal $? "herdr-swarm: detritus still present — resolve it by hand."
elif [ "$rc" -ne 0 ]; then
	fatal "$rc"
fi

# --- Collect inputs (nothing is created until every input is validated) -----

if [ -n "${HERDR_SWARM_SLOTS:-}" ]; then
	# No re-prompt loop here: a scripted caller cannot fix a typo mid-run, so a
	# bad count is a refusal with the cap check's own message above it.
	n="$HERDR_SWARM_SLOTS"
	preflight_check_slot_cap "$n" || fatal $? "herdr-swarm: HERDR_SWARM_SLOTS='$n' refused."
else
	require_var HERDR_SWARM_SLOTS "the slot count"
	while :; do
		prompt_line n "How many agents? "
		preflight_check_slot_cap "$n" && break
		# Cap check printed its own message; re-prompt rather than dying — a
		# typo'd N should not cost the user the whole flow.
	done
fi

plist="$(presets_list)" || fatal 1 "herdr-swarm: preset catalog is invalid — fix $(presets_file) and rerun."
default_preset="${plist%%$'\t'*}"

declare -a preset_names slot_argvs slot_tasks
if [ -n "${HERDR_SWARM_PRESETS:-}" ]; then
	IFS=',' read -r -a env_presets <<<"$HERDR_SWARM_PRESETS"
	# Exact count or exactly one. A short list quietly defaulting the tail
	# would start agents the caller never named — and every slot is a worktree,
	# a branch, and a process, so "close enough" is not a recoverable guess.
	if [ "${#env_presets[@]}" -ne 1 ] && [ "${#env_presets[@]}" -ne "$n" ]; then
		fatal 1 "herdr-swarm: HERDR_SWARM_PRESETS lists ${#env_presets[@]} preset name(s) but the run has $n slot(s) — give one name per slot, or a single name to apply to all."
	fi
	for ((i = 1; i <= n; i++)); do
		if [ "${#env_presets[@]}" -eq 1 ]; then
			p="${env_presets[0]}"
		else
			p="${env_presets[i - 1]}"
		fi
		# Trim surrounding whitespace so "a, b" reads the same as "a,b"; the
		# name itself is still charset-validated by preset_argv (branch names).
		p="${p#"${p%%[![:space:]]*}"}"
		p="${p%"${p##*[![:space:]]}"}"
		a="$(preset_argv "$p")" || fatal 1 "herdr-swarm: HERDR_SWARM_PRESETS names an unusable preset '$p' (slot $i)."
		preset_names[i]="$p"
		slot_argvs[i]="$a"
	done
else
	require_var HERDR_SWARM_PRESETS "one preset name per slot (comma-separated)"
	echo "Available presets:"
	while IFS=$'\t' read -r pname pargs; do
		[ -n "$pname" ] && printf '  %s — %s\n' "$pname" "$pargs"
	done <<<"$plist"
	for ((i = 1; i <= n; i++)); do
		while :; do
			prompt_line p "Slot $i preset [$default_preset]: "
			[ -n "$p" ] || p="$default_preset"
			if a="$(preset_argv "$p")"; then
				preset_names[i]="$p"
				slot_argvs[i]="$a"
				break
			fi
			# preset_argv printed why; re-prompt with the menu names.
			echo "Pick one of: $(printf '%s' "$plist" | cut -f1 | tr '\n' ' ')"
		done
	done
fi

if [ -n "${HERDR_SWARM_TASK_FILE:-}" ]; then
	# The file wins over HERDR_SWARM_TASK on purpose: it is the channel that can
	# carry a real multi-line brief, so a caller that set both meant this one.
	[ -f "$HERDR_SWARM_TASK_FILE" ] || fatal 1 "herdr-swarm: HERDR_SWARM_TASK_FILE '$HERDR_SWARM_TASK_FILE' is not a readable file."
	shared_task="$(cat "$HERDR_SWARM_TASK_FILE")" || fatal 1 "herdr-swarm: could not read HERDR_SWARM_TASK_FILE '$HERDR_SWARM_TASK_FILE'."
	# Command substitution ate the trailing newline; restore it so the task file
	# has the same shape it gets from the interactive reader (body, then footer).
	shared_task="$shared_task"$'\n'
	TASK_FROM_ENV=1
elif [ -n "${HERDR_SWARM_TASK:-}" ]; then
	shared_task="$HERDR_SWARM_TASK"$'\n'
	TASK_FROM_ENV=1
else
	require_var "HERDR_SWARM_TASK_FILE or HERDR_SWARM_TASK" "the shared task prompt"
	echo "Shared task prompt for all slots — end with a single '.' on its own line:"
	read_task shared_task
fi
trimmed="${shared_task//[[:space:]]/}"
[ -n "$trimmed" ] || fatal 1 "herdr-swarm: empty task prompt — nothing to hand the agents."

for ((i = 1; i <= n; i++)); do
	if [ "$TASK_FROM_ENV" -eq 1 ]; then
		# Per-slot overrides are interactive-only (see the env block up top):
		# the shared task arrived from the environment, so there is no prompt
		# session to elaborate it in.
		slot_tasks[i]="$shared_task"
		continue
	fi
	prompt_line ans "Override the task for slot $i (${preset_names[i]})? [y/N] "
	case "$ans" in
	y | Y | yes | YES)
		echo "Task for slot $i — end with a single '.' on its own line:"
		read_task t
		slot_tasks[i]="$t"
		;;
	*) slot_tasks[i]="$shared_task" ;;
	esac
done

# Every slot's binary is checked BEFORE any create: a missing binary found
# after worktree create would strand a half-built run (R3/R4).
preflight_check_argv "${slot_argvs[@]}" || fatal $?

# --- Run identity and manifest ----------------------------------------------

# Timestamp + urandom nonce, then sanitized: run-unique branch names are the
# defense against stale-run resurrection (worktree create silently reuses an
# existing branch — spike (d6)).
nonce="$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
run_id="$(sanitize_slug "$(date +%Y%m%d-%H%M%S)-$nonce")" || fatal 1 "herdr-swarm: could not generate a run id."
# repo_root is SWARM_REPO itself — the manifest must record the repo every
# later mutation targets, never a rev-parse of whatever cwd this pane
# inherited (that mismatch is exactly the bug this seam closes).
repo_root="$SWARM_REPO"
# Fork SHA recorded once, up front: every later diff and merge measures
# against this, never the moving base tip (R5/R7).
fork_sha="$(repo_git rev-parse --verify "$base_ref^{commit}")" || fatal 1 "herdr-swarm: could not resolve $base_ref."

identity="$(repo_identity_json "$repo_root")" || fatal 1 "herdr-swarm: could not resolve repository identity."
if ! node -e '
	const [run_id, repo_root, base_ref, fork_sha, created_at, identity] = process.argv.slice(1);
	const id = JSON.parse(identity);
	process.stdout.write(JSON.stringify(
		{ run_id, repo_root, repo_key: id.repo_key, git_common_dir: id.git_common_dir,
			base_ref, fork_sha, created_at, exclude_pattern_added: false, slots: [] },
		null, 2));
' "$run_id" "$repo_root" "$base_ref" "$fork_sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$identity" | manifest_write; then
	fatal 1 "herdr-swarm: could not write the run manifest."
fi
active_index_write "$run_id" "$repo_root" || fatal 1 "herdr-swarm: could not write the repository active-run index."

# Once, before the loop: the exclude file is shared repo-wide (resolved via
# --git-path because .git is a file in linked worktrees), so one append
# covers every slot's task file (input-channel KTD).
ensure_exclude_pattern || fatal $? "herdr-swarm: could not update the git exclude file."

# --- Create/start loop -------------------------------------------------------

mark_failed() {
	# mark_failed <slot> <reason…> — R4: a slot failing never unwinds the
	# earlier slots; mark it, count it, keep going. The status update is
	# best-effort (|| true): the pending row already exists write-ahead, and
	# a bookkeeping hiccup here must not abort the remaining slots.
	local slot="$1"
	shift
	echo "herdr-swarm: slot $slot FAILED: $*" >&2
	manifest_update_slot "$slot" '{"status":"failed"}' || true
	failed=$((failed + 1))
}

created=0
started=0
failed=0
setup_failures=0
for ((i = 1; i <= n; i++)); do
	slug="s${i}-${preset_names[i]}" # preset name is sanitize_slug-validated
	branch="swarm/$run_id/$slug"

	# Manifest failures are fatal, not per-slot: without the write-ahead row
	# the superset invariant is gone and abort would have to guess.
	append_slot_row "$i" "$slug" "$branch" "${preset_names[i]}" ||
		fatal 1 "herdr-swarm: manifest write failed before slot $i — stopping before anything is created."

	create_args=(--branch "$branch" --base "$fork_sha")
	if [ -n "${HERDR_WORKSPACE_ID:-}" ]; then
		create_args=(--workspace "$HERDR_WORKSPACE_ID" "${create_args[@]}")
	fi
	if ! out="$(herdr_worktree_create "${create_args[@]}")"; then
		mark_failed "$i" "worktree create refused: ${out:-see messages above}"
		continue
	fi
	if ! info="$(printf '%s' "$out" | parse_create_json)"; then
		mark_failed "$i" "could not parse the worktree-create response"
		continue
	fi
	IFS=$'\t' read -r wt_path slot_ws root_pane_id root_term_id <<<"$info"
	created=$((created + 1))

	# Path and ids recorded BEFORE the agent starts (write-ahead again): if
	# the start fails or this process dies, the worktree is already reapable
	# by recorded path, and until this write lands it is findable by its
	# run-unique branch name.
	patch="$(created_patch_json "$wt_path" "$slot_ws" "$root_pane_id" "$root_term_id")" || fatal 1 "herdr-swarm: internal error building the slot patch."
	manifest_update_slot "$i" "$patch" || fatal 1 "herdr-swarm: manifest write failed recording slot $i — stopping."

	# The task file is the prompt channel (input-channel KTD): presets
	# reference .swarm-task.md by convention, no placeholder substitution.
	if ! {
		printf '%s' "${slot_tasks[i]}"
		printf '\n---\n\n## Standing instructions\n\n'
		printf -- '- Work only in this worktree, on branch %s.\n' "$branch"
		printf -- '- Commit completed work locally as you go.\n'
		printf -- '- Never push. Never switch branches.\n'
	} >"$wt_path/$SWARM_TASK_FILE"; then
		mark_failed "$i" "could not write $SWARM_TASK_FILE in $wt_path"
		continue
	fi

	# Optional per-repo setup hook: fresh worktrees lack gitignored deps
	# (.env, node_modules), the most likely "all my agents failed" cause.
	# Failure warns but does not fail the slot — the agent may not need
	# what setup provides, and the warning names the log for diagnosis.
	setup_hook="${HERDR_PLUGIN_CONFIG_DIR:-}/setup.sh"
	if [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ] && [ -f "$setup_hook" ]; then
		setup_log="$(state_dir)/setup-$run_id-s$i.log"
		if ! (cd "$wt_path" && with_timeout "${HERDR_SWARM_SETUP_TIMEOUT:-300}" bash "$setup_hook") >"$setup_log" 2>&1; then
			echo "herdr-swarm: WARNING slot $i setup.sh failed (see $setup_log) — starting agent anyway" >&2
			setup_failures=$((setup_failures + 1))
		fi
	fi

	read -ra argv_arr <<<"${slot_argvs[i]}"
	agent_name="swarm-$run_id-$slug"
	start_args=("$agent_name")
	[ -n "$slot_ws" ] && start_args+=(--workspace "$slot_ws")
	# --split-from: the anchor the 0.7.5 path splits to build the slot's
	# topology itself (`pane split` takes a PANE_ID and has no --workspace, so
	# without an anchor it would split the user's focused pane). The worktree's
	# own root pane is that anchor. The 0.7.4 branch drops the flag — which
	# path runs is lib.sh's business, not this loop's.
	[ -n "$root_pane_id" ] && start_args+=(--split-from "$root_pane_id")
	# --cwd is EXPLICIT and mandatory on both paths: --workspace alone does
	# NOT put the agent in the worktree — it inherits the server's cwd
	# (spike (k)).
	start_args+=(--cwd "$wt_path" --no-focus -- "${argv_arr[@]}")
	if ! sout="$(herdr_agent_start "${start_args[@]}")"; then
		mark_failed "$i" "agent start failed"
		continue
	fi
	if ! sinfo="$(printf '%s' "$sout" | parse_start_json)"; then
		mark_failed "$i" "could not parse the agent-start response"
		continue
	fi
	IFS=$'\t' read -r a_name a_pane a_term a_ws <<<"$sinfo"
	# Row running with the ids the START returned (spike (k)): the agent's
	# pane, not the worktree root pane recorded above.
	rpatch="$(running_patch_json "$a_name" "$a_pane" "$a_term" "$a_ws")" || fatal 1 "herdr-swarm: internal error building the running patch."
	manifest_update_slot "$i" "$rpatch" || fatal 1 "herdr-swarm: manifest write failed marking slot $i running — stopping."
	started=$((started + 1))
	echo "herdr-swarm: slot $i running — $branch -> $wt_path"
done

# --- Summary and status pane -------------------------------------------------

echo
echo "herdr-swarm: fan-out $run_id complete — created $created, started $started, failed $failed."
if [ "$setup_failures" -gt 0 ]; then
	echo "herdr-swarm: WARNING: setup.sh failed in $setup_failures worktree(s) — agents started anyway; logs in $(state_dir)." >&2
fi
if [ "$failed" -gt 0 ]; then
	echo "herdr-swarm: WARNING: $failed slot(s) FAILED; successful slots were kept (R4). Manifest: $(manifest_path)" >&2
fi

# Status pane last (U4): by now the run is fully recorded, so the status
# renderer reconciles against a complete manifest from its first poll.
if ! herdr_pane_open --entrypoint status-pane --placement split --direction right >/dev/null; then
	echo "herdr-swarm: warning: could not open the Swarm Status pane — run the Status action by hand." >&2
fi

# Keep a partial-failure summary readable: this pane closes when the process
# exits. Lock released first — a lingering pane must never block abort.
release_lock "$MUTATION_LOCK"
if [ "$failed" -gt 0 ]; then
	pane_linger
fi
[ "$failed" -eq 0 ]
