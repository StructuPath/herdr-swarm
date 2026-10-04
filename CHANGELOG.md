# Changelog

Notable changes to the Swarm plugin. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org). The plugin version lives in
`herdr-plugin.toml` and `package.json` (kept in lockstep).

## [Unreleased]

## [0.5.0] — 2026-10-04

The "pick the winner" release: Swarm now checks each slot, notices when a
slot is done, compares them, lands the winner, steers running agents, and
hands merge conflicts to a resolver, all without giving up review-first
merging. Exercised live end to end on Herdr 0.8.2 (see `docs/readiness.md`).

### Changed
- `scripts/harvest-step.sh` (1,863 lines, 23 verbs) is split into domain
  modules it sources: `harvest-step-{merge,slot,publish,validate,settle,compare,broadcast,resolve}.sh`.
  The entry point, verbs, arguments, output, and exit codes are unchanged, and
  every function moved byte-for-byte. The modules stay directly in `scripts/`
  so CI's shellcheck and syntax globs, and the repository's invariant checks,
  still cover them. Those invariants treat `harvest-step.sh` and its modules
  as one program.

### Fixed
- A conflicted harvest merge resolved by hand in its merge tree could not be
  landed. Its commit was never journaled, so resume called it stale and
  abort-merge refused it as an unknown merge commit. `conclude` now adopts
  it.
- Approving ignored-file cleanup failed with "Argument list too long" for any
  worktree holding a real dependency tree, so abort and archive kept it
  forever. The inventory went to Node as one argv string, past ARG_MAX. It now
  goes through a file in the state dir. The harvest prompt summarizes large
  ignored sets by top-level directory.
- On Herdr 0.7.5+, a slot whose agent finished stayed `working` until a
  harvest preview. The plugin's own report holds Herdr's lifecycle authority,
  which suppresses screen detection (live-verified on 0.8.2). Finish
  detection now corrects it while the status pane is open.

### Added
- Conflict resolver: `resolve <slot>` (`g` in the conflict view) hands a
  conflicted detached merge to an agent. It writes a brief into the merge tree
  and starts the agent beside the slot's own on Herdr 0.7.5+. `conclude <slot>`
  (`c`) is a read-only review of a merge resolved in its tree, by the agent or
  by hand. It checks for exactly one finished merge of the exact slot tip
  that was merged onto the journaled base. It lists every path changed
  outside git's own automatic merge, and the full diffstat. `conclude <slot>
  apply <sha>` (on `y`) records only that reviewed commit, which the existing
  resume compare-and-swap then lands. Abort, abort-merge, and conclude keep the
  merge tree until the resolver is proven gone.
- `broadcast` harvest verb: types one single-line message into every running
  slot's agent (or `HERDR_SWARM_TARGETS`) and submits it. A slot is only typed
  into when its pane still holds the slot's terminal and a program, not the
  shell, is in the foreground. Multi-line text, control characters, and a
  leading `-` are refused.
- Elapsed time per slot in the status pane and the compare view (fan-out now
  records `started_at`). Token and cost display is deferred: Herdr has no
  usage channel and agents do not report usage to it.
- Per-slot tasks without a TTY: `<!-- swarm-slot: N -->` marker lines split
  `HERDR_SWARM_TASK_FILE` into per-slot sections after a shared preamble.
  The highest section sets the slot count when `HERDR_SWARM_SLOTS` is unset,
  and sections that don't fit the run refuse before anything is created.
  Fan-out also warns when slots given different tasks name the same tracked
  file or directory, since their merges may conflict. This applies to
  interactive overrides too.
- Slot environment: fan-out clones the repo's ignored `node_modules` (or a
  `clone-paths` list) into each worktree copy-on-write (`cp -c` / `--reflink`;
  skipped, not fully copied, where unsupported), before `setup.sh`. Each slot
  gets `HERDR_SWARM_RUN_ID`, `_SLOT`, `_PORT_BASE`, `_PORT_SPAN`: in
  `setup.sh` always, in the agent via `pane split --env` on Herdr 0.7.5+, and
  as a port-range line in the task file. Ports default to 10 per slot from
  4100 and are recorded on the manifest row.
- Compare view (`w` in the harvest pane; scriptable as the read-only
  `compare` verb). It ranks running slots by validation of their current
  tip, then commits, then finished, never by diff size, and shows commits,
  files, +/-, dirty count, and the files each pair of slots both changed.
  `d` shows the full diff between two slots' tips in git's pager. `m` merges
  a chosen winner through the normal merge, and only if it lands, skips and
  archives the other running slots (branches kept; anything that won't
  archive cleanly is left and named).
- Finish detection: the status pane runs a new `settle` verb every 10s. It
  records a slot as finished when its agent creates `.swarm-done` (now asked
  for in the task file's standing instructions, and excluded from `git status`
  and from ignored-file cleanup approval like `.swarm-task.md`). It also does
  so when the slot pane is back at a bare shell (via Herdr `pane process-info`).
  Finished slots show `finished`, flip their plugin-reported state to `idle`,
  and get one Herdr notification per run when all are done. Opt-in
  auto-validate (`HERDR_SWARM_AUTO_VALIDATE=1` or a config-dir
  `auto-validate` file) runs `validate` on each settled slot.
- `validate <slot>` harvest verb (`v`, then slot in the pane) runs the
  operator's `validate.sh` hook against a slot's clean HEAD and records a
  SHA-bound checks file. The strict candidate handoff now produces its own
  validation evidence instead of requiring the caller to bring it. An explicit
  `HERDR_SWARM_CANDIDATE_VALIDATION_FILE` still wins. The repo lock is released
  while the hook runs. On `HERDR_SWARM_VALIDATE_TIMEOUT` the hook's whole
  process group is killed. A slot that changes during the run records nothing.
- Strict candidate handoff (#15): `candidate-status <slot>` previews, and
  `publish-candidate-pr <slot>` publishes, a clean slot only with passing
  validation, a passing Browser QA result for the same SHA, and an operator
  review bound to the run, slot, and SHA. Every input is re-read before any
  push, and the handoff never merges.

## [0.4.0] — 2026-09-14

### Fixed
- The shared test environment now supplies its fixture Git identity to stub
  subprocesses too, avoiding hostname-based identity detection during commits
  and reflog writes when user/system Git configuration is disabled (#11).
- Harvest now reconciles the completed slot's plugin-reported state before
  automatic archive. On Herdr's pane-backed path, a successful merge could
  previously leave the slot marked working and unnecessarily block cleanup.
  Archive still verifies agent state and worktree contents before removal.
- Archive recognizes Herdr 0.8.2's `done` state (an unseen background idle
  agent) as settled, instead of refusing cleanup until its tab is focused.

### Added
- Opt-in `publish-pr <slot>` harvest verb (`g`, then slot in the pane) pushes
  the audited commit and creates/reuses its exact GitHub draft PR. Existing
  `publish` remains push-only. Optional SHA-bound validation JSON or Browser
  QA results contribute only typed check names/statuses to a new draft.
- `pr-status <slot>` (`c`, then slot) reads PR/CI state with explicit no-checks,
  unknown, failure, and local/remote head-drift reporting. No automatic merge,
  force push, or existing PR-body rewrite is performed.
- `npm run doctor` checks Node, Git, and the selected Herdr binary without
  creating plugin state or contacting a running session; incompatible versions
  include an explicit `HERDR_BIN_PATH` remedy.
- `npm run build` checks the manifest and every shell/Node source individually;
  `npm run validate` combines these checks with ShellCheck and the test suite.
  This avoids the first-file-only behavior of `bash -n scripts/*.sh`.

### Documented
- The suite website is the canonical Swarm guide, and installation diagnostics
  now distinguish prerequisite checks from live workflow verification.

## [0.3.0] — 2026-08-24

### Changed
- `bin/renderer.mjs` is now a thin mode-dispatch/re-export entrypoint over
  three modules split along the seam the test files already used:
  `renderer-shared.mjs` (pure helpers), `renderer-status.mjs`, and
  `renderer-harvest.mjs`. Import paths are unchanged.

### Fixed
- Status pane: a slot row with a recorded terminal id can no longer display
  the state of a different agent that happens to occupy its pane; the pane
  fallback now applies only to rows recorded before their terminal id was
  known.
- Harvest pane: input masking now spans a whole key handler rather than one
  verb, so a key landing between the verbs of a multi-step operation
  (merge→archive→reload, snapshot→discard) can no longer interleave two
  state-machine mutations.
- Status pane: metadata-only manifest changes now reset the poll backoff.

### Added
- **PR-based harvest**: the new `publish` verb (`harvest-step.sh publish
  <slot>`, or `p` + slot digit in the harvest pane) pushes a slot's branch
  to a remote (default `origin`, `HERDR_SWARM_PUBLISH_REMOTE` to override)
  so review and merge happen on the forge — plain push, never `--force`.
  The forge merge is auto-detected by the next re-preview via the existing
  ancestry/squash-containment checks, so no new terminal state exists.

## [0.2.0] — 2026-08-23

### Added
- Harvest preview now detects externally **squash-merged** (and
  cherry-pick-merged) slots: a clean slot whose content is already fully
  contained in base is marked merged (`squash_merged`) instead of
  conflicting on re-merge. Uses `git merge-tree --write-tree` containment
  (git >= 2.38); older gits keep the previous skip-by-hand behavior. Prune
  still deliberately keeps such branches — its ancestry test cannot see
  squashes.
- CI now runs the full test suite on macOS as well as Linux, and gates every
  script with shellcheck at default severity.
- Test coverage for the last two recorded gaps: archiving a slot whose agent
  is idle, and the `resume_stale` scan fact for a crash before any merge
  commit existed.

### Fixed
- The test harness sweeps its temp directories on process exit (a full run
  previously stranded well over a thousand fixture dirs under the system
  temp dir). Set `HS_KEEP_TMP=1` to keep them for inspection.

### Documented
- `setup.sh` hook output is logged verbatim and indefinitely to the plugin
  state dir — the README now warns against echoing secrets there.

## [0.1.0] — 2026-07-28

Initial public release, marketplace-listed (`herdr-plugin` topic).

### Added
- **Fan out** — N agents, each in its own git worktree on a run-unique
  `swarm/<run-id>/<slot>` branch forked from a recorded base SHA, with
  named presets, a shared task prompt, per-slot overrides, and a per-repo
  `setup.sh` worktree-prep hook. Fully scriptable with environment
  overrides (zero-TTY), including the leftover-detritus decision.
- **Status pane** — per-slot agent state and committed/uncommitted change
  counts measured against the fork SHA; survives a Herdr restart.
- **Harvest** — review-first, one-slot-at-a-time `--no-ff` merge-back with
  base-drift re-preview, atomic compare-and-swap base advance (or an
  explicit-confirm merge in the user's own tree), a journaled crash-recovery
  path, and classified conflict/hook-failure handling.
- **Abort** — stops agents and removes only exact, verified plugin-owned
  resources; branches are never deleted.
- **Prune** — dry-run-by-default deletion of fully-merged `swarm/*` branches
  and discard-snapshot refs, env-gated per resource class.
- Ignored-file cleanup as an exact two-step preview/apply protocol with
  digest-bound one-use approvals.
- Support for both herdr 0.7.4 (native agent slots) and 0.7.5+
  (plugin-built slots via `pane split`/`pane run`/`pane report-agent`).
- Safety hardening from the wave0 review: slot-ownership assertions on every
  slot-consuming verb, repository-keyed (not workspace-keyed) generation
  resolution and locking, and exact resource verification before any
  cleanup removal.
