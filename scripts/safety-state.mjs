#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function fail(message, code = 1) {
	process.stderr.write(`herdr-swarm: ${message}\n`);
	process.exit(code);
}

function git(repo, args, encoding = "utf8") {
	const result = spawnSync("git", ["-C", repo, ...args], {
		encoding: encoding === null ? undefined : encoding,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		fail(
			`git ${args.join(" ")} failed for ${repo}: ${String(result.stderr).trim()}`,
		);
	}
	return result.stdout;
}

function repoIdentity(repo) {
	const root = fs.realpathSync(
		git(repo, ["rev-parse", "--show-toplevel"]).trim(),
	);
	let common = git(repo, ["rev-parse", "--git-common-dir"]).trim();
	if (!path.isAbsolute(common)) common = path.resolve(root, common);
	common = fs.realpathSync(common);
	const repoKey = createHash("sha256")
		.update("herdr-swarm-repo-v1\0")
		.update(common)
		.digest("hex");
	return { repo_root: root, git_common_dir: common, repo_key: repoKey };
}

function isSafeId(value) {
	return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

function validateManifest(file, doc) {
	if (!doc || typeof doc !== "object" || Array.isArray(doc))
		throw new Error("root must be an object");
	if (!isSafeId(doc.run_id)) throw new Error("run_id is missing or unsafe");
	if (typeof doc.repo_root !== "string" || doc.repo_root.length === 0)
		throw new Error("repo_root is missing");
	if (
		typeof doc.base_ref !== "string" ||
		!doc.base_ref.startsWith("refs/heads/")
	)
		throw new Error("base_ref is invalid");
	if (!Array.isArray(doc.slots)) throw new Error("slots must be an array");
	const seen = new Set();
	for (const row of doc.slots) {
		if (!row || typeof row !== "object" || Array.isArray(row))
			throw new Error("slot row must be an object");
		const slot = String(row.slot ?? "");
		if (!/^[0-9]+$/.test(slot) || seen.has(slot))
			throw new Error("slot ids must be unique positive integers");
		seen.add(slot);
		if (
			typeof row.branch !== "string" ||
			!row.branch.startsWith(`swarm/${doc.run_id}/`)
		) {
			throw new Error(`slot ${slot} branch is outside the run namespace`);
		}
	}
	let identity;
	try {
		identity = repoIdentity(doc.repo_root);
	} catch (error) {
		throw new Error(`repo identity cannot be resolved: ${error.message}`);
	}
	if (doc.repo_key != null && doc.repo_key !== identity.repo_key)
		throw new Error("repo_key does not match repo_root");
	if (doc.git_common_dir != null) {
		let recorded;
		try {
			recorded = fs.realpathSync(doc.git_common_dir);
		} catch {
			throw new Error("git_common_dir cannot be resolved");
		}
		if (recorded !== identity.git_common_dir)
			throw new Error("git_common_dir does not match repo_root");
	}
	return { file, doc, identity };
}

function manifestFiles(stateDir) {
	return fs
		.readdirSync(stateDir)
		.filter((name) =>
			/^(?:run-[A-Za-z0-9_-]+|archived-[A-Za-z0-9_-]+)\.json$/.test(name),
		)
		.sort()
		.map((name) => path.join(stateDir, name));
}

function scan(stateDir, repo) {
	const target = repoIdentity(repo);
	const errors = [];
	const live = [];
	const archived = [];
	const runIds = new Map();
	for (const file of manifestFiles(stateDir)) {
		let stat;
		try {
			stat = fs.lstatSync(file);
		} catch (error) {
			errors.push(`${file}: cannot lstat: ${error.message}`);
			continue;
		}
		if (stat.isSymbolicLink() || !stat.isFile()) {
			errors.push(`${file}: bookkeeping must be a regular non-symlink file`);
			continue;
		}
		if (stat.size === 0) {
			errors.push(`${file}: bookkeeping is zero-length`);
			continue;
		}
		let parsed;
		try {
			parsed = validateManifest(
				file,
				JSON.parse(fs.readFileSync(file, "utf8")),
			);
		} catch (error) {
			errors.push(`${file}: ${error.message}`);
			continue;
		}
		if (parsed.identity.repo_key !== target.repo_key) continue;
		const previous = runIds.get(parsed.doc.run_id);
		if (previous)
			errors.push(
				`${file}: duplicate run_id ${parsed.doc.run_id} also appears in ${previous}`,
			);
		else runIds.set(parsed.doc.run_id, file);
		const item = {
			path: file,
			run_id: parsed.doc.run_id,
			workspace_id: path
				.basename(file)
				.replace(/^run-/, "")
				.replace(/\.json$/, ""),
			exclude_pattern_added: parsed.doc.exclude_pattern_added === true,
		};
		if (path.basename(file).startsWith("run-")) live.push(item);
		else archived.push(item);
	}
	if (live.length > 1)
		errors.push(
			`multiple live manifests exist for repo ${target.repo_key}: ${live.map((x) => x.path).join(", ")}`,
		);
	const activePath = path.join(stateDir, `active-repo-${target.repo_key}.json`);
	if (fs.existsSync(activePath)) {
		try {
			const stat = fs.lstatSync(activePath);
			if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0)
				throw new Error("must be a non-empty regular non-symlink file");
			const active = JSON.parse(fs.readFileSync(activePath, "utf8"));
			if (
				active.repo_key !== target.repo_key ||
				!isSafeId(active.run_id) ||
				typeof active.manifest_path !== "string"
			) {
				throw new Error("identity fields are invalid");
			}
			const match = live.find(
				(x) =>
					x.run_id === active.run_id &&
					path.resolve(x.path) === path.resolve(active.manifest_path),
			);
			if (!match)
				throw new Error("does not point to the exact live manifest generation");
		} catch (error) {
			errors.push(`${activePath}: active index ${error.message}`);
		}
	}
	return { ...target, active_index_path: activePath, live, archived, errors };
}

function canonicalInventory(repo, binding) {
	const output = git(
		repo,
		["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
		null,
	);
	const paths = [];
	let start = 0;
	for (let i = 0; i < output.length; i += 1) {
		if (output[i] !== 0) continue;
		const item = output.subarray(start, i);
		start = i + 1;
		if (item.length === 0 || item.equals(Buffer.from(".swarm-task.md")))
			continue;
		paths.push(Buffer.from(item));
	}
	paths.sort(Buffer.compare);
	const hash = createHash("sha256");
	hash.update("herdr-swarm-cleanup-v1\0");
	for (const value of [
		binding.repo_key,
		binding.git_common_dir,
		binding.run_id,
		binding.slot,
		binding.worktree,
		binding.operation_id,
	]) {
		const bytes = Buffer.from(String(value));
		const length = Buffer.alloc(8);
		length.writeBigUInt64BE(BigInt(bytes.length));
		hash.update(length).update(bytes);
	}
	for (const item of paths) {
		const length = Buffer.alloc(8);
		length.writeBigUInt64BE(BigInt(item.length));
		hash.update(length).update(item);
	}
	return {
		...binding,
		digest: hash.digest("hex"),
		count: paths.length,
		paths_base64: paths.map((item) => item.toString("base64")),
		paths_display: paths.map((item) => item.toString("utf8")),
	};
}

const [command, ...args] = process.argv.slice(2);
try {
	switch (command) {
		case "repo":
			process.stdout.write(`${JSON.stringify(repoIdentity(args[0]))}\n`);
			break;
		case "scan":
			process.stdout.write(`${JSON.stringify(scan(args[0], args[1]))}\n`);
			break;
		case "operation-id":
			process.stdout.write(
				`cleanup-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}\n`,
			);
			break;
		case "inventory": {
			const [repo, repoKey, common, runId, slot, worktree, operationId] = args;
			if (!isSafeId(runId) || !isSafeId(operationId) || !/^[0-9]+$/.test(slot))
				fail("cleanup inventory binding is invalid");
			const identity = repoIdentity(repo);
			if (identity.repo_key !== repoKey || identity.git_common_dir !== common)
				fail("cleanup inventory repo identity changed");
			const physical = fs.realpathSync(worktree);
			const binding = {
				repo_key: repoKey,
				git_common_dir: common,
				run_id: runId,
				slot,
				worktree: physical,
				operation_id: operationId,
			};
			process.stdout.write(
				`${JSON.stringify(canonicalInventory(physical, binding))}\n`,
			);
			break;
		}
		case "approval": {
			let raw = "";
			for await (const chunk of process.stdin) raw += chunk;
			const [inventoryRaw, stateDir] = args;
			const inventory = JSON.parse(inventoryRaw);
			const approval = JSON.parse(raw);
			for (const key of [
				"repo_key",
				"git_common_dir",
				"run_id",
				"slot",
				"worktree",
				"operation_id",
				"digest",
			]) {
				if (String(approval[key] ?? "") !== String(inventory[key] ?? ""))
					fail(`cleanup approval ${key} mismatch`, 2);
			}
			if (approval.approved !== true)
				fail("cleanup approval is not approved", 2);
			if (!isSafeId(approval.operation_id))
				fail("cleanup approval operation_id is unsafe", 2);
			const used = path.join(
				stateDir,
				`cleanup-used-${approval.repo_key}-${approval.operation_id}.json`,
			);
			if (fs.existsSync(used)) fail("cleanup approval was already consumed", 2);
			process.stdout.write(`${used}\n`);
			break;
		}
		case "consume": {
			let raw = "";
			for await (const chunk of process.stdin) raw += chunk;
			const [used] = args;
			const fd = fs.openSync(used, "wx", 0o600);
			fs.writeFileSync(fd, raw);
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			process.stdout.write(`${used}\n`);
			break;
		}
		default:
			fail(`unknown safety-state command '${command ?? ""}'`);
	}
} catch (error) {
	fail(error.message);
}
