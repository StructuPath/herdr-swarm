#!/usr/bin/env bash
# Shared helpers for herdr-swarm actions and pane scripts.
#
# Repo invariant (enforced by tests/lib.test.mjs): every herdr invocation in
# this repo goes through a named herdr_* wrapper in this file. herdr
# 0.7.4→0.7.5 broke four CLI surfaces in one week; wrappers keep that churn
# confined to one file and give the version gate a single seam.

HERDR="${HERDR_BIN_PATH:-herdr}"
# shellcheck disable=SC2034  # consumed by sourcing scripts, not here
PLUGIN_ID="structupath.swarm"

state_dir() {
	local d="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr-swarm}"
	# A literal leading '~' inside a variable value is never expanded by bash;
	# expand it ourselves or state silently lands in a per-cwd './~' tree.
	# shellcheck disable=SC2088 # the literal tilde is the match target, on purpose
	case "$d" in
	'~' | '~/'*) d="$HOME${d#\~}" ;;
	esac
	# Relative paths would scatter state across cwds; fall back to the default.
	case "$d" in
	/*) ;;
	*) d="$HOME/.local/state/herdr-swarm" ;;
	esac
	mkdir -p "$d"
	chmod 700 "$d"
	printf '%s\n' "$d"
}

# Workspace id as used in file names (locks, manifest names). herdr owns the
# id, but it is interpolated into paths under state_dir, so only a strict
# charset may pass.
ws_id() {
	local id
	id="$(printf '%s' "${HERDR_WORKSPACE_ID:-default}" | tr -cd 'a-zA-Z0-9_-')"
	printf '%s\n' "${id:-default}"
}

# Anything that becomes a filesystem path component — run ids, slot slugs,
# branch name components — passes through here before use: worktree removal
# is an rm -rf-class operation, so no other charset may ever reach a path.
# Empty-after-strip is an error, never a default: two callers silently
# defaulting to the same name would collide branches across runs.
sanitize_slug() {
	local s
	s="$(printf '%s' "${1-}" | tr -cd 'a-zA-Z0-9_-')"
	if [ -z "$s" ]; then
		echo "herdr-swarm: slug '${1-}' is empty after sanitizing" >&2
		return 1
	fi
	printf '%s\n' "$s"
}

# --- User-repo git -----------------------------------------------------------
# Every git command aimed at the USER'S repo goes through repo_git, and
# repo_git targets $SWARM_REPO — never the ambient cwd. A pane or action
# inherits whatever cwd the herdr server happened to have, so a bare `git`
# silently operates on some other repository: live, a fan-out driven for a
# scratch workspace recorded THIS plugin's repo_root and fork_sha, then failed
# with 'invalid reference' creating the worktree. harvest-step.sh, abort.sh,
# and prune.sh already pass `git -C "$REPO_ROOT"` at every call site; these two
# helpers are the same invariant with a single seam — the seam the parity test
# in tests/lib.test.mjs enforces across every script.

# resolve_repo_root: the workspace's repo, resolved WITHOUT trusting cwd.
# herdr hands each invocation its workspace in HERDR_PLUGIN_CONTEXT_JSON
# (workspace_cwd — spike-out/f-plugin-context-json.txt); $PWD stands in only
# when that is absent or unparseable. Prints the toplevel; fails loudly rather
# than degrading to "whatever repo is nearby", because the whole point is that
# the nearby repo is the wrong one.
resolve_repo_root() {
	local dir="" top
	if [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ] && command -v node >/dev/null 2>&1; then
		# Inline node, not jq — same prereq choice the manifest helpers made.
		dir="$(printf '%s' "$HERDR_PLUGIN_CONTEXT_JSON" | node -e '
			let d = "";
			process.stdin.on("data", (c) => (d += c)).on("end", () => {
				let j;
				try { j = JSON.parse(d); } catch { return; }
				if (typeof j.workspace_cwd === "string") {
					process.stdout.write(j.workspace_cwd);
				}
			});
		' 2>/dev/null)" || dir=""
	fi
	[ -n "$dir" ] || dir="$PWD"
	if ! top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)"; then
		echo "herdr-swarm: $dir is not a git repository — run this from a repo workspace." >&2
		return 1
	fi
	printf '%s\n' "$top"
}

# repo_git: THE seam. `:?` rather than a cwd fallback on purpose — an unset
# SWARM_REPO must fail with its own name, never silently mutate the process's
# ambient repo, which is the exact bug this pair exists to close.
repo_git() {
	git -C "${SWARM_REPO:?SWARM_REPO not set — resolve_repo_root before any repo git call}" "$@"
}

# repo_git_path <name>: ABSOLUTE path to a file inside the repo's git dir
# (info/exclude, info/sparse-checkout). `rev-parse --git-path` answers relative
# to the REPO, and under repo_git the caller's cwd is by definition not the
# repo — using its answer raw would land the write next to whatever directory
# the process happened to sit in. Same normalization harvest-step.sh applies to
# --git-common-dir. --git-path (not $GIT_DIR/…) because .git is a FILE in
# linked worktrees and these files are shared repo-wide.
repo_git_path() {
	local p
	p="$(repo_git rev-parse --git-path "$1")" || return 1
	case "$p" in
	/*) printf '%s\n' "$p" ;;
	*) printf '%s\n' "$SWARM_REPO/$p" ;;
	esac
}

# herdr CLI preflight: a missing binary otherwise surfaces as the wrong error
# ('failed to open pane') downstream.
require_herdr() {
	if ! command -v "$HERDR" >/dev/null 2>&1; then
		echo "herdr-swarm: herdr CLI not found (set HERDR_BIN_PATH)." >&2
		exit 1
	fi
}

# Portable timeout (macOS lacks GNU timeout): poll the child and SIGKILL it
# after SECONDS (exit 137). Done in-shell (no background watchdog) so a dying
# script can never orphan a sleep that holds the caller's stdout pipe open.
with_timeout() {
	local secs="$1"
	shift
	"$@" &
	local pid=$!
	local i=0
	while kill -0 "$pid" 2>/dev/null; do
		if [ "$i" -ge "$((secs * 10))" ]; then
			kill -9 "$pid" 2>/dev/null
			break
		fi
		sleep 0.1
		i=$((i + 1))
	done
	wait "$pid" 2>/dev/null
	return $?
}

# parse_json_field <field> <json>: first "<field>":"<string>" in herdr JSON.
# Whitespace-stripped first so compact and pretty-printed responses both parse
# — which also means it can only read values that contain no whitespace (ids,
# never a cwd path). grep, not node, because the herdr wrappers must stay
# usable on the pane paths that run before require_node.
parse_json_field() {
	printf '%s' "$2" | tr -d ' \n\r\t' | grep -o "\"$1\":\"[^\"]*\"" | head -n1 | cut -d'"' -f4
}

parse_pane_id() {
	parse_json_field pane_id "$1"
}

pane_alive() {
	[ -n "$1" ] && "$HERDR" pane read "$1" --lines 1 >/dev/null 2>&1
}

# --- Repository identity + mutation lock ------------------------------------
# Physical git-common-dir identity is the ownership key. Workspace ids are
# observations only: two Herdr workspaces pointed at one repository must
# contend on one lock and discover one another's live manifests.
safety_state() {
	node "${PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/scripts/safety-state.mjs" "$@"
}

repo_identity_json() {
	require_node || return 1
	safety_state repo "$1"
}

repo_identity_field() {
	local doc="$1" field="$2"
	printf '%s' "$doc" | node -e '
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const value = JSON.parse(d)[process.argv[1]];
			if (typeof value !== "string" || value.length === 0) process.exit(1);
			process.stdout.write(value);
		});
	' "$field"
}

repo_mutation_lock_name() {
	local identity key
	identity="$(repo_identity_json "$1")" || return 1
	key="$(repo_identity_field "$identity" repo_key)" || return 1
	printf 'mutate-repo-%s\n' "$key"
}

bookkeeping_scan() {
	require_node || return 1
	safety_state scan "$(state_dir)" "$1"
}

# Resolve the physical repository before selecting a live generation. An
# explicit Herdr workspace context is authoritative and must never be
# redirected by a stale workspace-named manifest. Without explicit context,
# the legacy manifest remains a discovery hint for reopened workspaces; cwd is
# the final fallback. The selected hint is validated again under the physical
# repository lock by bind_live_manifest_locked before it can authorize use.
discover_live_repo() {
	local hint repo=""
	if [ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ]; then
		resolve_repo_root
		return $?
	fi
	hint="$(state_dir)/run-$(ws_id).json"
	if [ -f "$hint" ] && [ ! -L "$hint" ]; then
		repo="$(node -e '
			const fs=require("fs");
			try { const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
				if(typeof d.repo_root==="string") process.stdout.write(d.repo_root); }
			catch {}
		' "$hint" 2>/dev/null || true)"
	fi
	[ -n "$repo" ] && [ -d "$repo" ] || repo="$(resolve_repo_root 2>/dev/null || true)"
	[ -n "$repo" ] || return 1
	printf '%s\n' "$repo"
}

# Caller holds repo_mutation_lock_name(repo). Exactly one semantically valid
# live manifest may be selected; zero is MANIFEST_EC_MISSING and multiples or
# unknown bookkeeping fail closed through bookkeeping_assert_known.
resolve_live_manifest_locked() {
	local repo_root="$1" scan
	scan="$(bookkeeping_scan "$repo_root")" || return 1
	bookkeeping_assert_known "$scan" || return $?
	printf '%s' "$scan" | node -e '
		let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
			const live=JSON.parse(d).live||[];
			if(live.length===0) process.exit(2);
			if(live.length!==1) process.exit(3);
			process.stdout.write(live[0].path+"\n");
		});
	'
}

# A workspace-named legacy manifest may participate only when it is the exact
# generation selected by the locked repository scan. A foreign/stale hint is
# never ignored in favor of a convenient candidate: fail closed before any
# pane, Git, manifest, or archive mutation.
validate_workspace_manifest_hint_locked() {
	local selected="$1" hint
	hint="$(state_dir)/run-$(ws_id).json"
	if [ -e "$hint" ] || [ -L "$hint" ]; then
		if [ -L "$hint" ] || [ ! -f "$hint" ] || ! node -e '
			const path=require("path");
			process.exit(path.resolve(process.argv[1])===path.resolve(process.argv[2]) ? 0 : 1);
		' "$hint" "$selected"; then
			echo "herdr-swarm: bookkeeping_unknown: workspace manifest hint $hint does not match the locked live generation $selected" >&2
			return "$MANIFEST_EC_CORRUPT"
		fi
	fi
}

bind_live_manifest_locked() {
	local selected
	selected="$(resolve_live_manifest_locked "$1")" || return $?
	validate_workspace_manifest_hint_locked "$selected" || return $?
	HERDR_SWARM_MANIFEST_PATH="$selected"
	export HERDR_SWARM_MANIFEST_PATH
}

bookkeeping_assert_known() {
	local scan="$1"
	printf '%s' "$scan" | node -e '
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const scan = JSON.parse(d);
			if ((scan.errors || []).length === 0) return;
			for (const error of scan.errors) console.error("herdr-swarm: bookkeeping_unknown: " + error);
			process.exit(3);
		});
	'
}

active_index_write() {
	local run_id="$1" repo_root="$2" mf identity key dst tmp
	mf="$(manifest_path)" || return 1
	identity="$(repo_identity_json "$repo_root")" || return 1
	key="$(repo_identity_field "$identity" repo_key)" || return 1
	dst="$(state_dir)/active-repo-$key.json"
	tmp="$dst.tmp.$$"
	node -e '
		const fs = require("fs");
		const [dst, runId, manifestPath, identity] = process.argv.slice(1);
		const id = JSON.parse(identity);
		const doc = { repo_key: id.repo_key, git_common_dir: id.git_common_dir,
			run_id: runId, manifest_path: manifestPath };
		fs.writeFileSync(dst, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
	' "$tmp" "$run_id" "$mf" "$identity" || {
		rm -f "$tmp"
		return 1
	}
	mv "$tmp" "$dst"
}

active_index_remove() {
	local repo_root="$1" run_id="$2" identity key dst
	identity="$(repo_identity_json "$repo_root")" || return 1
	key="$(repo_identity_field "$identity" repo_key)" || return 1
	dst="$(state_dir)/active-repo-$key.json"
	[ -e "$dst" ] || return 0
	node -e '
		const fs = require("fs");
		const [file, key, runId] = process.argv.slice(1);
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink()) process.exit(2);
		const doc = JSON.parse(fs.readFileSync(file, "utf8"));
		if (doc.repo_key !== key || doc.run_id !== runId) process.exit(2);
		fs.unlinkSync(file);
	' "$dst" "$key" "$run_id"
}

cleanup_operation_id() {
	safety_state operation-id
}

slot_resource_binding() {
	local repo_root="$1" run_id="$2" slot="$3" wt="$4" identity physical head
	identity="$(repo_identity_json "$repo_root")" || return 1
	physical="$(cd "$wt" 2>/dev/null && pwd -P)" || return 1
	head="$(git -C "$physical" rev-parse --verify 'HEAD^{commit}')" || return 1
	node -e '
		const [identity,runId,slot,worktree,head]=process.argv.slice(1), id=JSON.parse(identity);
		process.stdout.write(JSON.stringify({resource_type:"slot",repo_key:id.repo_key,
			git_common_dir:id.git_common_dir,run_id:runId,slot,worktree,
			generation:"slot-worktree",head}));
	' "$identity" "$run_id" "$slot" "$physical" "$head"
}

cleanup_inventory() {
	local repo_root="$1" binding="$2" operation_id="$3"
	safety_state inventory "$repo_root" "$binding" "$operation_id"
}

slot_ignored_inventory() {
	local repo_root="$1" run_id="$2" slot="$3" wt="$4" operation_id="$5" binding
	binding="$(slot_resource_binding "$repo_root" "$run_id" "$slot" "$wt")" || return 1
	cleanup_inventory "$repo_root" "$binding" "$operation_id"
}

verify_harvest_resource() {
	local run_id="$1" slot="$2" wt="$3" journal="$4"
	safety_state verify-harvest "$(state_dir)" "${SWARM_REPO:?}" "$run_id" "$slot" "$wt" "$journal" "$(manifest_path)"
}

harvest_ignored_inventory() {
	local repo_root="$1" run_id="$2" slot="$3" wt="$4" journal="$5" operation_id="$6" binding
	binding="$(verify_harvest_resource "$run_id" "$slot" "$wt" "$journal")" || return 1
	cleanup_inventory "$repo_root" "$binding" "$operation_id"
}

# The sole git-removal surface for detached harvest resources. Identity and
# recursive ignored inventory are checked twice, immediately around the
# no-force removal. Ignored data requires the exact one-use approval.
remove_harvest_resource() {
	local run_id="$1" slot="$2" wt="$3" journal="$4" operation inventory count used rechecked before after binding
	binding="$(verify_harvest_resource "$run_id" "$slot" "$wt" "$journal")" || return 36
	operation="$(printf '%s' "${HERDR_SWARM_CLEANUP_APPROVAL:-}" | node -e '
		let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d);if(a.operation_id)process.stdout.write(String(a.operation_id));}catch{}});
	')"
	[ -n "$operation" ] || operation="$(cleanup_operation_id)" || return 1
	inventory="$(cleanup_inventory "$SWARM_REPO" "$binding" "$operation")" || return 1
	count="$(cleanup_inventory_count "$inventory")" || return 1
	if [ "$count" -gt 0 ]; then
		used="$(cleanup_approval_validate "$inventory")" || {
			print_cleanup_inventory "$inventory"
			echo "herdr-swarm: harvest worktree holds ignored files; apply requires this exact one-use cleanup approval." >&2
			return 37
		}
	fi
	if [ -n "${HERDR_SWARM_TEST_CLEANUP_READY_FILE:-}" ]; then : >"$HERDR_SWARM_TEST_CLEANUP_READY_FILE"; fi
	if [ -n "${HERDR_SWARM_TEST_PAUSE_BEFORE_CLEANUP_RECHECK:-}" ]; then sleep "$HERDR_SWARM_TEST_PAUSE_BEFORE_CLEANUP_RECHECK"; fi
	binding="$(verify_harvest_resource "$run_id" "$slot" "$wt" "$journal")" || return 36
	rechecked="$(cleanup_inventory "$SWARM_REPO" "$binding" "$operation")" || return 1
	before="$(printf '%s' "$inventory" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).digest))')"
	after="$(printf '%s' "$rechecked" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).digest))')"
	if [ "$before" != "$after" ]; then
		print_cleanup_inventory "$rechecked"
		echo "herdr-swarm: harvest cleanup inventory changed after preview; zero removal performed." >&2
		return 37
	fi
	if [ "$count" -gt 0 ]; then cleanup_approval_consume "$used" || return 36; fi
	git -C "$SWARM_REPO" worktree remove "$wt" || return 1
	safety_state verify-harvest-removed "$SWARM_REPO" "$binding" || return 1
}

cleanup_inventory_count() {
	printf '%s' "$1" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(String(JSON.parse(d).count)))'
}

print_cleanup_inventory() {
	printf '%s' "$1" | node -e '
		let d="";
		process.stdin.on("data",c=>d+=c).on("end",()=>{
			const i=JSON.parse(d);
			console.log("cleanup_operation\t" + i.operation_id);
			console.log("cleanup_digest\t" + i.digest);
			if (i.count > 0) {
				const approval={approved:true};
				for (const k of ["resource_type","repo_key","git_common_dir","run_id","slot","worktree","generation","head","operation_id","digest"]) approval[k]=i[k];
				console.log("cleanup_approval\t" + JSON.stringify(approval));
			}
			for (const p of i.paths_display) console.log("ignored_json\t" + JSON.stringify(p));
		});
	'
}

cleanup_approval_validate() {
	local inventory="$1" approval="${HERDR_SWARM_CLEANUP_APPROVAL:-}"
	[ -n "$approval" ] || return 2
	printf '%s' "$approval" | safety_state approval "$inventory" "$(state_dir)"
}

cleanup_approval_consume() {
	local used="$1" approval="${HERDR_SWARM_CLEANUP_APPROVAL:-}"
	printf '%s' "$approval" | safety_state consume "$used" >/dev/null
}

# One mkdir+PID-token lock per caller-supplied name (e.g. the per-repo
# mutation lock shared by fan-out, harvest, abort, and prune — an abort must
# never reap a worktree mid-merge). mkdir is the portable atomic lock; the
# PID token means a holder's cleanup can never remove a stealer's fresh lock.
# After the wait budget a lock may be stolen — but only when the holder's PID
# is actually dead (kill -0): a legitimate hold can span a long merge, so
# elapsed time alone must never break mutual exclusion. Each waiter steals at
# most once, then keeps waiting; the steal removes only the known token file
# + dir, never an rm -rf of a foreign path.
#
# Callers pair acquire_lock with `trap 'release_lock <name>' EXIT` —
# release_lock only removes a lock this process owns, so the trap is safe
# even after a steal.
acquire_lock() {
	local name lock tries_max tries stolen holder
	name="$(sanitize_slug "${1-}")" || return 1
	lock="$(state_dir)/lock-$name"
	# Garbage in the override falls back to the default instead of looping forever.
	case "${HERDR_SWARM_LOCK_TRIES:-20}" in
	'' | *[!0-9]*) tries_max=20 ;;
	*) tries_max="${HERDR_SWARM_LOCK_TRIES:-20}" ;;
	esac
	tries=0
	stolen=0
	until mkdir "$lock" 2>/dev/null; do
		tries=$((tries + 1))
		if [ "$tries" -gt "$tries_max" ] && [ "$stolen" -eq 0 ]; then
			holder="$(cat "$lock/pid" 2>/dev/null || true)"
			if [ -z "$holder" ] || ! kill -0 "$holder" 2>/dev/null; then
				rm -f "$lock/pid" 2>/dev/null
				rmdir "$lock" 2>/dev/null || true
				stolen=1
				tries=0
			fi
		fi
		sleep 0.1
	done
	printf '%s\n' "$$" >"$lock/pid"
}

release_lock() {
	local name lock
	name="$(sanitize_slug "${1-}")" || return 1
	lock="$(state_dir)/lock-$name"
	# Only the owner releases: after a steal, the crashed holder's trap must
	# not remove the stealer's lock out from under it.
	if [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ]; then
		rm -f "$lock/pid"
		rmdir "$lock" 2>/dev/null
	fi
}

# --- Version gate ------------------------------------------------------------

# Newest herdr version this plugin has been exercised against; intersection
# calls warn (never refuse) above it — R13.
HERDR_SWARM_MAX_TESTED="0.7.5"

# Prints e.g. "0.7.4" from `herdr --version` ("herdr 0.7.4"). Last field, not
# a fixed column, so a wrapper script that prefixes output can't break the
# parse; anything non-numeric fails loudly rather than passing the gate.
herdr_version() {
	local out
	out="$(with_timeout 5 "$HERDR" --version 2>/dev/null)" || return 1
	out="${out##* }"
	case "$out" in
	[0-9]*.[0-9]*) printf '%s\n' "$out" ;;
	*) return 1 ;;
	esac
}

# version_ge <a> <b>: true when dotted version a >= b. Field-wise NUMERIC
# compare, deliberately not a string compare: lexically "0.7.10" sorts below
# "0.7.9", which would refuse a newer herdr as too old — the exact failure
# this gate exists to avoid. Trailing non-digits in a field (rc/beta suffixes)
# are dropped rather than compared: ordering pre-releases is out of scope, and
# a `[ -gt ]` on "5-rc1" would abort the gate with a syntax error.
version_ge() {
	local a="${1-}" b="${2-}" af bf
	while [ -n "$a" ] || [ -n "$b" ]; do
		af="${a%%.*}"
		bf="${b%%.*}"
		af="${af%%[!0-9]*}"
		bf="${bf%%[!0-9]*}"
		[ -n "$af" ] || af=0
		[ -n "$bf" ] || bf=0
		[ "$af" -gt "$bf" ] && return 0
		[ "$af" -lt "$bf" ] && return 1
		case "$a" in *.*) a="${a#*.}" ;; *) a="" ;; esac
		case "$b" in *.*) b="${b#*.}" ;; *) b="" ;; esac
	done
	return 0
}

# version_gate <gated|intersection>
# 'gated' guards fan-out, the only flow that CREATES herdr topology. It runs
# on two different code paths — `agent start --cwd/--workspace` on 0.7.4, and
# pane split + pane run + report-agent on 0.7.5+ (both live-verified;
# spike-out/l-075-verified.txt) — so the gate is now a floor, not a pin:
# below 0.7.4 neither path exists. herdr_agent_start picks the path.
# 'intersection' calls survive the 0.7.4→0.7.5 break untouched and are never
# refused. Both classes warn above the max tested version (R13): untested is
# not the same as unsupported, and refusing would strand users on every herdr
# release until this repo catches up.
version_gate() {
	local class="${1-}" v
	v="$(herdr_version)" || {
		echo "herdr-swarm: cannot determine herdr version (is '$HERDR' the herdr CLI?)" >&2
		return 1
	}
	case "$class" in
	gated)
		if ! version_ge "$v" "0.7.4"; then
			echo "herdr-swarm: fan-out needs herdr 0.7.4 or newer (no topology-creating form exists below it); herdr $v has no compatible form. Harvest and cleanup of an existing run still work." >&2
			return 1
		fi
		;;
	intersection) ;;
	*)
		# Fail closed: a typo'd class must never silently pass a gated call.
		echo "herdr-swarm: internal error: unknown version_gate class '$class'" >&2
		return 1
		;;
	esac
	if ! version_ge "$HERDR_SWARM_MAX_TESTED" "$v"; then
		echo "herdr-swarm: warning: herdr $v is newer than tested ($HERDR_SWARM_MAX_TESTED); proceeding." >&2
	fi
	return 0
}

# --- Named herdr wrappers ----------------------------------------------------
# Every herdr invocation outside this file goes through one of these
# (tests/lib.test.mjs greps for violations). All honor HERDR_BIN_PATH via
# $HERDR and run under with_timeout — a hung herdr socket must never hang a
# destructive verb script forever. worktree wrappers append --json themselves
# (callers must not) so machine-readable output is an invariant, not a
# per-call-site choice; agent/pane/workspace subcommands emit JSON by default
# on 0.7.4 (spike-verified), so no flag exists to add.

# 60s: create does real git work (checkout of a fresh worktree) and is slow
# on big repos; the UI-fast 5-15s budgets would kill legitimate creates.
herdr_worktree_create() {
	with_timeout 60 "$HERDR" worktree create "$@" --json
}

# --force is refused here, not just discouraged: R11 says never --force by
# default, and dirty state must fail noisily into the R9 prompt. A future
# user-confirmed force path extends this wrapper; callers never bypass it.
herdr_worktree_remove() {
	local a
	for a in "$@"; do
		if [ "$a" = "--force" ]; then
			echo "herdr-swarm: internal error: herdr_worktree_remove refuses --force (R11)" >&2
			return 1
		fi
	done
	with_timeout 30 "$HERDR" worktree remove "$@" --json
}

herdr_worktree_list() {
	with_timeout 10 "$HERDR" worktree list "$@" --json
}

# THE gated call, and THE seam: two herdr topologies behind one contract.
#
# Callers always pass the 0.7.4 argv shape — `<name> [--workspace WS]
# [--split-from PANE] --cwd PATH [--no-focus] -- <argv…>` — and always get the
# 0.7.4 agent-start JSON back, so no call site learns which path ran.
#
#   0.7.4: `agent start --cwd/--workspace` builds the topology itself.
#   0.7.5+: that form is gone. `--kind` replaced it and is a CLOSED whitelist
#           validated server-side ("unsupported interactive agent kind"), with
#           no custom/shell/exec member — an arbitrary binary CANNOT be a
#           tracked agent there (live-verified, spike-out/l-075-verified.txt).
#           R2 (agent-agnostic slots) therefore cannot go through `agent start`
#           at all, so we build the topology ourselves instead: split a pane in
#           the worktree, run the slot's argv in it, report the agent state
#           herdr can no longer detect for us.
herdr_agent_start() {
	local v
	version_gate gated || return 1
	v="$(herdr_version)" || return 1
	if version_ge "$v" "0.7.5"; then
		_agent_start_via_pane "$@"
	else
		_agent_start_native "$@"
	fi
}

# 0.7.4 path: verbatim passthrough, minus --split-from. The flag exists only
# for the 0.7.5 path; forwarding it would make 0.7.4's own arg parser reject
# the start, so it is dropped here rather than made conditional at the call
# site (the call site must stay path-blind).
_agent_start_native() {
	local -a args=()
	# A no-arg call is a caller bug; say so, because on macOS's bash 3.2
	# "${args[@]}" of an EMPTY array under `set -u` dies as "unbound
	# variable" — a message that names neither this function nor the mistake.
	if [ $# -eq 0 ]; then
		echo "herdr-swarm: internal error: herdr_agent_start called with no arguments" >&2
		return 1
	fi
	while [ $# -gt 0 ]; do
		case "$1" in
		--split-from)
			shift 2
			;;
		*)
			args+=("$1")
			shift
			;;
		esac
	done
	with_timeout 15 "$HERDR" agent start "${args[@]}"
}

# 0.7.5+ path: pane split (in the worktree) → pane run (the slot's argv) →
# report-agent (so the slot is an agent to `agent list` and the status pane).
# Emits a synthesized 0.7.4-shaped agent-start response — normalizing HERE,
# not at the call site, is the whole point of the seam.
_agent_start_via_pane() {
	local name="${1-}" ws="" cwd="" from="" out pane term pws
	local -a argv=()
	shift || true
	while [ $# -gt 0 ]; do
		case "$1" in
		--workspace)
			ws="${2-}"
			shift 2
			;;
		--cwd)
			cwd="${2-}"
			shift 2
			;;
		--split-from)
			from="${2-}"
			shift 2
			;;
		# `pane split` gets its own --no-focus below; the caller's copy is
		# consumed here rather than forwarded blindly.
		--no-focus) shift ;;
		--)
			shift
			argv=("$@")
			break
			;;
		*)
			# Never drop an unknown flag: a caller-requested option silently
			# discarded on 0.7.5 would start the slot with settings the user
			# got on 0.7.4 and never got here — a difference nothing reports.
			echo "herdr-swarm: internal error: herdr_agent_start cannot translate '$1' to the 0.7.5 pane path" >&2
			return 1
			;;
		esac
	done

	# The agent label is interpolated into the JSON this function synthesizes
	# and passed to herdr as --agent; callers build it from sanitize_slug'd
	# parts, so anything else is a bug upstream, not input to escape.
	case "$name" in
	'' | *[!a-zA-Z0-9_-]*)
		echo "herdr-swarm: internal error: agent name '$name' is not slug-safe" >&2
		return 1
		;;
	esac
	# --cwd is the whole reason this path exists: a split without it inherits
	# the herdr server's cwd (spike (k)), so the agent would run in whatever
	# repo the server happened to sit in instead of the slot's worktree.
	if [ -z "$cwd" ] || [ ! -d "$cwd" ]; then
		echo "herdr-swarm: internal error: herdr_agent_start needs an existing --cwd (got '$cwd')" >&2
		return 1
	fi
	# `pane split` has no --workspace (live-verified: it takes a PANE_ID and
	# splits that pane's workspace). Without an explicit anchor it would split
	# the FOCUSED pane — the user's own, in some unrelated workspace.
	if [ -z "$from" ]; then
		echo "herdr-swarm: internal error: herdr_agent_start needs --split-from <pane id> on herdr 0.7.5+" >&2
		return 1
	fi
	if [ "${#argv[@]}" -eq 0 ]; then
		echo "herdr-swarm: internal error: herdr_agent_start got no agent argv after '--'" >&2
		return 1
	fi

	out="$(herdr_pane_split "$from" --direction down --cwd "$cwd" --no-focus)" || {
		echo "herdr-swarm: pane split failed for $name" >&2
		return 1
	}
	pane="$(parse_json_field pane_id "$out")"
	term="$(parse_json_field terminal_id "$out")"
	pws="$(parse_json_field workspace_id "$out")"
	# The split's own workspace is authoritative (it inherits the anchor
	# pane's); the caller's --workspace is only a fallback for a response
	# that omitted the field.
	[ -n "$pws" ] || pws="$ws"
	if [ -z "$pane" ]; then
		echo "herdr-swarm: pane-split response has no pane_id" >&2
		return 1
	fi

	if ! herdr_pane_run "$pane" "${argv[@]}"; then
		# Close the pane we just made: the caller records ids only from a
		# SUCCESSFUL start, so an empty split left behind here is a pane no
		# manifest row names and no abort sweep can reap.
		herdr_pane_close "$pane" >/dev/null 2>&1 || true
		echo "herdr-swarm: pane run failed for $name" >&2
		return 1
	fi

	# Plugin-reported, because herdr cannot detect an arbitrary binary as an
	# agent on 0.7.5. Best-effort: the slot IS running by now, and agent state
	# is advisory everywhere in this plugin (harvest never gates on it), so
	# failing the slot over a status-only call would destroy real work to
	# protect a cosmetic.
	herdr_report_agent "$pane" --agent "$name" --state working >/dev/null 2>&1 ||
		echo "herdr-swarm: warning: could not report agent state for $name — the status pane will show it as unknown" >&2

	# The 0.7.4 agent_started shape, rebuilt from what the split returned:
	# this is the output contract every caller parses (name/pane/terminal/
	# workspace). Ids come from herdr's own JSON and the name is slug-checked
	# above, so no field here can carry a quote.
	printf '{"id":"cli:pane:split","result":{"agent":{"name":"%s","pane_id":"%s","terminal_id":"%s","workspace_id":"%s"},"type":"agent_started"}}\n' \
		"$name" "$pane" "$term" "$pws"
}

herdr_agent_list() {
	with_timeout 10 "$HERDR" agent list "$@"
}

# agent wait blocks by design, so with_timeout can't govern it without
# double-budgeting; herdr's own --timeout MS is the budget. Requiring the
# flag here means no call site can accidentally wait forever on a wedged
# agent.
herdr_agent_wait() {
	case " $* " in
	*" --timeout "*) ;;
	*)
		echo "herdr-swarm: internal error: herdr_agent_wait requires --timeout MS" >&2
		return 1
		;;
	esac
	"$HERDR" agent wait "$@"
}

herdr_agent_focus() {
	with_timeout 5 "$HERDR" agent focus "$@"
}

# Plugin panes only: --plugin is pinned so a call site can never open a pane
# under another plugin's id.
herdr_pane_open() {
	with_timeout 15 "$HERDR" plugin pane open --plugin "$PLUGIN_ID" "$@"
}

# Generic `pane close`, deliberately not `plugin pane close`: the
# plugin-scoped variant no-ops across plugin re-registrations, which is
# exactly when a cleanup sweep matters most.
herdr_pane_close() {
	with_timeout 5 "$HERDR" pane close "$@"
}

herdr_pane_list() {
	with_timeout 10 "$HERDR" pane list "$@"
}

herdr_workspace_close() {
	with_timeout 10 "$HERDR" workspace close "$@"
}

herdr_report_metadata() {
	with_timeout 5 "$HERDR" pane report-metadata "$@"
}

# 15s: a split does real terminal setup — the same budget as the 0.7.4
# `agent start` it stands in for.
herdr_pane_split() {
	with_timeout 15 "$HERDR" pane split "$@"
}

# `pane run <pane_id> <command>…` TYPES the command into the pane's SHELL —
# live-verified on 0.7.5 (`pane run <id> echo '$HOME'` printed the expanded
# home directory), so this is not an exec. argv elements are passed as
# separate COMMAND arguments because that is the CLI's own signature; herdr
# joins them with single spaces, which is exactly the whitespace-split argv
# presets.sh already documents. A preset carrying shell metacharacters IS
# interpreted here (unlike the 0.7.4 exec path) — README says so, and
# presets.conf is user-owned config, the same trust level as the binary it
# names.
herdr_pane_run() {
	with_timeout 10 "$HERDR" pane run "$@"
}

# --source is pinned to this plugin's id, like herdr_pane_open pins --plugin:
# herdr keys reported agent rows by source, so a call site inventing its own
# would orphan a row no later report of ours could ever update.
herdr_report_agent() {
	local pane="${1-}"
	shift || true
	with_timeout 5 "$HERDR" pane report-agent "$pane" --source "$PLUGIN_ID" "$@"
}

# report_slot_agent_state <pane_id> <agent label> <idle|working|blocked|unknown>
# Correct a plugin-reported slot's agent state. NO-OP below 0.7.5: there herdr
# detects the slot's agent natively, and a plugin report would fight that
# detection rather than add to it. Best-effort by contract — agent state is
# advisory everywhere in this plugin, so this must never fail a caller whose
# real job is merging or archiving work.
report_slot_agent_state() {
	local pane="${1-}" label="${2-}" state="${3-}" v
	[ -n "$pane" ] && [ -n "$label" ] && [ -n "$state" ] || return 0
	v="$(herdr_version 2>/dev/null)" || return 0
	version_ge "$v" "0.7.5" || return 0
	herdr_report_agent "$pane" --agent "$label" --state "$state" >/dev/null 2>&1 || true
	return 0
}

# --- Singleton panes and pane linger -----------------------------------------

# open_singleton_pane <kind> <entrypoint>: the shared launcher body of
# status.sh and harvest.sh — serialize the open, no-op on a live pane, record
# the new pane id. <kind> names both the lock ("<kind>-open-…") and the
# pidfile ("<kind>-pane-…"); abort.sh sweeps by exactly those names, so the
# naming is an interface, not a convention.
open_singleton_pane() {
	local kind="$1" entrypoint="$2" pidfile existing out pane_id
	# Serialize concurrent invokes: pane open is not idempotent (sibling
	# spike), so two racing actions would each open a pane. Same mkdir+PID
	# lock every launcher uses; scoped per workspace like the pane itself.
	# The lock name is deliberately NOT local: the EXIT trap fires after this
	# function's locals are gone.
	_open_lock="$kind-open-$(ws_id)"
	acquire_lock "$_open_lock" || return 1
	trap 'release_lock "$_open_lock"' EXIT
	# Single-instance guard: recorded pane id + liveness. A recorded id whose
	# pane died (herdr restart, user closed it) is a stale record — drop it
	# and open fresh instead of silently doing nothing.
	pidfile="$(state_dir)/$kind-pane-$(ws_id)"
	existing=""
	[ -f "$pidfile" ] && existing="$(cat "$pidfile")"
	if pane_alive "$existing"; then
		echo "herdr-swarm: $kind pane already open ($existing)."
		return 0
	fi
	rm -f "$pidfile"
	out="$(herdr_pane_open --entrypoint "$entrypoint" --placement split --direction right --focus)" || {
		echo "herdr-swarm: failed to open the $kind pane" >&2
		return 4
	}
	pane_id="$(parse_pane_id "$out")"
	if [ -n "$pane_id" ]; then
		# Recorded so the next invoke can find (and not duplicate) this pane,
		# and so abort's manifest-tracked pane sweep can close it.
		printf '%s\n' "$pane_id" >"$pidfile"
	else
		echo "herdr-swarm: warning: could not parse pane id from pane-open output" >&2
		rm -f "$pidfile"
	fi
}

# pane_linger: hold a pane's last message on screen — the pane closes with
# its process, so an instant exit reads as a crash. Tests set
# HERDR_SWARM_LINGER_SECS=0; garbage/zero skips the sleep instead of erroring
# (the linger is a courtesy, never worth failing an exit path over).
pane_linger() {
	local secs="${HERDR_SWARM_LINGER_SECS:-600}"
	case "$secs" in
	'' | *[!0-9]* | 0) ;;
	*) sleep "$secs" ;;
	esac
}

# pane_fatal <message>: print + linger + exit 1 — every early pane-script
# failure routes through here so the message stays readable.
pane_fatal() {
	echo "$1"
	pane_linger
	exit 1
}

# pane_require_node <pane-name>: the renderer is Node; a missing binary must
# fail with a message naming this pane, not a cryptic exec error.
pane_require_node() {
	command -v node >/dev/null 2>&1 ||
		pane_fatal "herdr-swarm: node not found on PATH (node >=20 is required for the $1)."
}

# pane_export_context <mode> <manifest-path>: the spawn-time env contract
# between the pane scripts and bin/renderer.mjs (spawn-time env is the only
# channel into the pane process — state-dir rule). Variable names and values
# are load-bearing: the renderer and tests read exactly these.
pane_export_context() {
	export HERDR_SWARM_PANE_MODE="$1"
	export HERDR_SWARM_MANIFEST="$2"
	HERDR_SWARM_WS_ID="$(ws_id)"
	export HERDR_SWARM_WS_ID
}

# --- Run manifest ------------------------------------------------------------
# The backbone artifact (KTD): one JSON file per run, written ahead of every
# mutation so abort can over-approximate and verify, never guess. Schema:
#   { run_id, repo_root, base_ref (fully-qualified refs/heads/<x>), fork_sha,
#     created_at, exclude_pattern_added, slots: [ { slot, label, branch, path,
#     workspace_id, pane_id, terminal_id, agent_name, self_created,
#     status: pending|running|failed|settled|merged|skipped|archived,
#     backup_ref, journal: {locus, expected_base_sha, merge_commit_sha} } ] }
# path/ids are null until herdr returns them (write-ahead pending rows);
# backup_ref/journal are null until a discard snapshot / merge intent exists.
#
# JSON work is inline node, not jq: node >=20 is already a plugin prereq
# (package.json engines) while jq is not installed anywhere by default —
# same choice the sibling's close.sh made for its pane sweep.

# Distinct read codes so destructive callers can branch without
# string-matching stderr: missing (2) means "no run" — a normal state —
# while corrupt (3) means "unknown state": destructive callers must refuse
# and degrade to report_only_discovery (preflight.sh).
# shellcheck disable=SC2034  # consumed by sourcing scripts as well as here
MANIFEST_EC_MISSING=2
MANIFEST_EC_CORRUPT=3

# node runs every manifest read/write; a missing binary must fail with its
# own name, not surface as a cryptic downstream JSON error.
require_node() {
	if ! command -v node >/dev/null 2>&1; then
		echo "herdr-swarm: node not found on PATH (node >=20 is required)." >&2
		return 1
	fi
}

manifest_path() {
	if [ -n "${HERDR_SWARM_MANIFEST_PATH:-}" ]; then
		printf '%s\n' "$HERDR_SWARM_MANIFEST_PATH"
	else
		printf '%s/run-%s.json\n' "$(state_dir)" "$(ws_id)"
	fi
}

# manifest_write: full manifest JSON on stdin → $(manifest_path). The order
# is load-bearing: validate → .bak → temp+fsync → rename → dir fsync.
# Validation first so a buggy writer can never replace a good manifest with
# garbage; the .bak copy before the rename keeps the previous generation
# recoverable; fsync before rename (then the directory) so a crash right
# after "success" can't leave the zero-length file manifest_read calls
# corrupt. The temp lives next to the target because rename(2) is only
# atomic within one filesystem.
manifest_write() {
	local mf
	mf="$(manifest_path)" || return 1
	require_node || return 1
	if [ -f "$mf" ]; then
		cp -p "$mf" "$mf.bak" || return 1
	fi
	node -e '
		const fs = require("fs"), path = require("path");
		const dst = process.argv[1], tmp = dst + ".tmp." + process.pid;
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			JSON.parse(d); // throws => nonzero exit, nothing touched on disk
			const fd = fs.openSync(tmp, "w");
			fs.writeSync(fd, d);
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			fs.renameSync(tmp, dst);
			// Persist the rename itself; best-effort (dir fsync is EINVAL on
			// some filesystems, and the data is already safe by this point).
			try {
				const dfd = fs.openSync(path.dirname(dst), "r");
				fs.fsyncSync(dfd);
				fs.closeSync(dfd);
			} catch {}
		});
	' "$mf"
}

# manifest_read: prints the manifest to stdout. 0 ok, MANIFEST_EC_MISSING no
# manifest, MANIFEST_EC_CORRUPT empty/unparseable. node's own parse stack is
# suppressed — our one-line message with the .bak pointer is the actionable
# part.
manifest_read() {
	local mf
	mf="$(manifest_path)" || return 1
	[ -e "$mf" ] || return "$MANIFEST_EC_MISSING"
	if [ -L "$mf" ] || [ ! -f "$mf" ]; then
		echo "herdr-swarm: manifest $mf is not a regular non-symlink file (corrupt); .bak is recovery inventory only" >&2
		return "$MANIFEST_EC_CORRUPT"
	fi
	if [ ! -s "$mf" ]; then
		echo "herdr-swarm: manifest $mf is zero-length (corrupt); previous generation may be in $mf.bak" >&2
		return "$MANIFEST_EC_CORRUPT"
	fi
	require_node || return 1
	if ! node -e '
		const fs = require("fs");
		const raw = fs.readFileSync(process.argv[1], "utf8");
		JSON.parse(raw);
		process.stdout.write(raw);
	' "$mf" 2>/dev/null; then
		echo "herdr-swarm: manifest $mf is unparseable (corrupt); previous generation may be in $mf.bak" >&2
		return "$MANIFEST_EC_CORRUPT"
	fi
}

# manifest_run_context <doc>: the run-level fields every destructive caller
# needs — run_id, repo_root, base_ref, fork_sha — printed as one \x1f-joined
# line. Unit separator, not tab: tab is IFS *whitespace*, so an empty
# nullable field would silently shift every later column (fork_sha may be
# empty; abort ignores it). The emptiness/dir guard lives HERE (a manifest
# without a usable run_id/repo_root must never feed an rm -rf-class caller),
# but the refusal MESSAGE stays at each call site — abort and harvest word
# their refusals differently on purpose.
manifest_run_context() {
	local out run_id repo_root rest
	out="$(printf '%s' "$1" | node -e '
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const doc = JSON.parse(d);
			process.stdout.write(
				[doc.run_id, doc.repo_root, doc.base_ref, doc.fork_sha].join("\x1f"));
		});
	')" || return 1
	IFS=$'\x1f' read -r run_id repo_root rest <<<"$out"
	: "$rest" # base_ref/fork_sha pass through unguarded; named to keep read honest
	if [ -z "$run_id" ] || [ ! -d "$repo_root" ]; then
		return 1
	fi
	printf '%s\n' "$out"
}

# verify_slot_ownership <run_id> <branch> <path>: does this manifest row name
# resources THIS run owns? Silent 0 when it does; a one-line reason on stdout
# and 1 when it does not.
#
# THE THIRD INSTANCE of the drift pattern in
# docs/solutions/best-practices/cross-script-invariant-drift.md (after the
# locus guard and the run_id charset guard): run_id is charset-checked before
# it reaches a path, but slot branch and slot path came straight out of the
# manifest into `git worktree remove`, `reset --hard`, and `clean -fd` behind
# nothing but a `[ -d ]`. A corrupted, hand-edited, or cross-repo manifest
# could therefore aim an rm -rf-class removal at any directory on disk. The
# verifier lives HERE, in the one file both consumers already source, so the
# rule is code in a shared helper rather than a comment each caller must
# remember — countermeasure 1 of that doc. Callers differ only in what they do
# with the answer (harvest refuses; abort keeps and reports), which is exactly
# why this returns a boolean instead of exiting itself.
#
# Two independent locks, different keys (same shape as swap_base's namespace
# check): the branch must sit in the run's OWN namespace, and the path must be
# a worktree GIT itself reports for that branch — the manifest's own path
# string is never the authority for whether the path is ours.
verify_slot_ownership() {
	local run_id="${1-}" branch="${2-}" wtpath="${3-}" want listed p q
	if [ -z "$run_id" ]; then
		printf 'no run_id to check slot ownership against\n'
		return 1
	fi
	# `?*` not `*`: "swarm/<run>/" with an empty tail is not a slot branch.
	case "$branch" in
	"swarm/$run_id/"?*) ;;
	*)
		printf "branch '%s' is outside this run's namespace swarm/%s/*\n" "$branch" "$run_id"
		return 1
		;;
	esac
	# A null path is the legitimate write-ahead pending row (manifest KTD:
	# path/ids stay null until herdr returns them) — nothing to own yet.
	[ -n "$wtpath" ] || return 0
	# Not on disk means nothing removable: the callers' own `[ -d ]` checks
	# report "worktree is gone", a normal state that must not become a refusal.
	[ -d "$wtpath" ] || return 0
	# Compare physical paths: /tmp is a symlink to /private/tmp on macOS, and
	# git records the resolved form, so a raw string compare would refuse
	# perfectly legitimate slots.
	want="$(cd "$wtpath" 2>/dev/null && pwd -P)" || want="$wtpath"
	listed="$(repo_git worktree list --porcelain 2>/dev/null | awk -v ref="branch refs/heads/$branch" '
		/^worktree /{p=substr($0,10)} $0==ref{print p}')"
	while IFS= read -r p; do
		[ -n "$p" ] || continue
		q="$(cd "$p" 2>/dev/null && pwd -P)" || q="$p"
		[ "$q" = "$want" ] && return 0
	done <<<"$listed"
	printf "path '%s' is not a worktree of %s checked out on '%s'\n" \
		"$wtpath" "${SWARM_REPO:-?}" "$branch"
	return 1
}

# manifest_update_slot <slot> <json-patch>: read-modify-write of one slot
# row (shallow merge). MUST be called with the mutation lock held — this
# function deliberately does not take the lock itself, because callers batch
# several updates inside one critical section and the mkdir lock is not
# reentrant. The row must already exist: a typo'd slot number fails loudly
# instead of inventing a row the reaper would then trust. Propagates
# manifest_read's missing/corrupt codes so destructive callers refuse on a
# corrupt manifest for free.
manifest_update_slot() {
	local slot="${1-}" patch="${2-}" doc updated
	doc="$(manifest_read)" || return $?
	updated="$(printf '%s' "$doc" | node -e '
		const [slot, patch] = process.argv.slice(1);
		let p;
		try { p = JSON.parse(patch); } catch {
			console.error("herdr-swarm: slot patch is not valid JSON: " + patch);
			process.exit(1);
		}
		let d = "";
		process.stdin.on("data", (c) => (d += c)).on("end", () => {
			const doc = JSON.parse(d);
			const row = (doc.slots || []).find((r) => String(r.slot) === slot);
			if (!row) {
				console.error("herdr-swarm: no slot " + slot + " in manifest");
				process.exit(1);
			}
			Object.assign(row, p);
			process.stdout.write(JSON.stringify(doc, null, 2));
		});
	' "$slot" "$patch")" || return 1
	printf '%s' "$updated" | manifest_write
}
