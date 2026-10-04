# Residual review findings — broadcast and elapsed time, accepted 2026-10-04

From an adversarial review of the uncommitted broadcast change: six
findings, two high. The reviewer found no data or git risk, and found the
elapsed-time change safe (no manifest validator rejects `started_at`; old
manifests fall back to `created_at`). Fixed before commit:

- **High — the message could reach a program other than the agent.** "Busy"
  only meant "not the shell", so a `bash`, `less`, or `vim` started in a
  finished slot's pane would receive it. A slot now receives it only when the
  foreground group's *leader* is its recorded agent program, and slots
  finished as `exited` are skipped. Mutation-checked: matching any group
  member instead of the leader fails the test.
- **High — keystrokes into an approval prompt.** A slot Herdr reports as
  `blocked` is skipped (see residual 1).
- **Duplicate targets typed twice.** They are now refused.
- **Partial delivery reported as skipped.** It is now `broadcast_partial`,
  told not to re-run, with a nonzero exit.
- **The agent exiting between check and send.** The program is re-checked
  between typing and Enter; Enter is withheld if it changed.
- **A locale-dependent control-character filter.** Validation moved to Node
  with explicit code points, plus a UTF-8 validity check; tested under `C` and
  UTF-8.

The items below were accepted as residual.

## 1. Plugin-reported panes cannot show `blocked`

On Herdr 0.7.5+ Swarm reports the slot's agent state itself, so an approval
prompt reads as `working`. Broadcast can then type into the prompt. This is
documented in the README.

## 2. The check-then-act window is narrowed, not closed

Four CLI calls are not atomic. With the Enter re-check, a lost race leaves
unsubmitted text in the shell. That is inert until someone presses Enter.

## 3. Herdr key syntax inside send-text is unverified

The live probe covered a raw newline only. If `pane send-text` interprets
key names inside text (`<Enter>`, `{Enter}`), a printable message could
still inject keys.

## 4. The terminal-id check assumes ids are never recycled

Pane reuse is caught by comparing `terminal_id`. That is safe only if Herdr
never reissues one; this is unverified.

## 5. Broadcast holds the repo lock across its Herdr calls

Up to about 6 calls per slot at 5 s each. Settle and harvest verbs wait
behind it.

## 6. Token usage and cost are not shown

Herdr's pane `tokens` are display metadata, and nothing reports LLM usage
to Herdr. Deferred by decision on 2026-10-03 until an agent actually reports
usage.
