// herdr-swarm renderer — shared pure helpers (split from renderer.mjs when
// harvest mode grew; residual finding 4). Everything here is side-effect-free
// and unit-tested via the re-exports in bin/renderer.mjs.
import path from "node:path";

export const ESC = "\x1b";

// --- pure helpers (unit-tested) ---

// Workspace ids become the manifest file name — must stay in lockstep with
// ws_id() in scripts/lib.sh (only a strict charset may reach a path).
export function safeWsId(id) {
	const s = String(id || "default").replace(/[^A-Za-z0-9_-]/g, "");
	return s || "default";
}

// Must stay in lockstep with state_dir()+manifest_path() in scripts/lib.sh:
// literal '~' expanded (nothing expands it inside a variable value), relative
// paths fall back to the default — otherwise bash and node would read two
// different manifests for the same workspace.
export function manifestPath(env) {
	let d =
		env.HERDR_PLUGIN_STATE_DIR ||
		path.join(env.HOME || ".", ".local/state/herdr-swarm");
	if (d === "~" || d.startsWith("~/"))
		d = path.join(env.HOME || ".", d.slice(1));
	if (!path.isAbsolute(d))
		d = path.join(env.HOME || ".", ".local/state/herdr-swarm");
	return path.join(d, `run-${safeWsId(env.HERDR_WORKSPACE_ID)}.json`);
}

// parseManifest(text) -> typed result, never a throw to the caller: a corrupt
// manifest is a first-class display state (U3), not a pane crash. text is
// null/undefined when the file does not exist (a normal "no run" state,
// distinct from corrupt — mirrors MANIFEST_EC_MISSING vs _CORRUPT in lib.sh).
export function parseManifest(text) {
	if (text == null) return { ok: false, reason: "missing" };
	if (String(text).trim() === "")
		return { ok: false, reason: "corrupt", detail: "zero-length" };
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		return { ok: false, reason: "corrupt", detail: "unparseable JSON" };
	}
	if (!doc || typeof doc !== "object" || !Array.isArray(doc.slots))
		return { ok: false, reason: "corrupt", detail: "no slots array" };
	return { ok: true, manifest: doc };
}

// Statuses that mean "this slot is settled history". Their worktree is
// legitimately gone (harvest removes it), so a missing worktree/branch must
// not override them — see reconcileSlots.
export const TERMINAL_STATUSES = new Set(["archived", "merged", "skipped", "failed"]);

// reconcileSlots — the R6 core: manifest rows × live `agent list` × git facts
// -> displayed rows. The manifest's "running" is only a claim; display trusts
// the live agent when one answers and degrades to "unknown" when none does
// (killed by the spike-(b) workspace-close cascade, Herdr restarted, or the
// agent query itself failed) — a slot must NEVER render stuck "working" on
// bookkeeping alone. Git facts outrank both: a deleted worktree or branch is
// "missing" whatever anyone claims. Committed/uncommitted counts ride along
// untouched so unknown slots stay visibly harvestable (R6: committed work
// survives every Herdr failure).
//
// agents: array from the agent-list query, or null when it was unanswerable.
// gitFacts: { [slot]: { worktreeMissing, branchMissing, committed, uncommitted } }
export function reconcileSlots(manifestSlots, agents, gitFacts) {
	return (manifestSlots || []).map((row) => {
		const facts = (gitFacts && gitFacts[row.slot]) || {};
		let state;
		if (TERMINAL_STATUSES.has(row.status)) {
			// Terminal statuses outrank git facts: harvest DELETES the worktree
			// (and archive may drop the branch) as the last step of merging,
			// archiving, or skipping — so "the worktree is gone" is the expected
			// end state there, not a fault. Checking git first rendered every
			// harvested slot as "missing" (P2 display bug).
			state = row.status;
		} else if (facts.worktreeMissing || facts.branchMissing) {
			state = "missing";
		} else if (row.status === "running") {
			// Match by terminal_id first (stable across pane moves), pane_id as
			// the fallback for rows recorded before the terminal id was known.
			const live = (agents || []).find(
				(a) =>
					(row.terminal_id && a.terminal_id === row.terminal_id) ||
					(row.pane_id && a.pane_id === row.pane_id),
			);
			state = live ? String(live.agent_status || "unknown") : "unknown";
		} else {
			state = row.status;
		}
		return {
			slot: row.slot,
			label: row.label,
			branch: row.branch,
			path: row.path,
			workspace_id: row.workspace_id,
			pane_id: row.pane_id,
			agent_name: row.agent_name,
			state,
			committed: facts.committed ?? null,
			uncommitted: facts.uncommitted ?? null,
		};
	});
}

// Blocked slots need the user (R5: visually loud AND first); everything else
// keeps stable slot order so rows do not jump around between polls.
export function sortSlots(rows) {
	const bySlot = (a, b) => a.slot - b.slot;
	return [
		...rows.filter((r) => r.state === "blocked").sort(bySlot),
		...rows.filter((r) => r.state !== "blocked").sort(bySlot),
	];
}

// The EXACT diff range, three dots: fork...HEAD diffs against the merge base,
// so commits that landed on the base branch after the fork never inflate a
// slot's counts. Base-tip two-dot forms are the documented inflation bug (R5).
export function diffRange(forkSha) {
	return `${forkSha}...HEAD`;
}

// `git diff --stat` summary line -> committed file count ("N files changed"
// / "1 file changed"); empty output means no commits past the fork.
export function parseDiffStat(text) {
	const m = /(\d+) files? changed/.exec(String(text || ""));
	return m ? Number(m[1]) : 0;
}

// `git status --porcelain` -> uncommitted (staged+unstaged+untracked) count.
export function parseStatusPorcelain(text) {
	return String(text || "")
		.split("\n")
		.filter((l) => l.trim() !== "").length;
}

// Branch names, labels, and agent excerpts get written into the user's
// terminal on every repaint: strip C0/C1 controls (tab -> space) so a hostile
// branch name can never smuggle escape sequences, and bidi/zero-width format
// chars so it cannot visually spoof what the user reviews before a merge.
export function sanitizeText(s) {
	return String(s)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => (ch === "\t" ? " " : ""))
		.replace(
			/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
			"",
		);
}

// Poll backoff (sibling pattern): each tick shells git per worktree plus one
// agent query, so a quiet run should not be polled at full rate forever.
// Any observed change resets idleTicks; after ~5 quiet minutes the floor
// drops to 30x — an unwatched pane costs ~zero.
export function pollDelay(baseMs, idleTicks) {
	const mult =
		idleTicks < 10
			? 1
			: idleTicks < 30
				? 2
				: idleTicks < 60
					? 4
					: idleTicks < 300
						? 8
						: 30;
	// 2**31-1 is setTimeout's ceiling; beyond it Node fires after ~1ms.
	return Math.min(baseMs * mult, 2 ** 31 - 1);
}

export const pad = (s, w) => {
	s = String(s);
	return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
};
