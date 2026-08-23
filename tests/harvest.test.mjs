// U6 harvest tests. The locus-decision and drift compare-and-swap tests were
// written BEFORE scripts/harvest-step.sh existed (plan execution note: they
// are the destructive-path guards, so they come first and were watched
// failing). Real throwaway git repos are the medium of choice here — merge
// semantics are exactly what a stub git would fake away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitIn, createHarness, makeFannedOutRun, repoRoot, mkdtemp } from "./harness.mjs";

const h = createHarness();
h.writeHerdrStub();

// Exit-code contract of scripts/harvest-step.sh — lockstep-asserted against
// both the bash constants and the renderer's copy further down.
const EC = {
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

// Shared fanned-out-run fixture (tests/harness.mjs); the prefix keeps this
// file's run ids distinct from other suites'.
const mkRun = (opts = {}) => makeFannedOutRun(h, { prefix: "r-hv", ...opts });

// A commit minted with plumbing only — moves nothing checked out anywhere, so
// tests can race the base ref under the verb's feet without touching a tree.
function bareCommitOn(repo, sha, msg = "racer") {
	const tree = h.git(repo, "rev-parse", `${sha}^{tree}`).stdout.trim();
	return h.git(repo, "commit-tree", tree, "-p", sha, "-m", msg).stdout.trim();
}

const step = (run, verb, args = [], extraEnv = {}) =>
	h.runScript("harvest-step.sh", [verb, ...args.map(String)], {
		...run.env,
		...extraEnv,
	});

function cleanupApproval(stdout) {
	const line = stdout
		.split("\n")
		.find((entry) => entry.startsWith("cleanup_approval\t"));
	assert.ok(line, `cleanup approval missing from preview:\n${stdout}`);
	return line.slice("cleanup_approval\t".length);
}

// Async variant for the interleave tests: the verb must be mid-flight while
// the test mutates the repo.
function stepAsync(run, verb, args = [], extraEnv = {}) {
	const child = spawn(
		"bash",
		[
			path.join(repoRoot, "scripts", "harvest-step.sh"),
			verb,
			...args.map(String),
		],
		{ env: { ...run.env, ...extraEnv } },
	);
	let out = "";
	let err = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (err += d));
	return new Promise((resolve) =>
		child.on("close", (code) => resolve({ code, out, err })),
	);
}

const until = async (cond, ms = 8000) => {
	const deadline = Date.now() + ms;
	while (!cond() && Date.now() < deadline)
		await new Promise((r) => setTimeout(r, 50));
	return cond();
};

// ---------------------------------------------------------------------------
// TEST-FIRST BLOCK — written and watched failing before harvest-step.sh
// existed. These encode the two destructive-path guards the plan's execution
// note singles out: the merge-locus decision and the drift compare-and-swap.
// ---------------------------------------------------------------------------

test("locus: base checked out -> user-tree merge; dirty user tree refused before any mutation", () => {
	const run = mkRun();
	const tip = commitIn(run.wt(1), "feat.txt");
	// Dirty the user's checkout (main is checked out in the repo worktree):
	// the verb must refuse BEFORE any git mutation — no merge, no MERGE_HEAD.
	fs.writeFileSync(path.join(run.repo, "scratch.txt"), "uncommitted\n");
	let r = step(run, "merge", [1, run.fork]);
	assert.equal(r.status, EC.LOCUS, `${r.stdout}\n${r.stderr}`);
	assert.match(
		r.stderr,
		/check out any other branch and re-run harvest/,
		"refusal names the escape hatch that converts to the safe detached case",
	);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		run.fork,
		"base untouched",
	);
	assert.equal(
		fs.existsSync(path.join(run.repo, ".git/MERGE_HEAD")),
		false,
		"no merge was started",
	);
	// Clean tree -> the user-tree path merges in the user's checkout.
	fs.rmSync(path.join(run.repo, "scratch.txt"));
	r = step(run, "merge", [1, run.fork]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	const head = h.git(run.repo, "rev-parse", "HEAD").stdout.trim();
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		head,
		"merge landed on the user's checked-out base",
	);
	assert.equal(h.git(run.repo, "rev-parse", "HEAD^1").stdout.trim(), run.fork);
	assert.equal(h.git(run.repo, "rev-parse", "HEAD^2").stdout.trim(), tip);
	assert.equal(
		h.git(run.repo, "log", "-1", "--format=%s").stdout.trim(),
		`swarm: merge s1 (run ${run.runId})`,
		"templated --no-ff message",
	);
	assert.equal(run.slotRow(1).status, "merged");
	assert.equal(run.slotRow(1).journal, null, "journal cleared after success");
});

test("locus: base NOT checked out -> detached harvest worktree, base advanced by ref swap, user checkout untouched", () => {
	const run = mkRun();
	const tip = commitIn(run.wt(1), "feat.txt");
	// Move the user off base: git now forbids no second checkout of main, so
	// the verb must pick the detached locus.
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	const r = step(run, "merge", [1, run.fork]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	const merged = h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim();
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main^1").stdout.trim(),
		run.fork,
	);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main^2").stdout.trim(),
		tip,
	);
	assert.match(r.stdout, new RegExp(`merged\t${merged}`), "new SHA reported");
	// The user's checkout never moved — the whole point of the detached locus.
	assert.equal(
		h.git(run.repo, "symbolic-ref", "HEAD").stdout.trim(),
		"refs/heads/elsewhere",
	);
	assert.equal(h.git(run.repo, "rev-parse", "HEAD").stdout.trim(), run.fork);
	// Reflog breadcrumb (KTD): the recovery trail for the atomic swap.
	assert.match(
		h.git(run.repo, "log", "-g", "-1", "--format=%gs", "refs/heads/main")
			.stdout,
		new RegExp(`swarm: harvest merge 1 \\(run ${run.runId}\\)`),
	);
	assert.ok(
		!h.git(run.repo, "worktree", "list").stdout.includes("harvest-"),
		"harvest worktree removed after a clean swap",
	);
	assert.equal(run.slotRow(1).status, "merged");
	assert.equal(run.slotRow(1).journal, null);
	// R10: archive keeps branches; merge must not delete them either.
	assert.equal(
		h
			.git(run.repo, "rev-parse", "--verify", `refs/heads/${run.branch(1)}`)
			.stdout.trim(),
		tip,
	);
});

test("drift CAS: base moving BETWEEN the drift check and the ref write fails the swap itself, base unchanged", async () => {
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	// The pause seam sleeps between journaling the merge commit and the
	// update-ref — the exact window a check-then-plain-write design would
	// lose. The journal write is the deterministic signal the merge finished.
	const done = stepAsync(run, "merge", [1, run.fork], {
		HERDR_SWARM_TEST_PAUSE_BEFORE_SWAP: "2",
	});
	assert.ok(
		await until(() => run.slotRow(1).journal?.merge_commit_sha),
		"merge commit never got journaled",
	);
	// Race the base ref during the pause (plumbing-only commit — no checkout).
	const racer = bareCommitOn(run.repo, run.fork);
	h.git(run.repo, "update-ref", "refs/heads/main", racer, run.fork);
	const r = await done;
	assert.equal(r.code, EC.SWAP, `${r.out}\n${r.err}`);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		racer,
		"the racing commit won; the swap changed nothing",
	);
	assert.match(r.err, /swap FAILED/i, "failure is loud");
	// The merge commit is journaled and reachable — never silently lost (R8).
	const msha = run.slotRow(1).journal.merge_commit_sha;
	assert.match(msha, /^[0-9a-f]{40}$/);
	assert.equal(
		spawnSync("git", ["-C", run.repo, "cat-file", "-e", `${msha}^{commit}`])
			.status,
		0,
		"dangling merge commit still exists in the object store",
	);
	assert.ok(
		fs.existsSync(run.slotRow(1).journal.worktree),
		"harvest worktree holding the un-swapped commit is never deleted",
	);
});

// ---------------------------------------------------------------------------
// End of the test-first block; the scenarios below were written against the
// implemented verbs (plan U6 acceptance list).
// ---------------------------------------------------------------------------

test("user-tree first-parent verify: mismatch triggers reset --hard ORIG_HEAD with a loud message", async () => {
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	// Pause seam sits between the clean/drift verification and the merge —
	// the window a sitting confirm prompt creates in real life. Journal
	// appearing (locus recorded, no merge sha yet) is the signal we're inside.
	const done = stepAsync(run, "merge", [1, run.fork], {
		HERDR_SWARM_TEST_PAUSE_BEFORE_MERGE: "2",
	});
	assert.ok(
		await until(() => run.slotRow(1).journal),
		"merge intent never got journaled",
	);
	// A commit lands in the user tree during the pause: HEAD (== base) moves.
	const racer = commitIn(run.repo, "racer.txt", "r\n", "racer commit");
	const r = await done;
	assert.equal(r.code, EC.SWAP, `${r.out}\n${r.err}`);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		racer,
		"reset --hard ORIG_HEAD restored the racing commit as the tip",
	);
	assert.equal(
		h.git(run.repo, "log", "-1", "--format=%s").stdout.trim(),
		"racer commit",
		"no merge commit survives in the user's history",
	);
	assert.equal(
		h.git(run.repo, "status", "--porcelain").stdout,
		"",
		"user tree left clean",
	);
	assert.match(r.err, /ABANDONED/, "abandoned merge commit reported loudly");
	assert.match(r.err, /[0-9a-f]{40}/, "the dangling SHA is named for recovery");
	assert.equal(run.slotRow(1).journal, null);
});

test("sequencer state in ANY worktree refuses the merge before any mutation", () => {
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	// MERGE_HEAD in a linked worktree's private git dir (not the main one) —
	// the scan must cover worktrees/*, not just the common dir.
	const wtGitDir = h
		.git(run.wt(1), "rev-parse", "--absolute-git-dir")
		.stdout.trim();
	fs.writeFileSync(path.join(wtGitDir, "MERGE_HEAD"), `${run.fork}\n`);
	let r = step(run, "merge", [1, run.fork]);
	assert.equal(r.status, EC.SEQUENCER, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stderr, /MERGE_HEAD/, "the offending state is named");
	fs.rmSync(path.join(wtGitDir, "MERGE_HEAD"));
	// rebase-merge dir in the MAIN git dir refuses too.
	fs.mkdirSync(path.join(run.repo, ".git/rebase-merge"));
	r = step(run, "merge", [1, run.fork]);
	assert.equal(r.status, EC.SEQUENCER);
	assert.match(r.stderr, /rebase-merge/);
	fs.rmdirSync(path.join(run.repo, ".git/rebase-merge"));
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		run.fork,
		"base untouched by both refusals",
	);
});

test("conflict in the detached locus: base and user checkout untouched, worktree left, abort-merge recovers", () => {
	const run = mkRun();
	// Conflicting edits to the same file on slot and base.
	commitIn(run.wt(1), "README.md", "slot version\n", "slot edit");
	const baseTip = commitIn(
		run.repo,
		"README.md",
		"base version\n",
		"base edit",
	);
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	const r = step(run, "merge", [1, baseTip]);
	assert.equal(r.status, EC.CONFLICT, `${r.stdout}\n${r.stderr}`);
	assert.match(
		r.stdout,
		/conflict_file\tREADME\.md/,
		"conflicted files listed",
	);
	const tree = /merge_tree\t(.*)/.exec(r.stdout)?.[1];
	assert.ok(tree && fs.existsSync(tree), "merge tree left for inspection");
	assert.ok(
		fs.existsSync(
			path.join(
				h.git(tree, "rev-parse", "--absolute-git-dir").stdout.trim(),
				"MERGE_HEAD",
			),
		),
		"merge is genuinely in progress in the harvest worktree",
	);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		baseTip,
		"base ref unchanged",
	);
	assert.equal(
		h.git(run.repo, "status", "--porcelain").stdout,
		"",
		"user checkout untouched",
	);
	// Abort cleans up: worktree removed, journal cleared, base still put.
	const a = step(run, "abort-merge", [1]);
	assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
	assert.equal(
		fs.existsSync(tree),
		false,
		"harvest worktree reaped after abort",
	);
	assert.equal(run.slotRow(1).journal, null);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		baseTip,
	);
});

test("hook failure is classified distinctly from conflict and is recoverable", () => {
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	// A failing pre-merge-commit hook in the real repo (hooks are shared
	// across worktrees via the common dir): merge fails with NO conflicts.
	const hook = path.join(run.repo, ".git/hooks/pre-merge-commit");
	fs.writeFileSync(hook, "#!/bin/sh\necho HOOKFAIL >&2\nexit 1\n");
	fs.chmodSync(hook, 0o755);
	const r = step(run, "merge", [1, run.fork]);
	assert.equal(r.status, EC.HOOK, `${r.stdout}\n${r.stderr}`);
	assert.doesNotMatch(r.stdout, /conflict_file/, "no conflicts claimed");
	assert.match(
		r.stderr,
		/WITHOUT conflicts/,
		"messaged distinctly from the conflict case",
	);
	assert.match(
		r.stderr,
		/node_modules/,
		"names the likely fresh-worktree cause (hook-policy KTD)",
	);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		run.fork,
		"base unchanged",
	);
	// abort-merge recovers whatever merge state the hook failure left.
	const a = step(run, "abort-merge", [1]);
	assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
	assert.equal(run.slotRow(1).journal, null);
	assert.equal(h.git(run.repo, "status", "--porcelain").stdout, "");
	fs.rmSync(hook);
});

test("sparse user tree refuses the in-user-tree merge with the escape hatch named", () => {
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	h.git(run.repo, "config", "core.sparseCheckout", "true");
	const r = step(run, "merge", [1, run.fork]);
	assert.equal(r.status, EC.LOCUS, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stderr, /SPARSE/i);
	assert.match(r.stderr, /check out any other branch and re-run harvest/);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		run.fork,
	);
});

test("preview: externally merged slot auto-marks merged; empty slot auto-skips; dirty slot counts", () => {
	const run = mkRun({ slots: 3 });
	// Slot 1: the user ff-merged it themselves.
	commitIn(run.wt(1), "feat.txt");
	h.git(run.repo, "merge", "-q", "--ff-only", run.branch(1));
	let r = step(run, "preview", [1]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, /state\texternal_merged/);
	assert.equal(run.slotRow(1).status, "merged");
	// Slot 2: no commits, clean tree -> empty -> skipped.
	r = step(run, "preview", [2]);
	assert.match(r.stdout, /state\tempty/);
	assert.equal(run.slotRow(2).status, "skipped");
	// Slot 3: uncommitted work only -> dirty, counted, NOT auto-skipped.
	fs.writeFileSync(path.join(run.wt(3), "wip.txt"), "dirty\n");
	r = step(run, "preview", [3]);
	assert.match(r.stdout, /state\tdirty/);
	assert.match(r.stdout, /dirty\t1/);
	assert.equal(run.slotRow(3).status, "running", "dirty slots stay live");
	// The task file never counts as dirt (it is excluded).
	assert.doesNotMatch(r.stdout, /swarm-task/);
});

// A 0.7.5 slot is PLUGIN-reported, not natively detected, so nothing updates
// its agent state on its own. Preview is the one hook the plugin already has:
// when it concludes a slot has stopped working, it says so — otherwise every
// harvested slot would sit at "working" in `agent list` forever. On 0.7.4
// herdr's own detection owns state and the plugin must stay out of the way.
test("preview reports a finished slot idle on 0.7.5, and never reports on 0.7.4", () => {
	const run = mkRun({ slots: 2 });
	// Slot 1: no commits, clean tree -> empty -> auto-skipped -> not working.
	let r = step(run, "preview", [1], { STUB_HERDR_VERSION: "0.7.5" });
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, /state\tempty/);
	assert.match(
		h.log(),
		/pane report-agent w11:p1 --source structupath\.swarm --agent claude --state idle/,
	);
	// A slot still doing work is left alone — reporting idle on a live agent
	// would be a lie the status pane then displays.
	fs.writeFileSync(path.join(run.wt(2), "wip.txt"), "dirty\n");
	const before = h.log();
	r = step(run, "preview", [2], { STUB_HERDR_VERSION: "0.7.5" });
	assert.match(r.stdout, /state\tdirty/);
	assert.equal(h.log(), before, "no report for a slot that is still working");
	// Same finished slot on 0.7.4: herdr detects the agent itself there. The
	// stub log is cumulative for this run's env, so compare the DELTA.
	const before074 = h.log();
	const on074 = step(run, "preview", [1]);
	assert.equal(on074.status, 0, on074.stderr);
	assert.doesNotMatch(h.log().slice(before074.length), /report-agent/);
});

test("preview reports base_sha, locus, and the three-dot diffstat for a clean slot", () => {
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	const r = step(run, "preview", [1]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, new RegExp(`base_sha\t${run.fork}`));
	assert.match(r.stdout, /state\tclean/);
	assert.match(r.stdout, /locus\tuser-tree\t/);
	assert.match(r.stdout, /stat\t.*feat\.txt/);
	// Detached once the user moves off base.
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	assert.match(step(run, "preview", [1]).stdout, /locus\tdetached/);
});

test("commit-wip commits tracked and untracked work as one WIP commit", () => {
	const run = mkRun();
	fs.writeFileSync(path.join(run.wt(1), "README.md"), "edited\n"); // tracked
	fs.writeFileSync(path.join(run.wt(1), "new.txt"), "new\n"); // untracked
	const r = step(run, "commit-wip", [1]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.equal(h.git(run.wt(1), "status", "--porcelain").stdout, "");
	assert.equal(
		h.git(run.wt(1), "log", "-1", "--format=%s").stdout.trim(),
		`swarm: WIP s1 (run ${run.runId})`,
	);
	const files = h.git(
		run.wt(1),
		"show",
		"--name-only",
		"--format=",
		"HEAD",
	).stdout;
	assert.match(files, /new\.txt/, "untracked work is in the WIP commit");
	assert.doesNotMatch(files, /swarm-task/, "task file never committed");
});

test("snapshot captures untracked work in a backup ref without touching the real index", () => {
	const run = mkRun();
	fs.writeFileSync(path.join(run.wt(1), "README.md"), "edited\n");
	fs.writeFileSync(path.join(run.wt(1), "untracked.txt"), "precious\n");
	const before = h.git(run.wt(1), "status", "--porcelain").stdout;
	const r = step(run, "snapshot", [1]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	const m = /snapshot\t(refs\/swarm-backups\/\S+)\t([0-9a-f]{40})/.exec(
		r.stdout,
	);
	assert.ok(m, `snapshot line missing in: ${r.stdout}`);
	const [, ref, sha] = m;
	assert.equal(ref, `refs/swarm-backups/${run.runId}/1`);
	assert.equal(
		h.git(run.repo, "rev-parse", ref).stdout.trim(),
		sha,
		"backup ref points at the snapshot commit",
	);
	assert.equal(
		h.git(run.repo, "show", `${sha}:untracked.txt`).stdout,
		"precious\n",
		"untracked content captured (git stash create would have skipped it)",
	);
	assert.equal(h.git(run.repo, "show", `${sha}:README.md`).stdout, "edited\n");
	assert.throws(
		() => h.git(run.repo, "show", `${sha}:.swarm-task.md`),
		/git show.*failed/,
		"excluded task file stays out of the snapshot",
	);
	assert.equal(
		h.git(run.wt(1), "status", "--porcelain").stdout,
		before,
		"the real index was never mutated",
	);
	assert.equal(run.slotRow(1).backup_ref, sha, "SHA recorded in the manifest");
});

test("discard refuses without a snapshot, refuses a bad token, then discards with work recoverable", () => {
	const run = mkRun();
	fs.writeFileSync(path.join(run.wt(1), "untracked.txt"), "precious\n");
	// Ordering guarantee: no recorded backup ref -> no destructive step runs.
	let r = step(run, "discard", [1], { HERDR_SWARM_CONFIRM: run.branch(1) });
	assert.equal(r.status, EC.REFUSED, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stderr, /no recorded snapshot/);
	assert.ok(
		fs.existsSync(path.join(run.wt(1), "untracked.txt")),
		"tree untouched",
	);
	assert.equal(step(run, "snapshot", [1]).status, 0);
	// Renderer typed the wrong thing (or a UI bug): the verb re-verifies.
	r = step(run, "discard", [1], { HERDR_SWARM_CONFIRM: "wrong-branch" });
	assert.equal(r.status, EC.REFUSED);
	assert.ok(fs.existsSync(path.join(run.wt(1), "untracked.txt")));
	// Correct token: tree cleaned, work still recoverable from the ref.
	r = step(run, "discard", [1], { HERDR_SWARM_CONFIRM: run.branch(1) });
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.equal(fs.existsSync(path.join(run.wt(1), "untracked.txt")), false);
	assert.equal(h.git(run.wt(1), "status", "--porcelain").stdout, "");
	assert.ok(
		fs.existsSync(path.join(run.wt(1), ".swarm-task.md")),
		"clean -fd (not -fdx): ignored/excluded files survive the discard",
	);
	const sha = run.slotRow(1).backup_ref;
	assert.equal(
		h.git(run.repo, "show", `${sha}:untracked.txt`).stdout,
		"precious\n",
		"discarded work recoverable from the backup ref",
	);
});

test("kill between merge commit and swap: resume offers completion when base is unmoved, completes it", () => {
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	// Deterministic crash seam right after the merge SHA is journaled.
	let r = step(run, "merge", [1, run.fork], {
		HERDR_SWARM_TEST_DIE_BEFORE_SWAP: "1",
	});
	assert.equal(r.status, 99);
	const msha = run.slotRow(1).journal.merge_commit_sha;
	assert.match(msha, /^[0-9a-f]{40}$/);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		run.fork,
		"crash left base unmoved",
	);
	r = step(run, "resume");
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, new RegExp(`resume_offer\t1\t${msha}`));
	r = step(run, "resume", ["complete", 1]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		msha,
		"completed swap advanced base to the journaled merge commit",
	);
	assert.equal(run.slotRow(1).status, "merged");
	assert.equal(run.slotRow(1).journal, null);
});

test("swap and resume use exact ignored preview/apply before removing a harvest generation", () => {
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	let result = step(run, "merge", [1, run.fork], {
		HERDR_SWARM_TEST_DIE_BEFORE_SWAP: "1",
	});
	assert.equal(result.status, 99);
	const hwt = run.slotRow(1).journal.worktree;
	fs.appendFileSync(path.join(run.repo, ".git/info/exclude"), "hook-output.log\n");
	fs.writeFileSync(path.join(hwt, "hook-output.log"), "ignored hook artifact\n");

	result = step(run, "resume", ["complete", 1]);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.ok(fs.existsSync(hwt), "ignored data keeps the generation after swap");
	assert.ok(run.slotRow(1).journal, "journal remains until verified removal");
	const approval = cleanupApproval(result.stdout);

	result = step(run, "resume", [], {
		HERDR_SWARM_CLEANUP_APPROVAL: approval,
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.equal(fs.existsSync(hwt), false);
	assert.equal(run.slotRow(1).journal, null);
	const used = fs
		.readdirSync(run.sdir)
		.filter((name) => name.startsWith("cleanup-used-") && name.endsWith(".json"));
	assert.equal(used.length, 1, "approval was durably consumed exactly once");
});

test("harvest removal refuses every exact identity mismatch", () => {
	for (const field of [
		"repo_key",
		"run_id",
		"slot",
		"path",
		"generation",
		"head",
		"registration",
		"symlink",
	]) {
		const run = mkRun();
		commitIn(run.wt(1), "feat.txt");
		h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
		let result = step(run, "merge", [1, run.fork], {
			HERDR_SWARM_TEST_DIE_BEFORE_SWAP: "1",
		});
		assert.equal(result.status, 99);
		const row = run.slotRow(1);
		const journal = structuredClone(row.journal);
		const hwt = journal.worktree;
		h.git(run.repo, "update-ref", "refs/heads/main", journal.merge_commit_sha, run.fork);
		if (field === "registration") {
			h.git(hwt, "checkout", "-q", "-b", `foreign-${run.runId}`);
		} else if (field === "symlink") {
			const actual = `${hwt}-actual`;
			fs.renameSync(hwt, actual);
			fs.symlinkSync(actual, hwt, "dir");
		} else {
			journal.resource[field] =
				field === "slot" ? "999" : `${journal.resource[field]}-wrong`;
			patchSlot(run, 1, { journal });
		}
		result = step(run, "abort-merge", [1]);
		assert.equal(result.status, EC.REFUSED, `${field}: ${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /identity|resource|symlink|registration/i, field);
		assert.ok(fs.existsSync(hwt), `${field}: zero removal`);
	}
});

test("kill between merge commit and swap: base moved -> dangling SHA reported loudly, worktree never deleted", () => {
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	let r = step(run, "merge", [1, run.fork], {
		HERDR_SWARM_TEST_DIE_BEFORE_SWAP: "1",
	});
	assert.equal(r.status, 99);
	const msha = run.slotRow(1).journal.merge_commit_sha;
	const hwt = run.slotRow(1).journal.worktree;
	// Base moves while the run is crashed.
	const racer = bareCommitOn(run.repo, run.fork);
	h.git(run.repo, "update-ref", "refs/heads/main", racer, run.fork);
	r = step(run, "resume");
	assert.equal(r.status, 0);
	assert.match(r.stdout, new RegExp(`resume_dangling\t1\t${msha}`));
	assert.match(
		r.stderr,
		/will not be auto-deleted/,
		"loud, with the policy named",
	);
	assert.ok(fs.existsSync(hwt), "harvest worktree kept");
	// Completing anyway must fail the CAS and change nothing.
	r = step(run, "resume", ["complete", 1]);
	assert.equal(r.status, EC.SWAP);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		racer,
	);
	assert.ok(fs.existsSync(hwt));
});

test("two merges in one harvest re-check drift per merge: a stale expected SHA is refused, re-baselined succeeds", () => {
	const run = mkRun({ slots: 2 });
	commitIn(run.wt(1), "a.txt");
	commitIn(run.wt(2), "b.txt");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	let r = step(run, "merge", [1, run.fork]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	const afterFirst = h
		.git(run.repo, "rev-parse", "refs/heads/main")
		.stdout.trim();
	// Slot 2 with the PRE-first-merge SHA: the per-merge drift check refuses.
	r = step(run, "merge", [2, run.fork]);
	assert.equal(r.status, EC.DRIFT, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stderr, /re-preview/, "re-preview signal in the refusal");
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		afterFirst,
		"refusal mutated nothing",
	);
	// Re-baselined expected SHA: succeeds.
	r = step(run, "merge", [2, afterFirst]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main^1").stdout.trim(),
		afterFirst,
		"second merge builds on the first",
	);
});

test("archive: inventory prompt on an agent-created ignored file, none on the task file alone", () => {
	h.writeHerdrStub(); // default stub: agent list has no term_s1 -> absent
	const run = mkRun({ status: "merged" });
	// Agent-created ignored file (pattern in the shared exclude, like a build
	// artifact): removal would silently delete it — spike (h).
	fs.appendFileSync(path.join(run.repo, ".git/info/exclude"), "*.log\n");
	fs.writeFileSync(path.join(run.wt(1), "debug.log"), "agent output\n");
	let r = step(run, "archive", [1]);
	assert.equal(r.status, EC.IGNORED, `${r.stdout}\n${r.stderr}`);
	assert.match(
		r.stdout,
		/ignored_json\t"debug\.log"/,
		"inventory names the file",
	);
	assert.equal(run.slotRow(1).status, "merged", "nothing archived yet");
	assert.doesNotMatch(h.log(), /worktree remove/, "no removal before the ack");
	// Apply the exact digest-bound one-use approval emitted by preview.
	const approval = cleanupApproval(r.stdout);
	r = step(run, "archive", [1], { HERDR_SWARM_CLEANUP_APPROVAL: approval });
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(h.log(), /herdr worktree remove --workspace w11 --json/);
	assert.doesNotMatch(h.log(), /--force/);
	assert.equal(run.slotRow(1).status, "archived");
	assert.equal(
		spawnSync("git", [
			"-C",
			run.repo,
			"rev-parse",
			"--verify",
			`refs/heads/${run.branch(1)}`,
		]).status,
		0,
		"branch kept (R10: teardown decoupled from branch deletion)",
	);
	// Task file alone never prompts: fresh run, only .swarm-task.md present.
	const run2 = mkRun({ status: "skipped" });
	r = step(run2, "archive", [1]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.equal(run2.slotRow(1).status, "archived");
});

test("archive refuses a working agent (herdr remove would kill it) and dirty worktrees route to the uncommitted flow", () => {
	// Live agent matching this slot's terminal id, working: refuse.
	h.writeStub(
		"herdr",
		`echo "herdr $@" >> "$STUB_LOG"
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  echo '{"id":"cli:agent:list","result":{"agents":[{"agent":"claude","agent_status":"working","pane_id":"w11:p1","terminal_id":"term_s1","workspace_id":"w11"}],"type":"agent_list"}}'
  exit 0
fi
exit 0`,
	);
	const run = mkRun({ status: "merged" });
	let r = step(run, "archive", [1]);
	assert.equal(r.status, EC.REFUSED, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stderr, /working/, "agent state named");
	assert.doesNotMatch(
		h.log(),
		/worktree remove/,
		"spike (a): never reached the killing verb",
	);
	// Dirty worktree: herdr refuses with the machine-readable code; the verb
	// routes to the uncommitted-work flow, never message-parses.
	h.writeStub(
		"herdr",
		`echo "herdr $@" >> "$STUB_LOG"
if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then
  echo '{"error":{"code":"dirty_worktree_requires_force","message":"fatal: contains modified or untracked files, use --force to delete it"}}'
  exit 1
fi
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  echo '{"id":"cli:agent:list","result":{"agents":[],"type":"agent_list"}}'
  exit 0
fi
exit 0`,
	);
	const run2 = mkRun({ status: "merged" });
	fs.writeFileSync(path.join(run2.wt(1), "wip.txt"), "dirty\n");
	r = step(run2, "archive", [1]);
	assert.equal(r.status, EC.DIRTY, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stderr, /commit-WIP, skip, or discard/);
	assert.equal(run2.slotRow(1).status, "merged", "not archived");
	h.writeHerdrStub(); // restore the default stub for later tests
});

test("archive refuses non-settled statuses; skip marks a slot skipped", () => {
	h.writeHerdrStub();
	const run = mkRun(); // status running
	let r = step(run, "archive", [1]);
	assert.equal(r.status, EC.REFUSED);
	assert.match(r.stderr, /only merged\/skipped\/failed/);
	r = step(run, "skip", [1]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.equal(run.slotRow(1).status, "skipped");
	r = step(run, "archive", [1]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.equal(run.slotRow(1).status, "archived");
});

test("verbs refuse on a corrupt manifest with the typed corrupt code", () => {
	const run = mkRun();
	fs.writeFileSync(path.join(run.sdir, "run-w9.json"), '{"slots": [');
	const r = step(run, "merge", [1, run.fork]);
	assert.equal(r.status, 3, "MANIFEST_EC_CORRUPT propagates");
	assert.match(r.stderr, /corrupt/);
});

// ---------------------------------------------------------------------------
// Code-review fixes. Each test below pins a failure mode that shipped in the
// first cut of harvest-step.sh; they are grouped here rather than woven in so
// the guard they exercise is obvious from the neighbourhood.
// ---------------------------------------------------------------------------

// Shallow-merge a patch into one slot row of the run manifest — used to build
// journal shapes a crash leaves behind but the happy path never writes.
function patchSlot(run, slot, patch) {
	const p = path.join(run.sdir, "run-w9.json");
	const doc = JSON.parse(fs.readFileSync(p, "utf8"));
	Object.assign(
		doc.slots.find((s) => s.slot === slot),
		patch,
	);
	fs.writeFileSync(p, JSON.stringify(doc, null, 2));
}

// The user's base checkout in a LINKED worktree — deliberately NOT the main
// working tree. git refuses to `worktree remove` a main working tree, so the
// main-tree fixture would pass these tests for the wrong reason; a linked
// checkout is the case git will happily delete, and the case real users hit
// (worktree-per-feature workflows). Returns its path; the tree is left CLEAN
// so a removal would genuinely succeed if the guard were missing.
function linkedBaseCheckout(run) {
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	const dir = path.join(
		mkdtemp("hs-userwt-"),
		"base",
	);
	h.git(run.repo, "worktree", "add", "-q", dir, "main");
	return dir;
}

function foreignHarvestWorktree(run, slot = 1, sha = run.fork) {
	const dir = path.join(run.sdir, `harvest-${run.runId}-s${slot}`);
	h.git(run.repo, "worktree", "add", "-q", "--detach", dir, sha);
	fs.appendFileSync(path.join(run.repo, ".git/info/exclude"), "precious.secret\n");
	fs.writeFileSync(path.join(dir, "precious.secret"), "foreign ignored data\n");
	return dir;
}

test("abort-merge refuses a same-prefix foreign detached worktree and its ignored data", () => {
	const run = mkRun();
	const foreign = foreignHarvestWorktree(run);
	patchSlot(run, 1, {
		journal: {
			locus: "detached",
			expected_base_sha: run.fork,
			merge_commit_sha: null,
			worktree: foreign,
		},
	});
	const result = step(run, "abort-merge", [1]);
	assert.equal(result.status, EC.REFUSED, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stderr, /resource identity failed/);
	assert.equal(fs.readFileSync(path.join(foreign, "precious.secret"), "utf8"), "foreign ignored data\n");
	assert.match(h.git(run.repo, "worktree", "list").stdout, new RegExp(foreign));
});

test("resume scan refuses same-prefix foreign harvest cleanup after the base landed", () => {
	const run = mkRun();
	const msha = bareCommitOn(run.repo, run.fork, "landed merge");
	h.git(run.repo, "update-ref", "refs/heads/main", msha, run.fork);
	const foreign = foreignHarvestWorktree(run, 1, msha);
	patchSlot(run, 1, {
		journal: {
			locus: "detached",
			expected_base_sha: run.fork,
			merge_commit_sha: msha,
			worktree: foreign,
		},
	});
	const result = step(run, "resume");
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stderr, /cleanup was refused/);
	assert.ok(fs.existsSync(path.join(foreign, "precious.secret")));
	assert.ok(run.slotRow(1).journal, "failed cleanup retains exact recovery journal");
});

test("Abort journal cleanup and leftover sweep both quarantine same-prefix foreign worktrees", () => {
	for (const journaled of [true, false]) {
		const run = mkRun();
		const foreign = foreignHarvestWorktree(run, journaled ? 1 : 999);
		if (journaled) {
			patchSlot(run, 1, {
				journal: {
					locus: "detached",
					expected_base_sha: run.fork,
					merge_commit_sha: null,
					worktree: foreign,
				},
			});
		}
		const result = spawnSync(
			"bash",
			[path.join(repoRoot, "scripts/abort.sh")],
			{ cwd: run.repo, env: run.env, encoding: "utf8" },
		);
		assert.equal(result.status, 4, `${result.stdout}\n${result.stderr}`);
		assert.ok(fs.existsSync(path.join(foreign, "precious.secret")));
		assert.match(result.stderr, journaled ? /identity FAILED/ : /no exact live resource journal/);
	}
});

test("resume scan never removes a user-tree-locus journal's worktree — that is the USER's checkout", () => {
	const run = mkRun();
	const userWt = linkedBaseCheckout(run);
	// A user-tree merge landed, then the process died before the manifest was
	// settled: base == the merge commit, so the scan takes its resume_completed
	// branch — the branch that fed journal.worktree to `git worktree remove`.
	const msha = commitIn(userWt, "user.txt", "user work\n", "user-tree merge");
	patchSlot(run, 1, {
		journal: {
			locus: "user-tree",
			expected_base_sha: run.fork,
			merge_commit_sha: msha,
			worktree: userWt,
		},
	});
	const r = step(run, "resume");
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, new RegExp(`resume_completed\t1\t${msha}`));
	assert.ok(fs.existsSync(userWt), "the user's checkout still exists");
	assert.equal(
		fs.readFileSync(path.join(userWt, "user.txt"), "utf8"),
		"user work\n",
		"the user's files are intact",
	);
	assert.ok(
		h.git(run.repo, "worktree", "list").stdout.includes(userWt),
		"still a registered worktree — nothing was reaped",
	);
	assert.equal(run.slotRow(1).status, "merged", "bookkeeping still settled");
});

test("resume complete never hands the user's checkout to swap_base's removal tail", () => {
	const run = mkRun();
	const userWt = linkedBaseCheckout(run);
	// Plumbing-only stand-in for the merge commit a user-tree merge had made
	// before the crash (nothing checked out moves).
	const msha = bareCommitOn(run.repo, run.fork, "user-tree merge");
	patchSlot(run, 1, {
		journal: {
			locus: "user-tree",
			expected_base_sha: run.fork,
			merge_commit_sha: msha,
			worktree: userWt,
		},
	});
	// The user has since moved that worktree off base. THAT is what makes the
	// removal tail reachable: swap_base's millisecond guard only bails while
	// base is still checked out somewhere.
	h.git(userWt, "checkout", "-q", "-b", "sidework");
	const r = step(run, "resume", ["complete", 1]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		msha,
		"the swap itself still completed",
	);
	assert.ok(fs.existsSync(userWt), "the user's checkout survived the swap");
	assert.ok(
		fs.existsSync(path.join(userWt, "README.md")),
		"its files are intact",
	);
});

test("swap_base refuses a journal lacking exact harvest resource identity before moving base", () => {
	const run = mkRun();
	const userWt = linkedBaseCheckout(run);
	const msha = bareCommitOn(run.repo, run.fork);
	// Locus says 'detached' but the path is the user's tree — a bad write, a
	// schema change, or a future caller. The ownership check is the second
	// lock on the same door as the locus gate.
	patchSlot(run, 1, {
		journal: {
			locus: "detached",
			expected_base_sha: run.fork,
			merge_commit_sha: msha,
			worktree: userWt,
		},
	});
	h.git(userWt, "checkout", "-q", "-b", "sidework");
	const r = step(run, "resume", ["complete", 1]);
	assert.equal(r.status, EC.REFUSED, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stderr, /identity failed before base swap/, "the refusal is reported");
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		run.fork,
		"forged resource cannot move the base",
	);
	assert.ok(fs.existsSync(userWt), "foreign worktree kept");
});

test("abort-merge keeps a harvest worktree whose HEAD is off base (merge commit the journal never recorded)", () => {
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	let r = step(run, "merge", [1, run.fork], {
		HERDR_SWARM_TEST_DIE_BEFORE_SWAP: "1",
	});
	assert.equal(r.status, 99);
	const hwt = run.slotRow(1).journal.worktree;
	const msha = run.slotRow(1).journal.merge_commit_sha;
	// Narrow the crash window by one step: between the merge commit's rev-parse
	// and its journal_set. Identical disk state, journal without the sha — so
	// an unguarded abort would remove the only anchor for a real merge commit.
	patchSlot(run, 1, {
		journal: {
			locus: "detached",
			expected_base_sha: run.fork,
			merge_commit_sha: null,
			worktree: hwt,
		},
	});
	r = step(run, "abort-merge", [1]);
	assert.equal(r.status, EC.REFUSED, `${r.stdout}\n${r.stderr}`);
	assert.ok(fs.existsSync(hwt), "worktree holding the merge commit is kept");
	assert.match(r.stderr, new RegExp(msha), "the recoverable SHA is reported");
	assert.equal(
		spawnSync("git", ["-C", run.repo, "cat-file", "-e", `${msha}^{commit}`])
			.status,
		0,
		"the merge commit is still reachable",
	);
	assert.ok(run.slotRow(1).journal, "journal kept — the state stays surfaced");
});

test("a manifest run_id that escapes the path charset is refused as unknown bookkeeping before any git mutation", () => {
	const run = mkRun();
	const p = path.join(run.sdir, "run-w9.json");
	const doc = JSON.parse(fs.readFileSync(p, "utf8"));
	// run_id reaches $(state_dir)/harvest-$RUN_ID-s<slot> and
	// refs/swarm-backups/$RUN_ID/<slot>; '../' would escape both.
	doc.run_id = "../../escape";
	fs.writeFileSync(p, JSON.stringify(doc, null, 2));
	// Log-and-passthrough git stub: the guard must fire before ANY git call.
	h.writeStub("git", 'echo "git $@" >> "$STUB_LOG"\nexec /usr/bin/git "$@"');
	try {
		const r = step(run, "preview", [1]);
		assert.equal(r.status, 3, `${r.stdout}\n${r.stderr}`);
		assert.match(r.stderr, /bookkeeping_unknown/);
		assert.deepEqual(mutatingGitCalls(h.log()), [], "no git mutation ran");
	} finally {
		fs.rmSync(path.join(h.stubDir, "git"), { force: true });
	}
});

test("discard clears STAGED changes too, so the slot can afterwards be archived", () => {
	h.writeHerdrStub();
	const run = mkRun({ status: "merged" });
	// No workspace recorded -> archive takes the plain-git removal path, which
	// really refuses a dirty tree (rather than a stub saying it did).
	patchSlot(run, 1, { workspace_id: null });
	fs.writeFileSync(path.join(run.wt(1), "README.md"), "edited\n"); // tracked
	fs.writeFileSync(path.join(run.wt(1), "staged.txt"), "staged\n"); // untracked
	h.git(run.wt(1), "add", "-A"); // both now STAGED — what checkout -- . left behind
	assert.equal(step(run, "snapshot", [1]).status, 0);
	let r = step(run, "discard", [1], { HERDR_SWARM_CONFIRM: run.branch(1) });
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.equal(
		h.git(run.wt(1), "status", "--porcelain").stdout,
		"",
		"index and working tree both clean — 'discarded' is the truth",
	);
	assert.ok(
		fs.existsSync(path.join(run.wt(1), ".swarm-task.md")),
		"clean -fd (not -fdx) still spares ignored/excluded files",
	);
	const sha = run.slotRow(1).backup_ref;
	// The consequence the old checkout-only discard made unreachable: a
	// staged-but-uncommitted leftover failed HS_EC_DIRTY forever.
	r = step(run, "archive", [1]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.equal(run.slotRow(1).status, "archived");
	assert.equal(
		h.git(run.repo, "show", `${sha}:staged.txt`).stdout,
		"staged\n",
		"staged work is still recoverable from the snapshot",
	);
});

test("archive's git-removal failure keeps stdout protocol-clean and reports the error on stderr", () => {
	h.writeHerdrStub();
	const run = mkRun({ status: "merged" });
	// No workspace recorded (herdr state lost) -> plain git removal. The
	// failure has to come from a REAL, run-owned worktree now: pointing the
	// slot at a plain directory (the original fixture) is refused by the slot
	// ownership check before git ever runs, so it would test the guard rather
	// than this stdout-hygiene path. A lock makes `worktree remove` refuse on
	// a perfectly clean tree — a non-dirty failure, same as before.
	patchSlot(run, 1, { workspace_id: null });
	h.git(run.repo, "worktree", "lock", run.wt(1));
	const r = step(run, "archive", [1]);
	assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
	assert.equal(
		r.stdout,
		"",
		"git noise on stdout would corrupt the key<TAB>value protocol",
	);
	assert.match(r.stderr, /locked/i, "the error text survives");
	assert.equal(run.slotRow(1).status, "merged", "nothing archived");
});

// ---------------------------------------------------------------------------
// Slot ownership (residual finding 2 — the THIRD instance of the drift pattern
// in docs/solutions/best-practices/cross-script-invariant-drift.md). run_id was
// charset-guarded; slot branch and slot path still reached `worktree remove`,
// `reset --hard`, and `clean -fd` behind only a `[ -d ]`. The guard lives in
// read_slot — the one function every slot verb passes through — so these tests
// drive the VERBS, not the helper: the claim is "no verb can get past it".
// ---------------------------------------------------------------------------

// A logging git shim in front of the real binary. The scripts' git calls are
// real (stubbing git would fake away exactly the worktree pairing under test),
// so proving "refused BEFORE any mutation" needs the call record itself, not
// just surviving state — a guard that refuses after a `reset --hard` would
// leave identical-looking state in a fixture with nothing to lose.
function withGitCallLog(fn) {
	h.writeStub("git", 'echo "git $*" >> "$STUB_LOG"\nexec /usr/bin/git "$@"');
	try {
		return fn();
	} finally {
		fs.rmSync(path.join(h.stubDir, "git"), { force: true });
	}
}

// Subcommand-precise, deliberately not a substring match: `merge-base` and
// `worktree list` are read-only and would both trip a naive /merge|worktree/.
const MUTATING_SUBCOMMANDS = new Set([
	"add",
	"am",
	"branch",
	"checkout",
	"cherry-pick",
	"clean",
	"commit",
	"commit-tree",
	"fetch",
	"init",
	"merge",
	"mv",
	"pull",
	"push",
	"read-tree",
	"rebase",
	"reset",
	"restore",
	"revert",
	"rm",
	"stash",
	"switch",
	"tag",
	"update-ref",
	"write-tree",
]);
function mutatingGitCalls(log) {
	const out = [];
	for (const line of log.split("\n")) {
		if (!line.startsWith("git ")) continue;
		const argv = line.slice(4).trim().split(/\s+/);
		let i = 0;
		// Skip the global options every call site uses to name its target.
		while (argv[i]?.startsWith("-"))
			i += argv[i] === "-C" || argv[i] === "-c" ? 2 : 1;
		const sub = argv[i];
		if (sub === "worktree") {
			if (
				["add", "remove", "prune", "lock", "move", "repair"].includes(
					argv[i + 1],
				)
			)
				out.push(line);
		} else if (MUTATING_SUBCOMMANDS.has(sub)) {
			out.push(line);
		}
	}
	return out;
}

// Every verb that reads a slot row. discard also gets the confirmation token
// it would otherwise refuse on — the ownership refusal must win over, not hide
// behind, the checks that already existed.
const SLOT_VERBS = [
	["preview", [1], {}],
	["commit-wip", [1], {}],
	["snapshot", [1], {}],
	["skip", [1], {}],
	["archive", [1], {}],
	["abort-merge", [1], {}],
];

test("a slot branch outside swarm/<run>/* makes bookkeeping unknown for every slot verb before mutation", () => {
	withGitCallLog(() => {
		for (const [verb, args, env] of SLOT_VERBS) {
			const run = mkRun({ status: "merged" });
			// A cross-repo or hand-edited manifest: the row names a branch this
			// run never minted, so nothing about the slot is ours to touch.
			patchSlot(run, 1, { branch: "swarm/some-other-run/s1" });
			const r = step(run, verb, args, env);
			assert.equal(r.status, 3, `${verb}: ${r.stdout}\n${r.stderr}`);
			assert.match(r.stderr, /bookkeeping_unknown/, `${verb} says why`);
			assert.match(
				r.stderr,
				/outside the run namespace/,
				`${verb} names the mismatch`,
			);
			assert.deepEqual(
				mutatingGitCalls(h.log()),
				[],
				`${verb} mutated git before refusing`,
			);
			assert.ok(fs.existsSync(run.wt(1)), `${verb} left the worktree alone`);
		}
	});
});

test("merge and discard refuse a foreign slot branch too (the two rm -rf-class verbs)", () => {
	withGitCallLog(() => {
		const run = mkRun({ slots: 2 });
		commitIn(run.wt(1), "a.txt");
		const base = h.git(run.repo, "rev-parse", "HEAD").stdout.trim();
		patchSlot(run, 1, {
			branch: "swarm/some-other-run/s1",
			backup_ref: base, // clears discard's snapshot precondition
		});
		const m = step(run, "merge", [1, base]);
		assert.equal(m.status, 3, `${m.stdout}\n${m.stderr}`);
		const d = step(run, "discard", [1], {
			HERDR_SWARM_CONFIRM: "swarm/some-other-run/s1",
		});
		assert.equal(d.status, 3, `${d.stdout}\n${d.stderr}`);
		assert.deepEqual(
			mutatingGitCalls(h.log()),
			[],
			"no reset --hard, no clean -fd",
		);
	});
});

test("a slot path that is a REAL worktree of a DIFFERENT branch is refused (pairing, not existence)", () => {
	withGitCallLog(() => {
		// Two real worktrees on purpose. A fixture pointing at a plain directory
		// would pass for the wrong reason — mere existence is what the old
		// `[ -d ]` already tested, and the whole point of this guard is that a
		// registered worktree is not automatically THIS slot's worktree.
		const run = mkRun({ slots: 2, status: "merged" });
		patchSlot(run, 1, { path: run.wt(2) });
		const r = step(run, "archive", [1]);
		assert.equal(r.status, EC.REFUSED, `${r.stdout}\n${r.stderr}`);
		assert.match(r.stderr, /is not a worktree of .* checked out on/);
		assert.deepEqual(mutatingGitCalls(h.log()), []);
		assert.ok(
			fs.existsSync(run.wt(2)),
			"slot 2's worktree survived slot 1's verb",
		);
	});
});

test("a slot path outside the repo entirely is refused", () => {
	withGitCallLog(() => {
		const run = mkRun({ status: "merged" });
		// Exists, so the `[ -d ]` checks would wave it straight through to
		// `git worktree remove` — the exact shape finding 2 describes.
		const outside = mkdtemp("hs-foreign-");
		fs.writeFileSync(path.join(outside, "precious.txt"), "user data\n");
		patchSlot(run, 1, { path: outside });
		const r = step(run, "archive", [1]);
		assert.equal(r.status, EC.REFUSED, `${r.stdout}\n${r.stderr}`);
		assert.deepEqual(mutatingGitCalls(h.log()), []);
		assert.ok(fs.existsSync(path.join(outside, "precious.txt")), "untouched");
	});
});

test("a legitimate pending row (null path) still passes the ownership check", () => {
	// The write-ahead shape (manifest KTD): the row exists before `worktree
	// create` returns, so path is null. Refusing it would break fan-out
	// recovery — a null path is normal, not a mismatch.
	const run = mkRun();
	patchSlot(run, 1, { path: null, status: "pending" });
	const r = step(run, "preview", [1]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, /^state\tmissing$/m);
});

// ---------------------------------------------------------------------------
// Renderer harvest mode (bin/renderer.mjs): UI + state machine + orchestration
// only — the audit test below IS the destructive-surface invariant.
// ---------------------------------------------------------------------------

const {
	HarvestRenderer,
	STEP_EC,
	parseStepOutput,
	previewFromStep,
	renderHarvest,
} = await import("../bin/renderer.mjs");

test("STEP_EC is in lockstep with the HS_EC_* constants in harvest-step.sh", () => {
	const src = fs.readFileSync(
		path.join(repoRoot, "scripts", "harvest-step.sh"),
		"utf8",
	);
	const bash = {};
	for (const m of src.matchAll(/^HS_EC_([A-Z]+)=(\d+)/gm))
		bash[m[1]] = Number(m[2]);
	assert.deepEqual(
		STEP_EC,
		bash,
		"renderer and verb script exit codes drifted",
	);
	assert.deepEqual(STEP_EC, EC, "this test file's own copy drifted");
});

test("no git-mutation strings in bin/ (destructive-git-in-scripts-only KTD)", () => {
	// The grep-able audit invariant from the plan: the renderer may run
	// read-only git for previews, but every mutating git/herdr string lives in
	// scripts/. Comments are stripped first so prose about merging is fine.
	const forbidden = [
		/update-ref/,
		/merge --no-ff/,
		/merge --abort/,
		/reset --hard/,
		/\bclean -f/,
		/commit-tree/,
		/write-tree/,
		/worktree add/,
		/worktree remove/,
		/checkout --/,
		/\bstash\b/,
		/branch -D/,
	];
	const readOnlyGit = new Set(["rev-parse", "diff", "status"]);
	for (const f of fs.readdirSync(path.join(repoRoot, "bin"))) {
		const code = fs
			.readFileSync(path.join(repoRoot, "bin", f), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.split("\n")
			.map((l) => l.replace(/\/\/.*$/, ""))
			.join("\n");
		for (const re of forbidden) {
			assert.doesNotMatch(code, re, `bin/${f} contains mutation string ${re}`);
		}
		// Every git invocation the renderer makes goes through this.git([...]) —
		// its first argument must be a read-only subcommand.
		for (const m of code.matchAll(/\.git\(\s*\[\s*"([a-z-]+)"/g)) {
			assert.ok(
				readOnlyGit.has(m[1]),
				`bin/${f}: this.git(["${m[1]}", …]) is not read-only`,
			);
		}
	}
});

test("parseStepOutput and previewFromStep decode the verb protocol", () => {
	const out = parseStepOutput(
		"slot\t1\nbranch\tswarm/r/s1\nbase_sha\tabc\ndirty\t2\nlocus\tuser-tree\t/tmp/repo\nstate\tdirty\nstat\t a | 1 +\nstat\t 1 file changed\n",
	);
	assert.deepEqual(out.locus, [["user-tree", "/tmp/repo"]]);
	assert.equal(out.stat.length, 2);
	const p = previewFromStep({ code: 0, out, stderr: "" });
	assert.equal(p.state, "dirty");
	assert.equal(p.dirty, 2);
	assert.equal(p.baseSha, "abc");
	assert.equal(p.locus, "user-tree");
	assert.equal(p.locusPath, "/tmp/repo");
	// A failed verb becomes a typed error preview, never a throw.
	const bad = previewFromStep({ code: 1, out: {}, stderr: "boom\n" });
	assert.equal(bad.state, "error");
	assert.equal(bad.error, "boom");
});

test("renderHarvest: conflict view lists files, drift banner shows, dirty rows are loud, hostile text stripped", () => {
	const rows = [
		{
			slot: 1,
			label: "s1",
			branch: "swarm/r1/s1",
			status: "running",
			preview: { state: "dirty", dirty: 3, stat: [" a | 1 +"] },
		},
	];
	let out = renderHarvest(
		{
			runInfo: { run_id: "r1", base_ref: "refs/heads/main" },
			banner: "base moved since preview — re-previewing all slots",
			phase: { name: "list" },
			rows,
		},
		120,
	);
	assert.match(out, /herdr-swarm harvest/);
	assert.match(out, /base moved since preview/);
	assert.match(out, /\x1b\[7m.*dirty/, "dirty row rendered loud");
	out = renderHarvest(
		{
			runInfo: null,
			banner: "",
			phase: {
				name: "conflict",
				slot: 1,
				kind: "conflict",
				files: ["README.md", "src/\x1b]0;pwn\x07x.js"],
				tree: "/tmp/hw",
			},
			rows,
		},
		120,
	);
	assert.match(out, /CONFLICT/);
	assert.match(out, /README\.md/);
	assert.ok(!out.includes("\x1b]"), "hostile filename cannot smuggle escapes");
	assert.match(out, /\[s\]hell into merge tree\s+\[a\]bort merge/);
	out = renderHarvest(
		{
			runInfo: null,
			banner: "",
			phase: { name: "conflict", slot: 1, kind: "hook", files: [], tree: "/t" },
			rows,
		},
		120,
	);
	assert.match(out, /HOOK\/OTHER FAILURE/, "hook failure is a distinct view");
	out = renderHarvest(
		{
			runInfo: null,
			banner: "",
			phase: { name: "discard", slot: 1, typed: "swarm/r1/s" },
			rows,
		},
		120,
	);
	assert.match(out, /Type the slot branch name/);
	assert.match(out, /> swarm\/r1\/s/, "typed confirmation echoed");
});

test("shellInto restores terminal state around the PTY handoff, including when the merge is still conflicted", () => {
	const events = [];
	const r = new HarvestRenderer(h.freshEnv());
	r.write = (s) => events.push(["w", s]);
	r.setRaw = (on) => events.push(["raw", on]);
	r.spawnShell = (dir) => events.push(["shell", dir]);
	// The merge is still conflicted when the shell exits — the conflict phase
	// must survive the handoff and be repainted.
	r.phase = {
		name: "conflict",
		slot: 1,
		kind: "conflict",
		files: ["README.md"],
		tree: "/tmp/hw",
	};
	r.shellInto("/tmp/hw");
	const idx = (pred) => events.findIndex(pred);
	const leave = idx(([k, v]) => k === "w" && v.includes("\x1b[?1049l"));
	const rawOff = idx(([k, v]) => k === "raw" && v === false);
	const shell = idx(([k]) => k === "shell");
	const rawOn = idx(([k, v]) => k === "raw" && v === true);
	const reenter = idx(([k, v]) => k === "w" && v.includes("\x1b[?1049h"));
	assert.ok(leave >= 0 && rawOff > leave, "alt screen left, then raw mode off");
	assert.ok(shell > rawOff, "shell spawns only after the terminal is sane");
	assert.ok(
		rawOn > shell && reenter > rawOn,
		"raw mode and alt screen restored after exit",
	);
	assert.ok(
		events.slice(reenter).some(([k, v]) => k === "w" && v.includes("CONFLICT")),
		"conflict view repainted after the handoff",
	);
	// A throwing spawn (shell missing, PTY error) must still restore.
	const events2 = [];
	const r2 = new HarvestRenderer(h.freshEnv());
	r2.write = (s) => events2.push(["w", s]);
	r2.setRaw = (on) => events2.push(["raw", on]);
	r2.spawnShell = () => {
		throw new Error("no shell");
	};
	assert.throws(() => r2.shellInto("/tmp/x"), /no shell/);
	assert.ok(events2.some(([k, v]) => k === "raw" && v === true));
	assert.ok(events2.some(([k, v]) => k === "w" && v.includes("\x1b[?1049h")));
});

test("HarvestRenderer against a real run: preview, drift re-preview + re-baseline, merge, auto-archive", async () => {
	h.writeHerdrStub();
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	const r = new HarvestRenderer(run.env);
	r.write = () => {}; // headless: no terminal writes in unit tests
	await r.refresh();
	let row = r.rows.find((x) => x.slot === 1);
	assert.equal(row.preview.state, "clean");
	assert.equal(row.preview.locus, "detached");
	assert.equal(row.preview.baseSha, run.fork);
	// Base moves under the renderer: the merge must hit the drift refusal and
	// the renderer must re-baseline the previews to the new SHA.
	const racer = bareCommitOn(run.repo, run.fork);
	h.git(run.repo, "update-ref", "refs/heads/main", racer, run.fork);
	await r.doMerge(1);
	assert.match(r.banner, /base moved/);
	row = r.rows.find((x) => x.slot === 1);
	assert.equal(
		row.preview.baseSha,
		racer,
		"previews re-baselined to the new base",
	);
	// Second attempt with the fresh SHA merges, then auto-archives (agent
	// absent in the stub, only the task file in the worktree -> no prompt).
	await r.doMerge(1);
	assert.equal(run.slotRow(1).status, "archived");
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main^2").stdout.trim(),
		h.git(run.repo, "rev-parse", `refs/heads/${run.branch(1)}`).stdout.trim(),
		"merge landed on base",
	);
});

test("selectSlot routes a user-tree locus through the confirm phase; 'y' merges, anything else cancels", async () => {
	h.writeHerdrStub();
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	const r = new HarvestRenderer(run.env);
	r.write = () => {};
	await r.refresh();
	await r.selectSlot(1);
	assert.equal(r.phase.name, "confirm-user", "no merge without the confirm");
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		run.fork,
		"nothing merged yet",
	);
	await r.onKey("n");
	assert.equal(r.phase.name, "list");
	assert.equal(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		run.fork,
	);
	await r.selectSlot(1);
	await r.onKey("y");
	assert.notEqual(
		h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(),
		run.fork,
		"confirmed merge advanced base in the user tree",
	);
	assert.equal(run.slotRow(1).status, "archived", "merged then auto-archived");
});

test("renderer discard flow: typed branch name gates it, snapshot lands before the tree is touched", async () => {
	h.writeHerdrStub();
	const run = mkRun();
	fs.writeFileSync(path.join(run.wt(1), "precious.txt"), "keep me\n");
	const r = new HarvestRenderer(run.env);
	r.write = () => {};
	await r.refresh();
	await r.onKey("1");
	assert.equal(r.phase.name, "dirty");
	await r.onKey("d");
	assert.equal(r.phase.name, "discard");
	for (const ch of "wrong-name") await r.onKey(ch);
	await r.onKey("\r");
	assert.match(r.banner, /did not match/);
	assert.ok(
		fs.existsSync(path.join(run.wt(1), "precious.txt")),
		"tree untouched",
	);
	assert.equal(
		run.slotRow(1).backup_ref,
		null,
		"no snapshot for a cancelled discard",
	);
	await r.onKey("1");
	await r.onKey("d");
	for (const ch of run.branch(1)) await r.onKey(ch);
	await r.onKey("\r");
	assert.equal(fs.existsSync(path.join(run.wt(1), "precious.txt")), false);
	const sha = run.slotRow(1).backup_ref;
	assert.match(
		sha ?? "",
		/^[0-9a-f]{40}$/,
		"snapshot recorded before the discard ran",
	);
	assert.equal(
		h.git(run.repo, "show", `${sha}:precious.txt`).stdout,
		"keep me\n",
		"work recoverable after the renderer-driven discard",
	);
});

// --- launcher + pane script (mirroring the status.sh conventions) ---

test("harvest.sh opens the pane once, records its id, and no-ops while alive", () => {
	h.writeStub(
		"herdr",
		`echo "herdr $@" >> "$STUB_LOG"
if [ "$1" = "plugin" ] && [ "$2" = "pane" ] && [ "$3" = "open" ]; then
  echo '{"id":"cli:plugin:pane:open","result":{"pane":{"pane_id":"w9:p8","tab_id":"w9:t1","workspace_id":"w9"},"type":"pane_opened"}}'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "read" ]; then exit "\${STUB_PANE_ALIVE:-1}"; fi
exit 0`,
	);
	const env = h.freshEnv();
	let r = h.runScript("harvest.sh", [], env);
	assert.equal(r.status, 0, r.stderr);
	assert.match(
		h.log(),
		/herdr plugin pane open --plugin structupath\.swarm --entrypoint harvest-pane/,
	);
	assert.equal(
		fs.readFileSync(path.join(h.stateDir, "harvest-pane-w9"), "utf8").trim(),
		"w9:p8",
		"pane id recorded for the next invoke and for abort's sweep",
	);
	r = h.runScript("harvest.sh", [], h.freshEnv({ STUB_PANE_ALIVE: "0" }));
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /already open/);
	assert.doesNotMatch(h.log(), /pane open/);
	fs.rmSync(path.join(h.stateDir, "harvest-pane-w9"), { force: true });
	h.writeHerdrStub();
});

test("harvest-pane.sh lingers without a manifest; with a real run it execs the harvest renderer end to end", () => {
	h.writeHerdrStub();
	const sdir = mkdtemp("hs-nomf-");
	let r = spawnSync(
		"bash",
		[path.join(repoRoot, "scripts", "harvest-pane.sh")],
		{
			env: h.freshEnv({ HERDR_PLUGIN_STATE_DIR: sdir }),
			encoding: "utf8",
			timeout: 1500,
		},
	);
	assert.match(r.stdout, /nothing to harvest/);
	assert.equal(r.signal, "SIGTERM", "still lingering when the timeout hit");
	// Real run: the pane must reach the harvest renderer's painted screen —
	// proof the mode seam, context resolution, and exec all line up.
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	r = spawnSync("bash", [path.join(repoRoot, "scripts", "harvest-pane.sh")], {
		env: run.env,
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.match(r.stdout, /herdr-swarm harvest/);
	assert.match(r.stdout, new RegExp(`run:${run.runId}`));
	assert.match(r.stdout, /clean/, "real preview rendered");
});
