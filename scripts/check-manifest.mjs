#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_SECTIONS = ["build", "startup", "actions", "panes", "events"];
const TOML_TO_JSON = `
import json
import sys
import tomllib

with open(sys.argv[1], "rb") as manifest:
    json.dump(tomllib.load(manifest), sys.stdout)
`;

function parseManifest(manifestPath) {
	const result = spawnSync("python3", ["-c", TOML_TO_JSON, manifestPath], {
		encoding: "utf8",
	});
	if (result.error) {
		throw new Error(
			`could not run python3 to parse the manifest: ${result.error.message}`,
		);
	}
	if (result.status !== 0) {
		throw new Error(`manifest is not valid TOML: ${result.stderr.trim()}`);
	}
	try {
		return JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(`manifest parser returned invalid JSON: ${error.message}`);
	}
}

function manifestCommands(manifest, errors) {
	const commands = [];
	for (const section of COMMAND_SECTIONS) {
		const entries = manifest[section] ?? [];
		if (!Array.isArray(entries)) {
			errors.push(`manifest section ${section} must be an array`);
			continue;
		}
		for (const [index, entry] of entries.entries()) {
			if (
				!entry ||
				!Array.isArray(entry.command) ||
				entry.command.length === 0 ||
				entry.command.some(
					(argument) => typeof argument !== "string" || argument.length === 0,
				)
			) {
				errors.push(
					`${section}[${index}] must declare a non-empty string command array`,
				);
				continue;
			}
			commands.push({ label: `${section}[${index}]`, command: entry.command });
		}
	}
	return commands;
}

function commandEntrypoint(command) {
	if (["bash", "node", "sh"].includes(command[0])) return command[1] ?? null;
	if (command[0].includes("/")) return command[0];
	return undefined;
}

function escapesRepository(root, target) {
	const relative = path.relative(root, target);
	return (
		path.isAbsolute(relative) ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`)
	);
}

export function validateRepository(root) {
	const errors = [];
	let repositoryRoot;
	let packageJson;
	let manifest;

	try {
		repositoryRoot = fs.realpathSync(root);
	} catch (error) {
		return {
			errors: [`repository root could not be resolved: ${error.message}`],
			entrypointCount: 0,
		};
	}

	try {
		packageJson = JSON.parse(
			fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
		);
	} catch (error) {
		errors.push(`package.json could not be parsed: ${error.message}`);
	}

	try {
		manifest = parseManifest(path.join(repositoryRoot, "herdr-plugin.toml"));
	} catch (error) {
		errors.push(error.message);
	}

	if (!packageJson || !manifest) return { errors, entrypointCount: 0 };

	if (typeof manifest.version !== "string") {
		errors.push("manifest version must be a string");
	} else if (packageJson.version !== manifest.version) {
		errors.push(
			`version mismatch: package.json=${packageJson.version} herdr-plugin.toml=${manifest.version}`,
		);
	}

	let entrypointCount = 0;
	for (const { label, command } of manifestCommands(manifest, errors)) {
		const entrypoint = commandEntrypoint(command);
		if (entrypoint === undefined) continue;
		if (entrypoint === null) {
			errors.push(`${label} command is missing an entrypoint`);
			continue;
		}

		entrypointCount += 1;
		const target = path.resolve(repositoryRoot, entrypoint);
		if (escapesRepository(repositoryRoot, target)) {
			errors.push(`${label} entrypoint escapes the repository: ${entrypoint}`);
			continue;
		}

		let realTarget;
		try {
			realTarget = fs.realpathSync(target);
		} catch {
			errors.push(`${label} entrypoint does not exist: ${entrypoint}`);
			continue;
		}
		if (escapesRepository(repositoryRoot, realTarget)) {
			errors.push(
				`${label} entrypoint resolves outside the repository: ${entrypoint}`,
			);
			continue;
		}

		const stat = fs.statSync(realTarget);
		if (!stat.isFile()) {
			errors.push(`${label} entrypoint is not a file: ${entrypoint}`);
		} else if ((stat.mode & 0o111) === 0) {
			errors.push(`${label} entrypoint is not executable: ${entrypoint}`);
		}
	}

	return { errors, entrypointCount };
}

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === sourcePath) {
	const root = path.resolve(path.dirname(sourcePath), "..");
	const result = validateRepository(root);
	if (result.errors.length > 0) {
		for (const error of result.errors) {
			process.stderr.write(`error: ${error}\n`);
		}
		process.exitCode = 1;
	} else {
		process.stdout.write(
			`Manifest valid: versions match and ${result.entrypointCount} entrypoints are contained, present, and executable.\n`,
		);
	}
}
