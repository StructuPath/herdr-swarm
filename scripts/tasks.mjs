// tasks.mjs — per-slot task files and fan-out conflict hints.
//
// A task file may carry one section per slot, each opened by a marker line
//
//   <!-- swarm-slot: N -->
//
// (an HTML comment: invisible when the brief is rendered as markdown, and not
// something a normal brief contains by accident). Text before the first
// marker is a shared preamble every slot receives; slot N's task is the
// preamble followed by its own section. A file with no markers is one shared
// task, exactly as before.
//
//   node tasks.mjs max <file>
//       highest section number, or 0 when the file has no markers
//   node tasks.mjs split <file> <n> <outdir>
//       writes <outdir>/slot-<i>.md (the task) and slot-<i>.focus.md (the
//       slot's OWN text — its section, or the whole task when unsectioned) for
//       i = 1..n; refuses duplicate/out-of-range sections, near-miss markers,
//       and slots left with no task at all; prints `preamble_only<TAB>i` for
//       slots that got the shared preamble alone. Markers inside ``` / ~~~
//       fences are text.
//   node tasks.mjs overlaps <repo> <focus-file>...
//       one `overlap<TAB>a<TAB>b<TAB>path` line per pair of slots whose
//       distinct tasks name the same tracked path (or a path inside a tracked
//       directory the other names), or one `skipped<TAB>why` when the repo
//       cannot be listed. A hint for the operator, not a gate.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MARKER = /^\s*<!--\s*swarm-slot:\s*(\d+)\s*-->\s*$/;
// Anything that LOOKS like a marker but does not parse as one. Silently
// keeping it as text would hand one slot two slots' work (and could shrink
// the slot count when it was the highest marker), so it is a refusal.
const NEAR_MARKER = /<!--\s*swarm[-_ ]?slot/i;
const FENCE = /^\s*(```|~~~)/;

export function parseSections(text) {
	const sections = new Map();
	let preamble = [];
	let current = null;
	let fence = null;
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		// Inside a fenced code block nothing is a marker: a brief may well show
		// the marker syntax as an example.
		const f = line.match(FENCE);
		if (f && (fence === null || f[1] === fence)) fence = fence === null ? f[1] : null;
		const m = fence === null && !f ? line.match(MARKER) : null;
		if (!m && fence === null && !f && NEAR_MARKER.test(line) && /^\s*<!--/.test(line)) {
			throw new Error(`line ${index + 1} looks like a slot marker but is not one: '${line.trim()}' — write it as <!-- swarm-slot: N -->`);
		}
		if (m) {
			const slot = Number(m[1]);
			if (!Number.isSafeInteger(slot) || slot < 1) throw new Error(`invalid slot marker '${line.trim()}' — slots start at 1`);
			if (sections.has(slot)) throw new Error(`slot ${slot} has two sections`);
			current = [];
			sections.set(slot, current);
			continue;
		}
		(current ?? preamble).push(line);
	}
	const join = (lines) => lines.join("\n").replace(/^\s*\n/, "").replace(/\s+$/, "");
	return { preamble: join(preamble), sections: new Map([...sections].map(([k, v]) => [k, join(v)])) };
}

export function splitTasks(text, n) {
	const { preamble, sections } = parseSections(text);
	if (sections.size === 0) {
		const whole = text.replace(/\s+$/, "");
		return Array.from({ length: n }, () => ({ task: whole, focus: whole }));
	}
	for (const slot of sections.keys()) {
		if (slot > n) throw new Error(`the task file has a section for slot ${slot}, but the run has ${n} slot(s)`);
	}
	return Array.from({ length: n }, (_, i) => {
		const own = sections.get(i + 1) ?? "";
		const task = [preamble, own].filter((part) => part !== "").join("\n\n");
		if (task.replace(/\s/g, "") === "") throw new Error(`slot ${i + 1} has no task — give it a section, or put shared text before the first marker`);
		// Allowed (a preamble can be the whole brief for extra slots), but in a
		// sectioned file it is often a missing section — callers say so.
		return { task, focus: own, preambleOnly: own.replace(/\s/g, "") === "" };
	});
}

// Words that look like paths: anything in backticks, plus bare words that
// contain a slash or end in a file extension. Surrounding punctuation and a
// leading ./ are stripped. Only tokens that are real tracked paths (or
// directories of tracked files) survive, which keeps prose from matching.
export function mentionedPaths(text, tracked) {
	const raw = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
	for (const word of text.split(/\s+/)) if (/\/|\.[A-Za-z0-9]{1,8}[)\].,;:'"]*$/.test(word)) raw.push(word);
	const found = new Set();
	for (let token of raw) {
		token = token.trim().replace(/^[("'[<]+/, "").replace(/[)\]>"',.;:!?]+$/, "").replace(/^\.\//, "").replace(/\/+$/, "");
		if (token && (tracked.files.has(token) || tracked.dirs.has(token))) found.add(token);
	}
	return found;
}

// Throws when git cannot list the repo (or the listing is over 256 MiB):
// the caller reports the hint as skipped instead of implying "no conflicts".
export function trackedPaths(repo) {
	const r = spawnSync("git", ["-C", repo, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(r.error?.code === "ENOBUFS" ? "the tracked-file list is too large" : "git ls-files failed");
	const files = new Set(r.stdout.split("\0").filter(Boolean));
	const dirs = new Set();
	for (const f of files) {
		const parts = f.split("/");
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
	}
	return { files, dirs };
}

const within = (p, q) => p === q || q.startsWith(`${p}/`);

// Pairs of slots whose focus texts differ and name overlapping paths. Slots
// with identical focus text (best-of-N on one task) are expected to overlap.
export function findOverlaps(focusTexts, tracked) {
	const mentions = focusTexts.map((t) => mentionedPaths(t, tracked));
	const out = [];
	for (let a = 0; a < focusTexts.length; a++) {
		for (let b = a + 1; b < focusTexts.length; b++) {
			if (focusTexts[a] === focusTexts[b]) continue;
			const hits = new Set();
			for (const p of mentions[a]) for (const q of mentions[b]) {
				if (within(p, q)) hits.add(q);
				else if (within(q, p)) hits.add(p);
			}
			for (const p of [...hits].sort()) out.push({ a: a + 1, b: b + 1, path: p });
		}
	}
	return out;
}

function main(cmd, args) {
	if (cmd === "max") {
		const { sections } = parseSections(fs.readFileSync(args[0], "utf8"));
		process.stdout.write(`${sections.size ? Math.max(...sections.keys()) : 0}\n`);
	} else if (cmd === "split") {
		const [file, n, outdir] = args;
		const tasks = splitTasks(fs.readFileSync(file, "utf8"), Number(n));
		tasks.forEach(({ task, focus, preambleOnly }, i) => {
			fs.writeFileSync(path.join(outdir, `slot-${i + 1}.md`), `${task}\n`);
			fs.writeFileSync(path.join(outdir, `slot-${i + 1}.focus.md`), focus);
			if (preambleOnly) process.stdout.write(`preamble_only\t${i + 1}\n`);
		});
	} else if (cmd === "overlaps") {
		const [repo, ...files] = args;
		let tracked;
		try {
			tracked = trackedPaths(repo);
		} catch (error) {
			process.stdout.write(`skipped\t${error.message}\n`);
			return;
		}
		for (const o of findOverlaps(files.map((f) => fs.readFileSync(f, "utf8")), tracked)) {
			process.stdout.write(`overlap\t${o.a}\t${o.b}\t${o.path}\n`);
		}
	} else {
		throw new Error(`unknown command '${cmd}'`);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv[2], process.argv.slice(3));
	} catch (error) {
		process.stderr.write(`herdr-swarm: task file: ${error.message}\n`);
		process.exitCode = 1;
	}
}
