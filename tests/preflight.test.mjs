import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness, sampleManifest, mkdtemp } from "./harness.mjs";

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
			cwd: () => mkdtemp("hs-norepo-"),
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
			pre: (repo) =>
				fs.writeFileSync(manifestFile, sampleManifest({ repo_root: repo })),
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
		if (c.pre) c.pre(cwd);
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
	const wt = path.join(mkdtemp("hs-wt-"), "wt");
	git(repo, "worktree", "add", "-q", wt, "swarm/r0/s1");
	const r = runPf("preflight_check_detritus", freshEnv(), repo);
	assert.equal(r.status, 14, r.stderr);
	assert.match(r.stderr, /worktree .*hs-wt-.* \(swarm\/r0\/s1\)/);
});

test("detritus check prunes stale worktree registrations instead of flagging them", () => {
	const repo = makeRepo();
	const wt = path.join(mkdtemp("hs-wt-"), "wt");
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

test("all-archived live manifest remains active until idempotent finalization archives it", () => {
	const repo = makeRepo();
	const archived = JSON.parse(sampleManifest({ repo_root: repo }));
	for (const s of archived.slots) s.status = "archived";
	fs.writeFileSync(manifestFile, JSON.stringify(archived));
	const r = runPf("preflight_check_active_run", freshEnv(), repo);
	assert.equal(r.status, 17, r.stderr);
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
		runPf(
			"preflight_check_slot_cap 3",
			freshEnv({ HERDR_SWARM_MAX_SLOTS: "2" }),
			repo,
		).status,
		19,
	);
	assert.equal(
		runPf(
			"preflight_check_slot_cap 2",
			freshEnv({ HERDR_SWARM_MAX_SLOTS: "2" }),
			repo,
		).status,
		0,
	);
	assert.equal(
		runPf(
			"preflight_check_slot_cap 7",
			freshEnv({ HERDR_SWARM_MAX_SLOTS: "banana" }),
			repo,
		).status,
		19,
	);
	assert.equal(
		runPf(
			"preflight_check_slot_cap 6",
			freshEnv({ HERDR_SWARM_MAX_SLOTS: "banana" }),
			repo,
		).status,
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
	for (const pattern of [".swarm-task.md", ".swarm-done", ".swarm-clone.*"]) {
		const ours = ex.split("\n").filter((l) => l === pattern);
		assert.equal(ours.length, 1, `${pattern} in exclude file:\n${ex}`);
	}
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
	assert.equal(fs.readFileSync(exPath, "utf8"), "junk\n.swarm-task.md\n.swarm-done\n.swarm-clone.*\n");
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
		"node_modules/\n.swarm-task.md\n.swarm-done\n.swarm-clone.*\n.swarm-task.md.orig\n.swarm-done.bak\n*.log\n",
	);
	const r = runPf("remove_exclude_pattern", freshEnv(), repo);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		fs.readFileSync(exPath, "utf8"),
		"node_modules/\n.swarm-task.md.orig\n.swarm-done.bak\n*.log\n",
	);
	const doc = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
	assert.equal(doc.exclude_pattern_added, false);
	fs.rmSync(manifestFile, { force: true });
});

// --- provision_slot_paths: copy-on-write dependency clones ---

function provisionFixture(list) {
	const repo = makeRepo();
	fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\nbuild/\nlinked-parent\n");
	git(repo, "add", ".gitignore");
	git(repo, "commit", "-q", "-m", "ignore");
	fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
	fs.writeFileSync(path.join(repo, "node_modules", "pkg", "a.js"), "a\n");
	fs.symlinkSync("pkg", path.join(repo, "node_modules", "linked"));
	const wt = path.join(mkdtemp("hs-pwt-"), "wt");
	git(repo, "worktree", "add", "-q", "--detach", wt);
	const cfg = mkdtemp("hs-pcfg-");
	if (list !== null) fs.writeFileSync(path.join(cfg, "clone-paths"), list);
	const run = (extra = {}) => runPf(`provision_slot_paths "${repo}" "${wt}"`, freshEnv({ HERDR_PLUGIN_CONFIG_DIR: cfg, ...extra }), repo);
	const records = (r) => r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));
	return { repo, wt, cfg, run, records };
}

// macOS test disks are APFS, so the default clonefile path really runs.
// Linux CI is ext4 (no reflinks): there the default mode must SKIP, and the
// clone mechanics are exercised through copy mode instead.
const cloneEnv = process.platform === "darwin" ? {} : { HERDR_SWARM_CLONE_MODE: "copy" };

test("provision clones the default node_modules, symlinks intact", () => {
	const f = provisionFixture(null);
	const r = f.run(cloneEnv);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(f.records(r), [["cloned", "node_modules"]]);
	assert.equal(fs.readFileSync(path.join(f.wt, "node_modules", "pkg", "a.js"), "utf8"), "a\n");
	assert.equal(fs.readlinkSync(path.join(f.wt, "node_modules", "linked")), "pkg");
	assert.deepEqual(fs.readdirSync(f.wt).filter((n) => n.startsWith(".swarm-clone")), [], "no temp left behind");
	// Second run: already present, never overwritten.
	assert.deepEqual(f.records(f.run(cloneEnv)), [["clone_skipped", "node_modules", "already present in the worktree"]]);
});

test("without copy-on-write, the default mode skips instead of silently copying (Linux)", { skip: process.platform === "darwin" && "macOS cp -c falls back to a copy by design" }, () => {
	const f = provisionFixture(null);
	const recs = f.records(f.run());
	// A runner whose filesystem DOES reflink (btrfs/xfs) legitimately clones.
	if (recs[0]?.[0] === "cloned") return;
	assert.deepEqual(recs.map((r) => r.slice(0, 2)), [["clone_skipped", "node_modules"]]);
	assert.match(recs[0][2], /clone failed or timed out/);
	assert.deepEqual(fs.readdirSync(f.wt).filter((n) => n.startsWith(".swarm-clone") || n === "node_modules"), []);
});

test("provision refuses anything that is not an ignored, in-repo, absent path", () => {
	const f = provisionFixture("# comment\n\nREADME.md\nnotes.txt\n../escape\n/abs\n./node_modules\nmissing/\nbuild\nlinked-parent/node_modules\n");
	fs.writeFileSync(path.join(f.repo, "notes.txt"), "untracked, not ignored\n");
	fs.mkdirSync(path.join(f.repo, "build"));
	fs.writeFileSync(path.join(f.repo, "build", "x"), "x\n");
	fs.mkdirSync(path.join(f.wt, "build"));
	// A symlinked parent pointing outside the repo, mirrored in the worktree.
	const outside = mkdtemp("hs-outside-");
	fs.mkdirSync(path.join(outside, "node_modules"));
	fs.symlinkSync(outside, path.join(f.repo, "linked-parent"));
	fs.symlinkSync(mkdtemp("hs-outside2-"), path.join(f.wt, "linked-parent"));
	const recs = Object.fromEntries(f.records(f.run()).map(([k, p, why]) => [p, `${k}:${why ?? ""}`]));
	assert.match(recs["README.md"], /^clone_skipped:already present in the worktree/, "tracked content came with the checkout");
	assert.match(recs["notes.txt"], /^clone_skipped:not ignored by git/);
	assert.match(recs["../escape"], /^clone_skipped:must be a plain relative path/);
	assert.match(recs["/abs"], /^clone_skipped:must be a plain relative path/);
	assert.match(recs["./node_modules"], /^clone_skipped:must be a plain relative path/);
	assert.match(recs["missing/"], /^clone_skipped:not present in the repo/);
	assert.match(recs["build"], /^clone_skipped:already present in the worktree/);
	assert.match(recs["linked-parent/node_modules"], /^clone_skipped:a parent directory resolves outside/);
	assert.equal(Object.values(recs).some((v) => v.startsWith("cloned")), false);
});

test("a clone that times out is killed with its children: no writer survives, no temp left", async () => {
	const f = provisionFixture("node_modules\n");
	const marker = path.join(mkdtemp("hs-cpkid-"), "pid");
	// A cp that hands the work to a child which keeps writing into the temp
	// long after its parent shell would have been killed — recreating the
	// tree as a real cp mid-copy would. Its stdio is detached so spawnSync
	// returns at the timeout instead of waiting for the writer to finish.
	const bin = mkdtemp("hs-slowcp-");
	fs.writeFileSync(path.join(bin, "cp"),
		`#!/bin/bash\nmkdir -p "$3"\n( sleep 3; mkdir -p "$3/pkg"; echo late > "$3/pkg/late.js" ) </dev/null >/dev/null 2>&1 &\necho $! > "${marker}"\nwait\n`, { mode: 0o755 });
	const r = f.run({ HERDR_SWARM_CLONE_MODE: "copy", HERDR_SWARM_CLONE_TIMEOUT: "1", PATH: `${bin}:${process.env.PATH}` });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /clone_skipped\tnode_modules\tclone failed or timed out/);
	const pid = Number(fs.readFileSync(marker, "utf8"));
	assert.throws(() => process.kill(pid, 0), /ESRCH/, "the writer outlived the timeout");
	await new Promise((res) => setTimeout(res, 3500));
	assert.deepEqual(fs.readdirSync(f.wt).filter((n) => n.startsWith(".swarm-clone") || n === "node_modules"), [], "no temp, no half clone");
});

test("an empty clone-paths clones nothing; copy mode forces a full copy", () => {
	const none = provisionFixture("");
	assert.deepEqual(none.records(none.run()), []);
	const copy = provisionFixture("node_modules\n");
	const r = copy.run({ HERDR_SWARM_CLONE_MODE: "copy" });
	assert.deepEqual(copy.records(r), [["cloned", "node_modules"]]);
	assert.ok(fs.existsSync(path.join(copy.wt, "node_modules", "pkg", "a.js")));
});
