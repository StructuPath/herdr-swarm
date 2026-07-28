#!/usr/bin/env node
// herdr-swarm pane renderer — status mode (U5) and harvest mode (U6).
//
// STRICTLY READ-ONLY on the run manifest: the single-writer rule (plan KTD)
// says writers are launchers and harvest verbs only. This process reconciles
// manifest × live Herdr state × git facts in memory for display and never
// writes any of them back; tests/renderer.test.mjs asserts a full poll cycle
// performs zero fs writes.
//
// Harvest mode is UI + state machine + orchestration ONLY (destructive-
// surface KTD): every state-mutating git/herdr step runs through
// `bash scripts/harvest-step.sh <verb>` — no git-mutation or raw-CLI strings
// live in this file (tests/harvest.test.mjs greps for violations), keeping
// all rm -rf-class and ref-mutating code in one bash surface under the stub
// harness.
//
// HERDR_SWARM_PANE_MODE selects the pane's mode at spawn time
// (status-pane.sh exports "status"; harvest-pane.sh exports "harvest").
// Unknown modes linger with a message instead of flash-closing the pane.
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const pExecFile = promisify(execFile);
const ESC = "\x1b";

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
const TERMINAL_STATUSES = new Set(["archived", "merged", "skipped", "failed"]);

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

const pad = (s, w) => {
	s = String(s);
	return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
};

// Status table for a TTY. Takes reconciled rows (already sorted); returns a
// plain string so tests can assert on it without a PTY. Blocked rows render
// inverse+red — R5 says loud, and color alone is invisible on some themes,
// so inverse carries the weight even without color support.
export function renderStatus(rows, cols = 80) {
	const head = ` ${pad("#", 3)}${pad("state", 9)}${pad("c/u", 8)}${pad("label", 14)}${pad("branch", 28)}path`;
	const lines = [head.slice(0, cols)];
	if (rows.length === 0) lines.push("  (no slots in this run)");
	for (const r of rows) {
		const counts = `${r.committed ?? "-"}/${r.uncommitted ?? "-"}`;
		// state comes from herdr's agent_status — externally controlled text on
		// the same footing as a branch name, so it sanitizes like one.
		const line =
			` ${pad(r.slot, 3)}${pad(sanitizeText(r.state ?? ""), 9)}${pad(counts, 8)}${pad(
				sanitizeText(r.label ?? ""),
				14,
			)}${pad(sanitizeText(r.branch ?? ""), 28)}${sanitizeText(r.path ?? "-")}`.slice(
				0,
				cols,
			);
		lines.push(
			r.state === "blocked" ? `${ESC}[7m${ESC}[31m${line}${ESC}[0m` : line,
		);
	}
	return lines.join("\n");
}

// --- Herdr access (the renderer's one module section for Herdr calls, per
// --- the lib.sh wrapper invariant; HERDR_BIN_PATH honored like lib.sh) ---

export function mkHerdr(env = process.env) {
	const bin = env.HERDR_BIN_PATH || "herdr";
	const call = (args, timeout) =>
		pExecFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, env });
	return {
		// null (not []) on any failure: reconcileSlots must distinguish "the
		// query failed" from "the query answered and our agent is gone" — both
		// display unknown, but [] would also erase agents on a slow socket.
		agentList: async () => {
			try {
				const { stdout } = await call(["agent", "list"], 10_000);
				const agents = JSON.parse(stdout)?.result?.agents;
				return Array.isArray(agents) ? agents : null;
			} catch {
				return null;
			}
		},
		// Jump-to-slot: spawn only, success/failure by exit code — no output
		// parsing needed (the plan's focus contract).
		agentFocus: async (target) => {
			try {
				await call(["agent", "focus", target], 5_000);
				return true;
			} catch {
				return false;
			}
		},
		// Fallback when agent focus can't reach the slot (agent terminals are
		// not plugin panes; directional focus can't target ids — plan U5).
		workspaceFocus: async (id) => {
			try {
				await call(["workspace", "focus", id], 5_000);
				return true;
			} catch {
				return false;
			}
		},
	};
}

// --- renderer main ---

export class Renderer {
	constructor(env = process.env) {
		this.env = env;
		this.mode = env.HERDR_SWARM_PANE_MODE || "status";
		// status-pane.sh exports the resolved path; the fallback recomputes it
		// in lockstep with lib.sh for direct/test invocation.
		this.manifestFile = env.HERDR_SWARM_MANIFEST || manifestPath(env);
		this.gitBin = "git";
		this.herdr = mkHerdr(env);
		// Clamp both ends: tiny/negative values busy-loop; values past the
		// setTimeout ceiling (2^31-1 after backoff) fire after ~1ms.
		this.intervalMs = Math.min(
			86_400_000,
			Math.max(500, Number(env.HERDR_SWARM_INTERVAL_MS) || 2000),
		);
		this.idleTicks = 0;
		this.rows = [];
		this.runInfo = null; // {run_id, base_ref, fork_sha, repo_root}
		this.banner = "";
		this.lastScreen = null;
	}

	async git(args, cwd) {
		const { stdout } = await pExecFile(this.gitBin, args, {
			cwd,
			timeout: 10_000,
			maxBuffer: 16 * 1024 * 1024,
			env: this.env,
		});
		return stdout;
	}

	// Git facts for one slot. Never throws: a failing git call leaves counts
	// null (rendered "-") rather than killing the pane — R6 says the pane
	// keeps rendering whatever it can still prove.
	async gitFactsFor(manifest, row) {
		const facts = {};
		if (!row.path) return facts; // write-ahead pending row: nothing on disk yet
		if (!fs.existsSync(row.path)) {
			facts.worktreeMissing = true;
			return facts;
		}
		const repoRoot = manifest.repo_root || this.env.HERDR_SWARM_REPO_ROOT;
		if (row.branch && repoRoot) {
			try {
				await this.git(
					["rev-parse", "--verify", "--quiet", `refs/heads/${row.branch}`],
					repoRoot,
				);
			} catch {
				facts.branchMissing = true;
				return facts;
			}
		}
		try {
			// Three-dot range against the recorded fork SHA — see diffRange().
			facts.committed = parseDiffStat(
				await this.git(
					["diff", "--stat", diffRange(manifest.fork_sha)],
					row.path,
				),
			);
		} catch {
			facts.committed = null;
		}
		try {
			facts.uncommitted = parseStatusPorcelain(
				await this.git(["status", "--porcelain"], row.path),
			);
		} catch {
			facts.uncommitted = null;
		}
		return facts;
	}

	// One full poll cycle. Reads the manifest via fs (READ-ONLY — the single
	// write path lives in lib.sh's manifest_write, held by launchers and
	// harvest verbs only), queries live agents, gathers git facts, reconciles
	// in memory, paints.
	async tick() {
		let text = null;
		try {
			text = fs.readFileSync(this.manifestFile, "utf8");
		} catch {
			/* missing file -> parseManifest's typed "missing" */
		}
		const parsed = parseManifest(text);
		if (!parsed.ok) {
			this.rows = [];
			this.runInfo = null;
			this.banner =
				parsed.reason === "missing"
					? "no active swarm run for this workspace — run the fan-out action first"
					: `manifest is corrupt (${parsed.detail}); previous generation may be in ${this.manifestFile}.bak`;
			this.paint();
			return;
		}
		const m = parsed.manifest;
		this.runInfo = {
			run_id: m.run_id,
			base_ref: m.base_ref,
			fork_sha: m.fork_sha,
			repo_root: m.repo_root,
		};
		// Agent query and per-slot git facts gathered concurrently: one hung
		// worktree must cost only its own timeout, not N× — the pane runs
		// unattended for hours, and a serial poll would stall every slot behind
		// the slowest one. Safe because agentList and gitFactsFor never throw.
		const [agents, factsList] = await Promise.all([
			this.herdr.agentList(),
			Promise.all(m.slots.map((row) => this.gitFactsFor(m, row))),
		]);
		const gitFacts = {};
		m.slots.forEach((row, i) => {
			gitFacts[row.slot] = factsList[i];
		});
		this.rows = sortSlots(reconcileSlots(m.slots, agents, gitFacts));
		this.banner =
			agents === null ? "agent list unavailable — states shown as unknown" : "";
		this.paint();
	}

	screen() {
		const cols = process.stdout.columns || 80;
		// Sanitize BEFORE truncating: slicing first can leave a half-stripped
		// escape, and the SHA comes from the manifest like every other field.
		const short = (s) => (s ? sanitizeText(String(s)).slice(0, 10) : "?");
		const title = this.runInfo
			? ` herdr-swarm status  run:${sanitizeText(String(this.runInfo.run_id))}  base:${sanitizeText(
					String(this.runInfo.base_ref || "").replace(/^refs\/heads\//, ""),
				)}  fork:${short(this.runInfo.fork_sha)}`
			: " herdr-swarm status";
		const lines = [
			`${ESC}[7m${title.slice(0, cols)}${ESC}[0m`,
			this.banner ? ` ! ${sanitizeText(this.banner)}`.slice(0, cols) : "",
			renderStatus(this.rows, cols),
			"",
			`${ESC}[2m 1-9:jump to slot's agent  q:quit${ESC}[0m`,
		];
		return lines.join("\n");
	}

	// Repaint-gated full-screen paint: home cursor, erase per line, erase the
	// remainder — no flicker-prone full clears on every poll.
	paint() {
		const out = this.screen();
		if (out === this.lastScreen) return;
		this.lastScreen = out;
		process.stdout.write(
			`${ESC}[H${out.split("\n").join(`${ESC}[K\n`)}${ESC}[K\n${ESC}[0J`,
		);
	}

	// Number keys jump to that slot's agent: agent focus by pane id, falling
	// back to workspace focus (agent terminals are not plugin panes, so
	// plugin-scoped focus can't reach them). Spawn only, no output parsing.
	async jumpToSlot(n) {
		const row = this.rows.find((r) => r.slot === n);
		if (!row) return;
		this.idleTicks = 0; // interaction restores the base poll cadence
		const target = row.pane_id || row.agent_name;
		const ok = target ? await this.herdr.agentFocus(target) : false;
		if (!ok && row.workspace_id)
			await this.herdr.workspaceFocus(row.workspace_id);
	}

	onKey(ch) {
		if (ch === "q" || ch === "\x03") {
			this.cleanup();
			process.exit(0);
		}
		if (ch >= "1" && ch <= "9") this.jumpToSlot(Number(ch));
	}

	setupInput() {
		if (!process.stdin.isTTY) return;
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", (chunk) => {
			for (const ch of chunk.toString("utf8")) this.onKey(ch);
		});
	}

	// Restore everything run() enables; safe to call twice (crash path plus
	// signal path can both land here).
	cleanup() {
		try {
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
		} catch {
			/* never set */
		}
		process.stdout.write(`${ESC}[?1049l${ESC}[?25h`);
	}

	async run() {
		if (this.mode !== "status") {
			// Unknown mode (harvest dispatches to HarvestRenderer in the main
			// guard) — linger with the message instead of flash-closing.
			process.stdout.write(
				`herdr-swarm: unknown pane mode '${sanitizeText(this.mode)}'.\n`,
			);
			await new Promise((r) => setTimeout(r, 600_000));
			return;
		}
		this.setupInput();
		// Register exits before the first paint so a kill in that window still
		// restores the terminal.
		for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) {
			process.on(sig, () => {
				this.cleanup();
				process.exit(0);
			});
		}
		// Last-resort safety net: a throw outside the run() promise (input
		// handler, timer) must still restore the terminal on the way out.
		process.on("uncaughtException", (err) => {
			this.cleanup();
			console.error("herdr-swarm renderer crashed:", err.message);
			process.exit(1);
		});
		process.stdout.write(`${ESC}[?1049h${ESC}[?25l`);
		process.stdout.on("resize", () => {
			this.lastScreen = null; // geometry changed: force a full repaint
			this.paint();
		});
		while (true) {
			const before = JSON.stringify([this.rows, this.banner]);
			try {
				await this.tick();
			} catch {
				// A tick must never kill the pane; the next poll retries.
				this.banner = "status poll failed — retrying";
				this.paint();
			}
			const after = JSON.stringify([this.rows, this.banner]);
			this.idleTicks = after === before ? this.idleTicks + 1 : 0;
			await new Promise((r) =>
				setTimeout(r, pollDelay(this.intervalMs, this.idleTicks)),
			);
		}
	}
}

// --- harvest mode (U6) -------------------------------------------------------

// Exit-code contract of scripts/harvest-step.sh; lockstep-asserted against
// the bash constants by tests/harvest.test.mjs so the two can never drift.
export const STEP_EC = {
	DRIFT: 30,
	SEQUENCER: 31,
	LOCUS: 32,
	CONFLICT: 33,
	HOOK: 34,
	SWAP: 35,
	REFUSED: 36,
	IGNORED: 37,
	DIRTY: 38,
};

// harvest-step's stdout protocol: "key<TAB>v1<TAB>v2…" lines -> multimap
// {key: [[v1,v2,…], …]}. Typed lines, never prose parsing.
export function parseStepOutput(text) {
	const out = {};
	for (const line of String(text || "").split("\n")) {
		if (line.trim() === "") continue;
		const [k, ...v] = line.split("\t");
		(out[k] ||= []).push(v);
	}
	return out;
}

// One preview-verb result -> the renderer's per-slot preview model.
export function previewFromStep(res) {
	const one = (k) => res.out[k]?.[0]?.[0] ?? null;
	const locus = res.out.locus?.[0] ?? [];
	return {
		state: res.code === 0 ? one("state") : "error",
		baseSha: one("base_sha"),
		dirty: Number(one("dirty") ?? 0),
		locus: locus[0] ?? null,
		locusPath: locus[1] ?? null,
		stat: (res.out.stat ?? []).map((v) => v.join("\t")),
		error: res.code !== 0 ? String(res.stderr || "").trim() : null,
	};
}

// Pure screen builder for harvest mode — takes a plain model so tests assert
// on views (conflict list, drift banner, prompts) without a PTY.
// model: { runInfo, banner, phase, rows }  where rows carry {slot, label,
// branch, status, preview} and phase is the state machine node.
export function renderHarvest(model, cols = 80) {
	const lines = [];
	const title = model.runInfo
		? ` herdr-swarm harvest  run:${sanitizeText(String(model.runInfo.run_id))}  base:${sanitizeText(
				String(model.runInfo.base_ref || "").replace(/^refs\/heads\//, ""),
			)}`
		: " herdr-swarm harvest";
	lines.push(`${ESC}[7m${title.slice(0, cols)}${ESC}[0m`);
	if (model.banner)
		lines.push(` ! ${sanitizeText(model.banner)}`.slice(0, cols));
	lines.push(
		` ${pad("#", 3)}${pad("state", 17)}${pad("dirty", 7)}${pad("label", 14)}branch`,
	);
	if (!model.rows?.length) lines.push("  (no slots in this run)");
	for (const r of model.rows ?? []) {
		const p = r.preview;
		const state = p ? p.state : r.status;
		const line = ` ${pad(r.slot, 3)}${pad(sanitizeText(state ?? "?"), 17)}${pad(
			p?.dirty ?? "-",
			7,
		)}${pad(sanitizeText(r.label ?? ""), 14)}${sanitizeText(r.branch ?? "")}`.slice(
			0,
			cols,
		);
		// Dirty and error rows need the user before any merge can happen —
		// same "loud" treatment blocked gets in status mode.
		lines.push(
			state === "dirty" || state === "error"
				? `${ESC}[7m${line}${ESC}[0m`
				: line,
		);
		for (const s of p?.stat ?? [])
			lines.push(`      ${sanitizeText(s)}`.slice(0, cols));
	}
	lines.push("");
	const ph = model.phase ?? { name: "list" };
	switch (ph.name) {
		case "resume": {
			const o = ph.offers[ph.idx];
			lines.push(
				` RESUME: slot ${o.slot} has a completed but un-swapped merge commit ${sanitizeText(String(o.sha)).slice(0, 10)}.`,
			);
			lines.push(
				`${ESC}[2m [y]complete the swap  [n]leave it journaled${ESC}[0m`,
			);
			break;
		}
		case "stale": {
			// A journaled merge intent with NO merge commit: nothing to complete,
			// so resume can't help. Until this phase existed the only key that
			// clears it (abort-merge) was bound inside the conflict phase, which
			// a pane restart threw away — sequencer_scan then refused every
			// later merge with no way out.
			const slot = ph.slots[ph.idx];
			lines.push(
				` STALE MERGE: slot ${slot} has a journaled merge intent with no merge commit.`,
			);
			lines.push(
				` Until it is cleared, harvest refuses every merge in this repo.`,
			);
			lines.push(`${ESC}[2m [a]bort the stale merge  [n]leave it${ESC}[0m`);
			break;
		}
		case "dirty":
			lines.push(` slot ${ph.slot} has uncommitted work:`);
			lines.push(
				`${ESC}[2m [w]commit as WIP  [s]kip slot  [d]iscard (typed confirm)  [b]ack${ESC}[0m`,
			);
			break;
		case "discard":
			lines.push(
				` DISCARD slot ${ph.slot}: a snapshot ref is written first, but this deletes uncommitted work.`,
			);
			lines.push(
				` Type the slot branch name to confirm, Enter to submit, Esc to cancel:`,
			);
			lines.push(` > ${sanitizeText(ph.typed)}`);
			break;
		case "confirm-user":
			lines.push(
				` MERGE slot ${ph.slot} IN YOUR CHECKOUT: base is checked out at ${sanitizeText(ph.path ?? "?")}.`,
			);
			lines.push(
				` The tree was verified clean and will be re-verified at merge time.`,
			);
			lines.push(
				`${ESC}[2m [y]merge in my tree  [any other key]cancel${ESC}[0m`,
			);
			break;
		case "conflict": {
			lines.push(
				ph.kind === "hook"
					? ` ${ESC}[7mHOOK/OTHER FAILURE${ESC}[0m slot ${ph.slot} — merge failed without conflicts:`
					: ` ${ESC}[7mCONFLICT${ESC}[0m slot ${ph.slot} — conflicted files:`,
			);
			for (const f of ph.files ?? []) lines.push(`   ${sanitizeText(f)}`);
			if (ph.message) lines.push(` ${sanitizeText(ph.message)}`.slice(0, cols));
			lines.push(
				`${ESC}[2m [s]hell into merge tree  [a]bort merge  [b]ack${ESC}[0m`,
			);
			break;
		}
		case "ignored":
			lines.push(
				` ARCHIVE slot ${ph.slot}: removal would silently delete these ignored files:`,
			);
			for (const f of ph.files ?? []) lines.push(`   ${sanitizeText(f)}`);
			lines.push(`${ESC}[2m [y]archive anyway  [n]keep the worktree${ESC}[0m`);
			break;
		default: {
			// Any row still carrying a journal wedges every merge (sequencer_scan
			// / the merge verb's own refusal), so the escape hatch has to be
			// reachable from the resting phase — not only from conflict.
			const j = (model.rows ?? []).find((r) => r.journal);
			lines.push(
				`${ESC}[2m 1-9:select slot (merge/prompt)  r:re-preview${
					j ? `  a:abort stale merge (slot ${j.slot})` : ""
				}  q:quit${ESC}[0m`,
			);
		}
	}
	return lines.join("\n");
}

export class HarvestRenderer {
	constructor(env = process.env) {
		this.env = env;
		this.manifestFile = env.HERDR_SWARM_MANIFEST || manifestPath(env);
		// The verb script is the ONLY mutation channel; resolved from the
		// plugin root so the pane's cwd never matters.
		this.stepScript = path.join(
			env.HERDR_PLUGIN_ROOT ||
				path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
			"scripts",
			"harvest-step.sh",
		);
		// Every other spawn in this file is bounded; this one is the ONLY one
		// that also masks SIGINT (see run()), so an unbounded verb — a hung git
		// call, a repo hook that waits on a tty — freezes the pane with no
		// Ctrl-C escape. Generous by default: destructive verbs legitimately
		// take a while on a large repo. Overridable for slow repos and tests.
		this.stepTimeoutMs = Math.max(
			250,
			Number(env.HERDR_SWARM_STEP_TIMEOUT_MS) || 120_000,
		);
		this.rows = [];
		this.runInfo = null;
		this.banner = "";
		this.phase = { name: "list" };
		this.staleSlots = []; // resume_stale queue, drained by enterStalePhase()
		this.busy = false; // a destructive verb is in flight — input masked
		this.lastScreen = null;
		this.write = (s) => process.stdout.write(s);
	}

	// Run one harvest-step verb. Input (and SIGINT — see run()) is masked
	// while it runs: interrupting a verb mid-merge is never fatal (lock +
	// journal), but it strands state the user then has to resume — so the
	// renderer simply refuses to race its own verbs.
	async step(verb, args = [], extraEnv = {}) {
		this.busy = true;
		try {
			const r = await new Promise((resolve) => {
				execFile(
					"bash",
					[this.stepScript, verb, ...args.map(String)],
					{
						env: { ...this.env, ...extraEnv },
						maxBuffer: 16 * 1024 * 1024,
						timeout: this.stepTimeoutMs,
						// SIGTERM, not SIGKILL: harvest-step.sh's trap must still get
						// to release the per-repo mutation lock on the way out.
						killSignal: "SIGTERM",
					},
					(err, stdout, stderr) =>
						resolve({
							code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
							// Node flags a timeout kill as `killed`; the exit code is
							// null there, so without this flag a timeout is
							// indistinguishable from an ordinary failure.
							timedOut: Boolean(err?.killed),
							stdout: stdout ?? "",
							stderr: stderr ?? "",
						}),
				);
			});
			r.verb = verb;
			r.out = parseStepOutput(r.stdout);
			// Banner set here (not only at the call sites): some callers consume
			// the result as a typed preview and never reach lastErrLine, and the
			// user must always learn why the pane went quiet.
			if (r.timedOut) this.banner = this.timeoutBanner(verb);
			return r;
		} finally {
			this.busy = false;
		}
	}

	timeoutBanner(verb) {
		return `harvest step '${verb}' timed out after ${this.stepTimeoutMs}ms and was killed — check for a hung git hook or lock, then retry (HERDR_SWARM_STEP_TIMEOUT_MS raises the limit)`;
	}

	lastErrLine(res) {
		// A killed child usually writes nothing to stderr, so the generic
		// "step failed (code)" line would hide the real cause.
		if (res.timedOut) return this.timeoutBanner(res.verb ?? "step");
		const ls = String(res.stderr || "")
			.split("\n")
			.filter((l) => l.trim() !== "");
		return ls[ls.length - 1] || `harvest step failed (${res.code})`;
	}

	// Re-read the manifest and re-preview every slot. Called after EVERY
	// successful merge (plan: re-baseline remaining previews) and on drift.
	async refresh() {
		let text = null;
		try {
			text = fs.readFileSync(this.manifestFile, "utf8");
		} catch {
			/* missing -> typed result below */
		}
		const parsed = parseManifest(text);
		if (!parsed.ok) {
			this.rows = [];
			this.runInfo = null;
			this.banner =
				parsed.reason === "missing"
					? "no active swarm run for this workspace"
					: `manifest is corrupt (${parsed.detail}) — harvest refuses to guess`;
			return;
		}
		const m = parsed.manifest;
		this.runInfo = {
			run_id: m.run_id,
			base_ref: m.base_ref,
			repo_root: m.repo_root,
		};
		const rows = [];
		// Sequential on purpose: every preview verb takes the per-repo mutation
		// lock, so concurrency here would only contend on that lock.
		for (const s of m.slots) {
			const row = {
				slot: s.slot,
				label: s.label,
				branch: s.branch,
				status: s.status,
				// A non-null journal means an unfinished merge intent. Carried onto
				// the row so the list phase can offer abort-merge without a resume
				// scan — otherwise a stale journal is only reachable at pane start.
				journal: s.journal ?? null,
				preview: null,
			};
			// Archived slots are settled history — no verb call, no row noise.
			if (s.status !== "archived") {
				row.preview = previewFromStep(await this.step("preview", [s.slot]));
			}
			rows.push(row);
		}
		this.rows = rows;
	}

	async reload() {
		await this.refresh();
		this.paint();
	}

	// Stale journals are queued behind the resume offers so a pane start that
	// has both surfaces both. Returns true when the phase was entered.
	enterStalePhase() {
		const slots = this.staleSlots ?? [];
		if (!slots.length) return false;
		this.staleSlots = [];
		this.phase = { name: "stale", slots, idx: 0 };
		return true;
	}

	// End of the resume queue: hand off to the stale queue before resting.
	async afterResume() {
		if (this.enterStalePhase()) {
			this.paint();
			return;
		}
		this.phase = { name: "list" };
		await this.reload();
	}

	async doMerge(slot) {
		const row = this.rows.find((r) => r.slot === slot);
		if (!row?.preview?.baseSha) return;
		const r = await this.step("merge", [slot, row.preview.baseSha]);
		if (r.code === 0) {
			this.banner = `slot ${slot} merged`;
			await this.doArchive(slot);
			// Re-baseline: every remaining preview must diff and merge against
			// the NEW base SHA (R7: drift re-checked before every merge).
			await this.reload();
		} else if (r.code === STEP_EC.DRIFT) {
			this.banner = "base moved since preview — re-previewing all slots";
			this.phase = { name: "list" };
			await this.reload();
		} else if (r.code === STEP_EC.CONFLICT || r.code === STEP_EC.HOOK) {
			this.phase = {
				name: "conflict",
				slot,
				kind: r.code === STEP_EC.HOOK ? "hook" : "conflict",
				files: (r.out.conflict_file ?? []).map((v) => v[0]),
				tree: r.out.merge_tree?.[0]?.[0] ?? null,
				message: this.lastErrLine(r),
			};
			this.paint();
		} else {
			this.banner = this.lastErrLine(r);
			this.phase = { name: "list" };
			this.paint();
		}
	}

	async doArchive(slot, approval = null) {
		const r = await this.step(
			"archive",
			[slot],
			approval ? { HERDR_SWARM_CLEANUP_APPROVAL: approval } : {},
		);
		if (r.code === STEP_EC.IGNORED) {
			this.phase = {
				name: "ignored",
				slot,
				approval: r.out.cleanup_approval?.[0]?.[0] ?? null,
				files: (r.out.ignored_json ?? []).map((v) => {
					try {
						return JSON.parse(v[0]);
					} catch {
						return v[0];
					}
				}),
			};
			this.paint();
		} else if (r.code === STEP_EC.DIRTY) {
			this.phase = { name: "dirty", slot };
			this.paint();
		} else if (r.code !== 0) {
			this.banner = this.lastErrLine(r);
			this.paint();
		}
	}

	async selectSlot(slot) {
		const row = this.rows.find((r) => r.slot === slot);
		if (!row?.preview) return;
		const p = row.preview;
		if (p.state === "dirty") {
			this.phase = { name: "dirty", slot };
			this.paint();
		} else if (p.state === "clean") {
			if (p.locus === "user-tree") {
				// The confirm is UI; the verb re-verifies clean+SHA when invoked
				// (the prompt can sit for minutes — merge-locus KTD).
				this.phase = { name: "confirm-user", slot, path: p.locusPath };
				this.paint();
			} else {
				await this.doMerge(slot);
			}
		} else if (
			// "empty" (auto-skipped: nothing past the fork) and "external_merged"
			// (the user merged it themselves) are terminal too — the preview verb
			// already wrote skipped/merged to the manifest. Omitting them left the
			// only route to archiving those slots a manual re-preview.
			p.state === "merged" ||
			p.state === "skipped" ||
			p.state === "failed" ||
			p.state === "empty" ||
			p.state === "external_merged"
		) {
			await this.doArchive(slot);
			await this.reload();
		} else {
			this.banner = `slot ${slot} is '${p.state}' — nothing to do here`;
			this.paint();
		}
	}

	// PTY handoff for shell-into-merge-tree: the child must own a sane
	// terminal, so leave the alt screen and raw mode first; the finally
	// restores BOTH even when the shell exits while the merge is still
	// conflicted or the spawn itself throws — terminal state is this
	// process's responsibility no matter what the merge tree looks like.
	shellInto(dir) {
		this.write(`${ESC}[?1049l${ESC}[?25h`);
		this.setRaw(false);
		try {
			this.spawnShell(dir);
		} finally {
			this.setRaw(true);
			this.write(`${ESC}[?1049h${ESC}[?25l`);
			this.lastScreen = null; // the shell scribbled on the screen: full repaint
			this.paint();
		}
	}

	// Seam for tests: overridden to observe ordering without a real shell.
	spawnShell(dir) {
		spawnSync(this.env.SHELL || "/bin/sh", [], {
			cwd: dir,
			stdio: "inherit",
			env: this.env,
		});
	}

	setRaw(on) {
		try {
			if (process.stdin.isTTY) process.stdin.setRawMode(on);
		} catch {
			/* not a TTY */
		}
	}

	async onKey(ch) {
		// busy: a destructive verb is in flight — every key (including ^C, see
		// run()'s SIGINT handler) is masked until it returns.
		if (this.busy) return;
		const ph = this.phase;
		if (ph.name === "discard") {
			// Line-input mode for the typed confirmation.
			if (ch === "\x1b") {
				this.phase = { name: "list" };
				this.paint();
			} else if (ch === "\r" || ch === "\n") {
				const typed = ph.typed;
				const row = this.rows.find((r) => r.slot === ph.slot);
				this.phase = { name: "list" };
				if (typed === row?.branch) {
					// Snapshot BEFORE discard — the verb refuses otherwise, but the
					// renderer sequences it explicitly so the user sees the ref.
					const snap = await this.step("snapshot", [ph.slot]);
					if (snap.code !== 0) {
						this.banner = this.lastErrLine(snap);
					} else {
						const d = await this.step("discard", [ph.slot], {
							HERDR_SWARM_CONFIRM: typed,
						});
						this.banner =
							d.code === 0
								? `slot ${ph.slot} discarded (backup: ${snap.out.snapshot?.[0]?.[0] ?? "recorded"})`
								: this.lastErrLine(d);
					}
					await this.reload();
				} else {
					this.banner = "discard cancelled — the typed name did not match";
					this.paint();
				}
			} else if (ch === "\x7f" || ch === "\b") {
				ph.typed = ph.typed.slice(0, -1);
				this.paint();
			} else if (ch >= " " && ch <= "~") {
				ph.typed += ch;
				this.paint();
			}
			return;
		}
		if (ch === "q" || ch === "\x03") {
			this.cleanup();
			process.exit(0);
		}
		switch (ph.name) {
			case "resume": {
				const offer = ph.offers[ph.idx];
				if (ch === "y" || ch === "Y") {
					const r = await this.step("resume", ["complete", offer.slot]);
					this.banner =
						r.code === 0
							? `slot ${offer.slot} swap completed`
							: this.lastErrLine(r);
				}
				if (ph.idx + 1 < ph.offers.length) {
					this.phase = { ...ph, idx: ph.idx + 1 };
					this.paint();
				} else {
					await this.afterResume();
				}
				break;
			}
			case "stale": {
				const slot = ph.slots[ph.idx];
				if (ch === "a" || ch === "A") {
					const r = await this.step("abort-merge", [slot]);
					this.banner =
						r.code === 0
							? `slot ${slot} stale merge aborted`
							: this.lastErrLine(r);
				}
				if (ph.idx + 1 < ph.slots.length) {
					this.phase = { ...ph, idx: ph.idx + 1 };
					this.paint();
				} else {
					this.phase = { name: "list" };
					await this.reload();
				}
				break;
			}
			case "dirty":
				if (ch === "w") {
					const r = await this.step("commit-wip", [ph.slot]);
					this.banner =
						r.code === 0
							? `slot ${ph.slot} committed as WIP`
							: this.lastErrLine(r);
					this.phase = { name: "list" };
					await this.reload();
				} else if (ch === "s") {
					const r = await this.step("skip", [ph.slot]);
					this.banner =
						r.code === 0 ? `slot ${ph.slot} skipped` : this.lastErrLine(r);
					this.phase = { name: "list" };
					await this.reload();
				} else if (ch === "d") {
					this.phase = { name: "discard", slot: ph.slot, typed: "" };
					this.paint();
				} else if (ch === "b" || ch === "\x1b") {
					this.phase = { name: "list" };
					this.paint();
				}
				break;
			case "confirm-user":
				if (ch === "y" || ch === "Y") {
					const slot = ph.slot;
					this.phase = { name: "list" };
					await this.doMerge(slot);
				} else {
					this.phase = { name: "list" };
					this.paint();
				}
				break;
			case "conflict":
				if (ch === "s" && ph.tree) {
					this.shellInto(ph.tree);
				} else if (ch === "a") {
					const r = await this.step("abort-merge", [ph.slot]);
					this.banner =
						r.code === 0
							? `slot ${ph.slot} merge aborted`
							: this.lastErrLine(r);
					this.phase = { name: "list" };
					await this.reload();
				} else if (ch === "b" || ch === "\x1b") {
					// Leave the conflict in place (the user may resolve by hand);
					// resume/abort-merge still know about it via the journal.
					this.phase = { name: "list" };
					this.paint();
				}
				break;
			case "ignored":
				if (ch === "y" || ch === "Y") {
					const slot = ph.slot;
					const approval = ph.approval;
					this.phase = { name: "list" };
					if (!approval) {
						this.banner = "cleanup approval missing — re-preview required";
						this.paint();
						break;
					}
					await this.doArchive(slot, approval);
					await this.reload();
				} else {
					this.banner = `slot ${ph.slot} kept — worktree not removed`;
					this.phase = { name: "list" };
					this.paint();
				}
				break;
			default:
				if (ch >= "1" && ch <= "9") await this.selectSlot(Number(ch));
				else if (ch === "r") {
					this.banner = "";
					await this.reload();
				} else if (ch === "a") {
					// Lowest journaled slot first; repeat to clear the next one.
					const row = this.rows.find((r) => r.journal);
					if (row) {
						const r = await this.step("abort-merge", [row.slot]);
						this.banner =
							r.code === 0
								? `slot ${row.slot} merge aborted`
								: this.lastErrLine(r);
						await this.reload();
					}
				}
		}
	}

	screen() {
		const cols = process.stdout.columns || 80;
		return renderHarvest(
			{
				runInfo: this.runInfo,
				banner: this.banner,
				phase: this.phase,
				rows: this.rows,
			},
			cols,
		);
	}

	paint() {
		const out = this.screen();
		if (out === this.lastScreen) return;
		this.lastScreen = out;
		this.write(
			`${ESC}[H${out.split("\n").join(`${ESC}[K\n`)}${ESC}[K\n${ESC}[0J`,
		);
	}

	cleanup() {
		try {
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
		} catch {
			/* never set */
		}
		this.write(`${ESC}[?1049l${ESC}[?25h`);
	}

	async run() {
		for (const sig of ["SIGTERM", "SIGHUP"]) {
			process.on(sig, () => {
				this.cleanup();
				process.exit(0);
			});
		}
		// SIGINT masked while a verb is in flight (destructive-surface KTD):
		// the verb's lock+journal make an interrupt survivable, but never free.
		process.on("SIGINT", () => {
			if (this.busy) return;
			this.cleanup();
			process.exit(0);
		});
		process.on("uncaughtException", (err) => {
			this.cleanup();
			console.error("herdr-swarm harvest renderer crashed:", err.message);
			process.exit(1);
		});
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
			process.stdin.resume();
			process.stdin.on("data", (chunk) => {
				(async () => {
					for (const ch of chunk.toString("utf8")) await this.onKey(ch);
				})().catch(() => {
					/* onKey failures surface via banners, never kill the pane */
				});
			});
		}
		this.write(`${ESC}[?1049h${ESC}[?25l`);
		process.stdout.on("resize", () => {
			this.lastScreen = null;
			this.paint();
		});
		// Journal scan FIRST (manifest KTD): a crashed merge is surfaced before
		// any new destructive step is offered.
		const r = await this.step("resume");
		const offers = (r.out.resume_offer ?? []).map(([slot, sha]) => ({
			slot: Number(slot),
			sha,
		}));
		// resume_stale rows have a journal but no merge commit — resume can do
		// nothing with them, yet leaving them journaled makes every subsequent
		// merge refuse. Queued behind the offers so both get surfaced.
		this.staleSlots = (r.out.resume_stale ?? []).map(([slot]) => Number(slot));
		const dangling = r.out.resume_dangling ?? [];
		if (dangling.length) {
			this.banner = `DANGLING merge commit(s): ${dangling
				.map(
					(v) =>
						`slot ${v[0]} @ ${String(v[1]).slice(0, 10)} (kept in ${v[2]})`,
				)
				.join("; ")}`;
		}
		if (offers.length) this.phase = { name: "resume", offers, idx: 0 };
		else this.enterStalePhase();
		await this.refresh();
		this.paint();
		// The pane lives until the user quits; headless (tests, pane without a
		// TTY) it lingers after the first paint like every other pane script.
		await new Promise(() => {});
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	// Construct inside the async wrapper so constructor failures hit the same
	// catch and never flash-close the pane.
	(async () => {
		const mode = process.env.HERDR_SWARM_PANE_MODE || "status";
		await (mode === "harvest" ? new HarvestRenderer() : new Renderer()).run();
	})().catch((err) => {
		// Restore raw mode + screen even when the crash predates run()'s own
		// handlers — a pane left in raw mode swallows keystrokes for the whole
		// 10-minute linger below.
		try {
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
		} catch {
			/* never set */
		}
		process.stdout.write(`${ESC}[?1049l${ESC}[?25h`);
		console.error("herdr-swarm renderer crashed:", err.message);
		setTimeout(() => process.exit(1), 600_000);
	});
}
