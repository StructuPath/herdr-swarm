import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness, sampleManifest } from "./harness.mjs";

const h = createHarness();
h.writeHerdrStub();
const { stateDir, freshEnv, runLib, log, makeRepo, git } = h;

const manifestFile = path.join(stateDir, "run-w9.json");

// Preflight functions live in a sourced file (the pane needs the distinct
// exit codes) — same runLib, with preflight.sh as the sourced entry point
// (it pulls lib.sh in itself).
function runPf(snippet, env = freshEnv(), cwd) {
	// preflight acts on SWARM_REPO (lib.sh repo_git), never the ambient cwd —
	// exporting it first is the caller contract the fan-out pane follows, so
	// tests drive the checks exactly the way production does.
	return runLib(
		`export SWARM_REPO="$(resolve_repo_root 2>/dev/null || true)" && ${snippet}`,
		env,
		{ sources: ["scripts/preflight.sh"], cwd },
	);
}

test("every preflight refusal has a distinct exit code and an actionable message", () => {
	const cases = [
		{
			name: "not a repo",
			fn: "preflight_check_repo",
			code: 10,
			msg: /not a git repository/,
			cwd: () => fs.mkdtempSync(path.join(os.tmpdir(), "hs-norepo-")),
		},
		{
			name: "detached HEAD",
			fn: "preflight_resolve_base",
			code: 11,
			msg: /detached HEAD/,
			cwd: () => {
				const r = makeRepo();
				git(r, "checkout", "-q", "--detach");
				return r;
			},
		},
		{
			name: "unborn HEAD",
			fn: "preflight_resolve_base",
			code: 12,
			msg: /unborn HEAD/,
			cwd: () => makeRepo({ empty: true }),
		},
		{
			name: "symref base",
			fn: "preflight_resolve_base",
			code: 13,
			msg: /symbolic ref/,
			cwd: () => {
				const r = makeRepo();
				git(r, "branch", "real");
				git(r, "symbolic-ref", "refs/heads/main", "refs/heads/real");
				return r;
			},
		},
		{
			name: "leftover swarm branch",
			fn: "preflight_check_detritus",
			code: 14,
			msg: /leftover swarm detritus[\s\S]*branch swarm\/r0\/s1/,
			cwd: () => {
				const r = makeRepo();
				git(r, "branch", "swarm/r0/s1");
				return r;
			},
		},
		{
			name: "missing agent binary",
			fn: `preflight_check_argv "echo ok" "hs-definitely-missing-xyz --model x"`,
			code: 15,
			msg: /slot 2: 'hs-definitely-missing-xyz' not found/,
			cwd: () => makeRepo(),
		},
		{
			name: "submodules present",
			fn: "preflight_check_submodules",
			code: 16,
			msg: /submodules/,
			cwd: () => {
				const r = makeRepo();
				fs.writeFileSync(path.join(r, ".gitmodules"), '[submodule "x"]\n');
				return r;
			},
		},
		{
			name: "active run",
			fn: "preflight_check_active_run",
			code: 17,
			msg: /harvest or abort/,
			cwd: () => makeRepo(),
			pre: () => fs.writeFileSync(manifestFile, sampleManifest()),
		},
		{
			// 0.7.3, not 0.7.5: since issue #1 the gate is a FLOOR, and 0.7.5
			// is a supported fan-out path (the pane path), not a refusal.
			name: "unsupported herdr version",
			fn: "preflight_check_version",
			code: 18,
			msg: /needs herdr 0\.7\.4 or newer/,
			cwd: () => makeRepo(),
			env: { STUB_HERDR_VERSION: "0.7.3" },
		},
		{
			name: "slot cap exceeded",
			fn: "preflight_check_slot_cap 7",
			code: 19,
			msg: /HERDR_SWARM_MAX_SLOTS/,
			cwd: () => makeRepo(),
		},
		{
			name: "sparse checkout note",
			fn: "preflight_check_sparse",
			code: 20,
			msg: /sparse checkout detected/,
			cwd: () => {
				const r = makeRepo();
				git(r, "config", "core.sparseCheckout", "true");
				return r;
			},
		},
	];
	// The pane branches on the code, so pairwise distinctness IS the contract.
	const codes = cases.map((c) => c.code);
	assert.equal(new Set(codes).size, codes.length, "codes must be distinct");
	for (const c of cases) {
		const cwd = c.cwd();
		fs.rmSync(manifestFile, { force: true });
		if (c.pre) c.pre();
		const r = runPf(c.fn, freshEnv(c.env ?? {}), cwd);
		assert.equal(
			r.status,
			c.code,
			`${c.name}: got ${r.status}, stderr: ${r.stderr}`,
		);
		assert.match(r.stderr, c.msg, c.name);
	}
	fs.rmSync(manifestFile, { force: true });
});

test("a clean repo passes every check; resolve_base prints the qualified ref", () => {
	fs.rmSync(manifestFile, { force: true });
	const repo = makeRepo();
	const r = runPf(
		[
			"preflight_check_repo",
			"preflight_resolve_base",
			"preflight_check_detritus",
			'preflight_check_argv "echo hi"',
			"preflight_check_submodules",
			"preflight_check_sparse",
			"preflight_check_active_run",
			"preflight_check_version",
			"preflight_check_slot_cap 6",
		].join(" && "),
		freshEnv(),
		repo,
	);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), "refs/heads/main");
});

test("slot-3 argv missing refuses before anything is created (zero worktree calls)", () => {
	const repo = makeRepo();
	const r = runPf(
		`preflight_check_argv "echo a" "echo b" "hs-missing-slot3-xyz --yolo"`,
		freshEnv(),
		repo,
	);
	assert.equal(r.status, 15, r.stderr);
	assert.match(r.stderr, /slot 3: 'hs-missing-slot3-xyz' not found/);
	// R3's whole point: the refusal happens with zero herdr mutations —
	// nothing to unwind. The stub log is the proof.
	assert.doesNotMatch(log(), /worktree create/);
});

test("argv check reports every broken slot in one refusal", () => {
	const repo = makeRepo();
	const r = runPf(
		`preflight_check_argv "hs-missing-a" "echo ok" "hs-missing-b"`,
		freshEnv(),
		repo,
	);
	assert.equal(r.status, 15);
	assert.match(r.stderr, /slot 1: 'hs-missing-a' not found/);
	assert.match(r.stderr, /slot 3: 'hs-missing-b' not found/);
});

test("detritus check lists leftover swarm worktrees by path", () => {
	const repo = makeRepo();
	git(repo, "branch", "swarm/r0/s1");
	const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hs-wt-")), "wt");
	git(repo, "worktree", "add", "-q", wt, "swarm/r0/s1");
	const r = runPf("preflight_check_detritus", freshEnv(), repo);
	assert.equal(r.status, 14, r.stderr);
	assert.match(r.stderr, /worktree .*hs-wt-.* \(swarm\/r0\/s1\)/);
});

test("detritus check prunes stale worktree registrations instead of flagging them", () => {
	const repo = makeRepo();
	const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hs-wt-")), "wt");
	// A worktree whose directory was deleted by hand leaves only a stale
	// registration; on a non-swarm branch that must be pruned and passed,
	// not surfaced as detritus. (A swarm-branch leftover would still refuse
	// via its surviving branch — that path is the table's detritus case.)
	git(repo, "worktree", "add", "-q", "-b", "scratch", wt);
	fs.rmSync(wt, { recursive: true, force: true });
	const r = runPf("preflight_check_detritus", freshEnv(), repo);
	assert.equal(r.status, 0, r.stderr);
	const list = git(repo, "worktree", "list", "--porcelain").stdout;
	assert.ok(!list.includes("hs-wt-"), "stale registration pruned");
});

test("active-run check passes when every slot is archived", () => {
	const repo = makeRepo();
	const archived = JSON.parse(sampleManifest());
	for (const s of archived.slots) s.status = "archived";
	fs.writeFileSync(manifestFile, JSON.stringify(archived));
	const r = runPf("preflight_check_active_run", freshEnv(), repo);
	assert.equal(r.status, 0, r.stderr);
	fs.rmSync(manifestFile, { force: true });
});

test("active-run check refuses a corrupt manifest with the corrupt code, not 'no run'", () => {
	const repo = makeRepo();
	fs.writeFileSync(manifestFile, '{"slots": [');
	const r = runPf("preflight_check_active_run", freshEnv(), repo);
	assert.equal(r.status, 3, `stderr: ${r.stderr}`);
	fs.rmSync(manifestFile, { force: true });
});

test("HERDR_SWARM_MAX_SLOTS overrides the cap; garbage falls back to 6", () => {
	const repo = makeRepo();
	assert.equal(
		runPf("preflight_check_slot_cap 3", freshEnv({ HERDR_SWARM_MAX_SLOTS: "2" }), repo).status,
		19,
	);
	assert.equal(
		runPf("preflight_check_slot_cap 2", freshEnv({ HERDR_SWARM_MAX_SLOTS: "2" }), repo).status,
		0,
	);
	assert.equal(
		runPf("preflight_check_slot_cap 7", freshEnv({ HERDR_SWARM_MAX_SLOTS: "banana" }), repo).status,
		19,
	);
	assert.equal(
		runPf("preflight_check_slot_cap 6", freshEnv({ HERDR_SWARM_MAX_SLOTS: "banana" }), repo).status,
		0,
	);
});

// --- exclude-pattern helpers ---

test("ensure_exclude_pattern appends exactly once across two calls and records it", () => {
	const repo = makeRepo();
	fs.writeFileSync(manifestFile, sampleManifest());
	const r = runPf(
		"ensure_exclude_pattern && ensure_exclude_pattern",
		freshEnv(),
		repo,
	);
	assert.equal(r.status, 0, r.stderr);
	const ex = fs.readFileSync(path.join(repo, ".git/info/exclude"), "utf8");
	const ours = ex.split("\n").filter((l) => l === ".swarm-task.md");
	assert.equal(ours.length, 1, `exclude file:\n${ex}`);
	const doc = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
	assert.equal(doc.exclude_pattern_added, true);
	fs.rmSync(manifestFile, { force: true });
});

test("ensure_exclude_pattern normalizes a final line missing its newline", () => {
	const repo = makeRepo();
	fs.writeFileSync(manifestFile, sampleManifest());
	const exPath = path.join(repo, ".git/info/exclude");
	// Hand-edited exclude without trailing \n: naive append would glue our
	// pattern onto "junk", corrupting both patterns.
	fs.writeFileSync(exPath, "junk");
	const r = runPf("ensure_exclude_pattern", freshEnv(), repo);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(fs.readFileSync(exPath, "utf8"), "junk\n.swarm-task.md\n");
	fs.rmSync(manifestFile, { force: true });
});

test("remove_exclude_pattern removes only our namespaced line", () => {
	const repo = makeRepo();
	fs.writeFileSync(
		manifestFile,
		sampleManifest({ exclude_pattern_added: true }),
	);
	const exPath = path.join(repo, ".git/info/exclude");
	// Neighbors on both sides, including one that merely *mentions* our name
	// — only the exact line may go.
	fs.writeFileSync(
		exPath,
		"node_modules/\n.swarm-task.md\n.swarm-task.md.orig\n*.log\n",
	);
	const r = runPf("remove_exclude_pattern", freshEnv(), repo);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		fs.readFileSync(exPath, "utf8"),
		"node_modules/\n.swarm-task.md.orig\n*.log\n",
	);
	const doc = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
	assert.equal(doc.exclude_pattern_added, false);
	fs.rmSync(manifestFile, { force: true });
});
