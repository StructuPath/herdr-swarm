# GitHub draft handoff contract

Swarm 0.4 adds optional GitHub handoff to the existing harvest commands. The
five manifest actions remain unchanged; these are new `harvest-step.sh` verbs.

## Commands and authorization

From a configured Swarm run:

```sh
# Push committed slot work, then create/reuse its exact matching draft PR.
HERDR_SWARM_VALIDATION_FILE=/absolute/path/result.json \
  bash scripts/harvest-step.sh publish-pr 1

# Read the PR's current head and CI state.
bash scripts/harvest-step.sh pr-status 1
```

The harvest pane exposes `g`, then a slot digit, for draft handoff and `c`, then
a slot digit, for CI status. Selecting the slot in the draft prompt authorizes
the push/PR creation. `p` and `publish` retain their existing push-only behavior.
Scripts use the same workspace/repository context as other harvest verbs.

Requirements: Node >=20, Git, authenticated `gh` with access to the destination,
and an active Swarm run with owned slot resources. `HERDR_SWARM_PUBLISH_REMOTE`
defaults to `origin`. It must name a Git remote with exactly one fetch and push
URL identifying the same GitHub.com repository (ordinary HTTPS or SSH, without
embedded credentials). Fork destinations, multiple push URLs, and Enterprise
hosts are not supported yet. No remote/auth/CI configuration is changed.

The PR base is the manifest's recorded base branch. The head is the slot branch.
The existing ownership, fork ancestry, non-empty-work, and non-force-push guards
remain active. Uncommitted work is excluded with the existing warning. The
prepared SHA must still match before publishing; the push uses that audited SHA
and destination URL, then verifies the PR head. No automatic merge occurs.

## Explicit validation evidence

`HERDR_SWARM_VALIDATION_FILE` is optional. Omitting it reports `not_run`, never
success. This file is read only for `publish-pr`; `pr-status` does not read it.
Swarm executes no validation commands. It accepts a regular JSON file of at most
1 MiB in either format below. Symlinks and special files are refused; the byte
limit applies to the actual read, including a file growing while read.

```json
{
  "schema_version": 1,
  "head_sha": "0123456789012345678901234567890123456789",
  "checks": [
    { "name": "unit-tests", "status": "not_run" },
    { "name": "typecheck", "status": "pending" }
  ]
}
```

Replace the example SHA with the actual tested slot commit. `head_sha` must
equal the prepared published SHA. Supply 1–30 checks with unique names matching
`[a-z][a-z0-9_-]{0,47}`. Statuses are `passed`, `failed`, `pending`, or `not_run`.
Check names are explicitly public labels; keep them free of secrets. Additional
fields such as raw command output are never copied to the PR.

Browser QA's `result.json` is accepted directly when it has `schemaVersion: 1`,
`kind: "herdr-browser-qa"`, a matching `git.commit`, and explicitly false
`git.dirty` and `git.changedDuringRun`. Its summary fields must be nonnegative
integers, and `scenario.policy.failOnConsoleError`, `failOnPageError`, and
`failOnFailedRequest` must all be explicitly true. The summary requires
1–4 viewports and matching pass/fail totals. Typed per-run steps and telemetry
must agree with the summary counts. A passing `browser-qa` check additionally
requires every viewport run and step to pass, at least one successful assertion,
passed cleanup, no recorded errors or incomplete telemetry, and zero console
errors, page errors, failed requests, or unresolved requests.
Other valid reports become `failed`. Raw runs, URLs, paths, and screenshots are
not published. Browser QA observations do not prove the served application was
built from the recorded commit.

Both formats are caller-supplied observations, not authenticated attestations.
Failed or pending checks can be attached to a draft; Swarm does not mislabel them
or treat them as approval.

## Retry and existing PRs

Discovery requires exact repository/head/base identity and excludes fork PRs.
One matching open PR is reused whether draft or already marked ready for review.
Existing title/body/state is preserved. Consequently, `validation_attached` is
false on reuse: the existing body may describe an earlier SHA and must not be
treated as fresh evidence. The caller can review/update it manually on GitHub.
Closed/merged matches or ambiguous/truncated discovery refuse handoff.

Evidence, CLI access, and remote-format failures occur before the push. A push
failure never creates a PR. A PR API failure can occur **after** publication;
the existing manifest `published` receipt records the pushed SHA, and the branch
remains on the remote. Retry the same verb. If creation succeeded but its response
was lost, Swarm searches again and reuses the exact PR instead of duplicating it.
If GitHub's head differs from the audited SHA, handoff refuses success and leaves
the published branch/PR for inspection; it never force-pushes a correction.

## Machine-readable output

All commands retain the `key<TAB>value` stdout protocol and human errors on stderr.
Preparation drift uses exit 30; handoff/precondition failures use exit 36.
Existing ownership/manifest refusal codes continue to apply. A failed create may
still emit the earlier successful `published` record; check the process exit code.

Successful `publish-pr` emits the existing `published` record followed by:

```text
pull_request<TAB>{"schema_version":1,"repository":"owner/repo","number":7,"url":"https://github.com/owner/repo/pull/7","state":"OPEN","draft":true,"head_sha":"...","base":"main","branch":"swarm/run/slot","reused":false,"validation_attached":true,"validation":{"source":"supplied","head_sha":"...","checks":[{"name":"unit-tests","status":"passed"}]}}
```

Validation sources are `none`, `supplied`, or `browser_qa`.

`pr-status` emits `ci_status` with schema version, repository, number, URL, PR
state/draft status, `head_sha`, `local_head_sha`, `matches_local_head`, `status`,
and `check_count`. No matching PR emits only schema version, repository,
`local_head_sha`, and `status: "no_pr"`.

CI status values are `passed`, `failed`, `pending`, `not_run`, and `unknown`.
Empty checks and otherwise successful sets containing skipped/neutral checks
are `not_run`; unrecognized responses are `unknown`.
A remote/local mismatch leaves the remote CI status intact and sets
`matches_local_head: false`; callers must display that mismatch. Passing checks
do not establish branch-protection completeness or authorize a merge.

CI inspection makes only GitHub reads, with no fetch/push/PR edits. As with other
harvest verbs, it takes the local run lock while resolving and verifying context.
