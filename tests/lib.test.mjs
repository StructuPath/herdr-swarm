import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness, repoRoot } from "./harness.mjs";

// Shared harness (tests/harness.mjs) — the herdr stub mirrors real 0.7.4
// JSON so wrapper tests exercise the true wire shapes.
const h = createHarness();
h.writeHerdrStub();
const { stateDir, freshEnv, runLib, log } = h;

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

test("version_gate refuses gated calls on 0.7.5 with the version named", () => {
	const r = runLib(
		`version_gate gated`,
		freshEnv({ STUB_HERDR_VERSION: "0.7.5" }),
	);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /needs herdr 0\.7\.4/);
	assert.match(r.stderr, /0\.7\.5/);
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

test("herdr_agent_start refuses on 0.7.5 without invoking agent start", () => {
	const r = runLib(
		`herdr_agent_start slot1 --cwd /tmp/wt/s1 --workspace w9 -- claude`,
		freshEnv({ STUB_HERDR_VERSION: "0.7.5" }),
	);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /needs herdr 0\.7\.4/);
	assert.doesNotMatch(log(), /agent start/);
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
