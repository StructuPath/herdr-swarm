import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHarness, makeFannedOutRun, commitIn, mkdtemp } from "./harness.mjs";
import { ciSummary, validationEvidence } from "../scripts/pr-handoff.mjs";
import { HarvestRenderer, renderHarvest } from "../bin/renderer-harvest.mjs";

const h = createHarness();
h.writeHerdrStub();
h.writeGithubStub();

function fixture() {
	const run = makeFannedOutRun(h, { prefix: "pr" });
	const sha = commitIn(run.wt(1), "change.txt");
	const bare = path.join(mkdtemp("hs-pr-remote-"), "remote.git");
	h.git(run.repo, "init", "-q", "--bare", bare);
	h.git(run.repo, "remote", "add", "origin", "https://github.com/example/project.git");
	// Only route the push transport to a local bare repository. Every Git
	// operation, including ancestry, refs, and worktree ownership, remains real.
	h.writeStub("git", `
args=("$@")
if [ "\${args[2]-}" = push ]; then
  printf 'git-push %s\\n' "\${args[*]}" >> "$STUB_LOG"
  if [ "\${STUB_PUSH_FAIL:-}" = yes ]; then exit 1; fi
  args[3]="$STUB_BARE_REMOTE"
fi
exec /usr/bin/git "\${args[@]}"
`);
	const state = path.join(run.sdir, "github.json");
	fs.writeFileSync(state, JSON.stringify({ repository: "example/project", branch: run.branch(1), base: "main", sha, prs: [] }));
	Object.assign(run.env, { STUB_GITHUB_STATE: state, STUB_BARE_REMOTE: bare });
	return { ...run, sha, bare, state,
		data: () => JSON.parse(fs.readFileSync(state, "utf8")),
		patch: (patch) => fs.writeFileSync(state, JSON.stringify({ ...JSON.parse(fs.readFileSync(state, "utf8")), ...patch })),
		step: (verb, env = {}) => h.runScript("harvest-step.sh", [verb, "1"], { ...run.env, ...env }),
	};
}

function output(result, key) {
	assert.equal(result.status, 0, result.stderr);
	const line = result.stdout.split("\n").find(value => value.startsWith(`${key}\t`));
	assert.ok(line, result.stdout);
	return JSON.parse(line.slice(key.length + 1));
}

test("draft handoff publishes audited commit, reports not-run evidence, and reuses exact PR without editing", () => {
	const run = fixture();
	const first = output(run.step("publish-pr"), "pull_request");
	assert.equal(first.reused, false);
	assert.equal(first.draft, true);
	assert.equal(first.validation.checks[0].status, "not_run");
	assert.equal(h.git(run.repo, "--git-dir", run.bare, "rev-parse", run.branch(1)).stdout.trim(), run.sha);
	const body = run.data().body;
	assert.match(body, /not_run/);
	assert.doesNotMatch(body, /\.swarm-task|\/Users\/|\/tmp\//);
	const next = output(run.step("publish-pr"), "pull_request");
	assert.equal(next.reused, true);
	assert.equal(next.validation_attached, false);
	assert.equal(run.data().body, body);
	const log = fs.readFileSync(h.logFile, "utf8");
	assert.equal(log.split('\n').filter(line => line.includes('"create"')).length, 1);
	assert.doesNotMatch(log, /--force|"merge"|"edit"/);
});

test("typed validation publishes only whitelisted names/statuses and rejects stale evidence before push", () => {
	const run = fixture();
	const file = path.join(run.sdir, "validation.json");
	fs.writeFileSync(file, JSON.stringify({ schema_version: 1, head_sha: run.fork, checks: [{ name: "tests", status: "passed" }] }));
	let result = run.step("publish-pr", { HERDR_SWARM_VALIDATION_FILE: file });
	assert.equal(result.status, 36);
	assert.doesNotMatch(h.log(), /git-push/);
	fs.writeFileSync(file, JSON.stringify({ schema_version: 1, head_sha: run.sha, logs: "SECRET_TOKEN=/private/path", checks: [{ name: "tests", status: "failed", output: "SECRET_TOKEN" }] }));
	result = run.step("publish-pr", { HERDR_SWARM_VALIDATION_FILE: file });
	assert.equal(output(result, "pull_request").validation.checks[0].status, "failed");
	assert.match(run.data().body, /tests: \*\*failed\*\*/);
	assert.doesNotMatch(run.data().body, /SECRET_TOKEN|private\/path/);
});

test("Browser QA evidence binds clean unchanged HEAD and never copies browser URLs or logs", () => {
	const run = fixture();
	const file = path.join(run.sdir, "qa.json");
	const report = { schemaVersion: 1, kind: "herdr-browser-qa", status: "passed", git: { commit: run.sha, dirty: false, changedDuringRun: false }, scenario: { policy: { failOnConsoleError: true, failOnPageError: true, failOnFailedRequest: true } }, cleanup: { status: "passed" }, summary: { viewports: 2, passed: 2, failed: 0, assertions: 8, consoleErrors: 0, pageErrors: 0, failedRequests: 0 }, runs: [0, 1].map(() => ({ status: "passed", steps: Array.from({ length: 4 }, (_, index) => ({ index, type: "assertVisible", status: "passed" })), consoleErrors: [], pageErrors: [], failedRequests: [], unresolvedRequests: 0, url: "https://private.invalid/secret" })) };
	for (const mutate of [
		value => { value.runs[0].status = "failed"; },
		value => { value.runs = []; },
		value => { value.runs.pop(); },
		value => { value.summary.assertions++; },
	]) {
		const invalid = structuredClone(report); mutate(invalid);
		fs.writeFileSync(file, JSON.stringify(invalid));
		assert.throws(() => validationEvidence(file, run.sha), /runs/);
	}
	for (const mutate of [
		value => { value.runs[0].steps[0].status = "failed"; },
		value => { value.runs[0].unresolvedRequests = 1; },
		value => { value.runs[0].telemetryError = "incomplete"; },
		value => { value.cleanup.status = "failed"; },
		value => { value.error = "interrupted"; },
	]) {
		const failed = structuredClone(report); mutate(failed);
		fs.writeFileSync(file, JSON.stringify(failed));
		assert.equal(validationEvidence(file, run.sha).checks[0].status, "failed");
	}
	fs.writeFileSync(file, JSON.stringify(report));
	const result = output(run.step("publish-pr", { HERDR_SWARM_VALIDATION_FILE: file }), "pull_request");
	assert.equal(result.validation.source, "browser_qa");
	assert.deepEqual(result.validation.checks, [{ name: "browser-qa", status: "passed" }]);
	assert.doesNotMatch(run.data().body, /private.invalid|secret/);
	for (const git of [{ ...report.git, dirty: true }, { ...report.git, changedDuringRun: true }, { ...report.git, commit: run.fork }]) {
		fs.writeFileSync(file, JSON.stringify({ ...report, git }));
		assert.throws(() => validationEvidence(file, run.sha), /clean, unchanged/);
	}
	fs.writeFileSync(file, JSON.stringify({ ...report, scenario: { policy: { ...report.scenario.policy, failOnPageError: false } } }));
	assert.throws(() => validationEvidence(file, run.sha), /strict error policies/);
});

test("gh authentication, malformed evidence and non-GitHub remotes fail before publication", () => {
	const run = fixture();
	run.patch({ listError: true });
	assert.equal(run.step("publish-pr").status, 36);
	assert.doesNotMatch(h.log(), /git-push/);
	run.patch({ listError: false, malformed: true });
	assert.equal(run.step("publish-pr").status, 36);
	assert.doesNotMatch(h.log(), /git-push/);
	h.git(run.repo, "remote", "set-url", "origin", run.bare);
	assert.equal(run.step("publish-pr").status, 36);
	assert.doesNotMatch(h.log(), /git-push/);
});

test("failed push never creates a PR; create failure leaves published branch retryable without duplicate", () => {
	const run = fixture();
	assert.equal(run.step("publish-pr", { STUB_PUSH_FAIL: "yes" }).status, 36);
	assert.equal(run.data().prs.length, 0);
	run.patch({ createError: true });
	assert.equal(run.step("publish-pr").status, 36);
	assert.equal(run.slotRow(1).published.sha, run.sha);
	assert.equal(run.data().prs.length, 0);
	run.patch({ createError: false, createThenError: true });
	const result = output(run.step("publish-pr"), "pull_request");
	assert.equal(result.reused, true);
	assert.equal(run.data().prs.length, 1);
});

test("read-only CI status distinguishes no PR, no checks, pending, failure and remote head drift", () => {
	const run = fixture();
	assert.equal(output(run.step("pr-status"), "ci_status").status, "no_pr");
	output(run.step("publish-pr"), "pull_request");
	const before = fs.readFileSync(path.join(run.sdir, "run-w9.json"), "utf8");
	fs.writeFileSync(h.logFile, "");
	assert.equal(output(run.step("pr-status"), "ci_status").status, "not_run");
	const pr = run.data().prs[0];
	run.patch({ view: { ...pr, headRefOid: run.fork, statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] } });
	const status = output(run.step("pr-status"), "ci_status");
	assert.equal(status.status, "pending");
	assert.equal(status.matches_local_head, false);
	assert.equal(fs.readFileSync(path.join(run.sdir, "run-w9.json"), "utf8"), before);
	assert.doesNotMatch(h.log(), /git-push|"create"|"edit"|"merge"/);
	assert.equal(ciSummary([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }]), "failed");
	assert.equal(ciSummary([{ __typename: "StatusContext", state: "SUCCESS" }]), "passed");
	assert.equal(ciSummary([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }]), "not_run");
	assert.equal(ciSummary([{ unrecognized: true }]), "unknown");
});

test("existing closed, ambiguous or foreign identity never becomes a reused handoff", () => {
	const run = fixture();
	output(run.step("publish-pr"), "pull_request");
	const pr = run.data().prs[0];
	run.patch({ prs: [{ ...pr, state: "CLOSED" }] });
	assert.equal(run.step("publish-pr").status, 36);
	run.patch({ prs: [pr, { ...pr, number: 8 }] });
	assert.equal(run.step("publish-pr").status, 36);
	run.patch({ prs: [{ ...pr, headRefOid: "invalid" }] });
	assert.equal(run.step("pr-status").status, 36);
});

test("prepared-head drift and ownership tampering refuse before push", () => {
	const run = fixture();
	const advanced = commitIn(run.wt(1), "later.txt");
	h.git(run.repo, "update-ref", `refs/heads/${run.branch(1)}`, run.sha, advanced);
	run.patch({ advance: { repo: run.repo, ref: `refs/heads/${run.branch(1)}`, sha: advanced } });
	assert.equal(run.step("publish-pr").status, 30);
	assert.doesNotMatch(h.log(), /git-push/);
	const manifest = run.manifest();
	manifest.slots[0].path = run.repo;
	fs.writeFileSync(path.join(run.sdir, "run-w9.json"), JSON.stringify(manifest));
	fs.writeFileSync(h.logFile, "");
	assert.notEqual(run.step("publish-pr").status, 0);
	assert.doesNotMatch(h.log(), /git-push|"gh"/);
});

test("PR head mismatch after create is reported as partial handoff, never as successful evidence", () => {
	const run = fixture();
	run.patch({ sha: run.fork });
	const result = run.step("publish-pr");
	assert.equal(result.status, 36);
	assert.match(result.stderr, /head changed/);
	assert.doesNotMatch(result.stdout, /pull_request\t/);
	assert.equal(run.slotRow(1).published.sha, run.sha);
});

test("handoff pins GitHub host and ignores inherited Git repository/config routing", () => {
	const run = fixture();
	const foreign = h.makeRepo();
	run.patch({ expectedHost: "github.com" });
	const result = run.step("publish-pr", { GH_HOST: "enterprise.invalid", GIT_DIR: path.join(foreign, ".git"), GIT_WORK_TREE: foreign, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.url", GIT_CONFIG_VALUE_0: "https://github.com/foreign/repo.git" });
	assert.equal(output(result, "pull_request").repository, "example/project");
	assert.match(h.log(), /github.com\/example\/project/);
	assert.equal(h.git(foreign, "status", "--porcelain").stdout, "");
});

test("validation files reject symlinks, FIFOs and oversized content without waiting for a writer", () => {
	const directory = mkdtemp("hs-evidence-bounds-");
	const file = path.join(directory, "evidence.json");
	fs.writeFileSync(file, "{}");
	const link = path.join(directory, "link.json");
	fs.symlinkSync(file, link);
	assert.throws(() => validationEvidence(link, "a".repeat(40)));
	const fifo = path.join(directory, "pipe");
	const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
	assert.equal(made.status, 0, made.stderr);
	assert.throws(() => validationEvidence(fifo, "a".repeat(40)), /regular JSON file/);
	fs.writeFileSync(file, "x".repeat(1024 * 1024 + 1));
	assert.throws(() => validationEvidence(file, "a".repeat(40)), /1 MiB/);
	assert.equal(ciSummary([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }]), "not_run");
});

test("harvest pane exposes separate opt-in draft and CI actions without changing push", async () => {
	const renderer = new HarvestRenderer(h.freshEnv());
	renderer.write = () => {};
	renderer.rows = [{ slot: 1 }];
	const verbs = [];
	renderer.step = async (verb) => {
		verbs.push(verb);
		return { code: 0, out: { pull_request: [[JSON.stringify({ url: "https://github.com/example/project/pull/7", reused: false })]], ci_status: [[JSON.stringify({ status: "not_run" })]] } };
	};
	await renderer.onKey("g");
	assert.match(renderHarvest({ phase: renderer.phase, rows: [] }, 100), /GITHUB DRAFT/);
	await renderer.onKey("1");
	await renderer.onKey("c");
	await renderer.onKey("1");
	assert.deepEqual(verbs, ["publish-pr", "pr-status"]);
	assert.match(renderer.banner, /not_run/);
	await renderer.onKey("p");
	assert.equal(renderer.phase.name, "publish-pick");
});
