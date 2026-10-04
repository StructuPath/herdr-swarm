import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSections, splitTasks, mentionedPaths, findOverlaps } from "../scripts/tasks.mjs";

const tracked = {
	files: new Set(["src/api/client.ts", "src/api/retry.ts", "src/ui/button.tsx", "README.md", "package.json"]),
	dirs: new Set(["src", "src/api", "src/ui"]),
};

test("an unmarked file is one shared task for every slot", () => {
	const tasks = splitTasks("Do the thing.\nCarefully.\n\n", 3);
	assert.deepEqual(tasks, Array(3).fill({ task: "Do the thing.\nCarefully.", focus: "Do the thing.\nCarefully." }));
});

test("sections follow a shared preamble; a slot without one gets the preamble", () => {
	const text = "Repo uses pnpm.\n\n<!-- swarm-slot: 1 -->\nAdd retries.\n<!--swarm-slot:3-->\nFix the button.\n";
	assert.deepEqual(parseSections(text).preamble, "Repo uses pnpm.");
	assert.deepEqual(splitTasks(text, 3), [
		{ task: "Repo uses pnpm.\n\nAdd retries.", focus: "Add retries.", preambleOnly: false },
		{ task: "Repo uses pnpm.", focus: "", preambleOnly: true },
		{ task: "Repo uses pnpm.\n\nFix the button.", focus: "Fix the button.", preambleOnly: false },
	]);
});

test("section errors are refusals, never guesses", () => {
	assert.throws(() => parseSections("<!-- swarm-slot: 0 -->\nx"), /slots start at 1/);
	assert.throws(() => parseSections("<!-- swarm-slot: 2 -->\na\n<!-- swarm-slot: 2 -->\nb"), /slot 2 has two sections/);
	assert.throws(() => splitTasks("<!-- swarm-slot: 4 -->\nx", 3), /section for slot 4, but the run has 3/);
	assert.throws(() => splitTasks("<!-- swarm-slot: 1 -->\nonly one", 2), /slot 2 has no task/);
});

test("a marker inside prose or a fenced code block is not a marker", () => {
	assert.equal(parseSections("Explain how `<!-- swarm-slot: 2 -->` works.\n").sections.size, 0);
	const doc = [
		"<!-- swarm-slot: 1 -->",
		"Document the syntax:",
		"```markdown",
		"<!-- swarm-slot: 1 -->",
		"<!-- swarm_slot: typo inside an example is fine too -->",
		"```",
		"~~~",
		"<!-- swarm-slot: 9 -->",
		"~~~",
		"<!-- swarm-slot: 2 -->",
		"Second task.",
	].join("\n");
	const { sections } = parseSections(doc);
	assert.deepEqual([...sections.keys()], [1, 2]);
	assert.match(sections.get(1), /```markdown\n<!-- swarm-slot: 1 -->/, "the example survives verbatim");
});

test("a near-miss marker is refused by line, never kept as text", () => {
	for (const typo of ["<!-- swarm_slot: 2 -->", "<!-- swarm slot: 2 -->", "<!-- Swarm-Slot: 2 -->", "<!-- swarm-slot: two -->", "<!-- swarm-slot 2 -->"]) {
		assert.throws(() => parseSections(`<!-- swarm-slot: 1 -->\nA\n${typo}\nB\n`), /line 3 looks like a slot marker but is not one/, typo);
	}
});

test("slots that get the preamble alone are flagged", () => {
	const tasks = splitTasks("Shared.\n<!-- swarm-slot: 1 -->\nOwn.\n<!-- swarm-slot: 2 -->\n   \n", 3);
	assert.deepEqual(tasks.map((t) => t.preambleOnly), [false, true, true]);
});

test("overlaps CLI says 'skipped' when the repo cannot be listed", async () => {
	const { spawnSync } = await import("node:child_process");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-notrepo-"));
	const focus = path.join(dir, "f.md");
	fs.writeFileSync(focus, "src/a.ts");
	const r = spawnSync("node", [new URL("../scripts/tasks.mjs", import.meta.url).pathname, "overlaps", dir, focus, focus], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^skipped\tgit ls-files failed$/m);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("only real tracked paths count as mentions", () => {
	const found = mentionedPaths("Touch `src/api/client.ts`, then ./src/ui/button.tsx. Read README.md (and docs/missing.md). Mind src/api/", tracked);
	assert.deepEqual([...found].sort(), ["README.md", "src/api", "src/api/client.ts", "src/ui/button.tsx"]);
	assert.deepEqual([...mentionedPaths("Refactor the api client and/or the retry logic", tracked)], []);
});

test("overlaps: same file, or a file inside a directory the other slot names", () => {
	const overlaps = findOverlaps([
		"Add retries in `src/api/retry.ts`.",
		"Restructure src/api for the new auth.",
		"Restyle `src/ui/button.tsx`.",
	], tracked);
	assert.deepEqual(overlaps, [{ a: 1, b: 2, path: "src/api/retry.ts" }]);
});

test("identical tasks (best-of-N) and empty focus never warn", () => {
	assert.deepEqual(findOverlaps(Array(3).fill("Fix `src/api/client.ts`."), tracked), []);
	assert.deepEqual(findOverlaps(["Fix `src/api/client.ts`.", ""], tracked), []);
});
