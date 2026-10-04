import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHarness, makeFannedOutRun, mkdtemp } from "./harness.mjs";
import { slotElapsedSeconds, formatDuration, reconcileSlots } from "../bin/renderer-shared.mjs";

const h = createHarness();
h.writeHerdrStub();

// A run whose slots run `claude` (agent_command, as fan-out records it), with
// every pane's foreground group led by `claude` unless a test says otherwise.
function fixture(slots = 3, env = {}, edit = () => {}) {
	const run = makeFannedOutRun(h, { prefix: "bc", slots });
	const file = path.join(run.sdir, "run-w9.json");
	const doc = JSON.parse(fs.readFileSync(file, "utf8"));
	for (const s of doc.slots) s.agent_command = "claude";
	edit(doc);
	fs.writeFileSync(file, JSON.stringify(doc, null, 2));
	Object.assign(run.env, { STUB_PANE_FG: "busy", STUB_FG_ARGV: '["claude","--resume"]', STUB_HERDR_VERSION: "0.8.2" }, env);
	return {
		...run,
		send: (extra = {}) => {
			fs.writeFileSync(h.logFile, "");
			return h.runScript("harvest-step.sh", ["broadcast"], { ...run.env, ...extra });
		},
	};
}

const records = (r, key) => r.stdout.split("\n").filter((l) => l.startsWith(`${key}\t`)).map((l) => l.split("\t").slice(1));
const skipped = (r) => Object.fromEntries(records(r, "broadcast_skipped").map(([s, why]) => [s, why]));
const typed = () => h.log().split("\n").filter((l) => /pane send-(text|keys)/.test(l));

test("one message reaches every running slot: typed, then submitted", () => {
	const run = fixture();
	const r = run.send({ HERDR_SWARM_MESSAGE: "Also add tests, then commit." });
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(records(r, "broadcast_sent"), [["1"], ["2"], ["3"]]);
	assert.deepEqual(typed(), [
		"herdr pane send-text w11:p1 Also add tests, then commit.",
		"herdr pane send-keys w11:p1 Enter",
		"herdr pane send-text w12:p1 Also add tests, then commit.",
		"herdr pane send-keys w12:p1 Enter",
		"herdr pane send-text w13:p1 Also add tests, then commit.",
		"herdr pane send-keys w13:p1 Enter",
	]);
});

test("types only into the slot's own agent: never a shell, a nested program, a reused pane, or a blocked prompt", () => {
	const run = fixture(6, {}, (doc) => {
		doc.slots[4].finished = { at: "2026-10-03T00:00:00Z", reason: "exited" };
		doc.slots[5].status = "skipped";
	});
	const r = run.send({
		HERDR_SWARM_MESSAGE: "stop and commit",
		HERDR_SWARM_TARGETS: "1,2,3,4,5,6",
		STUB_SHELL_PANES: "w12:p1",
		STUB_REUSED_PANES: "w13:p1",
		STUB_FOREIGN_PANES: "w14:p1",
		STUB_BLOCKED_PANES: "w11:p1",
	});
	assert.equal(r.status, 36, "not every target got it");
	assert.deepEqual(records(r, "broadcast_sent"), [], r.stdout);
	const why = skipped(r);
	assert.match(why["1"], /blocked waiting on you — keystrokes would answer its prompt/);
	assert.match(why["2"], /the foreground is not its agent 'claude' \(shell\)/);
	assert.match(why["3"], /no longer holds this slot's terminal/);
	assert.match(why["4"], /the foreground is not its agent 'claude' \(bash\)/, "the leader decides, not a member");
	assert.match(why["5"], /its agent exited — the pane belongs to the shell again/);
	assert.match(why["6"], /slot is 'skipped'/);
	assert.deepEqual(typed(), [], "nothing typed anywhere");
});

test("an interpreter-launched agent (node …/codex) is recognized by argv[1]", () => {
	const run = fixture(1, { STUB_FG_ARGV: '["node","/opt/lib/codex"]' }, (doc) => { doc.slots[0].agent_command = "codex"; });
	assert.deepEqual(records(run.send({ HERDR_SWARM_MESSAGE: "hi" }), "broadcast_sent"), [["1"]]);
});

test("a row from before broadcast existed (no agent_command) is skipped, not guessed", () => {
	const run = fixture(1, {}, (doc) => { delete doc.slots[0].agent_command; });
	const r = run.send({ HERDR_SWARM_MESSAGE: "hi" });
	assert.equal(r.status, 36);
	assert.match(skipped(r)["1"], /no recorded pane, terminal, or agent program/);
	assert.deepEqual(typed(), []);
});

test("Enter is withheld when the foreground changed after typing, and a failed Enter is 'partial'", () => {
	const flip = fixture(1, { STUB_FG_FLIP_FILE: path.join(mkdtemp("hs-flip-"), "flipped") });
	const r = flip.send({ HERDR_SWARM_MESSAGE: "make sure lint passes" });
	assert.equal(r.status, 36);
	assert.match(records(r, "broadcast_partial")[0][1], /typed, NOT submitted — the foreground changed to shell/);
	assert.deepEqual(typed(), ["herdr pane send-text w11:p1 make sure lint passes"], "no Enter into the shell");
	const fail = fixture(1, { STUB_SENDKEYS_FAIL: "1" });
	const p = fail.send({ HERDR_SWARM_MESSAGE: "x" });
	assert.equal(p.status, 36);
	assert.match(records(p, "broadcast_partial")[0][1], /the Enter key was refused; press Enter in that pane or clear it \(do not just re-run\)/);
	assert.deepEqual(records(p, "broadcast_skipped"), [], "partial is not reported as skipped");
});

test("unknown foreground (older herdr) is never the agent: nothing is typed", () => {
	const run = fixture(2, { STUB_PANE_FG: "" });
	const r = run.send({ HERDR_SWARM_MESSAGE: "hi" });
	assert.equal(r.status, 36);
	assert.match(r.stderr, /reached no slot/);
	assert.deepEqual(typed(), []);
});

test("targets pick slots; duplicates and junk refuse before anything is typed", () => {
	const run = fixture();
	const r = run.send({ HERDR_SWARM_MESSAGE: "only you two", HERDR_SWARM_TARGETS: "1, 3" });
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(records(r, "broadcast_sent"), [["1"], ["3"]]);
	for (const [targets, why] of [["1,two", /'two' is not a slot number/], ["1,3,1", /names slot 1 twice/]]) {
		const bad = run.send({ HERDR_SWARM_MESSAGE: "x", HERDR_SWARM_TARGETS: targets });
		assert.equal(bad.status, 36);
		assert.match(bad.stderr, why);
		assert.deepEqual(typed(), []);
	}
	const missing = run.send({ HERDR_SWARM_MESSAGE: "x", HERDR_SWARM_TARGETS: "9" });
	assert.equal(missing.status, 36);
	assert.match(skipped(missing)["9"], /not a slot of this run/);
});

test("messages must be one line of plain text, in any locale", () => {
	const run = fixture(1);
	const cases = [
		["", /needs a message/],
		["   ", /needs a message/],
		["line one\nline two", /one line of plain text/],
		["tab\there", /one line of plain text/],
		["ctrl-c \u0003 now", /one line of plain text/],
		["esc \u001b[31m red", /one line of plain text/],
		["c1 csi \u009b31m", /one line of plain text/],
		["next line \u0085 here", /one line of plain text/],
		["line sep   here", /one line of plain text/],
		["bidi ‮ reversed", /one line of plain text/],
		["--force everything", /must not start with '-'/],
		["x".repeat(4001), /over 4000 characters/],
	];
	for (const locale of ["C", "en_US.UTF-8"]) {
		for (const [msg, why] of cases) {
			const r = run.send({ HERDR_SWARM_MESSAGE: msg, LC_ALL: locale });
			assert.equal(r.status, 36, `${locale}: ${JSON.stringify(msg).slice(0, 40)}`);
			assert.match(r.stderr, why);
			assert.deepEqual(typed(), [], "nothing typed for a refused message");
		}
	}
	assert.deepEqual(records(run.send({ HERDR_SWARM_MESSAGE: "naïve café — ünïcode is fine" }), "broadcast_sent"), [["1"]]);
});

test("a message file works; a trailing newline is fine, an inner one or invalid UTF-8 is not", () => {
	const run = fixture(1);
	const dir = mkdtemp("hs-msg-");
	const ok = path.join(dir, "ok.txt");
	fs.writeFileSync(ok, "Rebase on main before you finish.\n");
	assert.deepEqual(records(run.send({ HERDR_SWARM_MESSAGE_FILE: ok }), "broadcast_sent"), [["1"]]);
	assert.deepEqual(typed()[0], "herdr pane send-text w11:p1 Rebase on main before you finish.");
	const multi = path.join(dir, "multi.txt");
	fs.writeFileSync(multi, "one\ntwo\n");
	assert.equal(run.send({ HERDR_SWARM_MESSAGE_FILE: multi }).status, 36);
	const bad = path.join(dir, "bad.txt");
	fs.writeFileSync(bad, Buffer.from([0x68, 0x69, 0x9b, 0x33]));
	const r = run.send({ HERDR_SWARM_MESSAGE_FILE: bad });
	assert.equal(r.status, 36);
	assert.match(r.stderr, /not valid UTF-8/);
	assert.equal(run.send({ HERDR_SWARM_MESSAGE_FILE: path.join(dir, "absent") }).status, 36);
});

test("elapsed time: from start to finish, or to now; unknown start is unknown", () => {
	const now = Date.parse("2026-10-03T12:00:00Z");
	assert.equal(slotElapsedSeconds({ started_at: "2026-10-03T11:30:00Z" }, null, now), 1800);
	assert.equal(slotElapsedSeconds({ started_at: "2026-10-03T11:30:00Z", finished: { at: "2026-10-03T11:42:30Z" } }, null, now), 750);
	assert.equal(slotElapsedSeconds({}, "2026-10-03T10:00:00Z", now), 7200, "older rows fall back to the run's start");
	assert.equal(slotElapsedSeconds({}, null, now), null);
	assert.deepEqual([null, 0, 59, 60, 3599, 3600, 3900].map(formatDuration), ["-", "0s", "59s", "1m", "59m", "1h00m", "1h05m"]);
	const rows = reconcileSlots([
		{ slot: 1, status: "running", started_at: "2026-10-03T11:58:00Z" },
		{ slot: 2, status: "merged", started_at: "2026-10-03T11:00:00Z" },
	], [], {}, null, now);
	assert.deepEqual(rows.map((r) => r.elapsed), [120, null], "settled history shows no live clock");
});
