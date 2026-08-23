// herdr-swarm pane renderer — status mode (U5). STRICTLY READ-ONLY on the
// run manifest: this process reconciles manifest × live Herdr state × git
// facts in memory for display and never writes any of them back
// (tests/renderer.test.mjs asserts a full poll cycle performs zero fs writes).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import {
	ESC,
	pad,
	sanitizeText,
	manifestPath,
	parseManifest,
	reconcileSlots,
	sortSlots,
	diffRange,
	parseDiffStat,
	parseStatusPorcelain,
	pollDelay,
} from "./renderer-shared.mjs";

const pExecFile = promisify(execFile);

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
