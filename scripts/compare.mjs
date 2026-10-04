// compare.mjs — read-only slot comparison behind `harvest-step.sh compare`.
// The verb verifies ownership of every row in bash, then feeds one TSV line
// per slot on stdin: slot, label, branch, path, status, finished_reason. This
// script only READS git (rev-parse, rev-list, diff, status) and the
// Swarm-produced validation files, and prints:
//
//   compare_slot<TAB>{json}            one per slot, candidates first, ranked
//   compare_overlap<TAB>a<TAB>b<TAB>n<TAB>[shared files…]  candidate pairs
//
// Ranking is deliberately explainable, never a score: validation outcome for
// the CURRENT tip (passed > not run > stale > failed), then having commits,
// then finished, then slot number. Diff size is reported but never ranked —
// a smaller change is not a better one.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VALIDATION_ORDER = { passed: 0, none: 1, stale: 2, failed: 3 };
const SHARED_LIMIT = 10;

function git(cwd, args) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return r.status === 0 ? r.stdout : null;
}

function validationFor(stateDir, runId, slot, tip) {
	const file = path.join(stateDir, `validation-${runId}-s${slot}.json`);
	let value;
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.size > 1024 * 1024) return { status: "none" };
		value = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return { status: "none" };
	}
	// Same identity rule the strict candidate gate applies to the default file.
	if (value?.kind !== "herdr-swarm-validation" || value.run_id !== runId || value.slot !== slot ||
		!["passed", "failed"].includes(value.status)) return { status: "none" };
	if (!tip || value.head_sha !== tip) return { status: "stale", head_sha: value.head_sha ?? null };
	const failed = (Array.isArray(value.checks) ? value.checks : [])
		.filter((c) => c?.status !== "passed").map((c) => String(c?.name ?? "?")).slice(0, 5);
	return { status: value.status, failed_checks: failed };
}

// Seconds from a slot's start to its finish, or to now while it runs; null
// when the start is unknown ("-" in the manifest).
function elapsedSeconds(startedAt, finishedAt, now) {
	const start = Date.parse(startedAt ?? "");
	if (!Number.isFinite(start)) return null;
	const end = Date.parse(finishedAt ?? "");
	return Math.max(0, Math.round(((Number.isFinite(end) ? end : now) - start) / 1000));
}

export function compareSlots({ repo, fork, runId, stateDir, rows, now = Date.now() }) {
	const slots = rows.map(({ slot, label, branch, path: wt, status, finished, startedAt, finishedAt }) => {
		const tip = git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])?.trim() || null;
		// files stays null when the diff could not be read: "no files" would be
		// a false claim of zero overlap with every other slot.
		const out = { slot, label, branch, status, finished: finished || null, tip, commits: null,
			files: null, insertions: null, deletions: null, dirty: null, validation: { status: "none" },
			elapsed_seconds: elapsedSeconds(startedAt, finishedAt, now) };
		if (tip) {
			const count = git(repo, ["rev-list", "--count", `${fork}..${tip}`]);
			out.commits = count === null ? null : Number(count.trim());
			const numstat = git(repo, ["diff", "--numstat", "-z", "--no-renames", fork, tip]);
			if (numstat !== null) {
				out.files = [];
				let ins = 0, del = 0;
				for (const rec of numstat.split("\0").filter(Boolean)) {
					const [a, d, ...name] = rec.split("\t");
					out.files.push(name.join("\t"));
					ins += Number(a) || 0; // "-" for binary
					del += Number(d) || 0;
				}
				out.insertions = ins;
				out.deletions = del;
			}
		}
		if (wt && fs.existsSync(wt)) {
			const porcelain = git(wt, ["status", "--porcelain"]);
			out.dirty = porcelain === null ? null : porcelain.split("\n").filter(Boolean).length;
		}
		out.validation = validationFor(stateDir, runId, slot, tip);
		out.candidate = status === "running";
		return out;
	});
	const key = (s) => [
		s.candidate ? 0 : 1,
		VALIDATION_ORDER[s.validation.status] ?? 9,
		s.commits > 0 ? 0 : 1,
		s.finished ? 0 : 1,
		s.slot,
	];
	slots.sort((a, b) => {
		const ka = key(a), kb = key(b);
		for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
		return 0;
	});
	let rank = 0;
	for (const s of slots) s.rank = s.candidate ? ++rank : null;
	const candidates = slots.filter((s) => s.candidate).sort((a, b) => a.slot - b.slot);
	const overlaps = [];
	for (let i = 0; i < candidates.length; i++) {
		const mine = candidates[i].files && new Set(candidates[i].files);
		for (let j = i + 1; j < candidates.length; j++) {
			const pair = { a: candidates[i].slot, b: candidates[j].slot };
			// Unknown is reported as unknown (count -1), never as "disjoint".
			if (!mine || !candidates[j].files) {
				overlaps.push({ ...pair, count: -1, shared: [] });
				continue;
			}
			const shared = candidates[j].files.filter((f) => mine.has(f)).sort();
			overlaps.push({ ...pair, count: shared.length, shared: shared.slice(0, SHARED_LIMIT) });
		}
	}
	return { slots, overlaps };
}

function main() {
	const [repo, fork, runId, stateDir] = process.argv.slice(2);
	// Fields are \x1f-separated, like read_slot's: TAB is legal in a path.
	const rows = fs.readFileSync(0, "utf8").split("\n").filter(Boolean).map((line) => {
		const [slot, label, branch, wt, status, finished, startedAt, finishedAt] = line.split("\x1f");
		return { slot: Number(slot), label, branch, path: wt, status, finished, startedAt, finishedAt };
	});
	const { slots, overlaps } = compareSlots({ repo, fork, runId, stateDir, rows });
	for (const s of slots) {
		const { files, ...rest } = s;
		process.stdout.write(`compare_slot\t${JSON.stringify({ ...rest, file_count: files ? files.length : null })}\n`);
	}
	for (const o of overlaps) {
		process.stdout.write(`compare_overlap\t${o.a}\t${o.b}\t${o.count}\t${JSON.stringify(o.shared)}\n`);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
