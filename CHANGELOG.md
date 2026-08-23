# Changelog

Notable changes to the Swarm plugin. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org). The plugin version lives in
`herdr-plugin.toml` and `package.json` (kept in lockstep).

## [Unreleased]

### Changed
- `bin/renderer.mjs` is now a thin mode-dispatch/re-export entrypoint over
  three modules split along the seam the test files already used:
  `renderer-shared.mjs` (pure helpers), `renderer-status.mjs`, and
  `renderer-harvest.mjs`. No behavior change; import paths are unchanged.

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
