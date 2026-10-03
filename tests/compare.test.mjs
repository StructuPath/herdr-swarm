import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHarness, makeFannedOutRun, commitIn, mkdtemp } from "./harness.mjs";
import { HarvestRenderer, renderHarvest } from "../bin/renderer-harvest.mjs";

const h = createHarness();
h.writeHerdrStub();

function compare(run) {
	const r = h.runScript("harvest-step.sh", ["compare"], run.env);
	assert.equal(r.status, 0, r.stderr);
	const lines = r.stdout.split("\n").filter(Boolean);
	return {
		r,
		slots: lines.filter((l) => l.startsWith("compare_slot\t")).map((l) => JSON.parse(l.slice("compare_slot\t".length))),
		overlaps: lines.filter((l) => l.startsWith("compare_overlap\t")).map((l) => {
			const [, a, b, n, shared] = l.split("\t");
			return { a: Number(a), b: Number(b), count: Number(n), shared: JSON.parse(shared) };
		}),
	};
}

function writeValidation(run, slot, sha, status, checks = [{ name: "validate", status }]) {
	fs.writeFileSync(path.join(run.sdir, `validation-${run.runId}-s${slot}.json`), JSON.stringify({
		schema_version: 1, kind: "herdr-swarm-validation", run_id: run.runId, slot, head_sha: sha, status, checks,
	}));
}

function setManifest(run, edit) {
	const file = path.join(run.sdir, "run-w9.json");
	const doc = JSON.parse(fs.readFileSync(file, "utf8"));
	edit(doc);
	fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}

test("compare ranks by checks on the current tip, then commits, then finished — never by diff size", () => {
	const run = makeFannedOutRun(h, { prefix: "cm", slots: 4 });
	commitIn(run.wt(1), "a.js", "a\n".repeat(50));
	commitIn(run.wt(1), "shared.js");
	const tip2 = commitIn(run.wt(2), "shared.js", "other\n");
	commitIn(run.wt(3), "c.js");
	const tip3 = commitIn(run.wt(3), "d.js");
	fs.writeFileSync(path.join(run.wt(3), "scratch.txt"), "dirty\n");
	writeValidation(run, 2, tip2, "passed");
	writeValidation(run, 3, tip3, "failed", [{ name: "unit-tests", status: "failed" }, { name: "validate", status: "passed" }]);
	// Slot 4: nothing committed, but finished. Slot 1: validated at an OLD tip.
	writeValidation(run, 1, run.fork, "passed");
	setManifest(run, (d) => { d.slots[3].finished = { at: "x", reason: "marker" }; });

	const { slots, overlaps } = compare(run);
	assert.deepEqual(slots.map((s) => [s.rank, s.slot, s.validation.status]), [
		[1, 2, "passed"],
		[2, 4, "none"],
		[3, 1, "stale"],
		[4, 3, "failed"],
	]);
	const by = Object.fromEntries(slots.map((s) => [s.slot, s]));
	assert.equal(by[1].commits, 2);
	assert.equal(by[1].file_count, 2);
	assert.equal(by[1].insertions, 51);
	assert.equal(by[2].tip, tip2);
	assert.equal(by[3].dirty, 1);
	assert.deepEqual(by[3].validation.failed_checks, ["unit-tests"]);
	assert.equal(by[4].commits, 0);
	assert.equal(by[4].finished, "marker");
	assert.equal(by[1].validation.head_sha, run.fork, "stale names the SHA it was for");
	assert.deepEqual(overlaps.find((o) => o.a === 1 && o.b === 2), { a: 1, b: 2, count: 1, shared: ["shared.js"] });
	assert.equal(overlaps.find((o) => o.a === 1 && o.b === 3).count, 0);
	assert.equal(overlaps.length, 6, "every candidate pair");
});

test("settled slots are listed unranked and kept out of overlaps; archived slots are left out", () => {
	const run = makeFannedOutRun(h, { prefix: "cm", slots: 3 });
	commitIn(run.wt(1), "x.js");
	commitIn(run.wt(2), "x.js", "y\n");
	setManifest(run, (d) => {
		d.slots[1].status = "skipped";
		d.slots[2].status = "archived";
	});
	const { slots, overlaps } = compare(run);
	assert.deepEqual(slots.map((s) => [s.slot, s.rank, s.candidate]), [[1, 1, true], [2, null, false]]);
	assert.deepEqual(overlaps, []);
});

test("a validation file that is not Swarm's record for this run and slot counts as not run", () => {
	const run = makeFannedOutRun(h, { prefix: "cm" });
	const tip = commitIn(run.wt(1), "x.js");
	for (const forged of [{ run_id: "other" }, { slot: 2 }, { kind: "something-else" }, { status: "maybe" }]) {
		fs.writeFileSync(path.join(run.sdir, `validation-${run.runId}-s1.json`), JSON.stringify({
			schema_version: 1, kind: "herdr-swarm-validation", run_id: run.runId, slot: 1, head_sha: tip, status: "passed", checks: [], ...forged,
		}));
		assert.equal(compare(run).slots[0].validation.status, "none", JSON.stringify(forged));
	}
});

test("a row failing its ownership check is left out of compare, loudly", () => {
	const run = makeFannedOutRun(h, { prefix: "cm", slots: 2 });
	setManifest(run, (d) => { d.slots[0].path = mkdtemp("hs-foreign-"); });
	const { r, slots } = compare(run);
	assert.deepEqual(slots.map((s) => s.slot), [2]);
	assert.match(r.stderr, /slot 1 left out of compare/);
});

// --- Harvest pane: compare view and merge-winner, against the real verbs. ---

function pane(run) {
	const renderer = new HarvestRenderer(run.env);
	renderer.write = () => {};
	renderer.paint = () => {};
	return renderer;
}

async function keys(renderer, ...ks) {
	for (const k of ks) await renderer.onKey(k);
}

test("w opens the ranked compare view; d diffs two slot tips through git", async () => {
	const run = makeFannedOutRun(h, { prefix: "cm", slots: 2 });
	const tip1 = commitIn(run.wt(1), "a.js");
	const tip2 = commitIn(run.wt(2), "b.js");
	const r = pane(run);
	await r.refresh();
	const diffs = [];
	r.spawnDiff = (a, b) => diffs.push([a, b]);
	await keys(r, "w");
	assert.equal(r.phase.name, "compare");
	assert.deepEqual(r.phase.slots.map((s) => s.slot), [1, 2]);
	const screen = renderHarvest({ rows: r.rows, phase: r.phase }, 120);
	assert.match(screen, /rank #  checks/);
	assert.match(screen, /overlap: none/);
	await keys(r, "d", "1", "2");
	assert.deepEqual(diffs, [[tip1, tip2]]);
	assert.equal(r.phase.name, "compare");
	await keys(r, "d", "7");
	assert.match(r.banner, /no slot 7/);
	await keys(r, "b");
	assert.equal(r.phase.name, "list");
});

const finishAll = (run, slots) => setManifest(run, (d) => {
	for (const s of slots) d.slots[s - 1].finished = { at: "x", reason: "marker" };
});

test("merge winner: merges the pick, then skips and archives the finished rest, keeping every branch", async () => {
	const run = makeFannedOutRun(h, { prefix: "cm", slots: 3 });
	commitIn(run.wt(1), "one.js");
	const winner = commitIn(run.wt(2), "two.js");
	commitIn(run.wt(3), "three.js");
	finishAll(run, [1, 2, 3]);
	const r = pane(run);
	await r.refresh();
	await keys(r, "w", "m", "2");
	assert.equal(r.phase.name, "winner-confirm");
	assert.deepEqual(r.phase.others, [1, 3]);
	assert.equal(r.phase.tip, winner);
	assert.match(renderHarvest({ rows: r.rows, phase: r.phase }, 140),
		new RegExp(`MERGE slot 2 at ${winner.slice(0, 7)} into your checked-out branch, then SKIP slots 1, 3\\?`));
	await keys(r, "y");
	const ancestor = (sha) => spawnSync("git", ["-C", run.repo, "merge-base", "--is-ancestor", sha, "main"]).status;
	assert.equal(ancestor(winner), 0, "winner landed on base");
	// Every slot settled, so the run itself finalized: rows read from the archive.
	assert.deepEqual([1, 2, 3].map((i) => run.slotRow(i).status), ["archived", "archived", "archived"]);
	assert.equal(run.archived().status, "completed");
	for (const i of [1, 3]) {
		assert.equal(h.git(run.repo, "rev-parse", "--verify", run.branch(i)).status, 0, `slot ${i} branch kept`);
		assert.equal(ancestor(run.branch(i)), 1, `slot ${i} NOT merged`);
	}
	assert.match(r.banner, /slot 2 merged; skipped 1, 3$/);
});

test("merge winner refuses when the winner moved after compare: the validated tip, or nothing", async () => {
	const run = makeFannedOutRun(h, { prefix: "cm", slots: 2 });
	commitIn(run.wt(1), "one.js");
	const compared = commitIn(run.wt(2), "two.js");
	finishAll(run, [1, 2]);
	const r = pane(run);
	await r.refresh();
	await keys(r, "w", "m", "2");
	const moved = commitIn(run.wt(2), "late.js"); // agent commits after the table was read
	await keys(r, "y");
	assert.match(r.banner, new RegExp(`slot 2 moved since it was compared \\(${compared.slice(0, 7)} -> ${moved.slice(0, 7)}\\)`));
	assert.equal(spawnSync("git", ["-C", run.repo, "merge-base", "--is-ancestor", compared, "main"]).status, 1, "nothing merged");
	assert.deepEqual(run.manifest().slots.map((s) => s.status), ["running", "running"], "nothing skipped");
});

test("merge verb: an expected slot tip pins the exact SHA merged and refuses junk", () => {
	const run = makeFannedOutRun(h, { prefix: "cm" });
	const tip = commitIn(run.wt(1), "one.js");
	const base = h.git(run.repo, "rev-parse", "main").stdout.trim();
	for (const junk of ["abc", "z".repeat(40), tip.slice(0, 39)]) {
		const bad = h.runScript("harvest-step.sh", ["merge", "1", base, junk], run.env);
		assert.equal(bad.status, 36, junk);
		assert.match(bad.stderr, /not a full SHA/);
	}
	const ok = h.runScript("harvest-step.sh", ["merge", "1", base, tip], run.env);
	assert.equal(ok.status, 0, ok.stderr);
	assert.equal(spawnSync("git", ["-C", run.repo, "merge-base", "--is-ancestor", tip, "main"]).status, 0);
});

test("merge winner leaves unfinished slots running and says so", async () => {
	const run = makeFannedOutRun(h, { prefix: "cm", slots: 3 });
	commitIn(run.wt(1), "one.js");
	commitIn(run.wt(2), "two.js");
	commitIn(run.wt(3), "three.js");
	finishAll(run, [1, 2]); // slot 3's agent is still working
	const r = pane(run);
	await r.refresh();
	await keys(r, "w", "m", "1");
	assert.deepEqual([r.phase.others, r.phase.unfinished], [[2], [3]]);
	assert.match(renderHarvest({ rows: r.rows, phase: r.phase }, 140), /Left running, agent not finished: 3\./);
	await keys(r, "y");
	assert.equal(run.slotRow(3).status, "running");
	assert.equal(run.slotRow(2).status, "archived");
	assert.match(r.banner, /skipped 2; still running \(agent not finished\): 3/);
});

test("merge winner keeps the winner's own ignored-files prompt and names it as kept", async () => {
	const run = makeFannedOutRun(h, { prefix: "cm", slots: 2 });
	commitIn(run.wt(1), "one.js");
	commitIn(run.wt(2), "two.js");
	finishAll(run, [1, 2]);
	fs.appendFileSync(path.join(run.repo, ".git/info/exclude"), "build/\n");
	fs.mkdirSync(path.join(run.wt(1), "build"));
	fs.writeFileSync(path.join(run.wt(1), "build", "out.js"), "artifact\n");
	const r = pane(run);
	await r.refresh();
	await keys(r, "w", "m", "1", "y");
	assert.equal(r.phase.name, "ignored", "the approval prompt survived the summary");
	assert.equal(r.phase.slot, 1);
	assert.match(r.banner, /slot 1 merged; skipped 2; worktrees kept for 1 \(winner\)/);
	assert.equal(run.slotRow(2).status, "archived");
});

test("unreadable diffs make overlap unknown, never 'disjoint'", async () => {
	const { compareSlots } = await import("../scripts/compare.mjs");
	const run = makeFannedOutRun(h, { prefix: "cm", slots: 2 });
	const rows = [1, 2].map((i) => ({ slot: i, label: `s${i}`, branch: run.branch(i), path: run.wt(i), status: "running", finished: "" }));
	const { slots, overlaps } = compareSlots({ repo: run.repo, fork: "f".repeat(40), runId: run.runId, stateDir: run.sdir, rows });
	assert.deepEqual(slots.map((s) => s.files), [null, null]);
	assert.deepEqual(overlaps, [{ a: 1, b: 2, count: -1, shared: [] }]);
	const screen = renderHarvest({ rows: [], phase: { name: "compare", slots: [], overlaps, pick: null } }, 120);
	assert.match(screen, /1 & 2: unknown/);
	assert.doesNotMatch(screen, /disjoint/);
});

test("the diff handoff drops inherited git routing", async () => {
	const { gitDisplayEnv } = await import("../bin/renderer-harvest.mjs");
	const env = gitDisplayEnv({ PATH: "/bin", GIT_DIR: "/elsewhere", GIT_CONFIG_PARAMETERS: "x", GIT_CONFIG_KEY_0: "k", GIT_CONFIG_VALUE_0: "v", GIT_PAGER: "less" });
	assert.deepEqual(env, { PATH: "/bin", GIT_PAGER: "less" });
});

test("merge winner never skips anything when the merge does not land", async () => {
	const run = makeFannedOutRun(h, { prefix: "cm", slots: 2 });
	commitIn(run.wt(1), "one.js");
	commitIn(run.wt(2), "README.md", "slot two\n");
	commitIn(run.repo, "README.md", "base moved\n"); // conflicts with slot 2
	const r = pane(run);
	await r.refresh();
	await keys(r, "w", "m", "2", "y");
	assert.equal(r.phase.name, "conflict");
	assert.deepEqual(run.manifest().slots.map((s) => s.status), ["running", "running"]);
	await keys(r, "a"); // abort the merge; leave the tree as found
});

test("merge winner refuses a winner that is not clean, before merging or skipping", async () => {
	const run = makeFannedOutRun(h, { prefix: "cm", slots: 2 });
	commitIn(run.wt(1), "one.js");
	commitIn(run.wt(2), "two.js");
	fs.writeFileSync(path.join(run.wt(2), "wip.txt"), "uncommitted\n");
	const r = pane(run);
	await r.refresh();
	await keys(r, "w", "m", "2", "y");
	assert.match(r.banner, /slot 2 is 'dirty'.*nothing was merged or skipped/);
	assert.deepEqual(run.manifest().slots.map((s) => s.status), ["running", "running"]);
});

test("only a running slot can be picked as winner", async () => {
	const run = makeFannedOutRun(h, { prefix: "cm", slots: 2 });
	commitIn(run.wt(1), "one.js");
	setManifest(run, (d) => { d.slots[1].status = "skipped"; });
	const r = pane(run);
	await r.refresh();
	await keys(r, "w", "m", "2");
	assert.equal(r.phase.name, "compare");
	assert.match(r.banner, /slot 2 is 'skipped' — only a running slot can win/);
});
