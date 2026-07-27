import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateRepository } from "../scripts/check-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t, command = ["bash", "scripts/open.sh"]) {
	const container = fs.mkdtempSync(
		path.join(os.tmpdir(), "herdr-swarm-manifest-"),
	);
	t.after(() => fs.rmSync(container, { recursive: true, force: true }));
	const repository = path.join(container, "repository");
	fs.mkdirSync(path.join(repository, "scripts"), { recursive: true });
	fs.writeFileSync(
		path.join(repository, "package.json"),
		JSON.stringify({ version: "1.2.3" }),
	);
	fs.writeFileSync(
		path.join(repository, "herdr-plugin.toml"),
		`version = "1.2.3"\n[[actions]]\nid = "open"\ncommand = ${JSON.stringify(command)}\n`,
	);
	fs.writeFileSync(path.join(repository, "scripts", "open.sh"), "#!/bin/sh\n", {
		mode: 0o755,
	});
	return { container, repository };
}

test("repository manifest passes CI validation", () => {
	const result = validateRepository(root);
	assert.deepEqual(result.errors, []);
	assert.equal(result.entrypointCount, 8);
});

test("manifest validation reports malformed TOML", (t) => {
	const { repository } = fixture(t);
	fs.writeFileSync(path.join(repository, "herdr-plugin.toml"), 'version = "');

	assert.match(validateRepository(repository).errors[0], /not valid TOML/);
});

test("manifest validation reports package and manifest version mismatch", (t) => {
	const { repository } = fixture(t);
	fs.writeFileSync(
		path.join(repository, "package.json"),
		JSON.stringify({ version: "9.9.9" }),
	);

	assert.ok(
		validateRepository(repository).errors.some((error) =>
			error.startsWith("version mismatch:"),
		),
	);
});

test("manifest validation reports missing and non-executable entrypoints", (t) => {
	const { repository } = fixture(t);
	fs.rmSync(path.join(repository, "scripts", "open.sh"));
	let errors = validateRepository(repository).errors;
	assert.ok(errors.some((error) => error.includes("entrypoint does not exist")));

	fs.writeFileSync(path.join(repository, "scripts", "open.sh"), "#!/bin/sh\n", {
		mode: 0o644,
	});
	errors = validateRepository(repository).errors;
	assert.ok(errors.some((error) => error.includes("entrypoint is not executable")));
});

test("manifest validation rejects entrypoints outside the repository", (t) => {
	const { container, repository } = fixture(t, ["bash", "../outside.sh"]);
	fs.writeFileSync(path.join(container, "outside.sh"), "#!/bin/sh\n", {
		mode: 0o755,
	});

	assert.ok(
		validateRepository(repository).errors.some((error) =>
			error.includes("entrypoint escapes the repository"),
		),
	);
});
