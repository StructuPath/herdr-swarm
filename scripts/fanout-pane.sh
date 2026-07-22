#!/usr/bin/env bash
# Swarm Fan-out pane — the real fan-out flow (U4 of
# docs/plans/2026-07-22-001). This is a PANE, not an action: plugin actions
# receive zero argv and have no TTY (sibling spike fact), so the interactive
# flow lives here.
#
# Every prompt reads line-wise from STDIN — deliberately, so tests can drive
# the whole flow by scripting stdin. Protocol, in order:
#   1. only if leftover swarm detritus exists: one choice line (d / r / q)
#   2. slot count N (re-prompted until the cap check passes)
#   3. per slot 1..N: preset name (empty line = default = first preset)
#   4. shared task prompt: free lines, terminated by a lone "." line
#   5. per slot 1..N: "y" to give that slot its own task (then free lines
#      terminated by a lone "."), anything else keeps the shared prompt
#
# Per-slot ordering is pinned write-ahead (manifest KTD — the manifest must
# stay a superset of git/herdr reality at every instant):
#   pending row (branch known, path null) → worktree create → record
#   path/ids → task file → agent start (explicit --cwd) → row running.
set -uo pipefail

PLUGIN_ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# shellcheck source=scripts/preflight.sh
. "$PLUGIN_ROOT/scripts/preflight.sh" # sources lib.sh itself
# shellcheck source=scripts/presets.sh
. "$PLUGIN_ROOT/scripts/presets.sh"

require_herdr
require_node || exit 1

# Linger budget for error paths: the pane closes with this process, so
# without a linger a fatal message would flash and vanish before the user
# can read it. Tests set HERDR_SWARM_LINGER_SECS=0.
LINGER="${HERDR_SWARM_LINGER_SECS:-600}"

linger() {
	# Garbage/zero in the override skips the sleep instead of erroring: the
	# linger is a courtesy, never worth failing an exit path over.
	case "$LINGER" in
	'' | *[!0-9]* | 0) ;;
	*) sleep "$LINGER" ;;
	esac
}

fatal() {
	# fatal <exit-code> [message…]. Lock released BEFORE the linger: a pane
	# sitting on screen for 10 minutes must never keep holding the mutation
	# lock (abort/harvest would block behind it the whole time).
	local code="$1"
	shift || true
	[ $# -gt 0 ] && echo "$*" >&2
	release_lock "mutate-$(ws_id)"
	linger
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

delete_detritus() {
	local p b
	# Worktrees first: a branch checked out in a worktree cannot be deleted.
	# _swarm_worktrees is preflight.sh's helper — shared on purpose so the
	# prompt acts on exactly the inventory the check reported.
	while IFS=$'\t' read -r p b; do
		[ -n "$p" ] || continue
		# No --force (R11): a dirty leftover refuses loudly here and then
		# blocks the fan-out at the re-check below.
		if git worktree remove "$p"; then
			echo "  removed worktree $p ($b)"
		else
			echo "herdr-swarm: kept $p — dirty or busy; clean it by hand (no --force, R11)." >&2
		fi
	done < <(_swarm_worktrees)
	while IFS= read -r b; do
		[ -n "$b" ] || continue
		# -D, not -d: leftovers are unmerged by definition and the user just
		# chose deletion explicitly; -d would refuse every one of them.
		if git branch -D "$b" >/dev/null 2>&1; then
			echo "  deleted branch $b"
		else
			echo "herdr-swarm: could not delete branch $b (still checked out somewhere?)" >&2
		fi
	done < <(git for-each-ref --format='%(refname:short)' 'refs/heads/swarm')
}

rename_detritus() {
	# Move leftovers out of the swarm/ namespace that preflight scans and the
	# reapers touch; the work stays reachable under swarm-kept/. git updates
	# a checked-out worktree's HEAD on rename, so worktrees survive intact.
	local b
	while IFS= read -r b; do
		[ -n "$b" ] || continue
		if git branch -m "$b" "swarm-kept/${b#swarm/}"; then
			echo "  renamed $b -> swarm-kept/${b#swarm/}"
		else
			echo "herdr-swarm: could not rename branch $b" >&2
		fi
	done < <(git for-each-ref --format='%(refname:short)' 'refs/heads/swarm')
}

# --- Main flow ---------------------------------------------------------------

# The mutation lock spans the WHOLE fan-out including preflight: if it
# covered only the create loop, two racing panes could both pass the
# active-run check and then serialize straight into a double run.
acquire_lock "mutate-$(ws_id)" || exit 1
trap 'release_lock "mutate-$(ws_id)"' EXIT

preflight_check_repo || fatal $?
# Version before anything herdr-shaped: on 0.7.5 nothing may be created and
# nothing else is worth prompting for (R13).
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
	prompt_line choice "Leftover swarm detritus: [d]elete / [r]ename to swarm-kept/ / [q]uit and harvest it first: "
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

while :; do
	prompt_line n "How many agents? "
	preflight_check_slot_cap "$n" && break
	# Cap check printed its own message; re-prompt rather than dying — a
	# typo'd N should not cost the user the whole flow.
done

plist="$(presets_list)" || fatal 1 "herdr-swarm: preset catalog is invalid — fix $(presets_file) and rerun."
default_preset="${plist%%$'\t'*}"
echo "Available presets:"
while IFS=$'\t' read -r pname pargs; do
	[ -n "$pname" ] && printf '  %s — %s\n' "$pname" "$pargs"
done <<<"$plist"

declare -a preset_names slot_argvs slot_tasks
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

echo "Shared task prompt for all slots — end with a single '.' on its own line:"
read_task shared_task
trimmed="${shared_task//[[:space:]]/}"
[ -n "$trimmed" ] || fatal 1 "herdr-swarm: empty task prompt — nothing to hand the agents."

for ((i = 1; i <= n; i++)); do
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
repo_root="$(git rev-parse --show-toplevel)" || fatal 1 "herdr-swarm: could not resolve the repo root."
# Fork SHA recorded once, up front: every later diff and merge measures
# against this, never the moving base tip (R5/R7).
fork_sha="$(git rev-parse --verify "$base_ref^{commit}")" || fatal 1 "herdr-swarm: could not resolve $base_ref."

if ! node -e '
	const [run_id, repo_root, base_ref, fork_sha, created_at] = process.argv.slice(1);
	process.stdout.write(JSON.stringify(
		{ run_id, repo_root, base_ref, fork_sha, created_at, exclude_pattern_added: false, slots: [] },
		null, 2));
' "$run_id" "$repo_root" "$base_ref" "$fork_sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | manifest_write; then
	fatal 1 "herdr-swarm: could not write the run manifest."
fi

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

	read -ra argv_arr <<<"${slot_argvs[i]}"
	agent_name="swarm-$run_id-$slug"
	start_args=("$agent_name")
	[ -n "$slot_ws" ] && start_args+=(--workspace "$slot_ws")
	# --cwd is EXPLICIT and mandatory: --workspace alone does NOT put the
	# agent in the worktree — it inherits the server's cwd (spike (k)).
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
release_lock "mutate-$(ws_id)"
if [ "$failed" -gt 0 ]; then
	linger
fi
[ "$failed" -eq 0 ]
