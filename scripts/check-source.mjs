#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function checkSources(root) {
	let count = 0;
	const errors = [];
	for (const directory of ["scripts", "bin"]) {
		for (const name of fs.readdirSync(path.join(root, directory)).sort()) {
			const extension = path.extname(name);
			if (![".sh", ".mjs"].includes(extension)) continue;
			const file = path.join(root, directory, name);
			const command = extension === ".sh" ? "bash" : process.execPath;
			const flag = extension === ".sh" ? "-n" : "--check";
			const result = spawnSync(command, [flag, file], {
				encoding: "utf8",
				timeout: 10_000,
			});
			count += 1;
			if (result.status !== 0) {
				errors.push(`${directory}/${name}: ${result.error?.message ?? result.stderr}`);
			}
		}
	}
	return { count, errors };
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === sourcePath) {
	const result = checkSources(path.resolve(path.dirname(sourcePath), ".."));
	for (const error of result.errors) process.stderr.write(`${error}\n`);
	if (result.errors.length) process.exitCode = 1;
	else process.stdout.write(`Syntax valid: ${result.count} shell scripts and Node modules.\n`);
}
