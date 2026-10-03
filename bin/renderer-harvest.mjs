// herdr-swarm pane renderer — harvest mode (U6). UI + state machine +
// orchestration ONLY (destructive-surface KTD): every state-mutating
// git/herdr step runs through `bash scripts/harvest-step.sh <verb>` — no
// git-mutation or raw-CLI strings live in this file (tests/harvest.test.mjs
// greps every bin/ file for violations).
import { execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import {
	ESC,
	pad,
	sanitizeText,
	manifestPath,
	parseManifest,
} from "./renderer-shared.mjs";

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
// The pane's env minus every variable that reroutes or reconfigures git —
// the same list scripts/lib.sh clear_git_routing_env removes.
const GIT_ROUTING = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
	"GIT_PREFIX", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]);
export function gitDisplayEnv(env) {
	return Object.fromEntries(Object.entries(env).filter(([k]) =>
		!GIT_ROUTING.has(k) && !/^GIT_CONFIG_(KEY|VALUE)_/.test(k)));
}

// Compare table: ranked candidates first, then settled slots (no rank).
// Every field is manifest- or git-derived text, so all of it is sanitized.
export function renderCompare(view, cols = 80) {
	const lines = [
		` ${pad("rank", 5)}${pad("#", 3)}${pad("checks", 16)}${pad("commits", 8)}${pad("files", 6)}${pad("+/-", 12)}${pad("dirty", 6)}${pad("finished", 9)}label`.slice(0, cols),
	];
	if (!view.slots?.length) lines.push("  (no slots to compare)");
	for (const s of view.slots ?? []) {
		const v = s.validation ?? {};
		const failed = v.failed_checks?.length ? `:${v.failed_checks.join(",")}` : "";
		const checks = v.status === "none" ? "not run" : `${v.status}${failed}`;
		const line = ` ${pad(s.rank ?? "-", 5)}${pad(s.slot, 3)}${pad(sanitizeText(checks).slice(0, 15), 16)}${pad(s.commits ?? "-", 8)}${pad(
			s.file_count ?? "-",
			6,
		)}${pad(s.insertions == null ? "-" : `+${s.insertions}/-${s.deletions}`, 12)}${pad(s.dirty ?? "-", 6)}${pad(
			sanitizeText(s.finished ?? (s.candidate ? "no" : s.status ?? "")),
			9,
		)}${sanitizeText(s.label ?? "")}`.slice(0, cols);
		// Failed checks are the one thing that must not be missed when picking.
		lines.push(v.status === "failed" ? `${ESC}[7m${line}${ESC}[0m` : line);
	}
	const overlaps = (view.overlaps ?? []).filter((o) => o.count !== 0);
	if (overlaps.length) {
		lines.push("");
		lines.push(" overlap (files both slots changed):");
		for (const o of overlaps) {
			if (o.count < 0) {
				lines.push(`   ${o.a} & ${o.b}: unknown - a diff could not be read; compare by hand (d)`.slice(0, cols));
				continue;
			}
			const more = o.count > o.shared.length ? `, +${o.count - o.shared.length} more` : "";
			lines.push(`   ${o.a} & ${o.b}: ${o.count} - ${sanitizeText(o.shared.join(", "))}${more}`.slice(0, cols));
		}
	} else if ((view.overlaps ?? []).length) {
		lines.push("");
		lines.push(" overlap: none - the candidates touch disjoint files");
	}
	return lines;
}

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
	const ph = model.phase ?? { name: "list" };
	// The compare view replaces the slot list: same slots, more columns.
	if (ph.name === "compare" || ph.name === "winner-confirm") {
		const view = ph.name === "compare" ? ph : ph.back;
		lines.push(...renderCompare(view, cols));
		lines.push("");
		if (ph.name === "winner-confirm") {
			lines.push(` MERGE slot ${ph.slot} at ${String(ph.tip ?? "").slice(0, 7)}${ph.locus === "user-tree" ? " into your checked-out branch" : ""}, then SKIP ${
				ph.others.length ? `slot${ph.others.length > 1 ? "s" : ""} ${ph.others.join(", ")}` : "nothing"
			}?`.slice(0, cols));
			if (ph.unfinished?.length)
				lines.push(` Left running, agent not finished: ${ph.unfinished.join(", ")}.`.slice(0, cols));
			lines.push(" Branches are kept. Worktrees that archive cleanly are archived; the rest stay and are named.".slice(0, cols));
			lines.push(" Nothing is skipped unless the merge lands, and it refuses if the slot moved since compare.".slice(0, cols));
			lines.push(`${ESC}[2m [y]merge winner  [n]back${ESC}[0m`);
		} else if (ph.pick?.op === "diff") {
			lines.push(ph.pick.first == null ? " DIFF: first slot?" : ` DIFF: slot ${ph.pick.first} against which slot?`);
			lines.push(`${ESC}[2m [1-9]slot  [Esc]cancel${ESC}[0m`);
		} else if (ph.pick?.op === "merge") {
			lines.push(" WINNER: merge which slot (the others are skipped)?");
			lines.push(`${ESC}[2m [1-9]slot  [Esc]cancel${ESC}[0m`);
		} else {
			lines.push(`${ESC}[2m d:diff two slots  m:merge winner, skip the rest  r:refresh  b:back${ESC}[0m`);
		}
		return lines.join("\n");
	}
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
		case "publish-pick":
			lines.push(
				` PUBLISH: push which slot's branch to the remote (plain push, never force)?`,
			);
			lines.push(
				` The forge merge is auto-detected on a later re-preview once base updates.`,
			);
			lines.push(`${ESC}[2m [1-9]slot  [Esc]cancel${ESC}[0m`);
			break;
		case "validate-pick":
			lines.push(" VALIDATE: run validate.sh against which slot's clean HEAD?");
			lines.push(" The pane waits while it runs; output goes to the plugin state dir.");
			lines.push(`${ESC}[2m [1-9]slot  [Esc]cancel${ESC}[0m`);
			break;
		case "github-pick":
			lines.push(ph.operation === "publish-pr"
				? " GITHUB DRAFT: push a slot and create/reuse its exact matching PR?"
				: " GITHUB CI: inspect which slot's PR? (read-only)");
			lines.push(" Validation comes from HERDR_SWARM_VALIDATION_FILE; absent means not run.");
			lines.push(`${ESC}[2m [1-9]slot  [Esc]cancel${ESC}[0m`);
			break;
		default: {
			// Any row still carrying a journal wedges every merge (sequencer_scan
			// / the merge verb's own refusal), so the escape hatch has to be
			// reachable from the resting phase — not only from conflict.
			const j = (model.rows ?? []).find((r) => r.journal);
			lines.push(
				`${ESC}[2m 1-9:select slot (merge/prompt)  p:publish to remote  r:re-preview${
					j ? `  a:abort stale merge (slot ${j.slot})` : ""
				}  q:quit${ESC}[0m`,
			);
			lines.push(`${ESC}[2m w:compare slots  v:validate slot  g:draft GitHub PR  c:read GitHub CI${ESC}[0m`);
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
		// validate runs the operator's test suite: its own budget (the hook
		// timeout) plus headroom for the verb to kill the hook's process group
		// and record the failure, so the pane never kills it mid-record.
		this.validateTimeoutMs = Math.max(
			this.stepTimeoutMs,
			((Number(env.HERDR_SWARM_VALIDATE_TIMEOUT) || 900) + 30) * 1000,
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
	async step(verb, args = [], extraEnv = {}, timeoutMs = this.stepTimeoutMs) {
		this.busy = true;
		try {
			const r = await new Promise((resolve) => {
				execFile(
					"bash",
					[this.stepScript, verb, ...args.map(String)],
					{
						env: { ...this.env, ...extraEnv },
						maxBuffer: 16 * 1024 * 1024,
						timeout: timeoutMs,
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
			r.timeoutMs = timeoutMs;
			if (r.timedOut) this.banner = this.timeoutBanner(verb, timeoutMs);
			return r;
		} finally {
			this.busy = false;
		}
	}

	timeoutBanner(verb, timeoutMs = this.stepTimeoutMs) {
		return `harvest step '${verb}' timed out after ${timeoutMs}ms and was killed — check for a hung git hook or lock, then retry (HERDR_SWARM_STEP_TIMEOUT_MS raises the limit)`;
	}

	lastErrLine(res) {
		// A killed child usually writes nothing to stderr, so the generic
		// "step failed (code)" line would hide the real cause.
		if (res.timedOut) return this.timeoutBanner(res.verb ?? "step", res.timeoutMs);
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

	// Returns true only when the merge landed; every other outcome has already
	// set the phase/banner the user needs (conflict, drift, refusal).
	// expectTip (compare view): merge refuses unless the slot is still at the
	// exact tip that was ranked and validated, and then merges that SHA.
	async doMerge(slot, expectTip = null) {
		const row = this.rows.find((r) => r.slot === slot);
		if (!row?.preview?.baseSha) return false;
		const r = await this.step("merge", expectTip ? [slot, row.preview.baseSha, expectTip] : [slot, row.preview.baseSha]);
		if (r.code === 0) {
			this.banner = `slot ${slot} merged`;
			// Pane-backed slots retain their plugin-reported working state until
			// a terminal-state preview reconciles it. Refresh before archive so
			// its unchanged settled-agent guard sees the completed harvest.
			const settled = await this.step("preview", [slot]);
			if (settled.code === 0) await this.doArchive(slot);
			else this.banner = `slot ${slot} merged; ${this.lastErrLine(settled)}`;
			// Re-baseline: every remaining preview must diff and merge against
			// the NEW base SHA (R7: drift re-checked before every merge).
			await this.reload();
			return true;
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
		return false;
	}

	// Compare view: one read-only `compare` verb call, parsed into the phase.
	async openCompare() {
		const r = await this.step("compare");
		if (r.code !== 0) {
			this.banner = this.lastErrLine(r);
			this.phase = { name: "list" };
			this.paint();
			return;
		}
		const slots = [];
		for (const [json] of r.out.compare_slot ?? []) {
			try {
				slots.push(JSON.parse(json));
			} catch {
				/* a malformed record is dropped, never guessed at */
			}
		}
		const overlaps = (r.out.compare_overlap ?? []).map(([a, b, n, shared]) => {
			let files = [];
			try {
				files = JSON.parse(shared);
			} catch {
				/* count alone still informs */
			}
			return { a: Number(a), b: Number(b), count: Number(n), shared: files };
		});
		this.phase = { name: "compare", slots, overlaps, pick: null };
		this.paint();
	}

	// Two slots' tips, full diff, in git's own pager: the same terminal
	// handoff as the merge-tree shell, restored no matter how the pager ends.
	showDiff(a, b) {
		this.write(`${ESC}[?1049l${ESC}[?25h`);
		this.setRaw(false);
		try {
			this.spawnDiff(a, b);
		} finally {
			this.setRaw(true);
			this.write(`${ESC}[?1049h${ESC}[?25l`);
			this.lastScreen = null;
			this.paint();
		}
	}

	// Seam for tests. Read-only git against the run's repo: inherited routing
	// variables are dropped (as clear_git_routing_env does for the verbs) so
	// the diff shown is the diff compared, and external diff drivers and
	// textconv filters are off — the patch is agent-written content. The
	// pager is the user's own git config; the bytes reach their terminal
	// through it, exactly as `git diff` in their shell would.
	spawnDiff(a, b) {
		spawnSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--stat", "--patch", a, b], {
			cwd: this.runInfo?.repo_root || undefined,
			stdio: "inherit",
			env: gitDisplayEnv(this.env),
		});
	}

	// Merge the chosen slot at the exact tip the compare view showed, then —
	// only if that merge LANDED — skip every other running slot whose agent
	// has FINISHED and archive whichever archive cleanly. Unfinished slots are
	// left running (skipping one would let its agent keep committing to a
	// settled slot nobody looks at again). Branches are always kept (skip is
	// bookkeeping; archive never deletes a branch). Anything that refuses to
	// archive — the winner included — is left in place and named, never forced.
	async mergeWinner(confirm) {
		const { slot, tip, others, unfinished, locus } = confirm;
		await this.refresh();
		const row = this.rows.find((r) => r.slot === slot);
		if (row?.preview?.state !== "clean") {
			this.banner = `slot ${slot} is '${row?.preview?.state ?? "unknown"}' — resolve it from the list (${slot}) first; nothing was merged or skipped`;
			this.phase = { name: "list" };
			this.paint();
			return;
		}
		// The confirm named where the merge lands; if that changed since (base
		// checked out or switched away meanwhile), ask again with the truth.
		if ((row.preview.locus ?? null) !== locus) {
			this.phase = { ...confirm, locus: row.preview.locus ?? null };
			this.banner = "where the merge lands changed since you confirmed — confirm again";
			this.paint();
			return;
		}
		if (!(await this.doMerge(slot, tip))) return;
		// doMerge already tried to archive the winner; an ignored-files approval
		// or dirty prompt it raised must survive the summary below.
		const winnerPrompt = ["ignored", "dirty"].includes(this.phase.name) ? this.phase : null;
		const skipped = [];
		const kept = [];
		for (const s of others) {
			if (this.rows.find((r) => r.slot === s)?.status !== "running") continue;
			const sk = await this.step("skip", [s]);
			if (sk.code !== 0) {
				kept.push(`${s} (skip failed)`);
				continue;
			}
			skipped.push(s);
			const ar = await this.step("archive", [s]);
			if (ar.code !== 0) kept.push(String(s));
		}
		await this.reload();
		// A finalized run has no rows left at all — that means everything,
		// winner included, archived. Only a winner row still present and not
		// archived is a worktree left behind.
		const winnerRow = this.rows.find((r) => r.slot === slot);
		if (winnerRow && winnerRow.status !== "archived") kept.unshift(`${slot} (winner)`);
		this.phase = winnerPrompt ?? { name: "list" };
		this.banner = `slot ${slot} merged${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}${
			unfinished.length ? `; still running (agent not finished): ${unfinished.join(", ")}` : ""
		}${kept.length ? `; worktrees kept for ${kept.join(", ")} — archive them from the list` : ""}`;
		this.paint();
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
			// "empty" (auto-skipped: nothing past the fork), "external_merged"
			// (the user merged it themselves), and "squash_merged" (content in
			// base with no ancestry trail) are terminal too — the preview verb
			// already wrote skipped/merged to the manifest. Omitting them left the
			// only route to archiving those slots a manual re-preview.
			p.state === "merged" ||
			p.state === "skipped" ||
			p.state === "failed" ||
			p.state === "empty" ||
			p.state === "external_merged" ||
			p.state === "squash_merged"
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
		// busy masks per-verb; keyInFlight masks the whole handler. Several
		// handlers run MORE than one verb with awaits between them (merge →
		// archive → reload; snapshot → discard → reload), and run() dispatches
		// each stdin chunk as its own async task — without an operation-level
		// guard a key landing between two verbs would interleave two handlers
		// mutating phase/rows/banner.
		if (this.busy || this.keyInFlight) return;
		this.keyInFlight = true;
		try {
			await this.handleKey(ch);
		} finally {
			this.keyInFlight = false;
		}
	}

	async handleKey(ch) {
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
			case "publish-pick":
				if (ch >= "1" && ch <= "9") {
					const slot = Number(ch);
					this.phase = { name: "list" };
					if (!this.rows.find((r) => r.slot === slot)) {
						this.banner = `no slot ${slot} in this run`;
						this.paint();
						break;
					}
					const r = await this.step("publish", [slot]);
					if (r.code === 0) {
						const [, remote, sha] = r.out.published?.[0] ?? [];
						this.banner = `slot ${slot} published to ${remote ?? "remote"} (${String(sha ?? "").slice(0, 10)})`;
					} else {
						this.banner = this.lastErrLine(r);
					}
					await this.reload();
				} else if (ch === "b" || ch === "\x1b") {
					this.phase = { name: "list" };
					this.paint();
				}
				break;
			case "compare": {
				const bySlot = (n) => ph.slots.find((s) => s.slot === n);
				if (ph.pick && ch >= "1" && ch <= "9") {
					const n = Number(ch);
					const chosen = bySlot(n);
					if (!chosen) {
						this.banner = `no slot ${n} in this comparison`;
						ph.pick = null;
					} else if (ph.pick.op === "diff" && ph.pick.first == null) {
						ph.pick.first = n;
					} else if (ph.pick.op === "diff") {
						const first = bySlot(ph.pick.first);
						ph.pick = null;
						if (first.tip && chosen.tip) this.showDiff(first.tip, chosen.tip);
						else this.banner = "both slots need a branch tip to diff";
					} else if (!chosen.candidate) {
						this.banner = `slot ${n} is '${chosen.status}' — only a running slot can win`;
						ph.pick = null;
					} else if (!chosen.tip) {
						this.banner = `slot ${n} has no branch tip to merge`;
						ph.pick = null;
					} else {
						const rest = ph.slots.filter((s) => s.candidate && s.slot !== n);
						this.phase = {
							name: "winner-confirm",
							slot: n,
							tip: chosen.tip,
							others: rest.filter((s) => s.finished).map((s) => s.slot),
							unfinished: rest.filter((s) => !s.finished).map((s) => s.slot),
							locus: this.rows.find((r) => r.slot === n)?.preview?.locus ?? null,
							back: ph,
						};
					}
					this.paint();
				} else if (ch === "d" || ch === "m") {
					ph.pick = { op: ch === "d" ? "diff" : "merge", first: null };
					this.paint();
				} else if (ch === "r") {
					await this.openCompare();
				} else if (ch === "b" || ch === "\x1b" || ch === "q") {
					if (ph.pick) ph.pick = null;
					else this.phase = { name: "list" };
					this.paint();
				}
				break;
			}
			case "winner-confirm":
				if (ch === "y" || ch === "Y") {
					await this.mergeWinner(ph);
				} else {
					this.phase = ph.back;
					this.phase.pick = null;
					this.paint();
				}
				break;
			case "validate-pick":
				if (ch >= "1" && ch <= "9") {
					const slot = Number(ch);
					this.phase = { name: "list" };
					if (!this.rows.some((row) => row.slot === slot)) {
						this.banner = `no slot ${slot} in this run`;
						this.paint();
						break;
					}
					this.banner = `validating slot ${slot}…`;
					this.paint();
					const result = await this.step("validate", [slot], {}, this.validateTimeoutMs);
					const [, sha, status] = result.out.validated?.[0] ?? [];
					this.banner = result.code === 0 && sha
						? `slot ${slot} validation ${status} @ ${sha.slice(0, 7)}`
						: this.lastErrLine(result);
					this.paint();
				} else if (ch === "b" || ch === "\x1b") {
					this.phase = { name: "list" };
					this.paint();
				}
				break;
			case "github-pick":
				if (ch >= "1" && ch <= "9") {
					const slot = Number(ch);
					this.phase = { name: "list" };
					if (!this.rows.some((row) => row.slot === slot)) {
						this.banner = `no slot ${slot} in this run`;
						this.paint();
						break;
					}
					const result = await this.step(ph.operation, [slot]);
					if (result.code !== 0) this.banner = this.lastErrLine(result);
					else {
						try {
							const key = ph.operation === "publish-pr" ? "pull_request" : "ci_status";
							const value = JSON.parse(result.out[key]?.[0]?.[0]);
							this.banner = ph.operation === "publish-pr"
								? `${value.reused ? "reused" : "draft created"}: ${value.url}${value.reused ? " (existing body preserved)" : ""}`
								: `CI ${value.status}${value.matches_local_head === false ? " (remote head differs from local)" : ""}${value.url ? `: ${value.url}` : ""}`;
						} catch { this.banner = "GitHub response was malformed; inspect the PR before retrying."; }
					}
					this.paint();
				} else if (ch === "b" || ch === "\x1b") {
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
				else if (ch === "p") {
					this.phase = { name: "publish-pick" };
					this.paint();
				} else if (ch === "v") {
					this.phase = { name: "validate-pick" };
					this.paint();
				} else if (ch === "w") {
					await this.openCompare();
				} else if (ch === "g" || ch === "c") {
					this.phase = { name: "github-pick", operation: ch === "g" ? "publish-pr" : "pr-status" };
					this.paint();
				} else if (ch === "r") {
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
