# Swarm readiness

The plugin targets version 0.4.0; changes on this branch are recorded under
Unreleased in the changelog. The manifest still requires Herdr >=0.7.4.

## Repeatable validation

Run `npm run doctor` to check the selected local Node, Git, and Herdr binaries.
Set `HERDR_BIN_PATH` explicitly when more than one Herdr installation exists.
This command neither connects to the running session nor creates plugin state.
Install and authenticate the agent commands selected by your presets separately.

Run `npm run validate` for source/manifest checks, ShellCheck, and the real-git
test suite. Tests isolate Git configuration and stub Herdr using captured CLI
response shapes. The source-only build has no generated artifact or dependencies.

## Live workflow evidence — 2026-09-13

A dedicated named Herdr 0.8.2 session and throwaway Git repository exercised:

- Scripted fan-out of a bounded local worker into an actual Herdr worktree/pane.
- A committed contribution, harvest preview, and merge into the checked-out base.
- A second run through `HarvestRenderer.refresh()` and `doMerge()`, including
  automatic archive, manifest finalization, and removal of the owned worktree.
- Prune dry-run, which listed the merged branch and deleted nothing.
- A third run aborted through the real CLI: owned panes/worktree removed,
  branch kept, manifest archived, and only the original Git worktree remaining.

The dedicated test server was stopped after verification.

The first run exposed two cleanup defects: the renderer attempted archive before
refreshing the completed plugin-reported state, and Herdr 0.8.2 reports background
idle agents as `done`. Both now have regression coverage. Working agents remain
ineligible for archive, and ignored-file approvals and ownership checks remain
in force.

This is bounded 0.8.2 smoke coverage, not certification of every CLI surface.
The broad compatibility baseline remains Herdr 0.7.4/0.7.5, and the existing
newer-than-tested warning is retained. No paid model agent, credentials, external
push, default user session, or production repository was used by the smoke run.

## Recommended next work

1. Add opt-in named-session integration coverage for released Herdr versions,
   especially agent identity/state and worktree removal. Keep real-git fixture
   coverage for drift, conflicts, snapshots, and interrupted-run recovery.
2. Validate each team's setup hook and agent preset against a small task before
   increasing slot count. Fresh worktrees lack ignored dependencies and secrets;
   setup-hook failure currently warns and still starts the agent.
3. Keep conflict resolution review-first. The resolver-agent document in
   `docs/plans/` describes future work, not a shipped feature.
4. Use `publish-pr` for an explicit draft GitHub handoff with SHA-bound supplied
   evidence, and `pr-status` for a current CI snapshot. Ordinary `publish` still
   only pushes. The orchestrator remains responsible for the final review.
