// Shared stub-CLI test harness — the ONE harness for every test file in this
// repo (repo rule: extend it here, never re-invent it per file). node --test
// runs each file in its own process, so createHarness() per file gives
// isolated stub/state dirs with zero cross-file interference.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

// Scripts under test make real commits (WIP, snapshot, merge, revert); the
// harness env has GIT_CONFIG_GLOBAL=/dev/null, so identity must ride in
// explicitly or every commit-producing path dies on "unable to auto-detect
// email". Spread into freshEnv overrides by tests that shell out to git.
export const gitIdent = {
	GIT_AUTHOR_NAME: "hs-test",
	GIT_AUTHOR_EMAIL: "hs@test.invalid",
	GIT_COMMITTER_NAME: "hs-test",
	GIT_COMMITTER_EMAIL: "hs@test.invalid",
};

// Every harness-made temp dir is tracked here and swept when the test process
// exits (node --test = one process per file, so the sweep is per-file). A full
// run otherwise strands well over a thousand fixture dirs under os.tmpdir().
// HS_KEEP_TMP=1 keeps everything for post-mortem inspection.
const tempDirs = [];
export function mkdtemp(prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}
// Fixtures deliberately drop write permission in places (read-only state-dir
// tests); restore it so the sweep can finish.
function makeWritable(dir) {
	try {
		fs.chmodSync(dir, 0o700);
	} catch {}
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.isDirectory()) makeWritable(path.join(dir, e.name));
	}
}
process.on("exit", () => {
	if (process.env.HS_KEEP_TMP) return;
	for (const dir of tempDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			try {
				makeWritable(dir);
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	}
});

// Module-scope (not per-harness): stateless — fixed identity env, no stub or
// state dir involved — and needed by the shared fixtures below.
function git(cwd, ...args) {
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			PATH: "/usr/bin:/bin",
			HOME: os.homedir(),
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			...gitIdent,
		},
	});
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	}
	return r;
}

// Stage + commit one file; returns the new HEAD SHA.
export function commitIn(dir, name, content = "work\n", msg = `add ${name}`) {
	fs.writeFileSync(path.join(dir, name), content);
	git(dir, "add", name);
	git(dir, "commit", "-q", "-m", msg);
	return git(dir, "rev-parse", "HEAD").stdout.trim();
}

// Per-file is enough for run-id uniqueness: node --test gives each test file
// its own process, so this counter never collides across files.
let runSeq = 0;

// A fanned-out-looking run built directly: real repo, real slot worktrees on
// run-unique branches forked at the recorded SHA, manifest written the way
// fanout-pane.sh writes it (task file present + excluded, like reality).
// opts: { prefix (run-id prefix, e.g. "r-hv"), slots (default 1),
//         status (slot status, default "running") }.
export function makeFannedOutRun(h, opts = {}) {
	const nslots = opts.slots ?? 1;
	const repo = h.makeRepo();
	const runId = `${opts.prefix ?? "r"}${++runSeq}`;
	const fork = git(repo, "rev-parse", "HEAD").stdout.trim();
	const sdir = mkdtemp("hs-run-");
	fs.appendFileSync(path.join(repo, ".git/info/exclude"), ".swarm-task.md\n");
	const slots = [];
	for (let i = 1; i <= nslots; i++) {
		const branch = `swarm/${runId}/s${i}`;
		const wt = path.join(
			mkdtemp("hs-wt-"),
			`s${i}`,
		);
		git(repo, "worktree", "add", "-q", "-b", branch, wt, fork);
		fs.writeFileSync(path.join(wt, ".swarm-task.md"), "task\n");
		slots.push({
			slot: i,
			label: `s${i}`,
			branch,
			path: wt,
			workspace_id: `w${10 + i}`,
			pane_id: `w${10 + i}:p1`,
			terminal_id: `term_s${i}`,
			agent_name: "claude",
			self_created: true,
			status: opts.status ?? "running",
			backup_ref: null,
			journal: null,
		});
	}
	const manifest = {
		run_id: runId,
		repo_root: repo,
		base_ref: "refs/heads/main",
		fork_sha: fork,
		created_at: "2026-07-22T15:00:00Z",
		exclude_pattern_added: true,
		slots,
	};
	fs.writeFileSync(
		path.join(sdir, "run-w9.json"),
		JSON.stringify(manifest, null, 2),
	);
	const env = h.freshEnv({ HERDR_PLUGIN_STATE_DIR: sdir, ...gitIdent });
	return {
		repo,
		runId,
		fork,
		sdir,
		env,
		wt: (i) => slots[i - 1].path,
		branch: (i) => slots[i - 1].branch,
		manifest: () =>
			JSON.parse(fs.readFileSync(path.join(sdir, "run-w9.json"), "utf8")),
		slotRow: (i) => {
			const live = path.join(sdir, "run-w9.json");
			const file = fs.existsSync(live)
				? live
				: path.join(sdir, `archived-${runId}.json`);
			return JSON.parse(fs.readFileSync(file, "utf8")).slots.find(
				(s) => s.slot === i,
			);
		},
		archived: () =>
			JSON.parse(
				fs.readFileSync(path.join(sdir, `archived-${runId}.json`), "utf8"),
			),
	};
}

// Canonical U3 manifest fixture: the FULL KTD schema, every field present —
// schema drift then breaks tests loudly instead of silently narrowing what
// they exercise. Slot 1 is the write-ahead shape (pending row written before
// `worktree create` returns, so path/ids are still null); slot 2 is a fully
// recorded running slot.
export function sampleManifest(overrides = {}) {
	return JSON.stringify(
		{
			run_id: "r-20260722-abc1",
			repo_root: "/tmp/repo",
			base_ref: "refs/heads/main",
			fork_sha: "a".repeat(40),
			created_at: "2026-07-22T15:00:00Z",
			exclude_pattern_added: false,
			slots: [
				{
					slot: 1,
					label: "s1",
					branch: "swarm/r-20260722-abc1/s1",
					path: null,
					workspace_id: null,
					pane_id: null,
					terminal_id: null,
					agent_name: "claude",
					self_created: true,
					status: "pending",
					backup_ref: null,
					journal: null,
				},
				{
					slot: 2,
					label: "s2",
					branch: "swarm/r-20260722-abc1/s2",
					path: "/tmp/herdr-worktrees/repo/swarm-r-20260722-abc1-s2",
					workspace_id: "w9",
					pane_id: "w9:p4",
					terminal_id: "term_abc123",
					agent_name: "claude",
					self_created: true,
					status: "running",
					backup_ref: null,
					journal: null,
				},
			],
			...overrides,
		},
		null,
		2,
	);
}

export function createHarness() {
	const stubDir = mkdtemp("hs-stub-");
	const stateDir = mkdtemp("hs-state-");
	const logFile = path.join(stubDir, "calls.log");

	function writeStub(name, body) {
		const p = path.join(stubDir, name);
		fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}`);
		fs.chmodSync(p, 0o755);
	}

	function freshEnv(overrides = {}) {
		fs.writeFileSync(logFile, "");
		return {
			PATH: `${stubDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
			HOME: os.homedir(),
			// Real-git tests must not inherit the user's config: hooksPath or
			// commit signing from ~/.gitconfig would hang a headless run.
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			STUB_LOG: logFile,
			HERDR_BIN_PATH: path.join(stubDir, "herdr"),
			HERDR_PLUGIN_ROOT: repoRoot,
			HERDR_PLUGIN_STATE_DIR: stateDir,
			HERDR_WORKSPACE_ID: "w9",
			...overrides,
		};
	}

	function runScript(script, args = [], env = freshEnv()) {
		return spawnSync(
			"bash",
			[path.join(repoRoot, "scripts", script), ...args],
			{ env, encoding: "utf8" },
		);
	}

	// Runs a snippet with lib.sh sourced — the unit under test is a bash
	// function, not a script, so tests drive functions directly.
	// opts: sources (extra/other files to source, e.g. scripts/preflight.sh),
	// cwd (git-backed checks run inside a throwaway repo), input (stdin for
	// functions like manifest_write that read the payload from stdin).
	function runLib(snippet, env = freshEnv(), opts = {}) {
		const sources = opts.sources ?? ["scripts/lib.sh"];
		const preamble = sources
			.map((s) => `. "${path.join(repoRoot, s)}"`)
			.join(" && ");
		return spawnSync("bash", ["-c", `${preamble} && ${snippet}`], {
			env,
			encoding: "utf8",
			cwd: opts.cwd,
			input: opts.input,
		});
	}

	const log = () => fs.readFileSync(logFile, "utf8");

	// The default herdr stub, mirroring real 0.7.4 JSON shapes so consumers
	// are tested against the true wire format, not an invented one.
	function writeHerdrStub() {
		writeStub(
			"herdr",
			`echo "herdr $@" >> "$STUB_LOG"
if [ "$1" = "--version" ]; then echo "herdr \${STUB_HERDR_VERSION:-0.7.4}"; exit 0; fi
if [ "$1" = "worktree" ] && [ "$2" = "create" ]; then
  # Mirrors the real herdr 0.7.4 worktree_created result (api schema, protocol
  # 16): workspace/tab/root_pane/worktree, worktree carries the real path.
  echo '{"id":"cli:worktree:create","result":{"root_pane":{"agent_status":"unknown","pane_id":"w9:p1","tab_id":"w9:t1","workspace_id":"w9"},"tab":{"tab_id":"w9:t1","workspace_id":"w9"},"type":"worktree_created","workspace":{"active_tab_id":"w9:t1","agent_status":"unknown","focused":true,"label":"swarm/r1/s1","number":7,"pane_count":1,"tab_count":1,"workspace_id":"w9"},"worktree":{"branch":"swarm/r1/s1","is_bare":false,"is_detached":false,"is_linked_worktree":true,"is_prunable":false,"label":"swarm/r1/s1","open_workspace_id":"w9","path":"/tmp/herdr-worktrees/repo/swarm-r1-s1"}}}'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then
  # Mirrors the real 0.7.4 pane_list schema: plugin panes carry the manifest
  # pane title as "label"; plain terminal panes have no label.
  echo '{"id":"cli:pane:list","result":{"panes":[{"agent_status":"unknown","label":"Swarm Status","pane_id":"w9:p9","tab_id":"w9:t1","workspace_id":"w9"},{"agent":"claude","agent_status":"idle","pane_id":"w9:p4","tab_id":"w9:t1","terminal_title":"claude","workspace_id":"w9"}],"type":"pane_list"}}'
  exit 0
fi
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  # Mirrors the 0.7.4 agent_list shape captured in the U1 spike (baseline.txt).
  echo '{"id":"cli:agent:list","result":{"agents":[{"agent":"claude","agent_status":"idle","cwd":"/tmp/herdr-worktrees/repo/swarm-r1-s1","focused":false,"foreground_cwd":"/tmp/herdr-worktrees/repo/swarm-r1-s1","pane_id":"w9:p4","revision":3,"screen_detection_skipped":true,"tab_id":"w9:t1","terminal_id":"term_abc123","terminal_title":"claude","terminal_title_stripped":"claude","workspace_id":"w9"}],"type":"agent_list"}}'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  # Mirrors the real 0.7.5 pane_info result captured live (spike pane-split-cwd
  # + the 0.7.5 re-probe): ids the 0.7.5 fan-out path reads live in result.pane.
  echo '{"id":"cli:pane:split","result":{"pane":{"agent_status":"unknown","focused":false,"pane_id":"w9:p7","revision":0,"tab_id":"w9:t1","terminal_id":"term_split7","workspace_id":"w9"},"type":"pane_info"}}'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "report-agent" ]; then
  # Live-verified: report-agent prints NOTHING on success. The 0.7.5 path must
  # therefore synthesize its own response, never parse one back.
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "read" ]; then exit "\${STUB_PANE_ALIVE:-1}"; fi
exit 0`,
		);
	}

	// Throwaway real git repo — cheaper and more faithful than stubbing git
	// for repo-state checks; pass it as opts.cwd to runLib. {empty: true}
	// leaves HEAD unborn (git init, no commit).
	function makeRepo(opts = {}) {
		const dir = mkdtemp("hs-repo-");
		git(dir, "init", "-q", "-b", "main");
		if (!opts.empty) {
			fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
			git(dir, "add", "README.md");
			git(dir, "commit", "-q", "-m", "seed");
		}
		return dir;
	}

	return {
		stubDir,
		stateDir,
		logFile,
		writeStub,
		freshEnv,
		runScript,
		runLib,
		log,
		writeHerdrStub,
		makeRepo,
		git,
	};
}
