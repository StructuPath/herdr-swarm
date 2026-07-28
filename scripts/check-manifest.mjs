#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_SECTIONS = ["build", "startup", "actions", "panes", "events"];

function stripTomlComment(line) {
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quoted && char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') quoted = !quoted;
		else if (char === "#" && !quoted) return line.slice(0, index);
	}
	if (quoted) throw new Error("unterminated string");
	return line;
}

function parseTomlValue(raw) {
	const value = raw.trim();
	if (value.startsWith('"') || value.startsWith("[")) return JSON.parse(value);
	if (/^(?:true|false)$/.test(value)) return value === "true";
	if (/^-?[0-9]+$/.test(value)) return Number(value);
	throw new Error(`unsupported value ${JSON.stringify(value)}`);
}

// Herdr's manifest contract here uses root scalars and arrays of tables with
// scalar/string-array fields. Parsing that declared subset in Node keeps the
// validator zero-dependency and makes Node >=20 the complete CI toolchain.
function parseManifest(manifestPath) {
	const document = {};
	let current = document;
	try {
		for (const source of fs.readFileSync(manifestPath, "utf8").split(/\r?\n/)) {
			const line = stripTomlComment(source).trim();
			if (!line) continue;
			const table = line.match(/^\[\[([A-Za-z0-9_-]+)\]\]$/);
			if (table) {
				const section = table[1];
				document[section] ??= [];
				if (!Array.isArray(document[section]))
					throw new Error(`${section} is not an array of tables`);
				current = {};
				document[section].push(current);
				continue;
			}
			const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
			if (!assignment) throw new Error("unsupported statement");
			const [, key, raw] = assignment;
			if (Object.hasOwn(current, key)) throw new Error(`duplicate key ${key}`);
			current[key] = parseTomlValue(raw);
		}
		return document;
	} catch (error) {
		throw new Error(`manifest is not valid TOML: ${error.message}`);
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
