import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtemp } from "./harness.mjs";
import { checkSources } from "../scripts/check-source.mjs";

test("source validation catches invalid later scripts and Node modules without executing them", () => {
	const root = mkdtemp("hs-source-");
	fs.mkdirSync(path.join(root, "scripts"));
	fs.mkdirSync(path.join(root, "bin"));
	fs.writeFileSync(path.join(root, "scripts/a.sh"), "exit 99\n");
	fs.writeFileSync(path.join(root, "scripts/z.sh"), "if then\n");
	fs.writeFileSync(path.join(root, "bin/broken.mjs"), "const = ;\n");
	const result = checkSources(root);
	assert.equal(result.count, 3);
	assert.equal(result.errors.length, 2);
	assert.match(result.errors.join("\n"), /scripts\/z.sh/);
	assert.match(result.errors.join("\n"), /bin\/broken.mjs/);
});
