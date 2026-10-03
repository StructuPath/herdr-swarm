# Residual review findings — finish detection (`settle`), accepted 2026-10-03

From an adversarial review of the uncommitted `settle` change: six findings,
no P0/P1. The reviewer confirmed there was no destructive path, no manifest
JSON injection, and no half-written manifest on SIGTERM. Fixed before commit:

- **Fan-out race.** The age-based grace for `exited` measured from run
  creation, so a slow fan-out could finish a slot whose shell had not yet
  started its argv. The age path is gone. `exited` now needs a busy sighting,
  then two consecutive bare-shell settles.
- **Ctrl-Z or agent restart finished a slot permanently.** `exited` is now
  reversible: a later busy reading clears it and reports `working`.
- **Status paint stalled on settle.** It waited on the repo lock for up to
  15 s per tick. Settle is now fire-and-forget behind an in-flight flag.
- **Auto-validate could be lost.** If settle was killed between recording a
  finish and spawning validate, the validate never ran. It is now spawned
  straight after the write, before the slow Herdr report.
- **`.swarm-done` content deleted without approval.** It is now skipped only
  as an empty regular file; content goes through the normal approval.

The items below were accepted as residual.

## 1. Settle holds the repo lock while it polls Herdr

Every `harvest-step.sh` verb takes the repo lock in its shared preamble. With
many unfinished slots and a hung Herdr (5 s per `process-info`), settle can
run into the renderer's 15 s timeout while holding the lock. The EXIT trap
releases the lock. Any `with_timeout` herdr client it started is orphaned
until that client exits on its own. Fixing this needs a lock-free settle
entry path: poll first, then lock to write. Worth doing if settle ever
polls more than process-info.

## 2. A refused auto-validate is only visible in its log

A slot that settles dirty (marker written before committing) makes validate
refuse, and that only lands in `auto-validate-<run>-s<slot>.log`. The compare
view (roadmap item 3) is where a missing or refused validation result for a
finished slot should be shown.

## 3. One notification per run, even across resume

`finish_notified` is set once. A slot that resumes and finishes again does
not re-notify. Re-notifying risks repeated toasts from a flapping signal; a
missed second toast costs little.

## 4. Pane-id reuse after a Herdr restart is unverified

If Herdr hands a recorded `pane_id` to another pane sitting at a bare shell,
`exited` could fire for a slot whose agent died in the restart. It is
labelled finished rather than lost, which is misleading but not destructive.

## 5. Detached validate inherits the status pane's environment

That includes `HERDR_SOCKET_PATH` / `HERDR_PANE_ID`. A `validate.sh` that
calls bare `herdr` acts as the Status pane. The same exposure already exists
when validate runs from the Harvest pane.
