---
module: herdr-cli-integration
date: 2026-10-03
problem_type: documentation_gap
component: tooling
severity: medium
category: documentation-gaps
related_components:
  - development_workflow
tags:
  - herdr
  - agent-lifecycle
  - finish-detection
  - live-verification
---

# Herdr 0.8.2: plugin-reported agent state freezes, and how to see a slot finish

## Problem

On the 0.7.5+ fan-out path, Swarm runs each slot with `pane split` + `pane run`
and registers it with `pane report-agent --state working`. A slot whose argv
exits still shows `working` in `agent list` indefinitely.

## Cause (live-verified, Herdr 0.8.2, protocol 20, throwaway named session)

A `report-agent` call gives its `--source` **full lifecycle authority** over
the pane. Herdr's docs say: "When an integration also reports state, Herdr
uses those reports instead of reading the screen." Nothing reads the screen
again until the source reports or releases. Observed after `sleep 40` exited:
`process-info` showed the bare shell, while `agent list` still said
`"agent_status":"working"`.

`pane release-agent <pane> --source ID --agent LABEL` doesn't hand state back
to detection; it **removes the agent row entirely** (`agent list` →
`[]`). Whether Herdr's own detection then picks up a natively supported agent
(claude/codex) in a split pane was **not** verified: that needs a real agent
running, and the probe deliberately used none.

## Signals that do work

- `pane process-info --pane ID` →
  `result.process_info.{shell_pid, foreground_process_group_id, foreground_processes[]}`.
  The argv has exited exactly when `foreground_process_group_id == shell_pid`.
  Before the shell starts the argv, the same holds, so it needs a "seen busy
  once" or age guard.
- An agent-written marker file (`.swarm-done`), requested in the task file.
- `notification show <title> --body T --sound done` →
  `{"type":"notification_show","shown":true,"reason":"shown"}`.

Response shapes are mirrored in `tests/harness.mjs` with paths sanitized.

## Gotchas while probing

- A process running inside a Herdr pane inherits `HERDR_SOCKET_PATH`, which
  overrides `HERDR_SESSION`. Probes must `env -u HERDR_SOCKET_PATH -u
  HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_ENV` and set
  `HERDR_SESSION=<throwaway>`. Check with `herdr status server` (socket path)
  before running anything mutating, and stop with `herdr session stop <name>`.
- `herdr pane process-info` with no `--pane` answers for the **current** pane.
  Assume other pane verbs have the same no-argument default; never probe them
  bare from inside a live session.
- `herdr <cmd> <sub> --help` prints the top-level help, not the subcommand's.
  Use `herdr api schema --json` (offline) for parameter and result types.
