import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitIdent, mkdtemp } from "./harness.mjs";

test("freshEnv supplies deterministic identity to real Git descendants despite poisoned parent settings", () => {
	const config = path.join(mkdtemp("hs-identity-"), "gitconfig");
	fs.writeFileSync(config, "[user]\nname = Poisoned User\nemail = poisoned@example.invalid\n");
	const stub = [
		"set -e",
		'git -C "$TEST_REPO" commit -q --allow-empty -m child',
		'git -C "$TEST_REPO" worktree add -q -b identity-child "$TEST_WORKTREE"',
		'git -C "$TEST_REPO" log -1 --format="%an <%ae>|%cn <%ce>"',
		'git -C "$TEST_REPO" reflog show identity-child --format="%gn <%ge>"',
	].join("\n");
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { spawnSync } from "node:child_process";
		import path from "node:path";
		import { createHarness, mkdtemp } from ${JSON.stringify(new URL("./harness.mjs", import.meta.url).href)};
		const h = createHarness();
		const repo = h.makeRepo();
		// Fail deterministically when identity is missing, without provoking DNS.
		h.git(repo, "config", "user.useConfigOnly", "true");
		h.writeStub("herdr", ${JSON.stringify(stub)});
		const env = h.freshEnv({
			TEST_REPO: repo,
			TEST_WORKTREE: path.join(mkdtemp("hs-identity-wt-"), "slot"),
		});
		const child = spawnSync(env.HERDR_BIN_PATH, [], { env, encoding: "utf8", timeout: 10_000 });
		assert.equal(child.status, 0, child.stderr || child.error?.message);
		process.stdout.write(child.stdout);
	`], {
		encoding: "utf8",
		timeout: 20_000,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Poisoned Author",
			GIT_AUTHOR_EMAIL: "author@example.invalid",
			GIT_COMMITTER_NAME: "Poisoned Committer",
			GIT_COMMITTER_EMAIL: "committer@example.invalid",
			GIT_CONFIG_GLOBAL: config,
			GIT_CONFIG_SYSTEM: config,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "user.email",
			GIT_CONFIG_VALUE_0: "injected@example.invalid",
		},
	});
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	const author = `${gitIdent.GIT_AUTHOR_NAME} <${gitIdent.GIT_AUTHOR_EMAIL}>`;
	const committer = `${gitIdent.GIT_COMMITTER_NAME} <${gitIdent.GIT_COMMITTER_EMAIL}>`;
	assert.deepEqual(result.stdout.trim().split("\n"), [`${author}|${committer}`, committer]);
});
