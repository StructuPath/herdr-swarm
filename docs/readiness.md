# Swarm readiness

The plugin is at version 0.5.0 (see the changelog). The manifest still
requires Herdr >=0.7.4. The broad compatibility baseline remains Herdr
0.7.4/0.7.5; Herdr 0.8.2 has the live evidence below. 0.7.4 does not support
the conflict resolver or agent-side slot variables.

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

## Live probe — 2026-10-03

A throwaway named Herdr 0.8.2 session (protocol 20), with every inherited
`HERDR_*` routing variable stripped, replayed the 0.7.5+ slot start: `pane
split`, `pane run sleep 40`, `report-agent --state working`. It captured
`process-info` while the argv was running and after it exited, `agent list`
before and after `release-agent`, and `notification show`. It confirmed
plugin-held state stays `working` after exit, and that foreground group ==
shell pid marks exit. Those shapes back finish detection's stubs. See
`docs/solutions/documentation-gaps/herdr-082-plugin-agent-authority-and-finish-detection.md`.
The session was stopped afterwards. No paid agent was run, so Herdr-native
detection after `release-agent` remains unverified.

## Live end-to-end smoke — 2026-10-04 (0.5.0)

A throwaway named Herdr 0.8.2 session (protocol 20) ran the whole 0.5.0 flow
against a disposable repository with temporary plugin state and config. Every
inherited `HERDR_*` routing variable was stripped, and `plugin …` calls were
refused so the installed plugin could not touch real state. Scripted
stand-in agents and a scripted resolver were used; no paid model agent ran.
Each step was exercised through the real verbs:

| Step | Live result |
| --- | --- |
| Scripted fan-out, per-slot task file | 3 created, 3 started; slot count from sections; conflict hint fired for two slots naming `app.txt` |
| Slot environment | Each agent saw its own `HERDR_SWARM_SLOT`, run id, and port base (via `pane split --env`), its own worktree, cloned `node_modules`, and its task file |
| Finish detection | `settle` recorded all three finished by marker; one notification; a second settle was a no-op |
| Validate | Two passed, one failed by design, each bound to its tip SHA |
| Compare | Passed slots ranked above the failed one; `app.txt` overlap shown |
| Broadcast | Delivered once to each running agent. After one agent exited, a second broadcast refused the bare shell |
| Merge | One slot landed at its compared tip through the detached locus and compare-and-swap |
| Conflict → resolve → conclude → land | Merge stopped with the merged tip journaled. The resolver ran in a pane split from the slot's pane, inside the merge tree, and made one commit. The read-only review recorded nothing; `apply` and `resume complete` landed exactly the reviewed commit |
| Review guards | A file slipped into the merge commit was flagged `outside_conflict`; applying the earlier-reviewed SHA after an amend was refused (exit 30) |
| Archive, prune | Exact one-use approvals removed worktrees holding cloned `node_modules`; branches kept; prune dry-run listed 2 merged and kept 1 unmerged |

Not covered: real agent quality (claude/codex), the status pane and its
periodic settle (opened through the plugin action, which was blocked; `settle`
was run directly), and Herdr 0.7.4. The session was stopped and every fixture
removed afterwards.

## Recommended next work

1. Run one live flow with real agent presets (`claude`, `codex`), including
   an approval prompt during broadcast and a real resolver resolution.
   Interpreter-launched agents (`node cli.js`) read as `unknown` to the
   resolver and broadcast checks by design; confirm that is workable.
2. Add opt-in named-session integration coverage for released Herdr versions.
   Keep real-git fixture coverage for drift, conflicts, snapshots, and
   interrupted-run recovery.
3. Raise the "newer than tested" baseline once 0.8.x evidence is broad
   enough; today it warns once per slot during fan-out.
4. Validate each team's `setup.sh`, `validate.sh`, and presets against a
   small task before increasing slot count.
