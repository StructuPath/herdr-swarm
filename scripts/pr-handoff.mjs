#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const FIELDS = "number,url,state,isDraft,headRefName,headRefOid,baseRefName,headRepository,isCrossRepository";
const refuse = (message) => { throw new Error(message); };
const ROUTING = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_PREFIX", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]);

function command(binary, args, cwd) {
	const env = { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" };
	if (binary === "git") {
		for (const key of Object.keys(env)) {
			if (ROUTING.has(key) || /^GIT_CONFIG_(KEY|VALUE)_/.test(key)) delete env[key];
		}
	}
	const result = spawnSync(binary, args, {
		cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
		env,
	});
	if (result.status !== 0) {
		refuse(`${path.basename(binary)} ${args[0]} failed${result.error?.code === "ENOENT" ? " (command not installed)" : ""}; verify access and retry. No automatic merge or force push was attempted.`);
	}
	return result.stdout.trim();
}

function readEvidenceFile(filename) {
	const limit = 1024 * 1024;
	const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > limit) refuse("Validation evidence must be a regular JSON file no larger than 1 MiB.");
		const bytes = Buffer.alloc(limit + 1);
		let length = 0;
		while (length < bytes.length) {
			const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
			if (read === 0) break;
			length += read;
		}
		if (length > limit) refuse("Validation evidence exceeded 1 MiB while reading.");
		return bytes.subarray(0, length).toString("utf8");
	} finally { fs.closeSync(fd); }
}

function githubRepository(url) {
	const match = url.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
	if (!match || [".", ".."].includes(match[1]) || [".", ".."].includes(match[2])) {
		refuse("PR handoff requires an ordinary GitHub.com SSH/HTTPS remote without embedded credentials.");
	}
	return `${match[1]}/${match[2]}`;
}

export function validationEvidence(filename, sha) {
	if (!filename) return { source: "none", head_sha: sha, checks: [{ name: "validation", status: "not_run" }] };
	const value = JSON.parse(readEvidenceFile(filename));
	if (value?.kind === "herdr-browser-qa") {
		const summary = value.summary;
		if (value.schemaVersion !== 1 || value.git?.commit !== sha || value.git?.dirty !== false || value.git?.changedDuringRun !== false) {
			refuse("Browser QA evidence must match the published commit and record a clean, unchanged checkout.");
		}
		if (!["failOnConsoleError", "failOnPageError", "failOnFailedRequest"].every((key) => value.scenario?.policy?.[key] === true)) refuse("Browser QA handoff requires all three strict error policies to be enabled.");
		if (!["passed", "failed"].includes(value.status) || !["passed", "failed"].includes(value.cleanup?.status) ||
			!["viewports", "passed", "failed", "assertions", "consoleErrors", "pageErrors", "failedRequests"].every((key) => Number.isSafeInteger(summary?.[key]) && summary[key] >= 0) ||
			summary.viewports < 1 || summary.passed + summary.failed !== summary.viewports) refuse("Browser QA summary is malformed.");
		const runs = value.runs;
		const stepTypes = new Set(["navigate", "click", "fill", "waitFor", "screenshot", "assertVisible", "assertText", "assertUrl", "assertTitle"]);
		if (!Array.isArray(runs) || runs.length > summary.viewports || summary.viewports > 4 || runs.some(run =>
			!["passed", "failed"].includes(run?.status) || !Array.isArray(run.steps) || run.steps.length > 40 ||
			run.steps.some((step, index) => !stepTypes.has(step?.type) || step.index !== index || !["passed", "failed"].includes(step.status)) ||
			!["consoleErrors", "pageErrors", "failedRequests"].every(key => Array.isArray(run[key])) ||
			!Number.isSafeInteger(run.unresolvedRequests) || run.unresolvedRequests < 0)) refuse("Browser QA runs are malformed.");
		const assertions = runs.flatMap(run => run.steps).filter(step => step.type.startsWith("assert"));
		if (summary.passed !== runs.filter(run => run.status === "passed").length || summary.assertions !== assertions.length ||
			!["consoleErrors", "pageErrors", "failedRequests"].every(key => summary[key] === runs.reduce((sum, run) => sum + run[key].length, 0))) refuse("Browser QA summary contradicts its runs.");
		const passed = value.status === "passed" && value.cleanup.status === "passed" && !value.error &&
			runs.length === summary.viewports && summary.failed === 0 && assertions.length > 0 && assertions.every(step => step.status === "passed") &&
			runs.every(run => run.status === "passed" && run.steps.length > 0 && run.steps.every(step => step.status === "passed" && !step.error) &&
				!["error", "evidenceError", "telemetryError", "cleanupError"].some(key => run[key]) &&
				run.consoleErrors.length === 0 && run.pageErrors.length === 0 && run.failedRequests.length === 0 && run.unresolvedRequests === 0);
		return { source: "browser_qa", head_sha: sha, checks: [{ name: "browser-qa", status: passed ? "passed" : "failed" }] };
	}
	if (value?.schema_version !== 1 || value.head_sha !== sha || !Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 30) {
		refuse("Validation evidence must have schema_version 1, the published head_sha, and 1–30 checks.");
	}
	const names = new Set();
	const checks = value.checks.map((check) => {
		if (!/^[a-z][a-z0-9_-]{0,47}$/.test(check?.name) || names.has(check.name) || !["passed", "failed", "pending", "not_run"].includes(check.status)) refuse("Validation check names/statuses are invalid or duplicated.");
		names.add(check.name);
		return { name: check.name, status: check.status };
	});
	return { source: "supplied", head_sha: sha, checks };
}

function context(args) {
	const [root, run, slot, branch, base, fork] = args;
	if (!root || !/^[A-Za-z0-9_-]+$/.test(run) || !/^[0-9]+$/.test(slot) || !branch?.startsWith(`swarm/${run}/`) || !base || !SHA.test(fork)) refuse("Invalid handoff context.");
	const git = (...values) => command("git", ["-C", root, ...values], root);
	const remote = process.env.HERDR_SWARM_PUBLISH_REMOTE || "origin";
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) refuse("PR handoff requires a named Git remote.");
	const push = git("remote", "get-url", "--push", "--all", remote).split("\n");
	const fetch = git("remote", "get-url", "--all", remote).split("\n");
	if (push.length !== 1 || fetch.length !== 1) refuse("PR handoff requires exactly one fetch and push URL.");
	const repository = githubRepository(push[0]);
	if (githubRepository(fetch[0]).toLowerCase() !== repository.toLowerCase()) refuse("Fetch and push remotes must identify the same GitHub repository.");
	const sha = git("rev-parse", "--verify", `refs/heads/${branch}`);
	if (!SHA.test(sha)) refuse("Cannot resolve slot commit.");
	return { root, run, slot: Number(slot), branch, base, fork, sha, remote, repository, push_url: push[0] };
}

function gh(plan, args) {
	return command("gh", args, plan.root);
}

function assertPrIdentity(plan, pr) {
	if (!pr || !Number.isSafeInteger(pr.number) || pr.number < 1 ||
		typeof pr.url !== "string" || pr.url.toLowerCase() !== `https://github.com/${plan.repository}/pull/${pr.number}`.toLowerCase() ||
		!SHA.test(pr.headRefOid) || typeof pr.isDraft !== "boolean" || !["OPEN", "CLOSED", "MERGED"].includes(pr.state) ||
		pr.headRefName !== plan.branch || pr.baseRefName !== plan.base || pr.isCrossRepository !== false ||
		pr.headRepository?.nameWithOwner?.toLowerCase() !== plan.repository.toLowerCase()) {
		refuse("GitHub returned an invalid PR identity.");
	}
}

function matchingPr(plan) {
	const prs = JSON.parse(gh(plan, ["pr", "list", "--repo", `github.com/${plan.repository}`, "--state", "all", "--head", plan.branch, "--base", plan.base, "--limit", "100", "--json", FIELDS]));
	if (!Array.isArray(prs) || prs.length >= 100) refuse("PR discovery is ambiguous or truncated; inspect GitHub manually.");
	const matching = prs.filter((pr) => pr.headRefName === plan.branch && pr.baseRefName === plan.base && pr.isCrossRepository === false && pr.headRepository?.nameWithOwner?.toLowerCase() === plan.repository.toLowerCase());
	if (matching.length > 1) refuse("Multiple exact matching PRs found; inspect GitHub manually.");
	if (matching.length === 1) {
		const pr = matching[0];
		assertPrIdentity(plan, pr);
		return pr;
	}
	return null;
}

function body(plan) {
	return [
		`Swarm slot ${plan.slot} from run \`${plan.run}\`.`, "",
		`Published commit: \`${plan.sha}\``,
		`Fork commit: \`${plan.fork}\``, "",
		"Validation summary (caller-supplied evidence, not an authenticated attestation):", "",
		...plan.validation.checks.map((check) => `- ${check.name}: **${check.status}**`), "",
		"No validation commands were run by this handoff. Browser QA observations do not prove the served application was built from this commit.",
		"Review this draft and CI before deciding whether to merge. No automatic merge is configured.", "",
	].join("\n");
}

function prResult(plan, pr, reused) {
	return { schema_version: 1, repository: plan.repository, number: pr.number, url: pr.url,
		state: pr.state, draft: pr.isDraft, head_sha: pr.headRefOid, base: plan.base, branch: plan.branch,
		reused, validation_attached: !reused, validation: plan.validation ?? null };
}

export function ciSummary(checks) {
	if (!Array.isArray(checks)) return "unknown";
	if (checks.length === 0) return "not_run";
	const states = checks.map((check) => {
		if (check.__typename === "CheckRun") {
			if (check.status !== "COMPLETED") return ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"].includes(check.status) ? "pending" : "unknown";
			if (check.conclusion === "SUCCESS") return "passed";
			if (["NEUTRAL", "SKIPPED"].includes(check.conclusion)) return "not_run";
			return ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(check.conclusion) ? "failed" : "unknown";
		}
		if (check.__typename === "StatusContext") return ({ SUCCESS: "passed", FAILURE: "failed", ERROR: "failed", PENDING: "pending", EXPECTED: "pending" })[check.state] ?? "unknown";
		return "unknown";
	});
	for (const state of ["failed", "unknown", "pending"]) if (states.includes(state)) return state;
	return states.every(state => state === "passed") ? "passed" : "not_run";
}

function main(mode, args) {
	if (mode === "prepare") {
		const plan = context(args);
		plan.validation = validationEvidence(process.env.HERDR_SWARM_VALIDATION_FILE, plan.sha);
		const pr = matchingPr(plan);
		if (pr && pr.state !== "OPEN") refuse("The exact matching PR is closed or merged; inspect it manually before retrying.");
		process.stdout.write(JSON.stringify(plan));
	} else if (mode === "handoff") {
		const plan = JSON.parse(fs.readFileSync(0, "utf8"));
		let pr = matchingPr(plan);
		let reused = true;
		if (pr && pr.state !== "OPEN") refuse("The matching PR was closed while publishing; branch remains published.");
		if (!pr) {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pr-"));
			try {
				const filename = path.join(directory, "body.md");
				fs.writeFileSync(filename, body(plan), { mode: 0o600 });
				try {
					gh(plan, ["pr", "create", "--repo", `github.com/${plan.repository}`, "--draft", "--head", plan.branch, "--base", plan.base, "--title", `Swarm ${plan.run}: slot ${plan.slot}`, "--body-file", filename]);
					reused = false;
				} catch (error) {
					// The request may have succeeded before its response was lost.
					pr = matchingPr(plan);
					if (!pr) throw error;
				}
			} finally { fs.rmSync(directory, { recursive: true, force: true }); }
			pr ??= matchingPr(plan);
		}
		if (!pr || pr.state !== "OPEN" || pr.headRefOid !== plan.sha) refuse("Published PR head changed or could not be verified; inspect GitHub and retry. The branch remains published.");
		if (!reused && !pr.isDraft) refuse("GitHub did not confirm a draft PR; inspect the created PR manually.");
		process.stdout.write(`pull_request\t${JSON.stringify(prResult(plan, pr, reused))}\n`);
	} else if (mode === "status") {
		const plan = context(args);
		const pr = matchingPr(plan);
		if (!pr) {
			process.stdout.write(`ci_status\t${JSON.stringify({ schema_version: 1, repository: plan.repository, status: "no_pr", local_head_sha: plan.sha })}\n`);
			return;
		}
		const current = JSON.parse(gh(plan, ["pr", "view", String(pr.number), "--repo", `github.com/${plan.repository}`, "--json", `${FIELDS},statusCheckRollup`]));
		assertPrIdentity(plan, current);
		if (current.number !== pr.number) refuse("PR identity changed during status inspection.");
		process.stdout.write(`ci_status\t${JSON.stringify({ schema_version: 1, repository: plan.repository, number: current.number, url: pr.url, state: current.state, draft: current.isDraft, head_sha: current.headRefOid, local_head_sha: plan.sha, matches_local_head: current.headRefOid === plan.sha, status: ciSummary(current.statusCheckRollup), check_count: Array.isArray(current.statusCheckRollup) ? current.statusCheckRollup.length : 0 })}\n`);
	} else refuse("Unknown PR handoff operation.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { main(process.argv[2], process.argv.slice(3)); }
	catch (error) {
		process.stderr.write(`herdr-swarm: ${error instanceof SyntaxError ? "Malformed JSON in evidence or GitHub response." : error.message}\n`);
		process.exitCode = 36;
	}
}
