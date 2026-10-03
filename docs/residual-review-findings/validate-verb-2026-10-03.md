# Residual review findings — `validate` verb, accepted 2026-10-03

From an adversarial review of the uncommitted `validate <slot>` change: five
findings, no P0/P1. All five were fixed before commit:

- Pane hangup orphaned the hook → HUP/QUIT now trapped.
- Iteration-count deadline drifted past the renderer's budget → now a real-time deadline.
- Hooks' background processes survived a normal exit → the group is always reaped.
- The default-path result was trusted without identity → it must now be Swarm's record for this run and slot.
- Concurrent validates of one slot → a per-slot `validating-*` lock.

The items below were accepted as residual. Each is a scope call, not a defect.

## 1. A same-user process can still forge the default result

The identity check (`kind`, `run_id`, `slot`, `validate` check) stops a
careless or stale file, not a determined same-user writer. The slot's agent
can learn every field and write a well-formed record. Supplied evidence has
the same trust level ("local observation, not an attestation"). The real
defense is that the operator reviews the slot and approves it in the separate
review file.

## 2. Agent edits that are reverted mid-run are invisible

Validate does not require the slot's agent to be idle. Its checks are HEAD
plus `git status --porcelain`, before and after the hook. A tracked file that
is edited and then reverted while the suite runs leaves both checks clean.
Ignored files (`node_modules`, `.env`, build output) change results without
appearing in porcelain at all. Documented in the README; finish detection
(roadmap item 2) is the natural place to gate validate on an idle agent.

## 3. Descendants that `setsid` escape group reaping

`reap_group` signals only the hook's process group. A daemonizing child
that calls `setsid` leaves the group and is beyond reach. Bash on macOS has
no portable cgroup-style containment.

## 4. A signal during the record phase loses the result

The TERM/INT/HUP trap is cleared once the hook exits. If the renderer's
budget (hook timeout + 30 s) expires while `validate_record` is still waiting
for the repo lock, the default SIGTERM ends the script. The EXIT trap still
releases both locks; only the result is lost, and re-running validate
recovers it.

## 5. Result, log, and orphaned temp files are never pruned

`validation-<run>-s<N>.{json,log}` and `validation-checks.*` left by a
SIGKILL accumulate in the `0700` state dir. Run IDs are unique, so nothing
collides; this is disk use only. Fold into prune when it next changes.
