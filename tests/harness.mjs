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
	const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-stub-"));
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-state-"));
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
if [ "$1" = "pane" ] && [ "$2" = "read" ]; then exit "\${STUB_PANE_ALIVE:-1}"; fi
exit 0`,
		);
	}

	// Throwaway real git repo — cheaper and more faithful than stubbing git
	// for repo-state checks; pass it as opts.cwd to runLib. {empty: true}
	// leaves HEAD unborn (git init, no commit).
	function makeRepo(opts = {}) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-repo-"));
		git(dir, "init", "-q", "-b", "main");
		if (!opts.empty) {
			fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
			git(dir, "add", "README.md");
			git(dir, "commit", "-q", "-m", "seed");
		}
		return dir;
	}

	function git(cwd, ...args) {
		const r = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				PATH: "/usr/bin:/bin",
				HOME: os.homedir(),
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_AUTHOR_NAME: "hs-test",
				GIT_AUTHOR_EMAIL: "hs@test.invalid",
				GIT_COMMITTER_NAME: "hs-test",
				GIT_COMMITTER_EMAIL: "hs@test.invalid",
			},
		});
		if (r.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
		}
		return r;
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
