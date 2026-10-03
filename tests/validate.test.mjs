import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHarness, makeFannedOutRun, commitIn, mkdtemp } from "./harness.mjs";
import { HarvestRenderer } from "../bin/renderer-harvest.mjs";

const h = createHarness();
h.writeHerdrStub();

// A run with one committed slot and a config dir holding `hookBody` as
// validate.sh. Real git throughout; validate never calls herdr.
function fixture(hookBody, env = {}) {
	const run = makeFannedOutRun(h, { prefix: "vd" });
	const sha = commitIn(run.wt(1), "change.txt");
	const cfg = mkdtemp("hs-vcfg-");
	if (hookBody !== null) fs.writeFileSync(path.join(cfg, "validate.sh"), hookBody);
	Object.assign(run.env, { HERDR_PLUGIN_CONFIG_DIR: cfg }, env);
	const resultFile = path.join(run.sdir, `validation-${run.runId}-s1.json`);
	return {
		...run, sha, cfg, resultFile,
		step: (verb = "validate", extra = {}) => h.runScript("harvest-step.sh", [verb, "1"], { ...run.env, ...extra }),
		result: () => JSON.parse(fs.readFileSync(resultFile, "utf8")),
		log: () => fs.readFileSync(path.join(run.sdir, `validation-${run.runId}-s1.log`), "utf8"),
	};
}

function validated(r) {
	assert.equal(r.status, 0, r.stderr);
	const line = r.stdout.split("\n").find((l) => l.startsWith("validated\t"));
	assert.ok(line, r.stdout);
	const [, slot, sha, status, file] = line.split("\t");
	return { slot, sha, status, file };
}

test("passing hook runs in the slot worktree and records SHA-bound typed checks", () => {
	const run = fixture(`
echo "cwd=$(pwd -P) slot=$HERDR_SWARM_SLOT run=$HERDR_SWARM_RUN_ID sha=$HERDR_SWARM_HEAD_SHA"
printf 'unit-tests passed\\nlint   passed\\n' >> "$HERDR_SWARM_CHECKS_FILE"
`);
	const out = validated(run.step());
	assert.deepEqual([out.slot, out.sha, out.status, out.file], ["1", run.sha, "passed", run.resultFile]);
	const result = run.result();
	assert.equal(result.schema_version, 1);
	assert.equal(result.kind, "herdr-swarm-validation");
	assert.equal(result.run_id, run.runId);
	assert.equal(result.slot, 1);
	assert.equal(result.head_sha, run.sha);
	assert.equal(result.timed_out, false);
	assert.deepEqual(result.checks, [
		{ name: "unit-tests", status: "passed" },
		{ name: "lint", status: "passed" },
		{ name: "validate", status: "passed" },
	]);
	assert.equal(fs.statSync(run.resultFile).mode & 0o777, 0o600);
	const wt = fs.realpathSync(run.wt(1));
	assert.match(run.log(), new RegExp(`cwd=${wt} slot=1 run=${run.runId} sha=${run.sha}`));
	// Hook output goes to the log, never into the key<TAB>value protocol.
	assert.doesNotMatch(run.step().stdout, /cwd=/);
});

test("failing hook is a recorded result, not a refusal", () => {
	const run = fixture("printf 'unit-tests failed\\n' >> \"$HERDR_SWARM_CHECKS_FILE\"\nexit 3\n");
	const out = validated(run.step());
	assert.equal(out.status, "failed");
	assert.equal(run.result().exit_code, 3);
	assert.deepEqual(run.result().checks.map((c) => c.status), ["failed", "failed"]);
});

test("exit 0 with a failed named check still fails overall", () => {
	const run = fixture("printf 'e2e failed\\n' >> \"$HERDR_SWARM_CHECKS_FILE\"\n");
	assert.equal(validated(run.step()).status, "failed");
	assert.deepEqual(run.result().checks, [
		{ name: "e2e", status: "failed" },
		{ name: "validate", status: "passed" },
	]);
});

test("malformed, duplicate, or reserved check lines fail the result rather than being trusted", () => {
	for (const lines of ["Bad Name passed", "tests passed\\ntests passed", "validate passed", "tests maybe"]) {
		const run = fixture(`printf '${lines}\\n' >> "$HERDR_SWARM_CHECKS_FILE"\n`);
		const r = run.step();
		assert.equal(validated(r).status, "failed", lines);
		assert.deepEqual(run.result().checks, [{ name: "validate", status: "failed" }], lines);
		assert.match(r.stderr, /recorded as failed/);
	}
});

test("no validate.sh is a loud refusal naming the fix", () => {
	const run = fixture(null);
	const r = run.step();
	assert.equal(r.status, 36);
	assert.match(r.stderr, /no validate\.sh/);
	assert.equal(fs.existsSync(run.resultFile), false);
});

test("dirty slot refuses before the hook runs", () => {
	const run = fixture("touch \"$HERDR_SWARM_CHECKS_FILE.ran\"\n");
	fs.writeFileSync(path.join(run.wt(1), "scratch.txt"), "uncommitted\n");
	const r = run.step();
	assert.equal(r.status, 36);
	assert.match(r.stderr, /uncommitted changes/);
	assert.equal(fs.existsSync(run.resultFile), false);
	assert.equal(fs.existsSync(path.join(run.sdir, `validation-${run.runId}-s1.log`)), false);
});

test("a hook that leaves untracked files is not recorded", () => {
	const run = fixture("echo build > out.txt\n");
	const r = run.step();
	assert.equal(r.status, 36);
	assert.match(r.stderr, /changed while validate\.sh ran/);
	assert.equal(fs.existsSync(run.resultFile), false);
});

test("a commit landing during validation is drift, not a stale pass", () => {
	const run = fixture("echo more > more.txt && git add more.txt && git commit -q -m more\n");
	const r = run.step();
	assert.equal(r.status, 30);
	assert.match(r.stderr, /moved from/);
	assert.equal(fs.existsSync(run.resultFile), false);
});

test("the repo lock is released while the hook runs", () => {
	const run = fixture(`
if ls -d "$HERDR_PLUGIN_STATE_DIR"/lock-* >/dev/null 2>&1; then echo locked; exit 1; fi
`);
	assert.equal(validated(run.step()).status, "passed", run.log());
});

test("timeout kills the hook's whole process group and records a failure", () => {
	const marker = path.join(mkdtemp("hs-vpid-"), "child.pid");
	const run = fixture(`sleep 30 &\necho $! > "${marker}"\nwait\n`, { HERDR_SWARM_VALIDATE_TIMEOUT: "1" });
	const r = run.step();
	const out = validated(r);
	assert.equal(out.status, "failed");
	assert.equal(run.result().timed_out, true);
	assert.match(r.stderr, /exceeded 1s/);
	const pid = Number(fs.readFileSync(marker, "utf8"));
	assert.throws(() => process.kill(pid, 0), /ESRCH/, "background child outlived the timeout");
});

test("a background process the hook leaves behind is reaped when it exits", () => {
	const marker = path.join(mkdtemp("hs-vbg-"), "child.pid");
	const run = fixture(`sleep 30 &\necho $! > "${marker}"\nexit 0\n`);
	assert.equal(validated(run.step()).status, "passed");
	const pid = Number(fs.readFileSync(marker, "utf8"));
	assert.throws(() => process.kill(pid, 0), /ESRCH/, "leftover child outlived validate");
});

// Start validate in the background, wait for the hook to be running, and
// hand back the child plus the hook's sleeping grandchild pid.
async function startValidate(run, marker) {
	const child = spawn("bash", [path.join(import.meta.dirname, "..", "scripts", "harvest-step.sh"), "validate", "1"],
		{ env: run.env, stdio: ["ignore", "pipe", "pipe"] });
	const done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
	for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await delay(100);
	assert.ok(fs.existsSync(marker), "hook never started");
	return { child, done, pid: () => Number(fs.readFileSync(marker, "utf8")) };
}

for (const signal of ["SIGHUP", "SIGTERM"]) {
	test(`${signal} mid-hook reaps the hook's group, records nothing, and frees the slot`, async () => {
		const marker = path.join(mkdtemp("hs-vsig-"), "child.pid");
		const run = fixture(`sleep 30 &\necho $! > "${marker}"\nwait\n`);
		const v = await startValidate(run, marker);
		v.child.kill(signal);
		const { code } = await v.done;
		assert.equal(code, 143);
		await delay(300);
		assert.throws(() => process.kill(v.pid(), 0), /ESRCH/, `hook child survived ${signal}`);
		assert.equal(fs.existsSync(run.resultFile), false);
		assert.deepEqual(fs.readdirSync(run.sdir).filter((f) => /^(lock-|validating-|validation-checks)/.test(f)), []);
	});
}

test("a second validate of the same slot is refused while one is running", async () => {
	const marker = path.join(mkdtemp("hs-vdup-"), "child.pid");
	const run = fixture(`sleep 30 &\necho $! > "${marker}"\nwait\n`);
	const v = await startValidate(run, marker);
	const second = run.step();
	assert.equal(second.status, 36);
	assert.match(second.stderr, /already being validated/);
	v.child.kill("SIGTERM");
	await v.done;
});

test("a planted default-path file that is not Swarm's record for this run and slot is invalid", () => {
	const run = fixture("true\n");
	const status = () => JSON.parse(run.step("candidate-status").stdout.split("\n")
		.find((l) => l.startsWith("candidate_status\t")).slice("candidate_status\t".length));
	const base = { schema_version: 1, kind: "herdr-swarm-validation", run_id: run.runId, slot: 1, head_sha: run.sha,
		checks: [{ name: "validate", status: "passed" }] };
	for (const forged of [
		{ ...base, kind: undefined },
		{ ...base, run_id: "other-run" },
		{ ...base, slot: 2 },
		{ ...base, checks: [{ name: "tests", status: "passed" }] },
	]) {
		fs.writeFileSync(run.resultFile, JSON.stringify(forged));
		assert.equal(status().validation_status, "invalid", JSON.stringify(forged));
	}
	fs.writeFileSync(run.resultFile, JSON.stringify(base));
	assert.equal(status().validation_status, "passed");
	// The identity rule binds only the default file: an explicit file with an
	// inherited marker is still judged as ordinary supplied evidence.
	const explicit = path.join(run.sdir, "explicit.json");
	fs.writeFileSync(explicit, JSON.stringify({ schema_version: 1, head_sha: run.sha, checks: [{ name: "tests", status: "passed" }] }));
	const r = run.step("candidate-status", { HERDR_SWARM_CANDIDATE_VALIDATION_FILE: explicit, HERDR_SWARM_CANDIDATE_VALIDATION_PRODUCED: "1" });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /"validation_status":"passed"/);
});

test("invalid timeout refuses", () => {
	const run = fixture("true\n", { HERDR_SWARM_VALIDATE_TIMEOUT: "soon" });
	assert.equal(run.step().status, 36);
});

test("harvest pane drives the real verb end to end", async () => {
	const run = fixture("printf 'unit-tests passed\\n' >> \"$HERDR_SWARM_CHECKS_FILE\"\n");
	const renderer = new HarvestRenderer(run.env);
	renderer.paint = () => {};
	renderer.write = () => {};
	renderer.rows = [{ slot: 1 }];
	await renderer.onKey("v");
	await renderer.onKey("1");
	assert.equal(renderer.banner, `slot 1 validation passed @ ${run.sha.slice(0, 7)}`);
	assert.equal(run.result().head_sha, run.sha);
});

test("strict candidate status reads the Swarm-produced result, goes stale on a new commit, and explicit files win", () => {
	const run = fixture("printf 'unit-tests passed\\n' >> \"$HERDR_SWARM_CHECKS_FILE\"\n");
	const status = () => {
		const r = run.step("candidate-status");
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout.split("\n").find((l) => l.startsWith("candidate_status\t")).slice("candidate_status\t".length));
	};
	assert.equal(status().validation_status, "missing");
	validated(run.step());
	assert.equal(status().validation_status, "passed");
	assert.ok(!status().issues.some((i) => i.startsWith("validation_")));

	const explicit = path.join(run.sdir, "explicit.json");
	fs.writeFileSync(explicit, JSON.stringify({ schema_version: 1, head_sha: run.sha, checks: [{ name: "tests", status: "failed" }] }));
	const r = run.step("candidate-status", { HERDR_SWARM_CANDIDATE_VALIDATION_FILE: explicit });
	assert.match(r.stdout, /"validation_status":"failed"/);

	commitIn(run.wt(1), "next.txt");
	assert.equal(status().validation_status, "stale");
});
