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

# First pane_id in herdr JSON output. Whitespace-stripped first so compact
# and pretty-printed responses both parse (pane ids never contain spaces).
parse_pane_id() {
	printf '%s' "$1" | tr -d ' \n\r\t' | grep -o '"pane_id":"[^"]*"' | head -n1 | cut -d'"' -f4
}

pane_alive() {
	[ -n "$1" ] && "$HERDR" pane read "$1" --lines 1 >/dev/null 2>&1
}

# --- Mutation lock -----------------------------------------------------------
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

# version_gate <gated|intersection>
# 'gated' guards the one call with no 0.7.4/0.7.5 intersection form
# (agent start --cwd/--workspace; 0.7.5 replaced it with pane targeting):
# only 0.7.4 passes, everything else refuses with the escape hatch named.
# 'intersection' calls survive the 0.7.4→0.7.5 break: never refused, but a
# version above the max tested gets a warning (behavior unverified there).
version_gate() {
	local class="${1-}" v
	v="$(herdr_version)" || {
		echo "herdr-swarm: cannot determine herdr version (is '$HERDR' the herdr CLI?)" >&2
		return 1
	}
	case "$class" in
	gated)
		case "$v" in
		0.7.4) return 0 ;;
		*)
			echo "herdr-swarm: fan-out needs herdr 0.7.4 (agent start --cwd/--workspace); herdr $v has no compatible form. Harvest and cleanup of an existing run still work." >&2
			return 1
			;;
		esac
		;;
	intersection)
		case "$v" in
		0.7.4 | 0.7.5) ;;
		*) echo "herdr-swarm: warning: herdr $v is newer than tested ($HERDR_SWARM_MAX_TESTED); proceeding." >&2 ;;
		esac
		return 0
		;;
	*)
		# Fail closed: a typo'd class must never silently pass a gated call.
		echo "herdr-swarm: internal error: unknown version_gate class '$class'" >&2
		return 1
		;;
	esac
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

# THE gated call: `agent start --cwd/--workspace` exists only on 0.7.4. The
# 0.7.5 pane-targeting variant lands as a second branch inside this same
# function (the seam the plan reserves) — never at a call site.
herdr_agent_start() {
	version_gate gated || return 1
	with_timeout 15 "$HERDR" agent start "$@"
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
	printf '%s/run-%s.json\n' "$(state_dir)" "$(ws_id)"
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
	[ -f "$mf" ] || return "$MANIFEST_EC_MISSING"
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
