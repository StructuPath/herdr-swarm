import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness, repoRoot, sampleManifest } from "./harness.mjs";

const h = createHarness();
const { stubDir, stateDir, writeStub, freshEnv, runScript, runLib, log, makeRepo, git } = h;

const manifestFile = path.join(stateDir, "run-w9.json");
const paneScript = path.join(repoRoot, "scripts", "fanout-pane.sh");

// The default preset argv is `claude`; preflight_check_argv does a real
// `command -v`, so the test PATH needs a claude binary. It is never executed
// (agent start goes through the herdr stub) — presence is all that matters.
writeStub("claude", "exit 0");

// Fan-out herdr stub. Beyond logging (like the shared stub), it does two
// things the U4 write-ahead assertions need:
//   1. real `git worktree add` in $STUB_REPO — so task-file/exclusion tests
//      run against real git, and killed runs leave a discoverable worktree;
//   2. manifest SNAPSHOTS at create/start time (snap-create-*/snap-start-*)
//      — log lines can't order cross-process manifest writes, but a
//      snapshot taken inside the herdr call proves what was on disk when
//      the call happened. That is the write-ahead contract, testably.
// Knobs: STUB_FAIL_CREATE_MATCH (branch substring → create fails, mirroring
// spike (d) error shape), STUB_KILL_AFTER_CREATE (kill -9 own process group
// right after the create JSON is emitted — the caller must be spawned
// detached so only the pane's group dies, not the test runner).
writeStub(
	"herdr",
	`echo "herdr $@" >> "$STUB_LOG"
if [ "$1" = "--version" ]; then echo "herdr \${STUB_HERDR_VERSION:-0.7.4}"; exit 0; fi
mf="$HERDR_PLUGIN_STATE_DIR/run-\${HERDR_WORKSPACE_ID:-w9}.json"
if [ "$1" = "worktree" ] && [ "$2" = "create" ]; then
  shift 2
  branch=""; base=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --branch) branch="$2"; shift 2 ;;
      --base) base="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  slug="$(printf '%s' "$branch" | tr '/' '-')"
  [ -f "$mf" ] && cp "$mf" "$HERDR_PLUGIN_STATE_DIR/snap-create-$slug.json"
  case "$branch" in
    *"\${STUB_FAIL_CREATE_MATCH:-@@nomatch@@}"*)
      echo '{"error":{"code":"worktree_create_failed","message":"fatal: path already exists"},"id":"cli:worktree:create"}'
      exit 1 ;;
  esac
  wt="$STUB_WT_ROOT/$slug"
  if ! git -C "$STUB_REPO" worktree add -q -b "$branch" "$wt" "$base" 2>>"$STUB_LOG"; then
    echo '{"error":{"code":"worktree_create_failed","message":"fatal: worktree add failed"},"id":"cli:worktree:create"}'
    exit 1
  fi
  printf '{"id":"cli:worktree:create","result":{"root_pane":{"agent_status":"unknown","cwd":"%s","pane_id":"wD:p1","tab_id":"wD:t1","terminal_id":"term_root","workspace_id":"wD"},"tab":{"tab_id":"wD:t1","workspace_id":"wD"},"type":"worktree_created","workspace":{"active_tab_id":"wD:t1","label":"%s","workspace_id":"wD"},"worktree":{"branch":"%s","is_bare":false,"is_detached":false,"is_linked_worktree":true,"is_prunable":false,"label":"%s","open_workspace_id":"wD","path":"%s"}}}\\n' "$wt" "$branch" "$branch" "$branch" "$wt"
  [ -n "\${STUB_KILL_AFTER_CREATE:-}" ] && kill -9 0
  exit 0
fi
if [ "$1" = "agent" ] && [ "$2" = "start" ]; then
  name="$3"
  [ -f "$mf" ] && cp "$mf" "$HERDR_PLUGIN_STATE_DIR/snap-start-$name.json"
  shift 3
  cwd=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --cwd) cwd="$2"; shift 2 ;;
      --) shift; break ;;
      *) shift ;;
    esac
  done
  printf '{"id":"cli:agent:start","result":{"agent":{"agent_status":"unknown","cwd":"%s","focused":false,"foreground_cwd":"%s","name":"%s","pane_id":"wD:p2","revision":0,"tab_id":"wD:t1","terminal_id":"term_%s","workspace_id":"wD"},"argv":["%s"],"type":"agent_started"}}\\n' "$cwd" "$cwd" "$name" "$name" "$*"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "pane" ] && [ "$3" = "open" ]; then
  echo '{"id":"cli:plugin:pane:open","result":{"plugin_pane":{"pane":{"pane_id":"w9:p9"}},"type":"plugin_pane"}}'
  exit 0
fi
exit 0`,
);

// One shared stateDir across tests: reset manifests, snapshots, and lock
// dirs so no test depends on (or trips over) a predecessor's leftovers —
// the kill test in particular strands a lock held by a dead pid.
function resetState() {
	for (const f of fs.readdirSync(stateDir)) {
		fs.rmSync(path.join(stateDir, f), { recursive: true, force: true });
	}
}

// Fresh scratch repo + worktree root per test; env wires the stub's git side.
function setup(extraEnv = {}) {
	resetState();
	const repo = makeRepo();
	const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hs-wtroot-"));
	const env = freshEnv({
		STUB_REPO: repo,
		STUB_WT_ROOT: wtRoot,
		// Fatal paths linger 10 min for humans; tests must not.
		HERDR_SWARM_LINGER_SECS: "0",
		...extraEnv,
	});
	return { repo, wtRoot, env };
}

// The pane reads all prompts from stdin (documented protocol in the script
// header) — tests drive the whole flow by scripting that stream. harness
// runScript has no cwd/input support, so pane runs use spawnSync directly.
function runPane(input, env, cwd) {
	return spawnSync("bash", [paneScript], {
		cwd,
		env,
		input,
		encoding: "utf8",
		timeout: 30000,
	});
}

// Async variant for the kill and concurrency tests. detached:true gives the
// pane its own process group, so the stub's `kill -9 0` (kill test) reaps
// the pane tree without touching the test runner.
function spawnPane(input, env, cwd, { detached = false } = {}) {
	return new Promise((resolve) => {
		const c = spawn("bash", [paneScript], { cwd, env, detached });
		let stdout = "";
		let stderr = "";
		c.stdout.on("data", (d) => (stdout += d));
		c.stderr.on("data", (d) => (stderr += d));
		c.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
		c.stdin.write(input);
		c.stdin.end();
	});
}

const readManifest = () => JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const lines = (input) => input.join("\n") + "\n";

// --- presets.sh --------------------------------------------------------------

function runPresets(snippet, env) {
	return runLib(snippet, env, { sources: ["scripts/presets.sh"] });
}

test("presets: missing config yields the two built-in defaults", () => {
	const env = freshEnv({ HERDR_PLUGIN_CONFIG_DIR: path.join(os.tmpdir(), "hs-no-such-cfg") });
	const l = runPresets("presets_list", env);
	assert.equal(l.status, 0, l.stderr);
	assert.equal(l.stdout, "claude\tclaude\ncodex\tcodex\n");
	const a = runPresets("preset_argv codex", env);
	assert.equal(a.status, 0, a.stderr);
	assert.equal(a.stdout.trim(), "codex");
});

test("presets: config file parsed — comments/blanks skipped, kind carried, args returned", () => {
	const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "hs-cfg-"));
	fs.writeFileSync(
		path.join(cfg, "presets.conf"),
		"# my presets\n\nfast|argv|claude --model haiku\nslow|custom-kind|codex --slow\n",
	);
	const env = freshEnv({ HERDR_PLUGIN_CONFIG_DIR: cfg });
	const l = runPresets("presets_list", env);
	assert.equal(l.status, 0, l.stderr);
	// Config presets REPLACE the defaults (they are a fallback, not a base).
	assert.equal(l.stdout, "fast\tclaude --model haiku\nslow\tcodex --slow\n");
	const a = runPresets("preset_argv slow", env);
	assert.equal(a.status, 0, a.stderr);
	assert.equal(a.stdout.trim(), "codex --slow");
});

test("presets: an invalid name fails the whole catalog loudly, never skips", () => {
	const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "hs-cfg-"));
	fs.writeFileSync(path.join(cfg, "presets.conf"), "ok|argv|echo hi\nbad name|argv|echo boom\n");
	const env = freshEnv({ HERDR_PLUGIN_CONFIG_DIR: cfg });
	const l = runPresets("presets_list", env);
	assert.notEqual(l.status, 0);
	assert.match(l.stderr, /preset name 'bad name' is invalid/);
	// Malformed lines (missing kind/args) are refused too.
	fs.writeFileSync(path.join(cfg, "presets.conf"), "claude|claude\n");
	const m = runPresets("presets_list", env);
	assert.notEqual(m.status, 0);
	assert.match(m.stderr, /malformed preset line/);
});

test("presets: unknown and hostile preset names are refused", () => {
	const env = freshEnv({ HERDR_PLUGIN_CONFIG_DIR: path.join(os.tmpdir(), "hs-no-such-cfg") });
	const u = runPresets("preset_argv nope", env);
	assert.notEqual(u.status, 0);
	assert.match(u.stderr, /unknown preset 'nope'/);
	assert.match(u.stderr, /available: claude codex/);
	// Path-dangerous input is refused outright, never sanitized into an
	// accidental match ("../claude" must not become "claude").
	const hostile = spawnSync(
		"bash",
		["-c", `. "${repoRoot}/scripts/presets.sh" && preset_argv "$1"`, "--", "../claude"],
		{ env, encoding: "utf8" },
	);
	assert.notEqual(hostile.status, 0);
	assert.match(hostile.stderr, /invalid preset name/);
});

// --- fanout.sh (thin action) -------------------------------------------------

test("fanout.sh opens the fan-out pane through the wrapper on 0.7.4", () => {
	const { env } = setup();
	const r = runScript("fanout.sh", [], env);
	assert.equal(r.status, 0, r.stderr);
	assert.match(
		log(),
		/plugin pane open --plugin structupath\.swarm --entrypoint fanout-pane --placement split --direction right --focus/,
	);
	// The open-race lock must not linger after a clean exit.
	assert.equal(fs.existsSync(path.join(stateDir, "lock-fanout-open")), false);
});

test("fanout.sh refuses on 0.7.5 before opening anything", () => {
	const { env } = setup({ STUB_HERDR_VERSION: "0.7.5" });
	const r = runScript("fanout.sh", [], env);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /needs herdr 0\.7\.4/);
	assert.doesNotMatch(log(), /pane open/);
});

// --- fan-out pane: happy path ------------------------------------------------

test("N=3 fans out exactly 3 creates + 3 starts on distinct run-unique branches", () => {
	const { repo, wtRoot, env } = setup();
	const r = runPane(
		lines(["3", "", "", "", "Build the widget", "Second line", ".", "", "", ""]),
		env,
		repo,
	);
	assert.equal(r.status, 0, r.stderr);
	const creates = log().split("\n").filter((l) => /worktree create/.test(l));
	const starts = log().split("\n").filter((l) => /agent start/.test(l));
	assert.equal(creates.length, 3);
	assert.equal(starts.length, 3);
	// Spike (k): --workspace alone leaves the agent in the server's cwd, so
	// --cwd must be explicit on EVERY start.
	for (const s of starts) assert.match(s, / --cwd /);
	const m = readManifest();
	assert.match(m.run_id, /^\d{8}-\d{6}-[0-9a-f]{4}$/, "timestamp+nonce run id");
	assert.equal(m.slots.length, 3);
	assert.equal(new Set(m.slots.map((s) => s.branch)).size, 3, "branches distinct");
	for (const s of m.slots) {
		assert.equal(s.status, "running");
		assert.equal(s.branch, `swarm/${m.run_id}/s${s.slot}-claude`);
		assert.ok(s.path && s.path.startsWith(wtRoot), `path from response: ${s.path}`);
		// Running rows carry the ids the START returned, not the root pane's.
		assert.equal(s.pane_id, "wD:p2");
		assert.match(s.terminal_id, /^term_swarm-/);
		assert.match(s.agent_name, /^swarm-/);
		assert.equal(s.workspace_id, "wD");
	}
	assert.match(log(), /plugin pane open --plugin structupath\.swarm --entrypoint status-pane/);
	assert.match(r.stdout, /created 3, started 3, failed 0/);
});

test("write-ahead ordering: pending row before create, path before start, running after", () => {
	const { repo, env } = setup();
	const r = runPane(lines(["2", "", "", "Order test", ".", "", ""]), env, repo);
	assert.equal(r.status, 0, r.stderr);
	const m = readManifest();
	assert.equal(m.slots.length, 2);
	for (const s of m.slots) {
		// Snapshot the stub took INSIDE `worktree create`: the pending row was
		// already on disk, path still null — the manifest led the mutation.
		const atCreate = JSON.parse(
			fs.readFileSync(path.join(stateDir, `snap-create-${s.branch.replace(/\//g, "-")}.json`), "utf8"),
		);
		const rowC = atCreate.slots.find((x) => x.branch === s.branch);
		assert.ok(rowC, `pending row on disk before create of ${s.branch}`);
		assert.equal(rowC.status, "pending");
		assert.equal(rowC.path, null);
		// Snapshot inside `agent start`: path recorded, but running only after
		// the start returns its ids.
		const atStart = JSON.parse(
			fs.readFileSync(path.join(stateDir, `snap-start-${s.agent_name}.json`), "utf8"),
		);
		const rowS = atStart.slots.find((x) => x.branch === s.branch);
		assert.ok(rowS.path, "path recorded before agent start");
		assert.equal(rowS.status, "pending");
		assert.equal(s.status, "running");
	}
});

// --- fan-out pane: failure paths ----------------------------------------------

test("slot 2 create failure keeps slots 1 and 3 running and reports loudly (R4)", () => {
	const { repo, env } = setup({ STUB_FAIL_CREATE_MATCH: "/s2-" });
	const r = runPane(
		lines(["3", "", "", "", "Partial failure", ".", "", "", ""]),
		env,
		repo,
	);
	// Partial failure exits nonzero — but only after finishing every slot.
	assert.equal(r.status, 1);
	const m = readManifest();
	assert.deepEqual(
		m.slots.map((s) => s.status),
		["running", "failed", "running"],
	);
	assert.equal(m.slots[1].path, null, "failed slot never got a path");
	assert.equal(log().split("\n").filter((l) => /worktree create/.test(l)).length, 3);
	assert.equal(log().split("\n").filter((l) => /agent start/.test(l)).length, 2);
	assert.match(r.stdout, /created 2, started 2, failed 1/);
	assert.match(r.stderr, /slot 2 FAILED/);
	assert.match(r.stderr, /WARNING: 1 slot\(s\) FAILED/);
});

test("kill between create-return and path-record leaves a pending-null-path row, worktree findable by branch", async () => {
	const { repo, env } = setup({ STUB_KILL_AFTER_CREATE: "1" });
	const r = await spawnPane(lines(["1", "", "Kill test", ".", ""]), env, repo, {
		detached: true,
	});
	assert.equal(r.signal, "SIGKILL", `expected the stub to kill the pane: ${r.stderr}`);
	const m = readManifest();
	assert.equal(m.slots.length, 1);
	// The write-ahead row survived the crash exactly as written: pending,
	// branch known, path null — abort's branch-name reconciliation contract.
	assert.equal(m.slots[0].status, "pending");
	assert.equal(m.slots[0].path, null);
	assert.ok(m.slots[0].branch.startsWith(`swarm/${m.run_id}/`));
	const wl = git(repo, "worktree", "list", "--porcelain").stdout;
	assert.ok(
		wl.includes(`branch refs/heads/${m.slots[0].branch}`),
		`worktree discoverable by run-unique branch:\n${wl}`,
	);
});

test("concurrent double-invoke: exactly one fan-out proceeds (mutation lock)", async () => {
	const { repo, env } = setup();
	const input = lines(["1", "", "Race test", ".", ""]);
	const [a, b] = await Promise.all([
		spawnPane(input, env, repo),
		spawnPane(input, env, repo),
	]);
	const ok = [a, b].filter((x) => x.code === 0);
	const refused = [a, b].filter((x) => x.code !== 0);
	assert.equal(ok.length, 1, `stderr A: ${a.stderr}\nstderr B: ${b.stderr}`);
	assert.equal(refused.length, 1);
	// The loser waited on the lock, then hit the active-run check — the lock
	// spans preflight precisely so both can never pass that check together.
	assert.match(refused[0].stderr, /harvest or abort/);
	assert.equal(readManifest().slots.length, 1, "exactly one run's slot exists");
});

test("an active run refuses fan-out with 'harvest or abort' before any create", () => {
	const { repo, env } = setup();
	fs.writeFileSync(manifestFile, sampleManifest());
	const r = runPane(lines(["1", "", "Nope", ".", ""]), env, repo);
	assert.equal(r.status, 17, r.stderr); // PF_EC_ACTIVE_RUN
	assert.match(r.stderr, /harvest or abort/);
	assert.doesNotMatch(log(), /worktree create/);
});

test("stub 0.7.5 refuses fan-out in the pane before any create (R13)", () => {
	const { repo, env } = setup({ STUB_HERDR_VERSION: "0.7.5" });
	const r = runPane(lines(["1", "", "Nope", ".", ""]), env, repo);
	assert.equal(r.status, 18, r.stderr); // PF_EC_VERSION
	assert.match(r.stderr, /needs herdr 0\.7\.4/);
	assert.doesNotMatch(log(), /worktree create/);
});

// --- fan-out pane: task file, overrides, presets, detritus --------------------

test("per-slot override lands in .swarm-task.md with the standing footer, excluded from git status", () => {
	const { repo, env } = setup();
	const r = runPane(
		lines(["1", "", "shared body", ".", "y", "slot special body", "."]),
		env,
		repo,
	);
	assert.equal(r.status, 0, r.stderr);
	const m = readManifest();
	const wt = m.slots[0].path;
	const tf = fs.readFileSync(path.join(wt, ".swarm-task.md"), "utf8");
	assert.match(tf, /slot special body/);
	assert.doesNotMatch(tf, /shared body/, "override replaces the shared prompt");
	// The standing footer is the parallel-fix convention: commit locally,
	// never push.
	assert.match(tf, /Commit completed work locally/);
	assert.match(tf, /Never push/);
	// info/exclude (shared repo-wide) keeps the task file out of git status
	// in the linked worktree — real git, real worktree.
	assert.doesNotMatch(git(wt, "status", "--porcelain").stdout, /swarm-task/);
	assert.equal(m.exclude_pattern_added, true);
});

test("a configured preset's argv reaches agent start verbatim", () => {
	const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "hs-cfg-"));
	fs.writeFileSync(path.join(cfg, "presets.conf"), "fast|argv|echo hello-fast\n");
	const { repo, env } = setup({ HERDR_PLUGIN_CONFIG_DIR: cfg });
	const r = runPane(lines(["1", "fast", "Preset test", ".", ""]), env, repo);
	assert.equal(r.status, 0, r.stderr);
	const start = log().split("\n").find((l) => /agent start/.test(l));
	assert.match(start, / -- echo hello-fast$/);
	const m = readManifest();
	assert.equal(m.slots[0].branch, `swarm/${m.run_id}/s1-fast`);
});

test("detritus prompt: choosing delete clears the leftovers and the fan-out proceeds", () => {
	const { repo, env } = setup();
	git(repo, "branch", "swarm/r0/s1");
	const r = runPane(lines(["d", "1", "", "Cleanup run", ".", ""]), env, repo);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	assert.match(r.stdout, /deleted branch swarm\/r0\/s1/);
	const refs = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/swarm").stdout;
	assert.doesNotMatch(refs, /swarm\/r0\/s1/, "old branch gone");
	assert.equal(readManifest().slots.length, 1, "new run created after cleanup");
});

// A leftover branch git refuses to delete holds committed agent work that is
// in no other ref — the abort→re-fanout path must not reach `-D` on the same
// single keystroke that clears merged leftovers.
function seedUnmergedLeftover(repo, branch = "swarm/r0/s1") {
	git(repo, "checkout", "-q", "-b", branch);
	fs.writeFileSync(path.join(repo, "agent-work.txt"), "committed agent work\n");
	git(repo, "add", "agent-work.txt");
	git(repo, "commit", "-q", "-m", "agent work nobody else has");
	const tip = git(repo, "rev-parse", "--short", "HEAD").stdout.trim();
	git(repo, "checkout", "-q", "main");
	return { branch, tip };
}

const branchRefs = (repo) =>
	git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/swarm").stdout;

test("detritus delete: an UNMERGED leftover is not deleted without the second typed confirmation", () => {
	const { repo, env } = setup();
	const { branch, tip } = seedUnmergedLeftover(repo);
	// "d" then anything-but-the-word: the flow must keep the branch, and the
	// re-check then blocks the fan-out entirely.
	const r = runPane(lines(["d", "yes", "1", "", "Task", ".", ""]), env, repo);
	assert.equal(r.status, 14, `${r.stdout}\n${r.stderr}`); // PF_EC_DETRITUS
	assert.match(branchRefs(repo), /swarm\/r0\/s1/, "unmerged branch survives");
	// The refusal must be informed: tip sha, subject, and the non-destructive
	// routes are all on screen before the prompt.
	assert.match(r.stderr, /NOT merged into HEAD/);
	assert.ok(r.stderr.includes(tip), "tip sha shown");
	assert.match(r.stderr, /agent work nobody else has/, "commit subject shown");
	assert.match(r.stderr, /Harvest/);
	assert.match(r.stderr, /swarm-kept\//);
	assert.match(r.stderr, /nothing was force-deleted/);
	assert.equal(fs.existsSync(manifestFile), false, "no run was created");
	assert.doesNotMatch(log(), /worktree create/);
	void branch;
});

test("detritus delete: the typed confirmation force-deletes the unmerged leftover and the fan-out proceeds", () => {
	const { repo, env } = setup();
	seedUnmergedLeftover(repo);
	const r = runPane(
		lines(["d", "delete-unmerged", "1", "", "Task", ".", ""]),
		env,
		repo,
	);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, /force-deleted branch swarm\/r0\/s1/);
	assert.doesNotMatch(branchRefs(repo), /swarm\/r0\/s1/, "old branch gone");
	assert.equal(readManifest().slots.length, 1, "new run created after cleanup");
});

test("detritus delete: a MERGED leftover still goes on the first pass, no second prompt", () => {
	const { repo, env } = setup();
	// Branch at HEAD => merged => `git branch -d` accepts it.
	git(repo, "branch", "swarm/r0/merged");
	// Input carries NO confirmation line: if the flow prompted for one, the
	// slot count would be consumed by it and the run would not come out right.
	const r = runPane(lines(["d", "1", "", "Task", ".", ""]), env, repo);
	assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stdout, /deleted branch swarm\/r0\/merged/);
	assert.doesNotMatch(r.stdout, /force-deleted/, "no -D path was taken");
	assert.doesNotMatch(r.stderr, /NOT merged into HEAD/, "no second gate shown");
	assert.doesNotMatch(branchRefs(repo), /swarm\/r0\/merged/);
	assert.equal(readManifest().slots.length, 1);
});

test("detritus delete: an archived run recording the branch is named as the harvest route", () => {
	const { repo, env } = setup();
	seedUnmergedLeftover(repo);
	fs.writeFileSync(
		path.join(stateDir, "archived-r0.json"),
		JSON.stringify({
			run_id: "r0",
			repo_root: repo,
			base_ref: "refs/heads/main",
			fork_sha: "a".repeat(40),
			created_at: "2026-07-22T15:00:00Z",
			exclude_pattern_added: false,
			slots: [{ slot: 1, label: "s1", branch: "swarm/r0/s1", status: "archived" }],
		}),
	);
	const r = runPane(lines(["d", "n", "1", "", "Task", ".", ""]), env, repo);
	assert.equal(r.status, 14, `${r.stdout}\n${r.stderr}`);
	assert.match(r.stderr, /run r0 .* still records: swarm\/r0\/s1/);
});

// --- setup.sh hook (kept in v1 scope by explicit user decision) ---

test("setup.sh hook runs in each worktree; failure warns but slots still start", () => {
	// Success path: the hook drops a marker; every worktree must have it.
	const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "hs-cfg-"));
	fs.writeFileSync(path.join(cfg, "setup.sh"), "echo ok > .setup-ran\n");
	{
		const { env, repo } = setup({ HERDR_PLUGIN_CONFIG_DIR: cfg });
		const r = runPane(lines(["2", "", "", "Task", ".", "", ""]), env, repo);
		assert.equal(r.status, 0, r.stderr);
		for (const s of readManifest().slots) {
			assert.equal(s.status, "running");
			assert.ok(fs.existsSync(path.join(s.path, ".setup-ran")), `marker in ${s.path}`);
		}
		assert.doesNotMatch(r.stderr, /setup\.sh failed/);
	}
	// Failure path: hook exits 1 — loud warning, agents started anyway.
	fs.writeFileSync(path.join(cfg, "setup.sh"), "exit 1\n");
	{
		const { env, repo } = setup({ HERDR_PLUGIN_CONFIG_DIR: cfg });
		const r = runPane(lines(["1", "", "Task", ".", ""]), env, repo);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stderr, /setup\.sh failed in 1 worktree/);
		assert.equal(readManifest().slots[0].status, "running");
	}
});
