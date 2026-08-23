# Residual review findings — accepted 2026-07-22

From the Tier 2 review of `ff8e373..143fd04` (9 reviewer personas, 19 findings).
Both P0s and all seven P1s were fixed in `27b3c92`. The five below were
accepted as residual: each is a deliberate design or scope call rather than a
defect, and none blocks use of the plugin.

## 1. No non-interactive fan-out entry point

**Source:** agent-native reviewer. **File:** `scripts/fanout-pane.sh`

Slot count, presets, and task text are collected exclusively from stdin
prompts. Abort, prune, and `harvest-step.sh` are all scriptable (env gates,
typed exit codes, TSV output), so fan-out is the outlier — an agent or CI job
can inspect, harvest, and clean up a run but cannot start one.

Closing it is additive, not a redesign: check `HERDR_SWARM_SLOTS`,
`HERDR_SWARM_PRESETS`, `HERDR_SWARM_TASK_FILE`, and
`HERDR_SWARM_DETRITUS_ACTION` before falling back to the prompts, matching the
env-gate pattern abort and prune already use. Worth doing before the plugin is
driven by anything other than a human at a keyboard.

## 2. Slot path and branch lack the ownership assertion applied to run_id

**Source:** adversarial reviewer. **File:** `scripts/harvest-step.sh`,
`scripts/abort.sh`

`RUN_ID` is now charset-guarded, but `SLOT_PATH` and `SLOT_BRANCH` reach
`rm -rf`-class git commands straight from the manifest with only a `[ -d ]`
check. The manifest is plugin-written and `0700`, so this is defense in depth
against a corrupted or hand-edited file rather than a live exploit.

Suggested guard: in `read_slot`, assert `SLOT_BRANCH` matches
`swarm/$RUN_ID/*` and that `SLOT_PATH` appears in
`git worktree list --porcelain` paired with that branch; refuse otherwise.
Same prefix assertion in `abort.sh`'s `reap_slot_worktree`.

## 3. Mutation lock and active-run check are keyed on workspace, not repo

**Source:** adversarial reviewer. **File:** `scripts/lib.sh`

Both invariants ("one active run per repo", "one mutating verb at a time")
are enforced per Herdr workspace id. Two workspaces open on the same repo
defeat both: two concurrent runs, two concurrent merges. The merge itself is
still protected by the drift compare-and-swap, so the failure mode is
confusing bookkeeping rather than corruption.

Fix: derive the lock name from a hashed `git rev-parse --git-common-dir`
token, and have `preflight_check_active_run` scan `run-*.json` matching on
`repo_root`.

## 4. `bin/renderer.mjs` merges two concerns in one 1078-line file

**Source:** maintainability reviewer.

Status mode and harvest mode are independent, separately tested feature areas
sharing a file. The test files already split along that seam. Suggested split:
shared pure helpers, `renderer-status.mjs`, `renderer-harvest.mjs`, keeping
`bin/renderer.mjs` as the mode-dispatch entrypoint it already ends with.

Deferred because the file is working, well covered, and the split is churn
without a forcing function — revisit when harvest mode next grows.

## 5. `setup.sh` hook log captures output unredacted

**Source:** project-standards reviewer. **File:** `scripts/fanout-pane.sh`,
`README.md`

The per-repo setup hook's stdout and stderr are written verbatim to
`$(state_dir)/setup-<run>-s<slot>.log`. `state_dir()` is `0700`, so exposure is
limited to the local user, but a hook that echoes a token during dependency
install leaves it on disk with no expiry. Documentation gap rather than a code
defect: the README's setup-hook section should warn against echoing secrets.

---

## Testing gaps recorded alongside these

- `do_archive`'s idle-agent branch is never exercised (tests hit absent or
  working only).
- `resume_stale` and scan-mode `resume_completed` have no bash-level test
  (the renderer side is now covered).
- The plan's "post-confirm re-verify catches a tree dirtied while the prompt
  sat" scenario has no test, and no explicit re-check exists in that window.
- No hostile-manifest fixture (traversal `run_id`, slot path outside
  `repo_root`).
- No fixture exercises two workspace ids against one repo (see residual 3).
- Test fixtures under `mkdtempSync` are never cleaned up; a full run leaves
  ~1400 temp dirs.

---

## Status addendum — 2026-08-23

Residuals 1 (scripted fan-out), 2 (slot ownership assertion), and 3
(repo-keyed lock/generation resolution) were closed by the wave0 safety work.
Residual 5 is addressed as a README warning next to the setup-hook docs.
Residual 4 (renderer split) remains deliberately deferred.

Of the recorded testing gaps: hostile-manifest fixtures, the two-workspace
fixture, and the post-confirm clean-tree re-check landed with wave0; the
`do_archive` idle-agent branch and a bash-level `resume_stale` scan test now
live at the end of `tests/harvest.test.mjs`; harness temp dirs are swept on
process exit (`tests/harness.mjs`, `HS_KEEP_TMP=1` to keep them).
