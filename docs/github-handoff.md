# GitHub draft handoff contract

Swarm 0.4 adds optional GitHub handoff to the existing harvest commands. The
five manifest actions remain unchanged; these are new `harvest-step.sh` verbs.

## Commands and authorization

From a configured Swarm run:

```sh
# Legacy mode: push committed slot work, then create/reuse its exact draft PR.
HERDR_SWARM_VALIDATION_FILE=/absolute/path/result.json \
  bash scripts/harvest-step.sh publish-pr 1

# Strict candidate mode: all three files are required and revalidated here.
HERDR_SWARM_CANDIDATE_VALIDATION_FILE=/absolute/path/checks.json \
HERDR_SWARM_CANDIDATE_BROWSER_QA_FILE=/absolute/path/browser-qa.json \
HERDR_SWARM_CANDIDATE_REVIEW_FILE=/absolute/path/operator-review.json \
  bash scripts/harvest-step.sh publish-candidate-pr 1

# Read candidate readiness locally, without GitHub access or mutations.
bash scripts/harvest-step.sh candidate-status 1

# Read the PR's current head and CI state.
bash scripts/harvest-step.sh pr-status 1
```

The harvest pane exposes `g`, then a slot digit, for the legacy draft handoff
and `c`, then a slot digit, for CI status. Selecting the slot in the draft
prompt authorizes that push/PR creation. Strict candidate handoff is deliberately
an explicit CLI verb: selecting its slot and supplying all three evidence files
authorizes only a push and draft-PR create/reuse. `p` and `publish` retain their
existing push-only behavior. Scripts use the same workspace/repository context
as other harvest verbs.

Creating or inspecting a PR requires Node >=20, Git, authenticated `gh` with
access to the destination, and an active Swarm run with owned slot resources.
The local `candidate-status` preview requires only Node, Git, and the active
run. `HERDR_SWARM_PUBLISH_REMOTE` defaults to `origin`. It must name a Git remote
with exactly one fetch and push URL identifying the same GitHub.com repository
(ordinary HTTPS or SSH, without embedded credentials). Fork destinations,
multiple push URLs, and Enterprise hosts are not supported yet. No
remote/auth/CI configuration is changed.

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


## Strict operator-selected candidate handoff

`publish-candidate-pr <slot>` is an additional opt-in mode; it does not change
the behavior of `publish-pr`. It requires the selected slot worktree to be Git
clean and at the selected branch HEAD. Before any `gh` invocation, push, or PR
creation, it reads and revalidates three separate files:

1. `HERDR_SWARM_CANDIDATE_VALIDATION_FILE` uses the explicit `schema_version: 1`
   checks format above. Its `head_sha` must equal the selected HEAD, and every
   check must be `passed`. When the variable is unset, the slot's result from
   `harvest-step.sh validate <slot>` is used if one exists (see the README's
   "Validating slots"). It goes through the same reader and gates, and it is
   still a local observation, not an attestation.
2. `HERDR_SWARM_CANDIDATE_BROWSER_QA_FILE` is a Browser QA `result.json` in the
   strict format above. Its commit must equal the same HEAD and its derived
   `browser-qa` check must be `passed`. The checks file cannot substitute for
   this file, or vice versa.
3. `HERDR_SWARM_CANDIDATE_REVIEW_FILE` records the operator's decision:

```json
{
  "schema_version": 1,
  "kind": "herdr-swarm-operator-review",
  "run_id": "run-id",
  "slot": 1,
  "head_sha": "0123456789012345678901234567890123456789",
  "decision": "approved"
}
```

The review `run_id`, numeric `slot`, and `head_sha` must exactly match the
selected candidate. `decision` is `approved` or `rejected`; only `approved`
permits handoff. A missing, malformed, stale, failed, pending, not-run, or
rejected input refuses before a network effect. The branch and worktree are
checked again before push, and the push still names the audited SHA rather than
the moving branch name.

All three inputs use the same bounded, regular-file, no-symlink reader described
above. They remain caller-supplied observations, not cryptographic attestations.
Only typed check names/statuses and the review decision are copied to a newly
created draft. Browser QA, Console, and the review record have no merge or apply
authority. This mode never auto-merges, auto-applies, or force-pushes.

`candidate-status <slot>` is a local, read-only preview. It rereads the current
files and worktree and emits:

```text
candidate_status<TAB>{"schema_version":1,"run_id":"run-id","slot":1,"head_sha":"...","ready":false,"issues":["validation_missing","browser_qa_missing","review_missing"],"validation_status":"missing","browser_qa_status":"missing","review_decision":"missing"}
```

Validation and Browser QA statuses are `passed`, `missing`, `stale`, `failed`,
or `invalid`. Review decisions are `approved`, `missing`, `stale`, `rejected`,
or `invalid`. Issue codes are `slot_head_mismatch`, `slot_dirty`,
`validation_missing`, `validation_stale`, `validation_failed`,
`validation_invalid`, `browser_qa_missing`, `browser_qa_stale`,
`browser_qa_failed`, `browser_qa_invalid`, `review_missing`, `review_stale`,
`review_rejected`, and `review_invalid`.

The preview does not invoke `gh`, push, create, edit, merge, or apply anything.
It binds only run ID, slot, and full HEAD SHA; it intentionally omits local
repository and evidence paths. Saved preview output is display information,
not authority. `publish-candidate-pr` always rereads the files and rechecks the
clean selected HEAD instead of trusting a saved preview.

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

Successful `publish-candidate-pr` uses the same `published` and `pull_request`
records. The latter additionally has `candidate_evidence_attached` and a
whitelisted `candidate` object:

```text
pull_request<TAB>{"schema_version":1,"repository":"owner/repo","number":7,"url":"https://github.com/owner/repo/pull/7","state":"OPEN","draft":true,"head_sha":"...","base":"main","branch":"swarm/run/slot","reused":false,"validation_attached":true,"validation":{"source":"supplied","head_sha":"...","checks":[{"name":"unit-tests","status":"passed"}]},"candidate_evidence_attached":true,"candidate":{"run_id":"run-id","slot":1,"head_sha":"...","validation":{"source":"supplied","head_sha":"...","checks":[{"name":"unit-tests","status":"passed"}]},"browser_qa":{"source":"browser_qa","head_sha":"...","checks":[{"name":"browser-qa","status":"passed"}]},"operator_review":{"decision":"approved"}}}
```

On reuse, the existing PR body is preserved, so both
`validation_attached` and `candidate_evidence_attached` are false. The output
still reports the newly revalidated supplied evidence but does not claim it was
written to the existing body.

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
