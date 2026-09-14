import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHarness } from "./harness.mjs";

const h = createHarness();
h.writeHerdrStub();

test("doctor accepts the tested CLI and never opens or changes session/state", () => {
	const absentState = path.join(h.stateDir, "untouched");
	const result = h.runScript("doctor.sh", [], h.freshEnv({
		HERDR_PLUGIN_STATE_DIR: absentState,
		STUB_HERDR_VERSION: "0.7.5",
	}));
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /OK Node/);
	assert.equal(h.log().trim(), "herdr --version");
	assert.equal(fs.existsSync(absentState), false);
});

test("doctor refuses an old CLI and explains the explicit binary override", () => {
	const result = h.runScript("doctor.sh", [], h.freshEnv({ STUB_HERDR_VERSION: "0.7.1" }));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /HERDR_BIN_PATH/);
	assert.match(result.stderr, /0.7.4 or newer/);
});

test("doctor warns for an untested newer CLI without claiming live compatibility", () => {
	const result = h.runScript("doctor.sh", [], h.freshEnv({ STUB_HERDR_VERSION: "0.8.2" }));
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /newer than tested/);
	assert.match(result.stdout, /does not exercise a Herdr session/);
});

test("doctor reports a missing explicit CLI", () => {
	const result = h.runScript("doctor.sh", [], h.freshEnv({ HERDR_BIN_PATH: "/does-not-exist/herdr" }));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /cannot determine herdr version/);
});
