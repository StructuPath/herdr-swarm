import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarness, sampleManifest, mkdtemp } from "./harness.mjs";

const h = createHarness();
h.writeHerdrStub();
const { stateDir, freshEnv, runLib, makeRepo, git } = h;

// HERDR_WORKSPACE_ID is "w9" in freshEnv, so the manifest lands here.
const manifestFile = path.join(stateDir, "run-w9.json");

// stateDir is shared across tests in this file — reset the manifest family
// per test so no test depends on a predecessor's leftovers.
function resetManifest() {
	for (const f of fs.readdirSync(stateDir)) {
		if (f.startsWith("run-w9.json")) fs.rmSync(path.join(stateDir, f));
	}
}

test("manifest_path is keyed by workspace id under the state dir", () => {
	const r = runLib("manifest_path");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), manifestFile);
});

test("manifest round-trips through write and read, leaving no temp debris", () => {
	resetManifest();
	const w = runLib("manifest_write", freshEnv(), { input: sampleManifest() });
	assert.equal(w.status, 0, w.stderr);
	const r = runLib("manifest_read");
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout), JSON.parse(sampleManifest()));
	// The fsync-then-rename write must not strand its temp file.
	const debris = fs.readdirSync(stateDir).filter((f) => f.includes(".tmp."));
	assert.deepEqual(debris, []);
});

test("manifest_write refuses invalid JSON and leaves the current manifest untouched", () => {
	resetManifest();
	fs.writeFileSync(manifestFile, sampleManifest());
	const w = runLib("manifest_write", freshEnv(), { input: '{"broken":' });
	assert.notEqual(w.status, 0);
	// Validate-before-write: a buggy writer can never replace a good
	// manifest with garbage.
	assert.deepEqual(
		JSON.parse(fs.readFileSync(manifestFile, "utf8")),
		JSON.parse(sampleManifest()),
	);
	const debris = fs.readdirSync(stateDir).filter((f) => f.includes(".tmp."));
	assert.deepEqual(debris, []);
});

test("a crashed writer's leftover temp file never shadows the manifest", () => {
	resetManifest();
	fs.writeFileSync(manifestFile, sampleManifest());
	// Simulates a writer killed between temp-write and rename: the garbage
	// stays in the temp name, the manifest proper is the last good rename.
	fs.writeFileSync(`${manifestFile}.tmp.4242`, '{"half":');
	const r = runLib("manifest_read");
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout), JSON.parse(sampleManifest()));
});

test("missing manifest returns the distinct missing code, not corrupt", () => {
	resetManifest();
	const r = runLib(`manifest_read; echo "rc=$?"`);
	assert.match(r.stdout, /rc=2/);
});

test("zero-length manifest returns the distinct corrupt code with a .bak pointer", () => {
	resetManifest();
	fs.writeFileSync(manifestFile, "");
	const r = runLib("manifest_read");
	assert.equal(r.status, 3, `stderr: ${r.stderr}`);
	assert.match(r.stderr, /zero-length/);
	assert.match(r.stderr, /\.bak/);
});

test("truncated manifest → corrupt code; report_only_discovery lists live reality", () => {
	resetManifest();
	const repo = makeRepo();
	git(repo, "branch", "swarm/r0/s1");
	const wt = path.join(mkdtemp("hs-wt-"), "wt");
	git(repo, "worktree", "add", "-q", wt, "swarm/r0/s1");
	fs.writeFileSync(manifestFile, '{"run_id":"r0","slots":[{');
	const r = runLib("manifest_read", freshEnv(), { cwd: repo });
	assert.equal(r.status, 3, `stderr: ${r.stderr}`);
	assert.match(r.stderr, /unparseable/);
	// The degradation path destructive callers switch to: branches,
	// worktrees, and this plugin's panes — from live sources, no manifest.
	// SWARM_REPO is the caller contract for every preflight helper (repo_git).
	const d = runLib(
		'export SWARM_REPO="$(resolve_repo_root)" && report_only_discovery',
		freshEnv(),
		{
			sources: ["scripts/preflight.sh"],
			cwd: repo,
		},
	);
	assert.equal(d.status, 0, d.stderr);
	assert.match(d.stdout, /branch\tswarm\/r0\/s1/);
	assert.match(d.stdout, /worktree\t[^\t\n]*hs-wt-[^\t\n]*\tswarm\/r0\/s1/);
	// Stub pane list carries one pane titled "Swarm Status" — swept by label.
	assert.match(d.stdout, /pane\tw9:p9\tSwarm Status/);
});

test(".bak keeps the previous generation and recovers a corrupted manifest", () => {
	resetManifest();
	const gen1 = sampleManifest();
	const gen2 = sampleManifest({ run_id: "r-20260722-def2" });
	let w = runLib("manifest_write", freshEnv(), { input: gen1 });
	assert.equal(w.status, 0, w.stderr);
	w = runLib("manifest_write", freshEnv(), { input: gen2 });
	assert.equal(w.status, 0, w.stderr);
	assert.deepEqual(
		JSON.parse(fs.readFileSync(`${manifestFile}.bak`, "utf8")),
		JSON.parse(gen1),
	);
	// Round-trip: corrupt the live file, restore from .bak, read cleanly.
	fs.writeFileSync(manifestFile, "{{{{");
	assert.equal(runLib("manifest_read").status, 3);
	fs.copyFileSync(`${manifestFile}.bak`, manifestFile);
	const r = runLib("manifest_read");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(JSON.parse(r.stdout).run_id, "r-20260722-abc1");
});

test("manifest_update_slot patches one row and leaves the others untouched", () => {
	resetManifest();
	let w = runLib("manifest_write", freshEnv(), { input: sampleManifest() });
	assert.equal(w.status, 0, w.stderr);
	const u = runLib(
		`manifest_update_slot 2 '{"status":"merged","journal":{"locus":"detached","expected_base_sha":"deadbeef","merge_commit_sha":"cafef00d"}}'`,
	);
	assert.equal(u.status, 0, u.stderr);
	const doc = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
	assert.equal(doc.slots[1].status, "merged");
	assert.deepEqual(doc.slots[1].journal, {
		locus: "detached",
		expected_base_sha: "deadbeef",
		merge_commit_sha: "cafef00d",
	});
	assert.equal(doc.slots[0].status, "pending", "slot 1 untouched");
	// Update went through manifest_write, so .bak holds the pre-update doc.
	assert.deepEqual(
		JSON.parse(fs.readFileSync(`${manifestFile}.bak`, "utf8")),
		JSON.parse(sampleManifest()),
	);
});

test("manifest_update_slot fails loudly on an unknown slot, manifest unchanged", () => {
	resetManifest();
	fs.writeFileSync(manifestFile, sampleManifest());
	const u = runLib(`manifest_update_slot 9 '{"status":"failed"}'`);
	assert.notEqual(u.status, 0);
	assert.match(u.stderr, /no slot 9/);
	assert.deepEqual(
		JSON.parse(fs.readFileSync(manifestFile, "utf8")),
		JSON.parse(sampleManifest()),
	);
});

test("manifest_update_slot propagates the corrupt code so destructive callers refuse", () => {
	resetManifest();
	fs.writeFileSync(manifestFile, '{"run_id":');
	const u = runLib(`manifest_update_slot 1 '{"status":"failed"}'`);
	assert.equal(u.status, 3, `stderr: ${u.stderr}`);
});
