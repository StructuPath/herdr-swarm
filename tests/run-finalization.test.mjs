import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHarness, makeFannedOutRun, repoRoot } from "./harness.mjs";

const h = createHarness();
h.writeHerdrStub();
const mkRun = (opts = {}) => makeFannedOutRun(h, { prefix: "r-safe", ...opts });
const step = (run, verb, args = [], extraEnv = {}) =>
	h.runScript("harvest-step.sh", [verb, ...args.map(String)], {
		...run.env,
		...extraEnv,
	});
const abort = (run, extraEnv = {}) =>
	spawnSync("bash", [path.join(repoRoot, "scripts/abort.sh")], {
		cwd: run.repo,
		env: { ...run.env, ...extraEnv },
		encoding: "utf8",
	});

function approvalFrom(stdout) {
	const line = stdout
		.split("\n")
		.find((entry) => entry.startsWith("cleanup_approval\t"));
	assert.ok(line, `approval missing from preview:\n${stdout}`);
	return line.slice("cleanup_approval\t".length);
}

function sha256(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function appendIgnore(run, pattern) {
	fs.appendFileSync(path.join(run.repo, ".git/info/exclude"), `${pattern}\n`);
}

test("archive preview recursively inventories ignored .env, nested files, and newline names without removal", () => {
	const run = mkRun({ status: "merged" });
	appendIgnore(run, "ignored/**");
	appendIgnore(run, ".env");
	fs.mkdirSync(path.join(run.wt(1), "ignored/deep"), { recursive: true });
	fs.writeFileSync(path.join(run.wt(1), ".env"), "secret\n");
	fs.writeFileSync(
		path.join(run.wt(1), "ignored/deep/result.txt"),
		"evidence\n",
	);
	fs.writeFileSync(
		path.join(run.wt(1), "ignored/deep/line\nbreak.txt"),
		"newline\n",
	);
	const preview = step(run, "archive", [1]);
	assert.equal(preview.status, 37, `${preview.stdout}\n${preview.stderr}`);
	assert.match(preview.stdout, /ignored_json\t"\.env"/);
	assert.match(preview.stdout, /ignored\/deep\/result\.txt/);
	assert.match(preview.stdout, /line\\nbreak\.txt/);
	assert.ok(fs.existsSync(run.wt(1)));
	assert.doesNotMatch(h.log(), /worktree remove/);

	const template = JSON.parse(approvalFrom(preview.stdout));
	for (const [field, value] of [
		["run_id", "wrong-run"],
		["slot", "2"],
		["worktree", `${run.wt(1)}-foreign`],
	]) {
		const wrong = { ...template, [field]: value };
		const refused = step(run, "archive", [1], {
			HERDR_SWARM_CLEANUP_APPROVAL: JSON.stringify(wrong),
		});
		assert.equal(refused.status, 37, field);
		assert.ok(
			fs.existsSync(run.wt(1)),
			`wrong ${field} binding performs zero removal`,
		);
		assert.doesNotMatch(h.log(), /worktree remove/);
	}
});

test("archive apply refuses stale and concurrently changed inventories before any removal", async () => {
	const run = mkRun({ status: "merged" });
	appendIgnore(run, "*.log");
	fs.writeFileSync(path.join(run.wt(1), "first.log"), "one\n");
	let preview = step(run, "archive", [1]);
	const staleApproval = approvalFrom(preview.stdout);
	fs.writeFileSync(path.join(run.wt(1), "second.log"), "two\n");
	const refused = step(run, "archive", [1], {
		HERDR_SWARM_CLEANUP_APPROVAL: staleApproval,
	});
	assert.equal(refused.status, 37, `${refused.stdout}\n${refused.stderr}`);
	assert.ok(fs.existsSync(run.wt(1)));
	assert.doesNotMatch(h.log(), /worktree remove/);

	preview = step(run, "archive", [1]);
	const approval = approvalFrom(preview.stdout);
	const ready = path.join(run.sdir, "cleanup-ready");
	const child = spawn(
		"bash",
		[path.join(repoRoot, "scripts/harvest-step.sh"), "archive", "1"],
		{
			env: {
				...run.env,
				HERDR_SWARM_CLEANUP_APPROVAL: approval,
				HERDR_SWARM_TEST_CLEANUP_READY_FILE: ready,
				HERDR_SWARM_TEST_PAUSE_BEFORE_CLEANUP_RECHECK: "1",
			},
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	for (let i = 0; i < 100 && !fs.existsSync(ready); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.ok(fs.existsSync(ready), "apply reached the immediate recheck seam");
	fs.writeFileSync(path.join(run.wt(1), "concurrent.log"), "raced\n");
	const code = await new Promise((resolve) => child.on("close", resolve));
	assert.equal(code, 37, `${stdout}\n${stderr}`);
	assert.match(stderr, /inventory changed/);
	assert.ok(fs.existsSync(run.wt(1)), "concurrent writer wins safety refusal");
	assert.doesNotMatch(h.log(), /worktree remove/);
});

test("abort ignored cleanup is preview/apply and a generic legacy acknowledgment cannot delete", () => {
	const run = mkRun();
	appendIgnore(run, ".env");
	fs.writeFileSync(path.join(run.wt(1), ".env"), "keep\n");
	let result = abort(run, { HERDR_SWARM_ACK_IGNORED: "1" });
	assert.equal(result.status, 4, `${result.stdout}\n${result.stderr}`);
	assert.ok(fs.existsSync(run.wt(1)));
	assert.doesNotMatch(h.log(), /worktree remove/);

	fs.writeFileSync(h.logFile, "");
	result = abort(run, {
		HERDR_SWARM_ABORT_PREVIEW: "yes",
		HERDR_SWARM_CLEANUP_OPERATION_ID: "abort-preview",
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /preview only — zero resources removed/);
	assert.doesNotMatch(h.log(), /pane close|worktree remove/);
	const approval = approvalFrom(result.stdout);
	result = abort(run, { HERDR_SWARM_CLEANUP_APPROVAL: approval });
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.equal(fs.existsSync(run.wt(1)), false);
	assert.equal(fs.existsSync(path.join(run.sdir, "run-w9.json")), false);
	assert.ok(fs.existsSync(path.join(run.sdir, `archived-${run.runId}.json`)));
});

test("Abort exits nonzero when post-removal or already-gone slot bookkeeping cannot persist", () => {
	for (const alreadyGone of [false, true]) {
		const run = mkRun();
		if (alreadyGone) {
			fs.rmSync(run.wt(1), { recursive: true, force: true });
			h.git(run.repo, "worktree", "prune");
		}
		const backup = path.join(run.sdir, "run-w9.json.bak");
		fs.rmSync(backup, { force: true });
		fs.symlinkSync(path.join(run.sdir, "missing-parent", "backup"), backup);
		const result = abort(run);
		assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /bookkeeping failure/);
		assert.equal(fs.existsSync(run.wt(1)), false);
		assert.ok(fs.existsSync(path.join(run.sdir, "run-w9.json")));
		assert.equal(
			fs.existsSync(path.join(run.sdir, `archived-${run.runId}.json`)),
			false,
		);
	}
});

test("Abort removes a landed exact harvest generation and archives every slot", () => {
	const run = mkRun();
	fs.writeFileSync(path.join(run.wt(1), "feature.txt"), "work\n");
	h.git(run.wt(1), "add", "feature.txt");
	h.git(run.wt(1), "commit", "-q", "-m", "feature");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	let result = step(run, "merge", [1, run.fork], {
		HERDR_SWARM_TEST_DIE_BEFORE_SWAP: "1",
	});
	assert.equal(result.status, 99, `${result.stdout}\n${result.stderr}`);
	const journal = run.slotRow(1).journal;
	h.git(run.repo, "update-ref", "refs/heads/main", journal.merge_commit_sha, run.fork);
	result = abort(run);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.equal(fs.existsSync(journal.worktree), false);
	assert.ok(run.archived().slots.every((slot) => slot.status === "archived"));
});

test("Abort keeps an ignored harvest journal reachable, then exact approval removes and archives once", () => {
	const run = mkRun();
	fs.writeFileSync(path.join(run.wt(1), "feature.txt"), "work\n");
	h.git(run.wt(1), "add", "feature.txt");
	h.git(run.wt(1), "commit", "-q", "-m", "feature");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	let result = step(run, "merge", [1, run.fork], {
		HERDR_SWARM_TEST_DIE_BEFORE_SWAP: "1",
	});
	assert.equal(result.status, 99, `${result.stdout}\n${result.stderr}`);
	const journal = run.slotRow(1).journal;
	h.git(
		run.repo,
		"update-ref",
		"refs/heads/main",
		journal.merge_commit_sha,
		run.fork,
	);
	appendIgnore(run, "*.secret");
	fs.writeFileSync(path.join(journal.worktree, "precious.secret"), "keep\n");

	result = abort(run);
	assert.equal(result.status, 4, `${result.stdout}\n${result.stderr}`);
	assert.equal(fs.existsSync(run.wt(1)), false, "ordinary slot was reaped");
	assert.ok(fs.existsSync(journal.worktree), "ignored harvest generation kept");
	const keptRow = run.slotRow(1);
	assert.notEqual(
		keptRow.status,
		"archived",
		"slot is not terminal while its exact harvest journal remains",
	);
	assert.deepEqual(keptRow.journal, journal);
	const approvals = result.stdout
		.split("\n")
		.filter((line) => line.startsWith("cleanup_approval\t"));
	assert.equal(approvals.length, 1, "zero-count slot inventory emits no approval");
	const approval = approvals[0].slice("cleanup_approval\t".length);
	assert.equal(JSON.parse(approval).resource_type, "harvest");

	result = abort(run, { HERDR_SWARM_CLEANUP_APPROVAL: approval });
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.equal(fs.existsSync(journal.worktree), false);
	assert.equal(fs.existsSync(path.join(journal.worktree, "precious.secret")), false);
	assert.equal(fs.existsSync(path.join(run.sdir, "run-w9.json")), false);
	const archive = run.archived();
	assert.equal(archive.slots[0].status, "archived");
	assert.equal(archive.slots[0].journal, null);
	assert.equal(archive.completion_events.length, 1);
	assert.equal(
		fs
			.readdirSync(run.sdir)
			.filter((name) => name === `archived-${run.runId}.json`).length,
		1,
		"run is archived exactly once",
	);
});

test("Abort exits nonzero when a removed exact harvest generation cannot clear its journal", () => {
	const run = mkRun();
	fs.writeFileSync(path.join(run.wt(1), "feature.txt"), "work\n");
	h.git(run.wt(1), "add", "feature.txt");
	h.git(run.wt(1), "commit", "-q", "-m", "feature");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	let result = step(run, "merge", [1, run.fork], {
		HERDR_SWARM_TEST_DIE_BEFORE_SWAP: "1",
	});
	assert.equal(result.status, 99, `${result.stdout}\n${result.stderr}`);
	const journal = run.slotRow(1).journal;
	h.git(run.repo, "update-ref", "refs/heads/main", journal.merge_commit_sha, run.fork);
	const backup = path.join(run.sdir, "run-w9.json.bak");
	fs.rmSync(backup, { force: true });
	fs.symlinkSync(path.join(run.sdir, "missing-parent", "backup"), backup);

	result = abort(run);
	assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.equal(fs.existsSync(run.wt(1)), false, "slot removal completed");
	assert.equal(fs.existsSync(journal.worktree), false, "harvest removal completed");
	assert.match(result.stderr, /journal update failed|bookkeeping failure/);
	assert.ok(fs.existsSync(path.join(run.sdir, "run-w9.json")));
	assert.equal(fs.existsSync(path.join(run.sdir, `archived-${run.runId}.json`)), false);
});

test("full harvest archives exactly once, removes the live pointer/exclude, and retry is idempotent", () => {
	const run = mkRun({ slots: 2, status: "skipped" });
	let result = step(run, "archive", [1]);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.ok(
		fs.existsSync(path.join(run.sdir, "run-w9.json")),
		"first slot keeps run live",
	);
	assert.ok(
		fs
			.readFileSync(path.join(run.repo, ".git/info/exclude"), "utf8")
			.includes(".swarm-task.md"),
	);
	result = step(run, "archive", [2]);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	const archive = path.join(run.sdir, `archived-${run.runId}.json`);
	assert.equal(fs.existsSync(path.join(run.sdir, "run-w9.json")), false);
	const doc = JSON.parse(fs.readFileSync(archive, "utf8"));
	assert.equal(doc.status, "completed");
	assert.equal(doc.completion_reason, "all_slots_archived");
	assert.equal(doc.completion_events.length, 1);
	assert.ok(doc.slots.every((slot) => slot.status === "archived"));
	assert.equal(
		fs
			.readFileSync(path.join(run.repo, ".git/info/exclude"), "utf8")
			.includes(".swarm-task.md"),
		false,
	);
	const before = sha256(archive);
	const retry = h.runLib(
		`export SWARM_REPO=${JSON.stringify(run.repo)}; finalize_run ${JSON.stringify(run.repo)} ${JSON.stringify(run.runId)}`,
		run.env,
		{ sources: ["scripts/preflight.sh"] },
	);
	assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
	assert.equal(sha256(archive), before, "retry never rewrites the archive");
	assert.equal(
		fs
			.readdirSync(run.sdir)
			.filter(
				(name) =>
					name.startsWith(`archived-${run.runId}`) && name.endsWith(".json"),
			).length,
		1,
	);
});

test("Harvest, Status, and Abort resolve the exact live run from a second workspace alias", () => {
	const run = mkRun();
	const aliasEnv = { ...run.env, HERDR_WORKSPACE_ID: "w2" };
	const preview = spawnSync(
		"bash",
		[path.join(repoRoot, "scripts/harvest-step.sh"), "preview", "1"],
		{ cwd: run.repo, env: aliasEnv, encoding: "utf8" },
	);
	assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
	assert.match(preview.stdout, /^slot\t1$/m);

	const status = spawnSync(
		"bash",
		[path.join(repoRoot, "scripts/status-pane.sh")],
		{ cwd: run.repo, env: aliasEnv, encoding: "utf8", timeout: 1800 },
	);
	assert.match(status.stdout, new RegExp(`run:${run.runId}`));

	const result = spawnSync("bash", [path.join(repoRoot, "scripts/abort.sh")], {
		cwd: run.repo,
		env: aliasEnv,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.equal(fs.existsSync(path.join(run.sdir, "run-w9.json")), false);
	assert.ok(fs.existsSync(path.join(run.sdir, `archived-${run.runId}.json`)));
});

test("explicit repository context refuses a conflicting workspace hint with zero removal", () => {
	const foreign = mkRun({ prefix: "r-foreign" });
	const current = mkRun({ prefix: "r-current" });
	const currentManifest = path.join(current.sdir, "run-w9.json");
	const currentHint = path.join(foreign.sdir, "run-w2.json");
	fs.copyFileSync(currentManifest, currentHint);
	const env = {
		...foreign.env,
		HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: current.repo }),
	};

	const harvest = spawnSync(
		"bash",
		[path.join(repoRoot, "scripts/harvest-step.sh"), "archive", "1"],
		{ cwd: current.repo, env, encoding: "utf8" },
	);
	assert.equal(harvest.status, 3, `${harvest.stdout}\n${harvest.stderr}`);
	assert.match(harvest.stderr, /workspace manifest hint|bookkeeping_unknown/);

	const status = spawnSync(
		"bash",
		[path.join(repoRoot, "scripts/status-pane.sh")],
		{
			cwd: current.repo,
			env: { ...env, HERDR_SWARM_LINGER_SECS: "1" },
			encoding: "utf8",
			timeout: 3000,
		},
	);
	assert.doesNotMatch(status.stdout, new RegExp(`run:${foreign.runId}`));
	assert.doesNotMatch(status.stdout, new RegExp(`run:${current.runId}`));
	assert.match(status.stdout, /no single validated active run/);

	const result = spawnSync("bash", [path.join(repoRoot, "scripts/abort.sh")], {
		cwd: current.repo,
		env,
		encoding: "utf8",
	});
	assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
	for (const [label, run] of [
		["current", current],
		["foreign", foreign],
	]) {
		assert.ok(fs.existsSync(run.wt(1)), `${label} worktree survives`);
	}
	assert.ok(fs.existsSync(currentHint), "current live generation survives");
	assert.ok(
		fs.existsSync(path.join(foreign.sdir, "run-w9.json")),
		"foreign workspace hint survives",
	);
	assert.equal(
		fs.existsSync(path.join(foreign.sdir, `archived-${foreign.runId}.json`)),
		false,
	);
	assert.equal(
		fs.existsSync(path.join(foreign.sdir, `archived-${current.runId}.json`)),
		false,
	);
	assert.doesNotMatch(h.log(), /worktree remove/);
});

test("repository identity makes workspace aliases share one lock and discover the same active run", () => {
	const run = mkRun();
	const source = path.join(run.sdir, "run-w9.json");
	const other = path.join(run.sdir, "run-w2.json");
	fs.renameSync(source, other);
	const lockA = h.runLib(
		`repo_mutation_lock_name ${JSON.stringify(run.repo)}`,
		run.env,
	);
	const lockB = h.runLib(
		`repo_mutation_lock_name ${JSON.stringify(run.repo)}`,
		{ ...run.env, HERDR_WORKSPACE_ID: "w2" },
	);
	assert.equal(lockA.status, 0, lockA.stderr);
	assert.equal(
		lockA.stdout,
		lockB.stdout,
		"workspace ids cannot partition the repo lock",
	);
	const active = h.runLib(
		`export SWARM_REPO=${JSON.stringify(run.repo)}; preflight_check_active_run`,
		{ ...run.env, HERDR_WORKSPACE_ID: "another-workspace" },
		{ sources: ["scripts/preflight.sh"] },
	);
	assert.equal(active.status, 17, active.stderr);
	assert.match(active.stderr, /another workspace/);
});

test("a stale foreign legacy archive is quarantined without bricking this repository", () => {
	const run = mkRun();
	const stale = {
		run_id: "stale-foreign",
		repo_root: "/a/repository/that/no/longer/exists",
		base_ref: "refs/heads/main",
		fork_sha: "a".repeat(40),
		created_at: "2026-01-01T00:00:00Z",
		exclude_pattern_added: false,
		slots: [{ slot: 1, branch: "swarm/stale-foreign/s1", status: "archived" }],
	};
	fs.writeFileSync(
		path.join(run.sdir, "archived-stale-foreign.json"),
		JSON.stringify(stale),
	);
	const scan = h.runLib(`bookkeeping_scan ${JSON.stringify(run.repo)}`, run.env);
	assert.equal(scan.status, 0, scan.stderr);
	const parsed = JSON.parse(scan.stdout);
	assert.deepEqual(parsed.errors, []);
	assert.equal(parsed.quarantined.length, 1);
	assert.match(parsed.quarantined[0].reason, /cannot be resolved/);
	assert.equal(parsed.live[0].run_id, run.runId);
});

test("corrupt or symlinked archived bookkeeping refuses all prune deletion", () => {
	for (const kind of ["corrupt", "symlink"]) {
		const run = mkRun({ status: "archived" });
		fs.rmSync(run.wt(1), { recursive: true, force: true });
		h.git(run.repo, "worktree", "prune");
		const live = path.join(run.sdir, "run-w9.json");
		fs.renameSync(live, path.join(run.sdir, `archived-${run.runId}.json`));
		const unknown = path.join(run.sdir, `archived-bad-${kind}.json`);
		if (kind === "corrupt") fs.writeFileSync(unknown, "{truncated");
		else
			fs.symlinkSync(
				path.join(run.sdir, `archived-${run.runId}.json`),
				unknown,
			);
		h.git(
			run.repo,
			"update-ref",
			`refs/swarm-backups/${run.runId}/1`,
			run.fork,
		);
		const result = spawnSync(
			"bash",
			[path.join(repoRoot, "scripts/prune.sh")],
			{
				cwd: run.repo,
				env: {
					...run.env,
					HERDR_SWARM_PRUNE_CONFIRM: "yes",
					HERDR_SWARM_PRUNE_BACKUPS: "yes",
				},
				encoding: "utf8",
			},
		);
		assert.equal(
			result.status,
			3,
			`${kind}: ${result.stdout}\n${result.stderr}`,
		);
		assert.match(result.stderr, /bookkeeping_unknown/);
		assert.match(
			h.git(
				run.repo,
				"for-each-ref",
				"--format=%(refname)",
				"refs/swarm-backups",
			).stdout,
			new RegExp(run.runId),
			`${kind}: backup survives`,
		);
	}
});

test("multiple live manifests fail closed and protect every live-run backup", () => {
	const run = mkRun();
	const second = JSON.parse(
		fs.readFileSync(path.join(run.sdir, "run-w9.json"), "utf8"),
	);
	second.run_id = `${run.runId}b`;
	second.slots[0].branch = `swarm/${second.run_id}/s1`;
	fs.writeFileSync(
		path.join(run.sdir, "run-w2.json"),
		JSON.stringify(second, null, 2),
	);
	for (const id of [run.runId, second.run_id]) {
		h.git(run.repo, "update-ref", `refs/swarm-backups/${id}/1`, run.fork);
	}
	const result = spawnSync("bash", [path.join(repoRoot, "scripts/prune.sh")], {
		cwd: run.repo,
		env: { ...run.env, HERDR_SWARM_PRUNE_BACKUPS: "yes" },
		encoding: "utf8",
	});
	assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stderr, /multiple live manifests/);
	const refs = h.git(
		run.repo,
		"for-each-ref",
		"--format=%(refname)",
		"refs/swarm-backups",
	).stdout;
	assert.ok(refs.includes(run.runId));
	assert.ok(refs.includes(second.run_id));
});

test("finalization retries safely after every journaled step and never duplicates completion", () => {
	for (const seam of [
		"after-complete",
		"after-exclude",
		"after-index",
		"after-archive",
	]) {
		const run = mkRun({ status: "archived" });
		fs.rmSync(run.wt(1), { recursive: true, force: true });
		h.git(run.repo, "worktree", "prune");
		const command = `export SWARM_REPO=${JSON.stringify(run.repo)}; finalize_run ${JSON.stringify(run.repo)} ${JSON.stringify(run.runId)}`;
		const crashed = h.runLib(
			command,
			{ ...run.env, HERDR_SWARM_TEST_FAIL_FINALIZE_STEP: seam },
			{ sources: ["scripts/preflight.sh"] },
		);
		assert.equal(
			crashed.status,
			99,
			`${seam}: ${crashed.stdout}\n${crashed.stderr}`,
		);
		const retry = h.runLib(command, run.env, {
			sources: ["scripts/preflight.sh"],
		});
		assert.equal(retry.status, 0, `${seam}: ${retry.stdout}\n${retry.stderr}`);
		const archive = path.join(run.sdir, `archived-${run.runId}.json`);
		const doc = JSON.parse(fs.readFileSync(archive, "utf8"));
		assert.equal(doc.completion_events.length, 1, seam);
		assert.equal(
			fs
				.readdirSync(run.sdir)
				.filter((name) => name === `archived-${run.runId}.json`).length,
			1,
			seam,
		);
	}
});
