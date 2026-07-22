// U5 status renderer tests. The reconcileSlots block was written BEFORE
// bin/renderer.mjs existed (plan execution note: the reconciliation helpers
// encode R6's restart-survival contract, so their tests come first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness, repoRoot, sampleManifest } from "./harness.mjs";
import {
	diffRange,
	manifestPath,
	mkHerdr,
	parseDiffStat,
	parseManifest,
	parseStatusPorcelain,
	pollDelay,
	reconcileSlots,
	Renderer,
	renderStatus,
	safeWsId,
	sanitizeText,
	sortSlots,
} from "../bin/renderer.mjs";

const h = createHarness();

// Renderer-side helpers, mirroring the sibling's mkRenderer/quiet/flush.
const mkRenderer = (env) => new Renderer(env);
// Silence painting; keep state transitions observable.
const quiet = (r) => {
	r.paint = () => {};
	return r;
};
// Drain fire-and-forget async work (onKey's jumpToSlot spawns a real child
// process, so setImmediate turns are not enough — poll with a deadline).
const until = async (cond, ms = 2000) => {
	const deadline = Date.now() + ms;
	while (!cond() && Date.now() < deadline)
		await new Promise((r) => setTimeout(r, 20));
	return cond();
};

// Slot-row factory grounded in the canonical U3 fixture so these tests break
// loudly if the manifest schema drifts.
const slots = () => JSON.parse(sampleManifest()).slots;
const liveAgent = (over = {}) => ({
	agent: "claude",
	agent_status: "idle",
	pane_id: "w9:p4",
	terminal_id: "term_abc123",
	workspace_id: "w9",
	...over,
});

// --- reconcileSlots: the R6 core (written first, watched failing) ---

test("reconcile: running slot with its agent present passes the live state through", () => {
	const [, running] = slots();
	for (const status of ["working", "idle"]) {
		const rows = reconcileSlots(
			[running],
			[liveAgent({ agent_status: status })],
			{ 2: { committed: 1, uncommitted: 0 } },
		);
		assert.equal(rows[0].state, status);
	}
});

test("reconcile: running slot whose agent vanished renders unknown, never stuck working", () => {
	const [, running] = slots();
	// Agent list answers, but our agent is not in it (killed, restarted away).
	const rows = reconcileSlots(
		[running],
		[liveAgent({ terminal_id: "term_other", pane_id: "w1:p1" })],
		{ 2: {} },
	);
	assert.equal(rows[0].state, "unknown");
});

test("reconcile: unqueryable agent list (null) renders unknown, never the manifest's raw running", () => {
	const [, running] = slots();
	const rows = reconcileSlots([running], null, { 2: {} });
	assert.equal(rows[0].state, "unknown");
});

test("reconcile: vanished workspace renders unknown with committed work still shown", () => {
	// Spike (b): closing the parent repo workspace cascades — agents are killed
	// silently but the worktree and its commits survive on disk. The slot must
	// stay visibly harvestable.
	const [, running] = slots();
	const rows = reconcileSlots([running], [], {
		2: { committed: 3, uncommitted: 1 },
	});
	assert.equal(rows[0].state, "unknown");
	assert.equal(rows[0].committed, 3, "committed work still displayed");
	assert.equal(rows[0].uncommitted, 1);
});

test("reconcile: deleted worktree dir renders missing; other slots are unaffected", () => {
	const [pending, running] = slots();
	const gone = { ...running, slot: 3, label: "s3", path: "/tmp/vanished" };
	const rows = reconcileSlots(
		[pending, running, gone],
		[liveAgent({ agent_status: "working" })],
		{
			2: { committed: 2, uncommitted: 0 },
			3: { worktreeMissing: true },
		},
	);
	assert.equal(rows.find((r) => r.slot === 3).state, "missing");
	assert.equal(
		rows.find((r) => r.slot === 2).state,
		"working",
		"a dead slot must not poison its neighbors",
	);
	assert.equal(rows.find((r) => r.slot === 1).state, "pending");
});

test("reconcile: deleted branch renders missing", () => {
	const [, running] = slots();
	const rows = reconcileSlots([running], [liveAgent()], {
		2: { branchMissing: true },
	});
	assert.equal(rows[0].state, "missing");
});

test("reconcile: terminal manifest states pass through untouched even when agents are unqueryable", () => {
	const base = slots()[1];
	const rows = reconcileSlots(
		["failed", "settled", "merged", "skipped", "archived"].map((status, i) => ({
			...base,
			slot: i + 1,
			status,
		})),
		null,
		{},
	);
	assert.deepEqual(
		rows.map((r) => r.state),
		["failed", "settled", "merged", "skipped", "archived"],
	);
});

test("reconcile: a live blocked agent surfaces as blocked", () => {
	const [, running] = slots();
	const rows = reconcileSlots(
		[running],
		[liveAgent({ agent_status: "blocked" })],
		{ 2: {} },
	);
	assert.equal(rows[0].state, "blocked");
});

test("sortSlots puts blocked slots first, keeps slot order otherwise", () => {
	const rows = [
		{ slot: 1, state: "working" },
		{ slot: 2, state: "blocked" },
		{ slot: 3, state: "idle" },
		{ slot: 4, state: "blocked" },
	];
	assert.deepEqual(
		sortSlots(rows).map((r) => r.slot),
		[2, 4, 1, 3],
		"blocked first (loud), stable slot order within each group",
	);
});

// --- parseManifest: corrupt input is a typed result, never a throw ---

test("parseManifest returns typed results for missing/corrupt input and never throws", () => {
	assert.deepEqual(parseManifest(null), { ok: false, reason: "missing" });
	assert.deepEqual(parseManifest(undefined), { ok: false, reason: "missing" });
	assert.equal(parseManifest("").reason, "corrupt");
	assert.equal(parseManifest("   \n").reason, "corrupt");
	assert.equal(parseManifest('{"slots": [').reason, "corrupt");
	assert.equal(parseManifest('"a bare string"').reason, "corrupt");
	assert.equal(parseManifest('{"slots": 42}').reason, "corrupt");
	const ok = parseManifest(sampleManifest());
	assert.equal(ok.ok, true);
	assert.equal(ok.manifest.slots.length, 2);
});

// --- git count helpers ---

test("diffRange is the exact three-dot fork range", () => {
	assert.equal(diffRange("abc123"), "abc123...HEAD");
});

test("parseDiffStat reads the summary line; parseStatusPorcelain counts entries", () => {
	assert.equal(parseDiffStat(" a | 1 +\n 1 file changed, 1 insertion(+)\n"), 1);
	assert.equal(
		parseDiffStat(" a | 1 +\n b | 2 -\n 2 files changed, 3 insertions(+)\n"),
		2,
	);
	assert.equal(parseDiffStat(""), 0, "no commits past the fork");
	assert.equal(parseStatusPorcelain(" M a.txt\n?? b.txt\n"), 2);
	assert.equal(parseStatusPorcelain(""), 0);
});

test("gitFactsFor issues the exact fork...HEAD range (never a two-dot base-tip form)", async () => {
	// Stub git captures argv: the three-dot range is the R5 contract — a
	// two-dot form counts base-branch commits into every slot (the documented
	// inflation bug).
	h.writeStub(
		"git",
		`echo "git $@" >> "$STUB_LOG"
case "$1" in
rev-parse) exit 0 ;;
diff) echo " 2 files changed, 5 insertions(+)" ;;
status) printf 'M a\\n?? b\\n?? c\\n' ;;
esac
exit 0`,
	);
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "hs-wt-"));
	const env = h.freshEnv();
	const r = quiet(mkRenderer(env));
	r.gitBin = path.join(h.stubDir, "git");
	const manifest = JSON.parse(sampleManifest());
	// repo_root must be a real dir: the branch check runs there first, and a
	// spawn failure would short-circuit as branchMissing before the diff.
	manifest.repo_root = fs.mkdtempSync(path.join(os.tmpdir(), "hs-root-"));
	const row = { ...manifest.slots[1], path: wt };
	const facts = await r.gitFactsFor(manifest, row);
	const sha = "a".repeat(40);
	assert.ok(
		h.log().includes(`git diff --stat ${sha}...HEAD\n`),
		`exact three-dot range not found in:\n${h.log()}`,
	);
	assert.ok(
		!h
			.log()
			.split("\n")
			.some((l) => /\.\.HEAD/.test(l) && !/\.\.\.HEAD/.test(l)),
		"a two-dot base-tip range must never be issued",
	);
	assert.deepEqual(facts, { committed: 2, uncommitted: 3 });
});

test("gitFactsFor flags a deleted branch as branchMissing", async () => {
	h.writeStub(
		"git",
		`echo "git $@" >> "$STUB_LOG"
if [ "$1" = rev-parse ]; then exit 1; fi
exit 0`,
	);
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "hs-wt-"));
	const r = quiet(mkRenderer(h.freshEnv()));
	r.gitBin = path.join(h.stubDir, "git");
	const manifest = JSON.parse(sampleManifest());
	const facts = await r.gitFactsFor(manifest, { ...manifest.slots[1], path: wt });
	assert.equal(facts.branchMissing, true);
});

// --- full poll cycle against a real repo: dirty + committed shows both ---

test("tick against a real worktree shows committed and uncommitted counts together", async () => {
	h.writeHerdrStub();
	// Earlier tests drop a stub git into stubDir (which leads PATH here) —
	// this test needs the real one.
	fs.rmSync(path.join(h.stubDir, "git"), { force: true });
	const repo = h.makeRepo();
	const fork = h.git(repo, "rev-parse", "HEAD").stdout.trim();
	const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hs-wt-")), "s2");
	h.git(repo, "worktree", "add", "-q", "-b", "swarm/r-t/s2", wt);
	fs.writeFileSync(path.join(wt, "done.txt"), "work\n");
	h.git(wt, "add", "done.txt");
	h.git(wt, "commit", "-q", "-m", "slot work");
	fs.writeFileSync(path.join(wt, "wip.txt"), "dirty\n"); // untracked = dirty
	const manifest = JSON.parse(sampleManifest());
	manifest.repo_root = repo;
	manifest.fork_sha = fork;
	manifest.slots[1].path = wt;
	manifest.slots[1].branch = "swarm/r-t/s2";
	// Dedicated state dir: shared-state coupling between tests is exactly the
	// kind of order dependence this suite must not have.
	const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-live-"));
	const env = h.freshEnv({ HERDR_PLUGIN_STATE_DIR: sdir });
	fs.writeFileSync(path.join(sdir, "run-w9.json"), JSON.stringify(manifest));
	const r = quiet(mkRenderer(env));
	await r.tick();
	const row = r.rows.find((x) => x.slot === 2);
	assert.equal(row.committed, 1, "one committed file past the fork");
	assert.equal(row.uncommitted, 1, "one dirty file");
	// The stub agent list answers with our slot's terminal — live state rules.
	assert.equal(row.state, "idle");
	assert.match(renderStatus(r.rows), /1\/1/, "both numbers rendered");
	// Committed counts must not move when base advances (three-dot range):
	fs.writeFileSync(path.join(repo, "base.txt"), "base moved\n");
	h.git(repo, "add", "base.txt");
	h.git(repo, "commit", "-q", "-m", "base advance");
	await r.tick();
	assert.equal(
		r.rows.find((x) => x.slot === 2).committed,
		1,
		"base-branch commits never inflate a slot's counts",
	);
});

// --- the single-writer rule: zero fs writes across a full poll cycle ---

test("renderer performs zero fs writes across a full poll cycle", async () => {
	h.writeHerdrStub();
	// Belt: read-only manifest + read-only state dir make any write attempt
	// throw. Suspenders: spy every mutating fs call the renderer's module
	// object exposes and require none fire.
	const roDir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-ro-"));
	const mf = path.join(roDir, "run-w9.json");
	const content = sampleManifest();
	fs.writeFileSync(mf, content);
	fs.chmodSync(mf, 0o444);
	fs.chmodSync(roDir, 0o555);
	const env = h.freshEnv({ HERDR_PLUGIN_STATE_DIR: roDir });
	const r = quiet(mkRenderer(env));
	const before = fs.statSync(mf).mtimeMs;
	const mutators = [
		"writeFileSync",
		"appendFileSync",
		"writeSync",
		"renameSync",
		"unlinkSync",
		"rmSync",
		"rmdirSync",
		"truncateSync",
		"copyFileSync",
		"mkdirSync",
		"chmodSync",
		"createWriteStream",
	];
	const calls = [];
	const orig = {};
	for (const m of mutators) {
		orig[m] = fs[m];
		fs[m] = (...a) => {
			calls.push(`${m} ${a[0]}`);
			throw new Error(`renderer attempted fs.${m}`);
		};
	}
	try {
		await r.tick(); // full cycle: manifest read, agent list, git facts, render
	} finally {
		for (const m of mutators) fs[m] = orig[m];
	}
	assert.deepEqual(calls, [], "no mutating fs call may fire during a poll");
	assert.equal(fs.statSync(mf).mtimeMs, before, "manifest untouched");
	assert.equal(fs.readFileSync(mf, "utf8"), content);
	assert.ok(r.rows.length > 0, "the cycle actually reconciled slots");
	fs.chmodSync(roDir, 0o755); // let tmp cleanup reap it
});

// --- backoff, sanitize, render ---

test("pollDelay backs off on idle and clamps below setTimeout's ceiling", () => {
	assert.equal(pollDelay(2000, 0), 2000);
	assert.equal(pollDelay(2000, 9), 2000);
	assert.equal(pollDelay(2000, 10), 4000);
	assert.equal(pollDelay(2000, 30), 8000);
	assert.equal(pollDelay(2000, 60), 16_000);
	assert.equal(pollDelay(2000, 300), 60_000);
	assert.equal(pollDelay(2000, 10_000), 60_000);
	// setTimeout's 2^31-1 ceiling: beyond it Node fires after ~1ms (busy loop)
	assert.equal(pollDelay(2 ** 28, 10_000), 2 ** 31 - 1);
});

test("intervalMs is clamped: no busy-loop from tiny/negative/garbage values", () => {
	const mk = (v) => mkRenderer({ HERDR_SWARM_INTERVAL_MS: v }).intervalMs;
	assert.equal(mk("-5"), 500);
	assert.equal(mk("100"), 500);
	assert.equal(mk("abc"), 2000);
	assert.equal(mk(undefined), 2000);
	assert.equal(mk("999999999999"), 86_400_000);
});

test("sanitizeText strips C0/C1, bidi overrides, and zero-width from a hostile branch name", () => {
	assert.equal(
		sanitizeText("swarm/\x1b]0;PWNED\x07r1/\x9bs1"),
		"swarm/]0;PWNEDr1/s1",
	);
	assert.equal(
		sanitizeText("swarm/good‮/1s/1r‬"),
		"swarm/good/1s/1r",
	);
	assert.equal(sanitizeText("a​b﻿c\td"), "abc d");
	assert.equal(sanitizeText("plain — unicode ✓ stays"), "plain — unicode ✓ stays");
});

test("renderStatus marks blocked rows loud (inverse+red) and shows every column", () => {
	const rows = sortSlots([
		{
			slot: 1,
			label: "auth",
			branch: "swarm/r1/auth",
			path: "/tmp/wt/auth",
			state: "working",
			committed: 3,
			uncommitted: 2,
		},
		{
			slot: 2,
			label: "docs",
			branch: "swarm/r1/docs",
			path: "/tmp/wt/docs",
			state: "blocked",
			committed: 0,
			uncommitted: null,
		},
	]);
	const out = renderStatus(rows, 120);
	const lines = out.split("\n");
	assert.match(lines[1], /^\x1b\[7m\x1b\[31m/, "blocked row is first and loud");
	assert.match(lines[1], /blocked/);
	assert.match(lines[1], /0\/-/, "unknown dirty count renders as -");
	assert.doesNotMatch(lines[2], /\x1b\[7m/, "working row stays quiet");
	assert.match(lines[2], /3\/2/, "committed/uncommitted both shown");
	assert.match(lines[2], /swarm\/r1\/auth/);
	assert.match(lines[2], /\/tmp\/wt\/auth/);
	const hostile = renderStatus(
		[{ slot: 1, label: "x", branch: "swarm/\x1b]0;pwn\x07/s1", state: "idle" }],
		120,
	);
	assert.ok(!hostile.includes("\x1b]"), "branch text cannot smuggle escapes");
});

// --- lockstep with lib.sh (bash and node must read the SAME manifest) ---

test("manifestPath is in lockstep with bash manifest_path, tilde expansion included", () => {
	const cleanEnv = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR")),
	);
	const cases = [
		{ HERDR_PLUGIN_STATE_DIR: h.stateDir, HERDR_WORKSPACE_ID: "w9" },
		{ HERDR_PLUGIN_STATE_DIR: h.stateDir, HERDR_WORKSPACE_ID: "../../evil" },
		{
			HERDR_PLUGIN_STATE_DIR: "~/.local/state/hs-tilde-test",
			HERDR_WORKSPACE_ID: "w1",
		},
	];
	for (const c of cases) {
		const sh = execFileSync(
			"bash",
			["-c", `. "${repoRoot}/scripts/lib.sh" && manifest_path`],
			{ env: { ...cleanEnv, ...c, HOME: os.homedir() } },
		)
			.toString()
			.trim();
		assert.equal(
			manifestPath({ ...c, HOME: os.homedir() }),
			sh,
			JSON.stringify(c),
		);
	}
	fs.rmSync(`${os.homedir()}/.local/state/hs-tilde-test`, {
		recursive: true,
		force: true,
	});
	assert.equal(safeWsId("../../evil"), "evil");
});

// --- Herdr access + jump-to-blocked ---

test("mkHerdr.agentList parses the real 0.7.4 shape and returns null on failure", async () => {
	h.writeHerdrStub();
	const env = h.freshEnv();
	const agents = await mkHerdr(env).agentList();
	assert.equal(agents.length, 1);
	assert.equal(agents[0].terminal_id, "term_abc123");
	// A dead CLI is "unanswerable", not "no agents" — reconcile treats null
	// as unknown, never as everyone-exited.
	h.writeStub("herdr", "exit 1");
	assert.equal(await mkHerdr(h.freshEnv()).agentList(), null);
	h.writeStub("herdr", 'echo "not json"');
	assert.equal(await mkHerdr(h.freshEnv()).agentList(), null);
});

test("number key focuses the slot's agent; workspace focus is the fallback", async () => {
	// Focus succeeds: agent focus only, by pane id, spawn-only (exit code is
	// the whole contract — no output parsing).
	h.writeStub(
		"herdr",
		`echo "herdr $@" >> "$STUB_LOG"
if [ "$1" = agent ] && [ "$2" = focus ]; then exit "\${STUB_FOCUS_EXIT:-0}"; fi
exit 0`,
	);
	let env = h.freshEnv();
	let r = quiet(mkRenderer(env));
	r.rows = [{ slot: 2, pane_id: "w9:p4", workspace_id: "w9", state: "blocked" }];
	r.onKey("2"); // the actual key path users hit
	assert.ok(
		await until(() => h.log().includes("agent focus")),
		"focus spawn never fired",
	);
	assert.match(h.log(), /herdr agent focus w9:p4/);
	assert.doesNotMatch(h.log(), /workspace focus/);

	// Agent focus fails (agent gone, plugin-scoped reach): workspace fallback.
	env = h.freshEnv({ STUB_FOCUS_EXIT: "1" });
	r = quiet(mkRenderer(env));
	r.rows = [{ slot: 2, pane_id: "w9:p4", workspace_id: "w9", state: "unknown" }];
	await r.jumpToSlot(2);
	assert.match(h.log(), /herdr agent focus w9:p4/);
	assert.match(h.log(), /herdr workspace focus w9/);

	// Unknown slot: no spawns at all.
	env = h.freshEnv();
	r = quiet(mkRenderer(env));
	r.rows = [];
	await r.jumpToSlot(5);
	assert.equal(h.log(), "");
});

test("tick shows typed banners for missing and corrupt manifests without crashing", async () => {
	h.writeHerdrStub();
	const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-banner-"));
	const env = h.freshEnv({ HERDR_PLUGIN_STATE_DIR: sdir });
	const r = quiet(mkRenderer(env));
	await r.tick();
	assert.match(r.banner, /no active swarm run/);
	assert.deepEqual(r.rows, []);
	fs.writeFileSync(path.join(sdir, "run-w9.json"), '{"slots": [');
	await r.tick();
	assert.match(r.banner, /corrupt/);
	assert.match(r.banner, /\.bak/, "recovery pointer named");
});

// --- launcher + pane script ---

test("status.sh opens the pane once, records its id, and no-ops while alive", () => {
	// Pane-open JSON mirrors the real 0.7.4 pane_opened shape; pane read is
	// the liveness probe (STUB_PANE_ALIVE, sibling convention).
	h.writeStub(
		"herdr",
		`echo "herdr $@" >> "$STUB_LOG"
if [ "$1" = plugin ] && [ "$2" = pane ] && [ "$3" = open ]; then
  echo '{"id":"cli:plugin:pane:open","result":{"pane":{"pane_id":"w9:p9","tab_id":"w9:t1","workspace_id":"w9"},"type":"pane_opened"}}'
  exit 0
fi
if [ "$1" = pane ] && [ "$2" = read ]; then exit "\${STUB_PANE_ALIVE:-1}"; fi
exit 0`,
	);
	const env = h.freshEnv();
	let r = h.runScript("status.sh", [], env);
	assert.equal(r.status, 0, r.stderr);
	assert.match(
		h.log(),
		/herdr plugin pane open --plugin structupath\.swarm --entrypoint status-pane/,
	);
	assert.equal(
		fs.readFileSync(path.join(h.stateDir, "status-pane-w9"), "utf8").trim(),
		"w9:p9",
		"pane id recorded for the next invoke and for abort's sweep",
	);
	// Second invoke while the pane is alive: no second open (not idempotent).
	r = h.runScript("status.sh", [], h.freshEnv({ STUB_PANE_ALIVE: "0" }));
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /already open/);
	assert.doesNotMatch(h.log(), /pane open/);
	// Dead pane: stale record dropped, fresh pane opened.
	r = h.runScript("status.sh", [], h.freshEnv({ STUB_PANE_ALIVE: "1" }));
	assert.equal(r.status, 0, r.stderr);
	assert.match(h.log(), /plugin pane open/);
	fs.rmSync(path.join(h.stateDir, "status-pane-w9"), { force: true });
});

test("status-pane.sh lingers with a friendly message instead of flash-closing", () => {
	h.writeHerdrStub();
	// Missing manifest: the pane must say so and stay open (sleep), never
	// exit instantly — an instant exit closes the pane before it is readable.
	const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-nomf-"));
	const r = spawnSync(
		"bash",
		[path.join(repoRoot, "scripts", "status-pane.sh")],
		{
			env: h.freshEnv({ HERDR_PLUGIN_STATE_DIR: sdir }),
			encoding: "utf8",
			timeout: 1500,
		},
	);
	assert.match(r.stdout, /no active swarm run/);
	assert.equal(r.signal, "SIGTERM", "still lingering when the timeout hit");
});

test("status-pane.sh execs the renderer with the resolved context (end to end)", () => {
	h.writeHerdrStub();
	fs.rmSync(path.join(h.stubDir, "git"), { force: true });
	const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-e2e-"));
	const env = h.freshEnv({ HERDR_PLUGIN_STATE_DIR: sdir });
	fs.writeFileSync(path.join(sdir, "run-w9.json"), sampleManifest());
	const r = spawnSync(
		"bash",
		[path.join(repoRoot, "scripts", "status-pane.sh")],
		{ env, encoding: "utf8", timeout: 3000 },
	);
	// The renderer painted the status screen: context resolution + exec work.
	assert.match(r.stdout, /herdr-swarm status/);
	assert.match(r.stdout, /run:r-20260722-abc1/);
});
