#!/usr/bin/env node
// herdr-swarm pane renderer — status mode (U5).
//
// STRICTLY READ-ONLY on the run manifest: the single-writer rule (plan KTD)
// says writers are launchers and harvest verbs only. This process reconciles
// manifest × live Herdr state × git facts in memory for display and never
// writes any of them back; tests/renderer.test.mjs asserts a full poll cycle
// performs zero fs writes.
//
// U6 seam: HERDR_SWARM_PANE_MODE selects the pane's mode at spawn time
// (status-pane.sh exports "status"; harvest-pane.sh will export "harvest").
// Only status is implemented here; unknown modes linger with a message
// instead of flash-closing the pane.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
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
		if (facts.worktreeMissing || facts.branchMissing) {
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
		const line = ` ${pad(r.slot, 3)}${pad(r.state, 9)}${pad(counts, 8)}${pad(
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
				await this.git(["diff", "--stat", diffRange(manifest.fork_sha)], row.path),
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
		const agents = await this.herdr.agentList();
		const gitFacts = {};
		for (const row of m.slots) {
			gitFacts[row.slot] = await this.gitFactsFor(m, row);
		}
		this.rows = sortSlots(reconcileSlots(m.slots, agents, gitFacts));
		this.banner = agents === null ? "agent list unavailable — states shown as unknown" : "";
		this.paint();
	}

	screen() {
		const cols = process.stdout.columns || 80;
		const short = (s) => (s ? String(s).slice(0, 10) : "?");
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
			// U6 seam: harvest (or any future mode) is selected by env but not
			// built yet — linger with the message instead of flash-closing.
			process.stdout.write(
				`herdr-swarm: pane mode '${sanitizeText(this.mode)}' is not implemented yet (harvest lands in U6).\n`,
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

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	// Construct inside the async wrapper so constructor failures hit the same
	// catch and never flash-close the pane.
	(async () => {
		await new Renderer().run();
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
