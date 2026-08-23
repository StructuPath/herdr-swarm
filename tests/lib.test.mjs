import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness, repoRoot, mkdtemp } from "./harness.mjs";

// Shared harness (tests/harness.mjs) — the herdr stub mirrors real 0.7.4 and
// 0.7.5 JSON so wrapper tests exercise the true wire shapes.
const h = createHarness();
h.writeHerdrStub();
const { stateDir, freshEnv, runLib, log, writeStub, writeHerdrStub } = h;

// --- sanitize_slug ---

test("sanitize_slug strips path-dangerous chars to [a-zA-Z0-9_-]", () => {
	for (const [input, want] of [
		["../../evil", "evil"],
		["a b/c", "abc"],
		["run-20260722_x1", "run-20260722_x1"],
		["$(rm -rf /)", "rm-rf"],
		["swarm/r1/s1", "swarmr1s1"],
	]) {
		// Hostile input rides in as a positional arg ($1), never interpolated
		// into the -c string — interpolation would execute the very payloads
		// this function exists to neutralize.
		const r = spawnSync(
			"bash",
			["-c", `. "${repoRoot}/scripts/lib.sh" && sanitize_slug "$1"`, "--", input],
			{ env: freshEnv(), encoding: "utf8" },
		);
		assert.equal(r.status, 0, `${input}: ${r.stderr}`);
		assert.equal(r.stdout.trim(), want, `sanitize_slug(${JSON.stringify(input)})`);
	}
});

test("sanitize_slug refuses input that strips to nothing (no silent default)", () => {
	const r = spawnSync(
		"bash",
		["-c", `. "${repoRoot}/scripts/lib.sh" && sanitize_slug "$1"`, "--", "!!!"],
		{ env: freshEnv(), encoding: "utf8" },
	);
	assert.notEqual(r.status, 0);
	assert.equal(r.stdout.trim(), "");
	assert.match(r.stderr, /empty after sanitizing/);
});

// --- state_dir ---

test("state_dir expands a literal leading ~ instead of creating ./~", () => {
	const rel = `.cache/hs-tilde-test-${process.pid}`;
	const r = runLib("state_dir", freshEnv({ HERDR_PLUGIN_STATE_DIR: `~/${rel}` }));
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), path.join(os.homedir(), rel));
	fs.rmSync(path.join(os.homedir(), rel), { recursive: true, force: true });
});

test("state_dir rejects relative paths and falls back to the default", () => {
	const r = runLib("state_dir", freshEnv({ HERDR_PLUGIN_STATE_DIR: "rel/path" }));
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		r.stdout.trim(),
		path.join(os.homedir(), ".local/state/herdr-swarm"),
	);
});

// --- parse_pane_id ---

test("parse_pane_id handles compact and pretty-printed JSON", () => {
	const compact = runLib(
		`parse_pane_id '{"id":"x","result":{"plugin_pane":{"pane":{"pane_id":"w9:p7"}}}}'`,
	);
	assert.equal(compact.stdout.trim(), "w9:p7");
	const pretty = runLib(
		`parse_pane_id '{\n  "result": {\n    "plugin_pane": {"pane": {"pane_id": "w9:p7"}}\n  }\n}'`,
	);
	assert.equal(pretty.stdout.trim(), "w9:p7");
});

// --- with_timeout ---

test("with_timeout kills a hung command and returns 137", () => {
	const r = runLib(`with_timeout 1 sleep 30; echo "rc=$?"`, freshEnv());
	assert.match(r.stdout, /rc=137/);
});

// --- mutation lock ---

test("acquire_lock/release_lock round-trip leaves no lock dir behind", () => {
	const r = runLib(`acquire_lock mut && release_lock mut && echo done`);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /done/);
	assert.equal(fs.existsSync(path.join(stateDir, "lock-mut")), false);
});

test("a stale lock with a dead holder is stolen, not waited on forever", () => {
	const lock = path.join(stateDir, "lock-mut");
	fs.mkdirSync(lock, { recursive: true });
	// 999999 is above macOS/Linux default pid_max ranges — reliably dead.
	fs.writeFileSync(path.join(lock, "pid"), "999999\n");
	const r = runLib(
		`acquire_lock mut && echo got && release_lock mut`,
		freshEnv({ HERDR_SWARM_LOCK_TRIES: "3" }),
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /got/);
	assert.equal(fs.existsSync(lock), false, "lock released after steal");
});

// --- version gate ---

test("version_gate accepts gated calls on 0.7.4", () => {
	const r = runLib(`version_gate gated`);
	assert.equal(r.status, 0, r.stderr);
});

// Fan-out runs on BOTH supported topologies now (issue #1), so the gate is a
// floor rather than a pin: 0.7.5 passes on the pane path, and only versions
// below 0.7.4 — where neither path exists — are refused.
test("version_gate accepts gated calls on 0.7.5 (the pane path)", () => {
	const r = runLib(
		`version_gate gated`,
		freshEnv({ STUB_HERDR_VERSION: "0.7.5" }),
	);
	assert.equal(r.status, 0, r.stderr);
	assert.doesNotMatch(r.stderr, /warning/);
});

test("version_gate refuses gated calls below the 0.7.4 floor with the version named", () => {
	const r = runLib(
		`version_gate gated`,
		freshEnv({ STUB_HERDR_VERSION: "0.7.3" }),
	);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /needs herdr 0\.7\.4 or newer/);
	assert.match(r.stderr, /0\.7\.3/);
});

test("version_gate warns but never refuses gated calls above max tested", () => {
	const r = runLib(
		`version_gate gated`,
		freshEnv({ STUB_HERDR_VERSION: "0.8.0" }),
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /newer than tested/);
});

// Field-wise numeric compare: a string compare puts 0.7.10 below 0.7.9 and
// would refuse a newer herdr as too old — the gate's worst failure mode.
test("version_ge compares versions numerically, not lexically", () => {
	const cases = [
		["0.7.10", "0.7.9", 0],
		["0.7.9", "0.7.10", 1],
		["0.7.5", "0.7.5", 0],
		["0.8.0", "0.7.4", 0],
		["0.7.3", "0.7.4", 1],
		["1.0", "0.9.9", 0],
		// Pre-release suffixes are dropped, not compared — and must not crash.
		["0.7.5-rc1", "0.7.5", 0],
	];
	for (const [a, b, want] of cases) {
		const r = runLib(`version_ge ${a} ${b}`);
		assert.equal(r.status, want, `version_ge ${a} ${b}: ${r.stderr}`);
	}
});

test("version_gate passes intersection calls through on 0.7.5, no warning", () => {
	const r = runLib(
		`version_gate intersection`,
		freshEnv({ STUB_HERDR_VERSION: "0.7.5" }),
	);
	assert.equal(r.status, 0, r.stderr);
	assert.doesNotMatch(r.stderr, /warning/);
});

test("version_gate warns but never refuses intersection calls above max tested", () => {
	const r = runLib(
		`version_gate intersection`,
		freshEnv({ STUB_HERDR_VERSION: "0.8.0" }),
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /newer than tested/);
});

test("version_gate fails closed on an unknown class", () => {
	const r = runLib(`version_gate tyop`);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /unknown version_gate class/);
});

// --- herdr wrappers: correct 0.7.4 shell-out shapes ---

test("herdr_worktree_create shells out with --json and returns the real result shape", () => {
	const r = runLib(
		`herdr_worktree_create --workspace w9 --branch swarm/r1/s1 --base abc123`,
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(
		log(),
		/herdr worktree create --workspace w9 --branch swarm\/r1\/s1 --base abc123 --json/,
	);
	const parsed = JSON.parse(r.stdout);
	assert.equal(parsed.result.type, "worktree_created");
	assert.equal(parsed.result.worktree.is_linked_worktree, true);
	assert.equal(parsed.result.worktree.branch, "swarm/r1/s1");
	// Paths must come from the response, never derived (upstream #261 will
	// move the worktrees dir) — assert the field consumers will read exists.
	assert.ok(parsed.result.worktree.path.startsWith("/"));
});

test("herdr_worktree_remove refuses --force before any herdr call (R11)", () => {
	const r = runLib(`herdr_worktree_remove --workspace w9 --force`);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /refuses --force/);
	assert.doesNotMatch(log(), /worktree remove/);
	const ok = runLib(`herdr_worktree_remove --workspace w9`);
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(log(), /herdr worktree remove --workspace w9 --json/);
});

test("herdr_agent_start passes through on 0.7.4 with the 0.7.4 argv shape", () => {
	const r = runLib(
		`herdr_agent_start slot1 --cwd /tmp/wt/s1 --workspace w9 --no-focus -- claude`,
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(
		log(),
		/herdr agent start slot1 --cwd \/tmp\/wt\/s1 --workspace w9 --no-focus -- claude/,
	);
});

// --split-from exists only for the 0.7.5 path; forwarding it would make
// 0.7.4's own arg parser reject the start.
test("herdr_agent_start drops --split-from on the 0.7.4 path", () => {
	const r = runLib(
		`herdr_agent_start slot1 --split-from w9:p1 --cwd /tmp/wt/s1 --no-focus -- claude`,
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(log(), /herdr agent start slot1 --cwd \/tmp\/wt\/s1 --no-focus -- claude/);
	assert.doesNotMatch(log(), /--split-from/);
});

// --- the 0.7.5 pane path (issue #1) ---

// The whole seam: same caller argv, same response shape, three herdr calls
// instead of one — and `agent start` never runs, because 0.7.5's --kind is a
// closed whitelist with no arbitrary-argv member (spike l).
test("herdr_agent_start on 0.7.5 splits, runs, and reports — never calls agent start", () => {
	const wt = mkdtemp("hs-wt075-");
	const r = runLib(
		`herdr_agent_start swarm-r1-s1 --workspace w9 --split-from w9:p1 --cwd ${wt} --no-focus -- claude --model opus`,
		freshEnv({ STUB_HERDR_VERSION: "0.7.5" }),
	);
	assert.equal(r.status, 0, r.stderr);
	const calls = log().split("\n").filter((l) => l.startsWith("herdr "));
	const order = calls.filter((l) => /pane (split|run|report-agent)/.test(l));
	assert.equal(order.length, 3, `expected 3 pane calls, got:\n${calls.join("\n")}`);
	// Order is load-bearing: the pane must exist before argv runs in it, and
	// the agent must not be advertised as working before its argv is running.
	assert.match(order[0], new RegExp(`pane split w9:p1 --direction down --cwd ${wt} --no-focus`));
	assert.match(order[1], /pane run w9:p7 claude --model opus/);
	assert.match(
		order[2],
		/pane report-agent w9:p7 --source structupath\.swarm --agent swarm-r1-s1 --state working/,
	);
	// R2: no whitelisted-kind start is attempted, with any kind at all.
	assert.doesNotMatch(log(), /agent start/);
	assert.doesNotMatch(log(), /--kind/);
	// Same output contract as 0.7.4 — the call site parses this identically.
	const j = JSON.parse(r.stdout);
	assert.equal(j.result.type, "agent_started");
	assert.equal(j.result.agent.name, "swarm-r1-s1");
	assert.equal(j.result.agent.pane_id, "w9:p7");
	assert.equal(j.result.agent.terminal_id, "term_split7");
	assert.equal(j.result.agent.workspace_id, "w9");
});

test("the 0.7.5 path refuses before splitting when the worktree cwd is missing", () => {
	const env = freshEnv({ STUB_HERDR_VERSION: "0.7.5" });
	// A split without the slot's worktree cwd inherits the herdr server's cwd
	// (spike k) — the agent would run in the wrong repo entirely.
	const noCwd = runLib(
		`herdr_agent_start swarm-r1-s1 --split-from w9:p1 -- claude`,
		env,
	);
	assert.notEqual(noCwd.status, 0);
	assert.match(noCwd.stderr, /needs an existing --cwd/);
	assert.doesNotMatch(log(), /pane split/);
	// And without an anchor pane, `pane split` would split the user's own
	// focused pane (it has no --workspace).
	const wt = mkdtemp("hs-wt075-");
	const noAnchor = runLib(`herdr_agent_start swarm-r1-s1 --cwd ${wt} -- claude`, env);
	assert.notEqual(noAnchor.status, 0);
	assert.match(noAnchor.stderr, /needs --split-from/);
	assert.doesNotMatch(log(), /pane split/);
});

test("the 0.7.5 path refuses an untranslatable flag instead of silently dropping it", () => {
	const wt = mkdtemp("hs-wt075-");
	const r = runLib(
		`herdr_agent_start swarm-r1-s1 --split-from w9:p1 --cwd ${wt} --timeout 5000 -- claude`,
		freshEnv({ STUB_HERDR_VERSION: "0.7.5" }),
	);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /cannot translate '--timeout'/);
	assert.doesNotMatch(log(), /pane split/);
});

test("the 0.7.5 path closes the pane it opened when pane run fails", () => {
	const wt = mkdtemp("hs-wt075-");
	// A pane the manifest never records is a pane no abort sweep can reap.
	writeStub(
		"herdr",
		`echo "herdr $@" >> "$STUB_LOG"
if [ "$1" = "--version" ]; then echo "herdr 0.7.5"; exit 0; fi
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  echo '{"id":"cli:pane:split","result":{"pane":{"pane_id":"w9:p7","terminal_id":"term_split7","workspace_id":"w9"},"type":"pane_info"}}'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "run" ]; then exit 1; fi
exit 0`,
	);
	const r = runLib(
		`herdr_agent_start swarm-r1-s1 --split-from w9:p1 --cwd ${wt} -- claude`,
		freshEnv(),
	);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /pane run failed/);
	assert.match(log(), /pane close w9:p7/);
	writeHerdrStub(); // restore the shared stub for later tests
});

// Agent state is advisory (harvest never gates on it), so a status-only call
// failing must never destroy a slot that is already running its work.
test("the 0.7.5 path warns but still succeeds when report-agent fails", () => {
	const wt = mkdtemp("hs-wt075-");
	writeStub(
		"herdr",
		`echo "herdr $@" >> "$STUB_LOG"
if [ "$1" = "--version" ]; then echo "herdr 0.7.5"; exit 0; fi
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  echo '{"id":"cli:pane:split","result":{"pane":{"pane_id":"w9:p7","terminal_id":"term_split7","workspace_id":"w9"},"type":"pane_info"}}'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "report-agent" ]; then exit 1; fi
exit 0`,
	);
	const r = runLib(
		`herdr_agent_start swarm-r1-s1 --split-from w9:p1 --cwd ${wt} -- claude`,
		freshEnv(),
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /could not report agent state/);
	assert.equal(JSON.parse(r.stdout).result.agent.pane_id, "w9:p7");
	writeHerdrStub();
});

// report_slot_agent_state is the harvest-preview hook. On 0.7.4 herdr detects
// the agent natively, so a plugin report there would fight its own detection.
test("report_slot_agent_state reports on 0.7.5+ and no-ops on 0.7.4", () => {
	const on = runLib(
		`report_slot_agent_state w9:p7 swarm-r1-s1 idle`,
		freshEnv({ STUB_HERDR_VERSION: "0.7.5" }),
	);
	assert.equal(on.status, 0, on.stderr);
	assert.match(
		log(),
		/pane report-agent w9:p7 --source structupath\.swarm --agent swarm-r1-s1 --state idle/,
	);
	const off = runLib(`report_slot_agent_state w9:p7 swarm-r1-s1 idle`, freshEnv());
	assert.equal(off.status, 0, off.stderr);
	assert.doesNotMatch(log(), /report-agent/);
	// A slot with no recorded pane (a pending row) is skipped, never reported
	// against an empty pane id.
	const none = runLib(
		`report_slot_agent_state "" swarm-r1-s1 idle`,
		freshEnv({ STUB_HERDR_VERSION: "0.7.5" }),
	);
	assert.equal(none.status, 0, none.stderr);
	assert.doesNotMatch(log(), /report-agent/);
});

test("herdr_agent_wait requires --timeout so no call site can wait forever", () => {
	const bad = runLib(`herdr_agent_wait term_abc123 --status idle`);
	assert.notEqual(bad.status, 0);
	assert.match(bad.stderr, /requires --timeout/);
	assert.doesNotMatch(log(), /agent wait/);
	const ok = runLib(
		`herdr_agent_wait term_abc123 --status idle --timeout 5000`,
	);
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(log(), /herdr agent wait term_abc123 --status idle --timeout 5000/);
});

test("herdr_pane_open pins --plugin to this plugin's id", () => {
	const r = runLib(
		`herdr_pane_open --entrypoint status-pane --placement split --direction right --focus`,
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(
		log(),
		/herdr plugin pane open --plugin structupath\.swarm --entrypoint status-pane/,
	);
});

test("herdr_pane_list and herdr_agent_list return real-shaped JSON", () => {
	const panes = runLib(`herdr_pane_list --workspace w9`);
	assert.equal(panes.status, 0, panes.stderr);
	assert.equal(JSON.parse(panes.stdout).result.type, "pane_list");
	const agents = runLib(`herdr_agent_list`);
	assert.equal(agents.status, 0, agents.stderr);
	assert.equal(JSON.parse(agents.stdout).result.type, "agent_list");
});

// --- the wrapper invariant ---

test("no raw herdr invocations outside lib.sh wrappers (scripts/ and bin/)", () => {
	const files = [];
	for (const f of fs.readdirSync(path.join(repoRoot, "scripts"))) {
		if (f.endsWith(".sh") && f !== "lib.sh")
			files.push(path.join(repoRoot, "scripts", f));
	}
	const binDir = path.join(repoRoot, "bin");
	if (fs.existsSync(binDir)) {
		for (const f of fs.readdirSync(binDir)) files.push(path.join(binDir, f));
	}
	assert.ok(files.length > 0, "scaffold scripts must exist to be scanned");
	const offenders = [];
	for (const file of files) {
		fs.readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, i) => {
				// Comment strip is crude but sufficient for our own sources; the
				// point is that `herdr ...` in a comment is not an invocation.
				const code = line.replace(/#.*$/, "");
				// $HERDR (however quoted) or a bare `herdr ` word — but not
				// `herdr-swarm`, `herdr_*` wrapper names, or paths like .herdr/.
				if (/\$HERDR\b/.test(code) || /(^|[^-\w."'/])herdr(\s|$)/.test(code)) {
					offenders.push(`${file}:${i + 1}: ${line.trim()}`);
				}
			});
	}
	assert.deepEqual(offenders, [], "raw herdr invocations outside lib.sh");
});

// The sibling of the herdr-wrapper invariant, and the countermeasure for the
// bug that motivated it: fanout-pane.sh and preflight.sh ran every git call
// against the AMBIENT cwd, so a fan-out driven for one workspace recorded (and
// would have mutated) whatever repo the process happened to sit in. Three
// scripts already did it right, two did not, and the suite stayed green
// because every fixture ran with cwd already inside the target repo. A bare
// `git <verb>` in a command position is the offense; `git -C <dir>` and
// repo_git both name their target explicitly, and lib.sh is where the seam
// itself is defined.
test("no ambient-cwd git invocations outside lib.sh (every repo git names its target)", () => {
	// A real invocation sits in command position: line start, after an
	// operator/subshell opener (`;` `&&` `||` `|` `(` `$(` `` ` `` `{` `!`), or
	// after a shell keyword. That is what separates `git worktree remove` and
	// `x="$(git rev-parse …)"` from a `git` sitting inside prose.
	const CMD_PUNCT = /[;&|(){}!`]$/;
	const CMD_KEYWORD = /\b(?:if|then|else|elif|while|until|do)$/;
	const files = fs
		.readdirSync(path.join(repoRoot, "scripts"))
		.filter((f) => f.endsWith(".sh") && f !== "lib.sh")
		.map((f) => path.join(repoRoot, "scripts", f));
	assert.ok(files.length > 0, "scripts must exist to be scanned");
	const offenders = [];
	for (const file of files) {
		fs.readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, i) => {
				// Quoted bodies go first: `echo "…git merge --abort…"` is prose,
				// not a call, and the inline-node blocks are single-quoted whole.
				// A quoted span holding a command substitution is NOT stripped —
				// `repo_root="$(git rev-parse --show-toplevel)"` is the literal
				// line this whole test exists to catch, and blanking it would
				// make the test pass over the original bug.
				const dequote = (s, q) =>
					s.replace(new RegExp(`${q}[^${q}]*${q}`, "g"), (m) =>
						/\$\(|`/.test(m) ? m : `${q}${q}`,
					);
				const code = dequote(dequote(line, "'"), '"').replace(/#.*$/, "");
				for (const m of code.matchAll(/\bgit\s+(\S*)/g)) {
					const before = code.slice(0, m.index).trimEnd();
					const inCmdPosition =
						before === "" || CMD_PUNCT.test(before) || CMD_KEYWORD.test(before);
					if (!inCmdPosition) continue;
					if (m[1] === "-C") continue; // explicit target — the correct form
					offenders.push(
						`${file}:${i + 1}: ${line.trim()}\n    → use repo_git (or git -C <dir>); a bare git runs against the ambient cwd`,
					);
				}
			});
	}
	assert.deepEqual(offenders, [], "ambient-cwd git invocations outside lib.sh");
});

// The third member of the parity family (after the herdr-wrapper and
// ambient-git tests above), and the countermeasure for residual finding 2 —
// see docs/solutions/best-practices/cross-script-invariant-drift.md. run_id
// got its charset guard in one script and then in the other only after a
// review caught the asymmetry; slot branch and slot path reached
// `worktree remove` / `reset --hard` / `clean -fd` from the manifest with only
// a `[ -d ]` in BOTH. The rule now lives in lib.sh's verify_slot_ownership,
// and this test is what stops the next script from mutating a manifest-named
// worktree without calling it.
//
// Scope note: the offense is mutating a WORKTREE named by a manifest slot row.
// prune.sh runs `branch -d` and `update-ref -d`, but its targets come from
// `for-each-ref refs/heads/swarm` in the repo itself and are gated on git
// ancestry — nothing there is manifest-path-derived. fanout-pane.sh's detritus
// reaper is the same shape: `_swarm_worktrees` reads git's own worktree list,
// so its path/branch pairing comes from git, not from a file on disk.
test("every script that mutates a manifest-named slot worktree calls verify_slot_ownership", () => {
	// Mutations that can destroy work in a worktree. `worktree list` and
	// `merge-base` are deliberately absent: read-only calls are not the hazard.
	const WORKTREE_MUTATORS = [
		/\bworktree\s+(?:remove|move)\b/,
		/\bherdr_worktree_remove\b/,
		/\breset\s+--hard\b/,
		/\bclean\s+-[a-z]*f/,
	];
	// Reading a slot row's path/branch out of the manifest — the bash side
	// (SLOT_PATH) and the inline-node side (`s.path ?? ""`) both count.
	const SLOT_ROW_READERS = [/\bSLOT_PATH\b/, /\b[a-z]\.path\s*\?\?/];
	const offenders = [];
	for (const f of fs.readdirSync(path.join(repoRoot, "scripts"))) {
		if (!f.endsWith(".sh") || f === "lib.sh") continue;
		const file = path.join(repoRoot, "scripts", f);
		// Comments describe these mutations at length in this repo; only code
		// lines can actually run one.
		const code = fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => !/^\s*#/.test(l))
			.join("\n");
		const mutates = WORKTREE_MUTATORS.some((re) => re.test(code));
		const readsSlotRows = SLOT_ROW_READERS.some((re) => re.test(code));
		if (!mutates || !readsSlotRows) continue;
		if (!/\bverify_slot_ownership\b/.test(code)) {
			offenders.push(
				`${file}: mutates a worktree named by a manifest slot row without calling verify_slot_ownership (lib.sh)`,
			);
		}
	}
	assert.deepEqual(offenders, [], "slot-ownership guard missing");
	// The test is only worth anything if it is actually pointed at the two
	// scripts finding 2 named — an over-tight regex that matches nothing would
	// otherwise pass forever.
	for (const f of ["harvest-step.sh", "abort.sh"]) {
		const src = fs.readFileSync(path.join(repoRoot, "scripts", f), "utf8");
		assert.match(src, /\bverify_slot_ownership\b/, `${f} must be in scope`);
	}
});

test("every harvest-worktree removal route uses the shared exact verifier/remover", () => {
	const harvest = fs.readFileSync(
		path.join(repoRoot, "scripts/harvest-step.sh"),
		"utf8",
	);
	const abort = fs.readFileSync(path.join(repoRoot, "scripts/abort.sh"), "utf8");
	const lib = fs.readFileSync(path.join(repoRoot, "scripts/lib.sh"), "utf8");
	assert.doesNotMatch(harvest, /worktree remove "\$(?:hwt|wt|jwt|d)"/);
	assert.doesNotMatch(abort, /worktree remove "\$(?:hwt|jwt|d)"/);
	assert.ok(
		(harvest.match(/remove_harvest_resource/g) || []).length >= 3,
		"swap, resume, and abort-merge share the remover",
	);
	assert.match(abort, /remove_harvest_resource/);
	assert.match(abort, /verify_harvest_resource[^\n]+"null"/);
	assert.equal(
		(lib.match(/git -C "\$SWARM_REPO" worktree remove "\$wt"/g) || []).length,
		1,
		"one audited harvest git-removal call exists",
	);
	assert.match(lib, /verify-harvest-removed/);
});

// The pane titles in herdr-plugin.toml ARE the cleanup sweep labels (pane
// list reports them as "label"), and preflight.sh re-declares them as a
// hardcoded set for abort's corrupt-manifest sweep. A rename on one side
// alone silently narrows the safety net to nothing, with no runtime error —
// this test is the lockstep.
test("preflight's pane-title sweep set matches the manifest's [[panes]] titles exactly", () => {
	const toml = fs.readFileSync(path.join(repoRoot, "herdr-plugin.toml"), "utf8");
	// [[panes]] blocks only: [[actions]] also has `title =` keys, and only the
	// pane titles are sweep labels.
	const paneTitles = toml
		.split(/^\[\[/m)
		.filter((block) => block.startsWith("panes]]"))
		.map((block) => block.match(/^\s*title\s*=\s*"([^"]+)"/m))
		.filter(Boolean)
		.map((m) => m[1]);
	assert.equal(paneTitles.length, 3, "manifest declares all three panes");

	const pf = fs.readFileSync(path.join(repoRoot, "scripts", "preflight.sh"), "utf8");
	const set = pf.match(/const titles = new Set\(\[([^\]]*)\]\)/);
	assert.ok(set, "preflight.sh still declares a hardcoded pane-title set");
	const swept = [...set[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

	assert.deepEqual(
		[...swept].sort(),
		[...paneTitles].sort(),
		"preflight.sh sweep titles drifted from herdr-plugin.toml [[panes]] titles",
	);
});

test("every script the manifest references exists on disk", () => {
	const toml = fs.readFileSync(path.join(repoRoot, "herdr-plugin.toml"), "utf8");
	const refs = [...toml.matchAll(/"scripts\/([^"]+)"/g)].map((m) => m[1]);
	assert.ok(refs.length >= 8, "manifest lists all actions and panes");
	for (const ref of refs) {
		assert.ok(
			fs.existsSync(path.join(repoRoot, "scripts", ref)),
			`manifest references missing script: ${ref}`,
		);
	}
});
