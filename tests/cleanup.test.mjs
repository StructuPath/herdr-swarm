// U7 cleanup tests: abort.sh and prune.sh. Real throwaway git repos again
// (harvest.test.mjs convention) — worktree registration, ancestry, and
// branch -d refusals are exactly what a stub git would fake away; herdr stays
// a stub because abort must work even when the real server state is gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitIn, createHarness, gitIdent, makeFannedOutRun, repoRoot, mkdtemp } from "./harness.mjs";

const h = createHarness();
h.writeHerdrStub();

// Shared fanned-out-run fixture (tests/harness.mjs); the prefix keeps this
// file's run ids distinct from other suites'.
const mkRun = (opts = {}) => makeFannedOutRun(h, { prefix: "r-cl", ...opts });

function editManifest(r, fn) {
	const p = path.join(r.sdir, "run-w9.json");
	const doc = JSON.parse(fs.readFileSync(p, "utf8"));
	fn(doc);
	fs.writeFileSync(p, JSON.stringify(doc, null, 2));
}

// Actions run with cwd = the repo workspace (that is what herdr gives them);
// the corrupt-manifest path leans on it for report-only discovery.
const run = (r, script, extraEnv = {}, cwd = r.repo) =>
	spawnSync("bash", [path.join(repoRoot, "scripts", script)], {
		env: { ...r.env, ...extraEnv },
		cwd,
		encoding: "utf8",
	});

const branchExists = (repo, b) =>
	spawnSync(
		"git",
		["-C", repo, "rev-parse", "--verify", "-q", `refs/heads/${b}`],
		{
			encoding: "utf8",
		},
	).status === 0;

const count = (haystack, needle) => haystack.split(needle).length - 1;

// ---------------------------------------------------------------------------
// abort.sh
// ---------------------------------------------------------------------------

test("abort closes tracked panes exactly once and the label sweep spares the decoy user pane", () => {
	const r = mkRun();
	// status.sh-style pidfile record; the same pane also shows up in the label
	// sweep (stub pane list carries it), so the seen-set must dedupe.
	fs.writeFileSync(path.join(r.sdir, "status-pane-w9"), "w9:p9\n");
	const a = run(r, "abort.sh");
	assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
	const log = h.log();
	assert.equal(
		count(log, "pane close w9:p9"),
		1,
		"tracked+swept pane closed once",
	);
	// w9:p4 is a plain user terminal pane in the stub pane list (no plugin
	// label) — the sweep matches manifest pane titles only, so it survives.
	assert.equal(
		log.includes("pane close w9:p4"),
		false,
		"decoy user pane untouched",
	);
	assert.equal(fs.existsSync(path.join(r.sdir, "status-pane-w9")), false);
	assert.match(a.stdout, /abort summary/);
});

test("dirty slot worktree is KEPT and reported — never prompted, never forced", () => {
	const r = mkRun();
	fs.writeFileSync(path.join(r.wt(1), "junk.txt"), "uncommitted\n");
	const a = run(r, "abort.sh");
	// Distinct nonzero code: work was kept, so this is NOT a clean teardown.
	assert.equal(a.status, 4, `${a.stdout}\n${a.stderr}`);
	assert.equal(fs.existsSync(r.wt(1)), true, "dirty worktree survives");
	assert.match(a.stderr, /KEPT/);
	assert.match(a.stderr, /uncommitted work/);
	assert.match(a.stdout, /kept 1/);
	assert.ok(branchExists(r.repo, r.branch(1)), "branch untouched (R10)");
});

// Residual finding 2, abort's half: the same shared verify_slot_ownership
// harvest's read_slot uses, with abort's own posture. Abort never destroys
// what it cannot verify — but it also never lets one unverifiable row abandon
// the rest of the teardown, so the mismatch KEEPS and reports rather than
// exiting.
test("abort refuses every deletion when a slot branch makes bookkeeping semantically unknown", () => {
	const r = mkRun({ slots: 2 });
	// A cross-repo or hand-edited manifest row: this branch is not ours, so
	// neither is anything it names.
	editManifest(r, (d) => {
		d.slots.find((s) => s.slot === 1).branch = "swarm/some-other-run/s1";
	});
	const a = run(r, "abort.sh");
	assert.equal(a.status, 3, `${a.stdout}\n${a.stderr}`);
	assert.equal(fs.existsSync(r.wt(1)), true, "unverifiable worktree survives");
	assert.equal(fs.existsSync(r.wt(2)), true, "all deletion is refused");
	assert.match(a.stderr, /bookkeeping_unknown/);
	assert.match(a.stderr, /outside the run namespace/);
	assert.doesNotMatch(h.log(), /worktree remove|pane close/);
	assert.equal(r.slotRow(1).status, "running", "manifest is untouched");
});

test("abort KEEPS a slot whose recorded path is another branch's worktree", () => {
	// Two REAL worktrees: the failure must be the branch/path PAIRING, not
	// mere existence — a plain directory would pass for the wrong reason.
	const r = mkRun({ slots: 2 });
	editManifest(r, (d) => {
		// Slot 2 archived so abort skips it and its worktree stays on disk as
		// the thing slot 1 wrongly claims.
		d.slots.find((s) => s.slot === 2).status = "archived";
		d.slots.find((s) => s.slot === 1).path = r.wt(2);
	});
	const a = run(r, "abort.sh");
	assert.equal(a.status, 4, `${a.stdout}\n${a.stderr}`);
	assert.match(a.stderr, /slot 1 KEPT — ownership check failed/);
	assert.match(a.stderr, /is not a worktree of .* checked out on/);
	assert.equal(
		fs.existsSync(r.wt(2)),
		true,
		"the other slot's worktree untouched",
	);
});

// The recovery route abort prints is Harvest, and Harvest reads the LIVE
// manifest — archiving it would strand exactly the work abort just chose to
// protect.
test("abort that KEPT a dirty slot leaves the run ACTIVE: manifest stays live and the kept path is named", () => {
	const r = mkRun();
	fs.writeFileSync(path.join(r.wt(1), "junk.txt"), "uncommitted\n");
	const a = run(r, "abort.sh");
	assert.equal(a.status, 4, `${a.stdout}\n${a.stderr}`);
	assert.equal(
		fs.existsSync(path.join(r.sdir, "run-w9.json")),
		true,
		"live manifest NOT archived — Harvest can still reach the kept worktree",
	);
	assert.equal(
		fs.existsSync(path.join(r.sdir, `archived-${r.runId}.json`)),
		false,
		"nothing was archived",
	);
	assert.match(a.stdout, /stays ACTIVE/);
	assert.ok(a.stdout.includes(r.wt(1)), "the kept worktree is listed by path");
	assert.equal(
		r.slotRow(1).status,
		"running",
		"kept slot is not marked archived",
	);
});

// The exclude file is shared repo-wide: dropping the pattern while a kept
// worktree still holds .swarm-task.md would expose it to git status there.
test("abort that KEPT a slot also keeps the .swarm-task.md exclude pattern", () => {
	const r = mkRun();
	fs.writeFileSync(path.join(r.wt(1), "junk.txt"), "uncommitted\n");
	const a = run(r, "abort.sh");
	assert.equal(a.status, 4, `${a.stdout}\n${a.stderr}`);
	const lines = fs
		.readFileSync(path.join(r.repo, ".git/info/exclude"), "utf8")
		.split("\n");
	assert.ok(
		lines.includes(".swarm-task.md"),
		"pattern survives a kept-work abort",
	);
	assert.equal(
		spawnSync("git", ["-C", r.wt(1), "status", "--porcelain"], {
			encoding: "utf8",
		}).stdout.includes(".swarm-task.md"),
		false,
		"task file still invisible to git status in the kept worktree",
	);
});

// The harvest pane holds no mutation lock while the user resolves conflicts
// (minutes), so a `merge --abort` here would hard-reset live work.
test("harvest worktree with unmerged paths is a LIVE conflict: kept untouched, never merge --aborted", () => {
	const r = mkRun();
	// Build a real conflict: base and slot branch both touch the same file.
	commitIn(r.repo, "conflict.txt", "base side\n");
	commitIn(r.wt(1), "conflict.txt", "slot side\n");
	const hwt = path.join(r.sdir, `harvest-${r.runId}-s1`);
	h.git(r.repo, "worktree", "add", "-q", "--detach", hwt, "main");
	const m = spawnSync(
		"git",
		["-C", hwt, "merge", "--no-ff", "-m", "swarm merge", r.branch(1)],
		{
			encoding: "utf8",
			env: { PATH: "/usr/bin:/bin", HOME: os.homedir(), ...gitIdent },
		},
	);
	assert.notEqual(m.status, 0, "fixture must actually conflict");
	assert.notEqual(
		spawnSync("git", ["-C", hwt, "ls-files", "-u"], {
			encoding: "utf8",
		}).stdout.trim(),
		"",
		"fixture must leave unmerged index entries",
	);
	editManifest(r, (doc) => {
		doc.slots[0].journal = {
			locus: "detached",
			expected_base_sha: r.fork,
			merge_commit_sha: null,
			worktree: hwt,
		};
	});
	const a = run(r, "abort.sh");
	assert.equal(a.status, 4, `${a.stdout}\n${a.stderr}`);
	assert.equal(
		fs.existsSync(hwt),
		true,
		"conflicted harvest worktree survives",
	);
	assert.notEqual(
		spawnSync("git", ["-C", hwt, "ls-files", "-u"], {
			encoding: "utf8",
		}).stdout.trim(),
		"",
		"the in-flight conflict resolution was NOT reset",
	);
	assert.match(a.stderr, /LIVE conflict/);
});

test("crash abort (manifest present, herdr agents gone) completes, reaps both slots, spares foreign refs", () => {
	const r = mkRun({ slots: 2 });
	commitIn(r.wt(1), "a.txt");
	commitIn(r.wt(2), "b.txt");
	// Foreign branch + worktree: ownership rule says abort may never touch them.
	const fwt = path.join(
		mkdtemp("hs-fwt-"),
		"fx",
	);
	h.git(r.repo, "worktree", "add", "-q", "-b", "feature-x", fwt, r.fork);
	const a = run(r, "abort.sh");
	assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
	assert.equal(fs.existsSync(r.wt(1)), false);
	assert.equal(fs.existsSync(r.wt(2)), false);
	// The herdr one-shot verb was attempted per slot (the stop mechanism,
	// spike (a)); the stub can't remove disk state, so the git fallback did.
	assert.match(h.log(), /worktree remove --workspace w11/);
	assert.match(h.log(), /worktree remove --workspace w12/);
	assert.equal(fs.existsSync(fwt), true, "foreign worktree untouched");
	assert.ok(branchExists(r.repo, "feature-x"), "foreign branch untouched");
	assert.match(a.stdout, /worktrees removed 2/);
	// Branches stay behind, list-only (R10).
	assert.match(a.stdout, /swarm branches remaining/);
	assert.ok(branchExists(r.repo, r.branch(1)));
	assert.ok(branchExists(r.repo, r.branch(2)));
});

test("pending-null-path row: worktree found by run-unique branch name and reaped", () => {
	const r = mkRun();
	const wt = r.wt(1);
	// Simulate the crash window between `worktree create` returning and the
	// path being recorded: the row is pending with every herdr field null.
	editManifest(r, (doc) => {
		Object.assign(doc.slots[0], {
			path: null,
			workspace_id: null,
			pane_id: null,
			terminal_id: null,
			status: "pending",
		});
	});
	const a = run(r, "abort.sh");
	assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
	assert.equal(
		fs.existsSync(wt),
		false,
		"worktree reconciled by branch and removed",
	);
	assert.equal(
		h.log().includes("worktree remove"),
		false,
		"no workspace id -> plain git path",
	);
	assert.match(a.stdout, /worktrees removed 1/);
});

test("harvest worktree holding an un-swapped merge commit is reported loudly, never deleted", () => {
	const r = mkRun();
	commitIn(r.wt(1), "feat.txt");
	const hwt = path.join(r.sdir, `harvest-${r.runId}-s1`);
	h.git(r.repo, "worktree", "add", "-q", "--detach", hwt, r.fork);
	h.git(hwt, "merge", "--no-ff", "-m", "swarm merge", r.branch(1));
	const msha = h.git(hwt, "rev-parse", "HEAD").stdout.trim();
	editManifest(r, (doc) => {
		doc.slots[0].journal = {
			locus: "detached",
			expected_base_sha: r.fork,
			merge_commit_sha: msha,
			worktree: hwt,
		};
	});
	const a = run(r, "abort.sh");
	assert.equal(a.status, 4, `${a.stdout}\n${a.stderr}`); // kept work => ACTIVE
	assert.equal(
		fs.existsSync(hwt),
		true,
		"worktree with the dangling commit survives",
	);
	assert.match(a.stderr, /UN-SWAPPED/);
	assert.ok(a.stderr.includes(msha), "dangling SHA named in the report");
	assert.equal(
		fs.existsSync(r.wt(1)),
		false,
		"the clean slot worktree still gets reaped",
	);
	assert.match(a.stdout, /kept 1/);
});

test("corrupt manifest: report-only discovery, nothing destroyed, distinct exit code", () => {
	const r = mkRun();
	fs.writeFileSync(path.join(r.sdir, "run-w9.json"), "{ definitely not json");
	const a = run(r, "abort.sh");
	assert.equal(a.status, 3, `${a.stdout}\n${a.stderr}`);
	assert.match(
		a.stderr,
		/\.bak/,
		"recovery hint names the previous generation",
	);
	assert.match(a.stdout, /WOULD act on/);
	assert.ok(a.stdout.includes(r.branch(1)), "discovery lists the swarm branch");
	assert.ok(a.stdout.includes(r.wt(1)), "discovery lists the swarm worktree");
	assert.equal(fs.existsSync(r.wt(1)), true, "worktree untouched");
	assert.equal(
		fs.existsSync(path.join(r.sdir, "run-w9.json")),
		true,
		"corrupt manifest kept in place (not archived, not deleted)",
	);
	assert.equal(h.log().includes("pane close"), false, "no pane was closed");
	assert.match(
		a.stdout,
		/abort summary/,
		"summary printed on the refusal path too",
	);
});

test("manually deleted worktree path: 'already gone' via the worktree-prune fallback", () => {
	const r = mkRun();
	const wt = r.wt(1);
	fs.rmSync(wt, { recursive: true, force: true });
	const a = run(r, "abort.sh");
	assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
	assert.match(a.stdout, /already gone 1/);
	assert.equal(
		h.git(r.repo, "worktree", "list", "--porcelain").stdout.includes(wt),
		false,
		"stale registration pruned",
	);
});

test("MERGE_HEAD in the user's tree: exact merge --abort command printed, merge NOT aborted", () => {
	const r = mkRun();
	fs.writeFileSync(path.join(r.repo, ".git/MERGE_HEAD"), `${r.fork}\n`);
	const a = run(r, "abort.sh");
	assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
	assert.ok(
		a.stdout.includes(`git -C ${r.repo} merge --abort`),
		"the exact command is offered",
	);
	assert.equal(
		fs.existsSync(path.join(r.repo, ".git/MERGE_HEAD")),
		true,
		"abort never runs the merge --abort itself (no prompts, no surprises)",
	);
});

test("abort removes only the plugin's exclude line; user patterns survive", () => {
	const r = mkRun();
	const ex = path.join(r.repo, ".git/info/exclude");
	fs.appendFileSync(ex, "user-keep-me\n");
	const a = run(r, "abort.sh");
	assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
	const lines = fs.readFileSync(ex, "utf8").split("\n");
	assert.equal(lines.includes(".swarm-task.md"), false, "plugin pattern gone");
	assert.ok(lines.includes("user-keep-me"), "user pattern untouched");
});

test("abort archives the manifest (rename, never delete) with final slot states", () => {
	const r = mkRun();
	const a = run(r, "abort.sh");
	assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
	assert.equal(fs.existsSync(path.join(r.sdir, "run-w9.json")), false);
	const doc = r.archived();
	assert.equal(
		doc.run_id,
		r.runId,
		"archived manifest parses and is the run's record",
	);
	assert.equal(doc.slots[0].status, "archived");
});

test("stale workspace id: git fallback removes the worktree and the workspace close is attempted", () => {
	// Custom stub: the herdr removal verb fails (server lost the workspace
	// across a restart) — abort must fall back to plain git + workspace close.
	h.writeStub(
		"herdr",
		`echo "herdr $@" >> "$STUB_LOG"
if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then echo '{"error":{"code":"not_found","message":"no such workspace"}}'; exit 1; fi
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then echo '{"id":"x","result":{"panes":[],"type":"pane_list"}}'; exit 0; fi
exit 0`,
	);
	const r = mkRun();
	commitIn(r.wt(1), "c.txt");
	const a = run(r, "abort.sh");
	h.writeHerdrStub(); // restore the shared default for later tests
	assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
	assert.equal(
		fs.existsSync(r.wt(1)),
		false,
		"git fallback removed the worktree",
	);
	assert.match(a.stderr, /falling back to plain git/);
	assert.match(h.log(), /workspace close w11/);
});

// R13: intersection calls warn above the max tested version and are NEVER
// refused — cleanup of an existing run is mostly git and must survive herdr
// churn. The gate was implemented but unreachable until abort called it.
test("abort on an untested herdr (0.8.0) warns about the version and still completes", () => {
	const r = mkRun();
	const a = run(r, "abort.sh", { STUB_HERDR_VERSION: "0.8.0" });
	assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
	assert.match(a.stderr, /newer than tested/);
	assert.equal(fs.existsSync(r.wt(1)), false, "the run was still torn down");
	assert.match(a.stdout, /abort summary/);
});

test("no active run: abort no-ops with a message and still prints the summary", () => {
	const repo = h.makeRepo();
	const sdir = mkdtemp("hs-cl-");
	const env = h.freshEnv({ HERDR_PLUGIN_STATE_DIR: sdir, ...gitIdent });
	const a = spawnSync("bash", [path.join(repoRoot, "scripts", "abort.sh")], {
		env,
		cwd: repo,
		encoding: "utf8",
	});
	assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
	assert.match(a.stdout, /nothing to abort/);
	assert.match(a.stdout, /abort summary/);
});

// ---------------------------------------------------------------------------
// prune.sh
// ---------------------------------------------------------------------------

// Repo + state dir for prune scenarios. addBranch puts a commit on a swarm
// branch via a short checkout dance and optionally merges it --no-ff into
// main (returning the merge commit for the revert scenarios).
function mkPruneRepo() {
	const repo = h.makeRepo();
	const fork = h.git(repo, "rev-parse", "HEAD").stdout.trim();
	const sdir = mkdtemp("hs-pr-");
	const env = h.freshEnv({ HERDR_PLUGIN_STATE_DIR: sdir, ...gitIdent });
	return { repo, fork, sdir, env };
}

function addBranch(p, branch, { merge = true } = {}) {
	h.git(p.repo, "checkout", "-q", "-b", branch, p.fork);
	commitIn(p.repo, `${branch.replace(/\//g, "-")}.txt`);
	h.git(p.repo, "checkout", "-q", "main");
	if (!merge) return null;
	h.git(p.repo, "merge", "--no-ff", "-m", `swarm: merge ${branch}`, branch);
	return h.git(p.repo, "rev-parse", "HEAD").stdout.trim();
}

function writeArchived(p, runId, branches, baseRef = "refs/heads/main") {
	fs.writeFileSync(
		path.join(p.sdir, `archived-${runId}.json`),
		JSON.stringify(
			{
				run_id: runId,
				repo_root: p.repo,
				base_ref: baseRef,
				fork_sha: p.fork,
				created_at: "2026-07-22T15:00:00Z",
				exclude_pattern_added: false,
				slots: branches.map((b, i) => ({
					slot: i + 1,
					label: `s${i + 1}`,
					branch: b,
					path: null,
					workspace_id: null,
					pane_id: null,
					terminal_id: null,
					agent_name: "claude",
					self_created: true,
					status: "archived",
					backup_ref: null,
					journal: null,
				})),
			},
			null,
			2,
		),
	);
}

test("prune dry-run lists merged branch, backup refs, archived manifests — and deletes nothing", () => {
	const p = mkPruneRepo();
	addBranch(p, "swarm/rp1/s1");
	writeArchived(p, "rp1", ["swarm/rp1/s1"]);
	h.git(p.repo, "update-ref", "refs/swarm-backups/rp1/1", p.fork);
	const r = run(p, "prune.sh");
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, /merged\s+swarm\/rp1\/s1/);
	assert.match(r.stdout, /backup\s+refs\/swarm-backups\/rp1\/1/);
	assert.match(r.stdout, /archived manifests: 1/);
	assert.match(r.stdout, /DRY RUN/);
	assert.ok(
		branchExists(p.repo, "swarm/rp1/s1"),
		"branch survives the dry run",
	);
	assert.equal(
		h.git(p.repo, "for-each-ref", "refs/swarm-backups").stdout.trim() === "",
		false,
		"backup ref survives the dry run",
	);
	assert.match(r.stdout, /prune summary/);
});

test("prune with confirm deletes merged branch and backup ref; unmerged and foreign branches survive", () => {
	const p = mkPruneRepo();
	addBranch(p, "swarm/rp2/s1");
	addBranch(p, "swarm/rp2/s2", { merge: false });
	addBranch(p, "feature-x"); // merged, but NOT swarm-namespaced: invisible to prune
	writeArchived(p, "rp2", ["swarm/rp2/s1", "swarm/rp2/s2"]);
	h.git(p.repo, "update-ref", "refs/swarm-backups/rp2/1", p.fork);
	const r = run(p, "prune.sh", {
		HERDR_SWARM_PRUNE_CONFIRM: "yes",
		HERDR_SWARM_PRUNE_BACKUPS: "yes",
	});
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.equal(
		branchExists(p.repo, "swarm/rp2/s1"),
		false,
		"merged branch deleted",
	);
	assert.ok(branchExists(p.repo, "swarm/rp2/s2"), "unmerged branch kept");
	assert.match(r.stdout, /unmerged swarm\/rp2\/s2/);
	assert.ok(branchExists(p.repo, "feature-x"), "foreign branch untouched");
	assert.equal(
		r.stdout.includes("feature-x"),
		false,
		"foreign branch never even listed",
	);
	assert.equal(
		h.git(p.repo, "for-each-ref", "refs/swarm-backups").stdout.trim(),
		"",
		"backup ref deleted under the dedicated backups flag",
	);
	assert.match(r.stdout, /prune summary/);
});

// Backup refs are the last copy of discarded work: the branch gate must not
// double as their gate.
test("PRUNE_CONFIRM alone lists backup refs but never deletes one", () => {
	const p = mkPruneRepo();
	addBranch(p, "swarm/rp6/s1");
	writeArchived(p, "rp6", ["swarm/rp6/s1"]);
	h.git(p.repo, "update-ref", "refs/swarm-backups/rp6/1", p.fork);
	const r = run(p, "prune.sh", { HERDR_SWARM_PRUNE_CONFIRM: "yes" });
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.equal(
		branchExists(p.repo, "swarm/rp6/s1"),
		false,
		"the branch gate still works",
	);
	assert.match(r.stdout, /backup\s+refs\/swarm-backups\/rp6\/1/, "listed");
	assert.equal(
		r.stdout.includes("deleted  refs/swarm-backups"),
		false,
		"never deleted",
	);
	assert.ok(
		h
			.git(p.repo, "for-each-ref", "refs/swarm-backups")
			.stdout.includes("rp6/1"),
		"backup ref survives PRUNE_CONFIRM",
	);
	assert.match(r.stdout, /HERDR_SWARM_PRUNE_BACKUPS/, "the real flag is named");
});

test("PRUNE_BACKUPS deletes archived-run snapshots but never the ACTIVE run's", () => {
	const p = mkPruneRepo();
	addBranch(p, "swarm/rp7/s1");
	writeArchived(p, "rp7", ["swarm/rp7/s1"]);
	h.git(p.repo, "update-ref", "refs/swarm-backups/rp7/1", p.fork);
	// A LIVE manifest for a different run: its snapshots are the only undo an
	// in-flight harvest has, so no flag may reach them.
	const active = "rp7live";
	fs.writeFileSync(
		path.join(p.sdir, "run-w9.json"),
		JSON.stringify(
			{
				run_id: active,
				repo_root: p.repo,
				base_ref: "refs/heads/main",
				fork_sha: p.fork,
				created_at: "2026-07-22T15:00:00Z",
				exclude_pattern_added: false,
				slots: [],
			},
			null,
			2,
		),
	);
	h.git(p.repo, "update-ref", `refs/swarm-backups/${active}/1`, p.fork);
	const r = run(p, "prune.sh", {
		HERDR_SWARM_PRUNE_CONFIRM: "yes",
		HERDR_SWARM_PRUNE_BACKUPS: "yes",
	});
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	const refs = h.git(p.repo, "for-each-ref", "refs/swarm-backups").stdout;
	assert.equal(refs.includes("rp7/1"), false, "archived-run snapshot deleted");
	assert.ok(refs.includes(`${active}/1`), "ACTIVE run's snapshot survives");
	assert.match(r.stdout, /ACTIVE RUN — kept/);
	assert.match(r.stdout, /active-run kept 1/);
});

test("ancestry is judged against the recorded base even with another branch checked out; -d refusal is reported, never -D", () => {
	const p = mkPruneRepo();
	addBranch(p, "swarm/rp3/s1");
	writeArchived(p, "rp3", ["swarm/rp3/s1"]);
	// elsewhere forks BEFORE the merge, so HEAD's view says "not merged" —
	// the recorded-base ancestry check must still classify it merged.
	h.git(p.repo, "checkout", "-q", "-b", "elsewhere", p.fork);
	const dry = run(p, "prune.sh");
	assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
	assert.match(
		dry.stdout,
		/merged\s+swarm\/rp3\/s1 \(base refs\/heads\/main\)/,
	);
	// Under confirm, `git branch -d` (HEAD-relative) refuses — prune reports
	// and skips instead of escalating to -D.
	const del = run(p, "prune.sh", { HERDR_SWARM_PRUNE_CONFIRM: "yes" });
	assert.equal(del.status, 0, `${del.stdout}\n${del.stderr}`);
	assert.ok(
		branchExists(p.repo, "swarm/rp3/s1"),
		"branch survives the -d refusal",
	);
	assert.match(del.stderr, /branch -d refused/);
});

test("base hard-reset before the merge landed: branch reported unmerged and kept even under confirm", () => {
	const p = mkPruneRepo();
	addBranch(p, "swarm/rp4/s1");
	writeArchived(p, "rp4", ["swarm/rp4/s1"]);
	// The user rewinds base: the manifest still says archived/merged, but git
	// ancestry — the single authority — now says the work is NOT in base.
	h.git(p.repo, "reset", "--hard", "-q", p.fork);
	const r = run(p, "prune.sh", { HERDR_SWARM_PRUNE_CONFIRM: "yes" });
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, /unmerged swarm\/rp4\/s1/);
	assert.ok(branchExists(p.repo, "swarm/rp4/s1"), "unmerged branch kept");
});

test("merged-then-reverted: flagged in dry-run; deletion additionally requires the ack env", () => {
	const p = mkPruneRepo();
	const mc = addBranch(p, "swarm/rp5/s1");
	writeArchived(p, "rp5", ["swarm/rp5/s1"]);
	h.git(p.repo, "revert", "-m", "1", "--no-edit", mc);
	const dry = run(p, "prune.sh");
	assert.match(dry.stdout, /MERGED-THEN-REVERTED/);
	const noAck = run(p, "prune.sh", { HERDR_SWARM_PRUNE_CONFIRM: "yes" });
	assert.ok(
		branchExists(p.repo, "swarm/rp5/s1"),
		"confirm alone does not delete a reverted branch",
	);
	assert.match(noAck.stderr, /HERDR_SWARM_PRUNE_ACK_REVERTED/);
	const acked = run(p, "prune.sh", {
		HERDR_SWARM_PRUNE_CONFIRM: "yes",
		HERDR_SWARM_PRUNE_ACK_REVERTED: "yes",
	});
	assert.equal(acked.status, 0, `${acked.stdout}\n${acked.stderr}`);
	assert.equal(
		branchExists(p.repo, "swarm/rp5/s1"),
		false,
		"ack + confirm deletes it",
	);
});

test("branch no validated manifest mentions is kept without a destructive current-branch fallback", () => {
	const p = mkPruneRepo(); // state dir stays empty: no manifest knows this branch
	addBranch(p, "swarm/orphan/s1");
	const r = run(p, "prune.sh");
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, /kept\s+swarm\/orphan\/s1/);
	assert.match(r.stdout, /destructive current-branch fallback is forbidden/);
	assert.ok(branchExists(p.repo, "swarm/orphan/s1"));
});
