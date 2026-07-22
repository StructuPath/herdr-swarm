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
import { createHarness, repoRoot } from "./harness.mjs";

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

// harvest-step.sh makes real commits (WIP, snapshot, merge); the harness env
// has GIT_CONFIG_GLOBAL=/dev/null, so identity must ride in explicitly or
// every commit-producing verb dies on "unable to auto-detect email".
const gitIdent = {
	GIT_AUTHOR_NAME: "hs-test",
	GIT_AUTHOR_EMAIL: "hs@test.invalid",
	GIT_COMMITTER_NAME: "hs-test",
	GIT_COMMITTER_EMAIL: "hs@test.invalid",
};

let runSeq = 0;

// A fanned-out-looking run built directly: real repo, real slot worktrees on
// run-unique branches forked at the recorded SHA, manifest written the way
// fanout-pane.sh writes it (task file present + excluded, like reality).
function mkRun(opts = {}) {
	const nslots = opts.slots ?? 1;
	const repo = h.makeRepo();
	const runId = `r-hv${++runSeq}`;
	const fork = h.git(repo, "rev-parse", "HEAD").stdout.trim();
	const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-hv-"));
	fs.appendFileSync(path.join(repo, ".git/info/exclude"), ".swarm-task.md\n");
	const slots = [];
	for (let i = 1; i <= nslots; i++) {
		const branch = `swarm/${runId}/s${i}`;
		const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hs-wt-")), `s${i}`);
		h.git(repo, "worktree", "add", "-q", "-b", branch, wt, fork);
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
		slotRow: (i) =>
			JSON.parse(fs.readFileSync(path.join(sdir, "run-w9.json"), "utf8")).slots.find(
				(s) => s.slot === i,
			),
	};
}

function commitIn(dir, name, content = "work\n", msg = `add ${name}`) {
	fs.writeFileSync(path.join(dir, name), content);
	h.git(dir, "add", name);
	h.git(dir, "commit", "-q", "-m", msg);
	return h.git(dir, "rev-parse", "HEAD").stdout.trim();
}

// A commit minted with plumbing only — moves nothing checked out anywhere, so
// tests can race the base ref under the verb's feet without touching a tree.
function bareCommitOn(repo, sha, msg = "racer") {
	const tree = h.git(repo, "rev-parse", `${sha}^{tree}`).stdout.trim();
	return h.git(repo, "commit-tree", tree, "-p", sha, "-m", msg).stdout.trim();
}

const step = (run, verb, args = [], extraEnv = {}) =>
	h.runScript(
		"harvest-step.sh",
		[verb, ...args.map(String)],
		{ ...run.env, ...extraEnv },
	);

// Async variant for the interleave tests: the verb must be mid-flight while
// the test mutates the repo.
function stepAsync(run, verb, args = [], extraEnv = {}) {
	const child = spawn(
		"bash",
		[path.join(repoRoot, "scripts", "harvest-step.sh"), verb, ...args.map(String)],
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
		h.git(run.repo, "log", "-g", "-1", "--format=%gs", "refs/heads/main").stdout,
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
		h.git(run.repo, "rev-parse", "--verify", `refs/heads/${run.branch(1)}`)
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
	const wtGitDir = h.git(run.wt(1), "rev-parse", "--absolute-git-dir").stdout.trim();
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
	const baseTip = commitIn(run.repo, "README.md", "base version\n", "base edit");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	const r = step(run, "merge", [1, baseTip]);
	assert.equal(r.status, EC.CONFLICT, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, /conflict_file\tREADME\.md/, "conflicted files listed");
	const tree = /merge_tree\t(.*)/.exec(r.stdout)?.[1];
	assert.ok(tree && fs.existsSync(tree), "merge tree left for inspection");
	assert.ok(
		fs.existsSync(
			path.join(h.git(tree, "rev-parse", "--absolute-git-dir").stdout.trim(), "MERGE_HEAD"),
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
	assert.equal(fs.existsSync(tree), false, "harvest worktree reaped after abort");
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

test("preview reports base_sha, locus, and the three-dot diffstat for a clean slot", () => {
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	const r = step(run, "preview", [1]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, new RegExp(`base_sha\t${run.fork}`));
	assert.match(r.stdout, /state\tclean/);
	assert.match(r.stdout, new RegExp(`locus\tuser-tree\t`));
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
	const files = h.git(run.wt(1), "show", "--name-only", "--format=", "HEAD").stdout;
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
	const m = /snapshot\t(refs\/swarm-backups\/\S+)\t([0-9a-f]{40})/.exec(r.stdout);
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
	assert.equal(
		h.git(run.repo, "show", `${sha}:README.md`).stdout,
		"edited\n",
	);
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
	assert.ok(fs.existsSync(path.join(run.wt(1), "untracked.txt")), "tree untouched");
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
	let r = step(run, "merge", [1, run.fork], { HERDR_SWARM_TEST_DIE_BEFORE_SWAP: "1" });
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

test("kill between merge commit and swap: base moved -> dangling SHA reported loudly, worktree never deleted", () => {
	const run = mkRun();
	commitIn(run.wt(1), "feat.txt");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	let r = step(run, "merge", [1, run.fork], { HERDR_SWARM_TEST_DIE_BEFORE_SWAP: "1" });
	assert.equal(r.status, 99);
	const msha = run.slotRow(1).journal.merge_commit_sha;
	const hwt = run.slotRow(1).journal.worktree;
	// Base moves while the run is crashed.
	const racer = bareCommitOn(run.repo, run.fork);
	h.git(run.repo, "update-ref", "refs/heads/main", racer, run.fork);
	r = step(run, "resume");
	assert.equal(r.status, 0);
	assert.match(r.stdout, new RegExp(`resume_dangling\t1\t${msha}`));
	assert.match(r.stderr, /will not be auto-deleted/, "loud, with the policy named");
	assert.ok(fs.existsSync(hwt), "harvest worktree kept");
	// Completing anyway must fail the CAS and change nothing.
	r = step(run, "resume", ["complete", 1]);
	assert.equal(r.status, EC.SWAP);
	assert.equal(h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(), racer);
	assert.ok(fs.existsSync(hwt));
});

test("two merges in one harvest re-check drift per merge: a stale expected SHA is refused, re-baselined succeeds", () => {
	const run = mkRun({ slots: 2 });
	commitIn(run.wt(1), "a.txt");
	commitIn(run.wt(2), "b.txt");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	let r = step(run, "merge", [1, run.fork]);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	const afterFirst = h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim();
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
	assert.match(r.stdout, /ignored\tdebug\.log/, "inventory names the file");
	assert.equal(run.slotRow(1).status, "merged", "nothing archived yet");
	assert.doesNotMatch(h.log(), /worktree remove/, "no removal before the ack");
	// Acknowledged: removal proceeds via the herdr verb (workspace-scoped, no
	// --force), manifest goes archived, branch survives.
	r = step(run, "archive", [1], { HERDR_SWARM_ACK_IGNORED: "1" });
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(h.log(), /herdr worktree remove --workspace w11 --json/);
	assert.doesNotMatch(h.log(), /--force/);
	assert.equal(run.slotRow(1).status, "archived");
	assert.equal(
		spawnSync("git", ["-C", run.repo, "rev-parse", "--verify", `refs/heads/${run.branch(1)}`]).status,
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
	assert.doesNotMatch(h.log(), /worktree remove/, "spike (a): never reached the killing verb");
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
	r = step(run2, "archive", [1], { HERDR_SWARM_ACK_IGNORED: "1" });
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
	for (const m of src.matchAll(/^HS_EC_([A-Z]+)=(\d+)/gm)) bash[m[1]] = Number(m[2]);
	assert.deepEqual(STEP_EC, bash, "renderer and verb script exit codes drifted");
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
	assert.ok(rawOn > shell && reenter > rawOn, "raw mode and alt screen restored after exit");
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
	assert.equal(row.preview.baseSha, racer, "previews re-baselined to the new base");
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
	assert.equal(h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim(), run.fork);
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
	assert.ok(fs.existsSync(path.join(run.wt(1), "precious.txt")), "tree untouched");
	assert.equal(run.slotRow(1).backup_ref, null, "no snapshot for a cancelled discard");
	await r.onKey("1");
	await r.onKey("d");
	for (const ch of run.branch(1)) await r.onKey(ch);
	await r.onKey("\r");
	assert.equal(fs.existsSync(path.join(run.wt(1), "precious.txt")), false);
	const sha = run.slotRow(1).backup_ref;
	assert.match(sha ?? "", /^[0-9a-f]{40}$/, "snapshot recorded before the discard ran");
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
	const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-nomf-"));
	let r = spawnSync("bash", [path.join(repoRoot, "scripts", "harvest-pane.sh")], {
		env: h.freshEnv({ HERDR_PLUGIN_STATE_DIR: sdir }),
		encoding: "utf8",
		timeout: 1500,
	});
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
