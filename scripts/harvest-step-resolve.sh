#!/usr/bin/env bash
# harvest-step-resolve.sh — Conflict resolver: resolve and conclude for detached merge trees.
#
# Sourced by harvest-step.sh, the one entry point; not run on its own. The
# globals used here (RUN_ID, REPO_ROOT, DOC, SLOT_*, HS_EC_*, …) are set there.
# shellcheck disable=SC2154,SC2153

# detached_conflict_context <slot>: shared preconditions of resolve and
# conclude. Sets CX_EXPECTED, CX_TREE, CX_GENERATION. The merge must be the
# plugin-owned DETACHED kind (a user-tree conflict is the user's own checkout,
# outside what the plugin may hand to an agent or conclude on its behalf),
# still un-concluded, and its tree must be the exact journaled resource.
detached_conflict_context() {
	local slot="$1" locus msha
	if [ "$SLOT_JOURNAL" = "null" ]; then
		echo "herdr-swarm: slot $slot has no merge in flight." >&2
		return "$HS_EC_REFUSED"
	fi
	locus="$(journal_field "$SLOT_JOURNAL" locus)"
	msha="$(journal_field "$SLOT_JOURNAL" merge_commit_sha)"
	CX_EXPECTED="$(journal_field "$SLOT_JOURNAL" expected_base_sha)"
	CX_TREE="$(journal_field "$SLOT_JOURNAL" worktree)"
	CX_GENERATION="$(printf '%s' "$SLOT_JOURNAL" | node -e '
		let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
			try { process.stdout.write(String(JSON.parse(d)?.resource?.generation ?? "")); } catch {}
		});')"
	if [ "$locus" != detached ]; then
		echo "herdr-swarm: slot $slot is conflicted in YOUR checked-out branch ($CX_TREE) — resolve it there yourself; Swarm only hands its own detached merge trees to a resolver or concludes them." >&2
		return "$HS_EC_LOCUS"
	fi
	# A journaled-but-unlanded commit may be re-adopted (conclude), e.g. after
	# a landing that failed; one already ON the base is resume's business.
	CX_MSHA="$msha"
	if [ -n "$msha" ] && [ "$(base_sha 2>/dev/null)" = "$msha" ]; then
		echo "herdr-swarm: slot $slot merge $msha has already landed — re-open harvest to settle it." >&2
		return "$HS_EC_REFUSED"
	fi
	CX_TIP="$(journal_field "$SLOT_JOURNAL" merge_tip)"
	if [ -z "$CX_TREE" ] || [ ! -d "$CX_TREE" ]; then
		echo "herdr-swarm: slot $slot merge tree is missing — refused." >&2
		return "$HS_EC_REFUSED"
	fi
	# Identity is verified in full (repository, run/slot binding, exact
	# generation path, real directory, registration). Only HEAD is allowed to
	# have moved, and only by committing the merge: still the journaled base,
	# or a commit whose FIRST parent is it. Anything else is not this merge.
	local head first allowed=""
	head="$(git -C "$CX_TREE" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || head=""
	if [ -n "$head" ] && [ "$head" != "$CX_EXPECTED" ]; then
		first="$(git -C "$CX_TREE" rev-parse --verify "$head^1" 2>/dev/null)" || first=""
		if [ "$first" != "$CX_EXPECTED" ]; then
			echo "herdr-swarm: slot $slot merge tree HEAD moved off the journaled base $CX_EXPECTED — it is not this merge any more; refused." >&2
			return "$HS_EC_REFUSED"
		fi
		allowed="$head"
	fi
	if ! verify_harvest_resource "$RUN_ID" "$slot" "$CX_TREE" "$SLOT_JOURNAL" "$allowed" >/dev/null; then
		echo "herdr-swarm: slot $slot merge tree is not the exact journaled resource — refused." >&2
		return "$HS_EC_REFUSED"
	fi
}

# conclude <slot> [apply <sha>]: adopt a conflicted detached merge that was
# resolved IN its merge tree — by a person who shelled in, or by a resolver
# agent. Until now such a commit was unrecorded: resume called the journal
# stale and abort-merge refused it as an unknown merge commit.
#
# Two steps, so nothing is recorded before the operator has reviewed it:
#   conclude <slot>            READ-ONLY. Checks the tree holds exactly one
#                              finished merge of THIS slot's merged tip onto
#                              the journaled base, and prints what it changes:
#                              conclude_ready, outside_conflict (paths the
#                              resolution changed beyond git's own automatic
#                              merge — the "evil merge" surface), stat (full).
#   conclude <slot> apply SHA  Re-runs every check, requires HEAD == SHA (the
#                              commit reviewed), and only then journals it.
# Landing stays `resume complete`, behind the compare-and-swap; the pane runs
# apply and land together on the operator's `y`.
do_conclude() {
	local slot="$1" mode="${2-}" want="${3-}" head parents p1 p2 extra row rpane ragent rstate auto conflicted path
	read_slot "$slot" || return $?
	detached_conflict_context "$slot" || return $?
	if [ -z "$CX_TIP" ]; then
		echo "herdr-swarm: slot $slot merge was journaled before the merged tip was recorded — abort-merge and merge again to use conclude." >&2
		return "$HS_EC_REFUSED"
	fi
	# A resolver still in its tree could amend after review, or lose its cwd
	# when landing removes the tree: it must be proven gone first.
	row="$(slot_row_json "$slot")"
	rstate="$(resolver_state "$row")"
	if [ "$rstate" != gone ]; then
		echo "herdr-swarm: slot $slot conflict resolver is $rstate — exit the agent in its pane (it should have committed), then conclude. If you know it stopped, HERDR_SWARM_RESOLVER_STOPPED=yes." >&2
		return "$HS_EC_REFUSED"
	fi
	if git -C "$CX_TREE" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
		if [ -n "$(git -C "$CX_TREE" ls-files -u)" ]; then
			echo "herdr-swarm: slot $slot still has conflicted files in $CX_TREE — resolve them, git add, and commit." >&2
		else
			echo "herdr-swarm: slot $slot conflicts are resolved but the merge is not committed — run git commit in $CX_TREE." >&2
		fi
		return "$HS_EC_REFUSED"
	fi
	if [ -n "$(git -C "$CX_TREE" status --porcelain)" ]; then
		echo "herdr-swarm: slot $slot merge tree has uncommitted changes beyond the merge commit — commit or discard them first; nothing outside the merge may ride along." >&2
		return "$HS_EC_REFUSED"
	fi
	head="$(git -C "$CX_TREE" rev-parse --verify 'HEAD^{commit}')" || return "$HS_EC_REFUSED"
	parents="$(git -C "$CX_TREE" rev-list --parents -n 1 "$head")" || return "$HS_EC_REFUSED"
	read -r _ p1 p2 extra <<<"$parents"
	if [ -z "$p2" ] || [ -n "$extra" ]; then
		echo "herdr-swarm: slot $slot merge tree HEAD $head is not a two-parent merge commit — it must conclude the merge in one commit (no extra commits, rebases, or octopus merges)." >&2
		return "$HS_EC_REFUSED"
	fi
	if [ "$p1" != "$CX_EXPECTED" ]; then
		echo "herdr-swarm: slot $slot merge commit's first parent $p1 is not the journaled base $CX_EXPECTED — refused." >&2
		return "$HS_EC_REFUSED"
	fi
	# The second parent must be EXACTLY the slot commit this merge started
	# with (journaled MERGE_HEAD) — the tip that was compared and validated —
	# never a newer slot commit swapped in by redoing the merge.
	if [ "$p2" != "$CX_TIP" ]; then
		echo "herdr-swarm: slot $slot merge commit's second parent $p2 is not the merged slot tip $CX_TIP — refused (a different slot commit was merged)." >&2
		return "$HS_EC_REFUSED"
	fi
	if [ "$mode" = apply ]; then
		if [ "$head" != "$want" ]; then
			echo "herdr-swarm: slot $slot merge tree HEAD is $head, not the reviewed $want — conclude again and review the new commit." >&2
			return "$HS_EC_DRIFT"
		fi
		journal_set "$slot" detached "$CX_EXPECTED" "$head" "$CX_TREE" "$CX_GENERATION" "$CX_TIP" || return 1
		IFS=$'\t' read -r rpane ragent <<<"$(printf '%s' "$row" | node -e '
			let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
				const v = JSON.parse(d)?.resolver; if (v) process.stdout.write([v.pane_id ?? "", v.agent_name ?? ""].join("\t"));
			});')"
		[ -z "$rpane" ] || report_slot_agent_state "$rpane" "$ragent" idle
		printf 'concluded\t%s\t%s\n' "$slot" "$head"
		return 0
	elif [ -n "$mode" ]; then
		echo "usage: harvest-step.sh conclude <slot> [apply <sha>]" >&2
		return 1
	fi
	printf 'conclude_ready\t%s\t%s\n' "$slot" "$head"
	# What the resolution changed BEYOND git's own automatic merge of the same
	# two commits: the conflicted files are expected to differ; anything else
	# is a change the slot never made and nobody compared. merge-tree prints
	# the automatic result's tree, then its conflicted paths.
	auto="$(git -C "$REPO_ROOT" merge-tree --write-tree --name-only --no-messages "$p1" "$p2" 2>/dev/null)"
	if [ -z "$auto" ]; then
		printf 'outside_conflict_unknown\t%s\n' "git merge-tree --write-tree is unavailable (git < 2.38)"
	else
		conflicted="$(printf '%s\n' "$auto" | tail -n +2)"
		while IFS= read -r path; do
			[ -n "$path" ] || continue
			printf '%s\n' "$conflicted" | grep -qxF -- "$path" || printf 'outside_conflict\t%s\n' "$path"
		done < <(git -C "$REPO_ROOT" diff --name-only "$(printf '%s\n' "$auto" | head -n 1)" "$head")
	fi
	git -C "$REPO_ROOT" diff --stat "$CX_EXPECTED" "$head" | sed $'s/^/stat\t/'
}

# resolve <slot>: hand a conflicted DETACHED merge to a resolver agent. Merges
# nothing — it only writes a brief into the merge tree and starts the agent
# beside the slot's own agent (split from the slot pane, into the merge tree).
# The agent's commit is then adopted by `conclude` and landed by `resume`,
# exactly like a human resolution. Preset: HERDR_SWARM_RESOLVER_PRESET, else
# the slot's own. Needs herdr 0.7.5+ (the pane-built start; 0.7.4's native
# start path was never verified against an existing conflicted tree).
do_resolve() {
	local slot="$1" v preset argv conflicted tip out pane term ws name patch row rstate
	local -a argv_arr
	read_slot "$slot" || return $?
	detached_conflict_context "$slot" || return $?
	if [ -n "$CX_MSHA" ]; then
		echo "herdr-swarm: slot $slot merge is already concluded ($CX_MSHA) — nothing left for a resolver." >&2
		return "$HS_EC_REFUSED"
	fi
	conflicted="$(git -C "$CX_TREE" diff --name-only --diff-filter=U)"
	if [ -z "$conflicted" ]; then
		echo "herdr-swarm: slot $slot merge tree has no conflicted files left — nothing to hand to a resolver (conclude it once committed)." >&2
		return "$HS_EC_REFUSED"
	fi
	v="$(herdr_version 2>/dev/null)" || v=""
	if [ -z "$v" ] || ! version_ge "$v" "0.7.5"; then
		echo "herdr-swarm: the conflict resolver needs Herdr 0.7.5 or newer (found ${v:-unknown}) — shell into the merge tree instead." >&2
		return "$HS_EC_REFUSED"
	fi
	row="$(slot_row_json "$slot")"
	rstate="$(resolver_state "$row")"
	if [ "$rstate" != gone ]; then
		echo "herdr-swarm: slot $slot already has a conflict resolver ($rstate) — wait for it, or exit it first." >&2
		return "$HS_EC_REFUSED"
	fi
	if [ -z "$SLOT_PANE" ]; then
		echo "herdr-swarm: slot $slot has no recorded pane to start the resolver beside." >&2
		return "$HS_EC_REFUSED"
	fi
	# Label is s<N>-<preset> (fan-out); its preset is the default resolver.
	preset="${HERDR_SWARM_RESOLVER_PRESET:-${SLOT_LABEL#s*-}}"
	argv="$(preset_argv "$preset")" || {
		echo "herdr-swarm: resolver preset '$preset' is unusable (set HERDR_SWARM_RESOLVER_PRESET)." >&2
		return "$HS_EC_REFUSED"
	}
	read -ra argv_arr <<<"$argv"
	command -v "${argv_arr[0]}" >/dev/null 2>&1 || {
		echo "herdr-swarm: resolver command '${argv_arr[0]}' is not on PATH." >&2
		return "$HS_EC_REFUSED"
	}
	tip="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/heads/$SLOT_BRANCH")" || tip="?"
	# The brief (scripts/resolver-brief.md, filled in) becomes the merge tree's
	# task file: excluded from git, skipped by the ignored-file inventory.
	# shellcheck disable=SC2016 # ${f} is a JS template literal, not bash
	node -e '
		const fs = require("fs");
		const [tpl, out, slotBranch, slotTip, baseBranch, baseSha, conflicted] = process.argv.slice(1);
		const vals = { SLOT_BRANCH: slotBranch, SLOT_TIP: slotTip, BASE_BRANCH: baseBranch, BASE_SHA: baseSha,
			CONFLICTED: conflicted.split("\n").filter(Boolean).map((f) => `- ${f}`).join("\n") };
		fs.writeFileSync(out, fs.readFileSync(tpl, "utf8").replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => vals[k] ?? m));
	' "$PLUGIN_ROOT/scripts/resolver-brief.md" "$CX_TREE/$SWARM_TASK_FILE" "$SLOT_BRANCH" "${tip:0:12}" \
		"$BASE_BRANCH" "${CX_EXPECTED:0:12}" "$conflicted" || return 1
	name="swarm-$RUN_ID-s$slot-resolve"
	out="$(herdr_agent_start "$name" --split-from "$SLOT_PANE" --cwd "$CX_TREE" --no-focus \
		--env "HERDR_SWARM_RUN_ID=$RUN_ID" --env "HERDR_SWARM_SLOT=$slot" -- "${argv_arr[@]}")" || {
		echo "herdr-swarm: could not start the resolver agent." >&2
		return 1
	}
	pane="$(parse_json_field pane_id "$out")"
	term="$(parse_json_field terminal_id "$out")"
	ws="$(parse_json_field workspace_id "$out")"
	# Without its pane, terminal, and workspace the resolver could never be
	# proven gone, and its merge tree would be stuck: say so now, not later.
	if [ -z "$pane" ] || [ -z "$term" ] || [ -z "$ws" ]; then
		echo "herdr-swarm: the resolver started, but its pane/terminal/workspace id came back empty — exit it by hand; its merge tree stays until HERDR_SWARM_RESOLVER_STOPPED=yes." >&2
	fi
	patch="$(node -e '
		const [pane, term, ws, name, cmd, gen] = process.argv.slice(1);
		process.stdout.write(JSON.stringify({ resolver: { pane_id: pane || null, terminal_id: term || null,
			workspace_id: ws || null, agent_name: name, agent_command: require("path").basename(cmd), generation: gen,
			started_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") } }));
	' "$pane" "$term" "$ws" "$name" "${argv_arr[0]}" "$CX_GENERATION")" || return 1
	manifest_update_slot "$slot" "$patch" || return 1
	printf 'resolver_started\t%s\t%s\n' "$slot" "$pane"
}
