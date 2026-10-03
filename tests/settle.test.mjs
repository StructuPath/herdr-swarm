import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHarness, makeFannedOutRun, commitIn, mkdtemp } from "./harness.mjs";
import { Renderer } from "../bin/renderer-status.mjs";
import { reconcileSlots } from "../bin/renderer-shared.mjs";

const h = createHarness();
h.writeHerdrStub();

// A fanned-out run on the 0.7.5+ path (plugin-reported agent state), with
// created_at set `ageSeconds` in the past so the exit grace is controllable.
function fixture({ slots = 1, ageSeconds = 3600, env = {} } = {}) {
	const run = makeFannedOutRun(h, { prefix: "st", slots });
	const file = path.join(run.sdir, "run-w9.json");
	const doc = JSON.parse(fs.readFileSync(file, "utf8"));
	doc.created_at = new Date(Date.now() - ageSeconds * 1000).toISOString();
	fs.writeFileSync(file, JSON.stringify(doc, null, 2));
	Object.assign(run.env, { STUB_HERDR_VERSION: "0.8.2" }, env);
	return {
		...run,
		settle: (extra = {}) => h.runScript("harvest-step.sh", ["settle"], { ...run.env, ...extra }),
	};
}

function records(r, key) {
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.split("\n").filter((l) => l.startsWith(`${key}\t`)).map((l) => l.split("\t").slice(1));
}

const calls = () => fs.readFileSync(h.logFile, "utf8");

test("the finish marker settles a slot once: recorded, reported idle, never repeated", () => {
	const run = fixture();
	fs.writeFileSync(h.logFile, "");
	fs.writeFileSync(path.join(run.wt(1), ".swarm-done"), "");
	assert.deepEqual(records(run.settle(), "settled"), [["1", "marker"]]);
	const row = run.slotRow(1);
	assert.equal(row.status, "running", "the harvest state machine is untouched");
	assert.equal(row.finished.reason, "marker");
	assert.match(row.finished.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
	assert.match(calls(), /pane report-agent w11:p1 --source structupath\.swarm --agent claude --state idle/);
	fs.writeFileSync(h.logFile, "");
	assert.deepEqual(records(run.settle(), "settled"), []);
	assert.doesNotMatch(calls(), /report-agent/);
});

const SHELL = { STUB_PANE_FG: "shell" };
const BUSY = { STUB_PANE_FG: "busy" };

test("an exited argv settles only after a busy sighting and two consecutive bare-shell readings", () => {
	const run = fixture();
	assert.deepEqual(records(run.settle(BUSY), "settled"), []);
	assert.equal(run.slotRow(1).seen_running, true);
	assert.deepEqual(records(run.settle(SHELL), "settled"), [], "one shell reading is not enough");
	assert.equal(run.slotRow(1).shell_pending, true);
	// A busy reading in between (agent restarting) resets the count.
	assert.deepEqual(records(run.settle(BUSY), "settled"), []);
	assert.equal(run.slotRow(1).shell_pending, null);
	assert.deepEqual(records(run.settle(SHELL), "settled"), []);
	assert.deepEqual(records(run.settle(SHELL), "settled"), [["1", "exited"]]);
	assert.equal(run.slotRow(1).finished.reason, "exited");
	assert.equal(run.slotRow(1).shell_pending, null);
});

test("a bare shell never seen busy is no evidence, however old the run (slow fan-out race)", () => {
	const run = fixture({ ageSeconds: 3600 });
	for (let i = 0; i < 3; i++) assert.deepEqual(records(run.settle(SHELL), "settled"), []);
	assert.equal(run.slotRow(1).finished, undefined);
});

test("exited is reversible: a busy pane resumes the slot and reports it working again", () => {
	const run = fixture();
	run.settle(BUSY);
	run.settle(SHELL);
	assert.deepEqual(records(run.settle(SHELL), "settled"), [["1", "exited"]]);
	fs.writeFileSync(h.logFile, "");
	assert.deepEqual(records(run.settle(BUSY), "resumed"), [["1"]]);
	assert.equal(run.slotRow(1).finished, null);
	assert.match(calls(), /pane report-agent w11:p1 --source structupath\.swarm --agent claude --state working/);
	// …and can finish again later.
	run.settle(SHELL);
	assert.deepEqual(records(run.settle(SHELL), "settled"), [["1", "exited"]]);
});

test("the marker is final, and firms up an earlier exited without re-triggering", () => {
	const run = fixture();
	run.settle(BUSY);
	run.settle(SHELL);
	run.settle(SHELL);
	fs.writeFileSync(path.join(run.wt(1), ".swarm-done"), "");
	const r = run.settle(BUSY);
	assert.deepEqual(records(r, "settled"), []);
	assert.deepEqual(records(r, "resumed"), []);
	assert.equal(run.slotRow(1).finished.reason, "marker");
	assert.deepEqual(records(run.settle(BUSY), "resumed"), [], "a marker-finished slot is never resumed");
});

test("unknown foreground (older herdr, closed pane) is never evidence", () => {
	const run = fixture();
	run.settle(BUSY);
	assert.deepEqual(records(run.settle(), "settled"), []);
	assert.deepEqual(records(run.settle(), "settled"), []);
	assert.equal(run.slotRow(1).finished, undefined);
	const fresh = fixture();
	assert.deepEqual(records(fresh.settle(), "settled"), []);
	assert.equal(fresh.slotRow(1).seen_running, undefined);
});

test("only running slots are considered", () => {
	const run = makeFannedOutRun(h, { prefix: "st", status: "merged" });
	fs.writeFileSync(path.join(run.wt(1), ".swarm-done"), "");
	const r = h.runScript("harvest-step.sh", ["settle"], run.env);
	assert.deepEqual(records(r, "settled"), []);
	assert.equal(run.slotRow(1).finished, undefined);
});

test("one notification when every running slot has finished, never before and never twice", () => {
	const run = fixture({ slots: 2 });
	fs.writeFileSync(h.logFile, "");
	fs.writeFileSync(path.join(run.wt(1), ".swarm-done"), "");
	assert.deepEqual(records(run.settle(), "notified"), []);
	assert.doesNotMatch(calls(), /notification show/);
	fs.writeFileSync(path.join(run.wt(2), ".swarm-done"), "");
	assert.deepEqual(records(run.settle(), "notified"), [["2"]]);
	assert.match(calls(), /notification show Swarm: all 2 slots finished --body Run st\d+ is ready to compare in Harvest\. --sound done/);
	assert.match(run.manifest().finish_notified, /Z$/);
	fs.writeFileSync(h.logFile, "");
	assert.deepEqual(records(run.settle(), "notified"), []);
	assert.doesNotMatch(calls(), /notification show/);
});

test("settle never marks a row whose ownership fails", () => {
	const run = fixture();
	const file = path.join(run.sdir, "run-w9.json");
	const doc = JSON.parse(fs.readFileSync(file, "utf8"));
	// A real directory that is NOT a worktree on the slot's branch, holding a
	// marker: ownership (verify_slot_ownership) must fail before it is read.
	const foreign = mkdtemp("hs-foreign-");
	fs.writeFileSync(path.join(foreign, ".swarm-done"), "");
	doc.slots[0].path = foreign;
	fs.writeFileSync(file, JSON.stringify(doc, null, 2));
	assert.deepEqual(records(run.settle(), "settled"), []);
	assert.equal(run.slotRow(1).finished, undefined);
});

for (const [how, env, file] of [
	["env flag", { HERDR_SWARM_AUTO_VALIDATE: "1" }, false],
	["config-dir file", {}, true],
]) {
	test(`auto-validate (${how}) runs validate detached once the slot settles`, async () => {
		const cfg = mkdtemp("hs-scfg-");
		fs.writeFileSync(path.join(cfg, "validate.sh"), "printf 'unit-tests passed\\n' >> \"$HERDR_SWARM_CHECKS_FILE\"\n");
		if (file) fs.writeFileSync(path.join(cfg, "auto-validate"), "");
		const run = fixture({ env: { HERDR_PLUGIN_CONFIG_DIR: cfg, ...env } });
		const sha = commitIn(run.wt(1), "change.txt");
		fs.writeFileSync(path.join(run.wt(1), ".swarm-done"), "");
		assert.deepEqual(records(run.settle(), "auto_validate"), [["1"]]);
		const result = path.join(run.sdir, `validation-${run.runId}-s1.json`);
		for (let i = 0; i < 100 && !fs.existsSync(result); i++) await delay(100);
		const v = JSON.parse(fs.readFileSync(result, "utf8"));
		assert.equal(v.head_sha, sha);
		assert.equal(v.status, "passed");
	});
}

test("auto-validate stays off without the opt-in, even with validate.sh present", () => {
	const cfg = mkdtemp("hs-scfg-");
	fs.writeFileSync(path.join(cfg, "validate.sh"), "true\n");
	const run = fixture({ env: { HERDR_PLUGIN_CONFIG_DIR: cfg } });
	fs.writeFileSync(path.join(run.wt(1), ".swarm-done"), "");
	const r = run.settle();
	assert.deepEqual(records(r, "settled"), [["1", "marker"]]);
	assert.deepEqual(records(r, "auto_validate"), []);
});

test("status rows show finished, but blocked stays loud", () => {
	const slots = [
		{ slot: 1, status: "running", terminal_id: "t1", finished: { at: "x", reason: "marker" } },
		{ slot: 2, status: "running", terminal_id: "t2", finished: { at: "x", reason: "exited" } },
		{ slot: 3, status: "running", terminal_id: "t3" },
		{ slot: 4, status: "merged", finished: { at: "x", reason: "marker" } },
	];
	const agents = [
		{ terminal_id: "t1", agent_status: "working" },
		{ terminal_id: "t2", agent_status: "blocked" },
		{ terminal_id: "t3", agent_status: "working" },
	];
	assert.deepEqual(reconcileSlots(slots, agents, {}).map((r) => r.state), ["finished", "blocked", "working", "merged"]);
});

test("the status pane runs settle out of process, throttled, and survives its failure", async () => {
	const dir = mkdtemp("hs-sfake-");
	const out = path.join(dir, "calls");
	const script = path.join(dir, "fake-step.sh");
	fs.writeFileSync(script, `echo "$1" >> "${out}"\nexit 1\n`);
	const r = new Renderer(h.freshEnv({ HERDR_SWARM_SETTLE_SCRIPT: script, HERDR_SWARM_SETTLE_INTERVAL_MS: "5000" }));
	await r.maybeSettle(100_000);
	await r.maybeSettle(101_000);
	assert.deepEqual(fs.readFileSync(out, "utf8").split("\n").filter(Boolean), ["settle"], "throttled to one call per interval");
	await r.maybeSettle(106_000);
	assert.equal(fs.readFileSync(out, "utf8").split("\n").filter(Boolean).length, 2);
	// Without the script (direct/test invocation) nothing is spawned.
	const bare = new Renderer(h.freshEnv());
	assert.equal(bare.settleScript, null);
	await bare.maybeSettle(1e9);
});

test("a settle blocked on the repo lock never stalls the status paint, and never overlaps itself", async () => {
	const dir = mkdtemp("hs-sslow-");
	const out = path.join(dir, "calls");
	const script = path.join(dir, "slow-step.sh");
	fs.writeFileSync(script, `echo "$1" >> "${out}"\nsleep 3\n`);
	const r = new Renderer(h.freshEnv({ HERDR_SWARM_SETTLE_SCRIPT: script, HERDR_SWARM_SETTLE_INTERVAL_MS: "1000" }));
	r.manifestFile = path.join(dir, "absent.json");
	let painted = 0;
	r.paint = () => { painted++; };
	const started = Date.now();
	await r.tick();
	assert.ok(Date.now() - started < 1500, "tick waited on settle");
	assert.equal(painted, 1);
	await delay(1200);
	await r.tick();
	assert.equal(painted, 2);
	await r.settling;
	assert.equal(fs.readFileSync(out, "utf8").split("\n").filter(Boolean).length, 1, "no second settle while one is in flight");
});
