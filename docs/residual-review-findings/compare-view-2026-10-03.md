# Residual review findings — compare view and merge winner, accepted 2026-10-03

From an adversarial review of the uncommitted compare change: seven
findings. The reviewer confirmed nothing blocks the safety model: no path
deletes work without the approval flow. Fixed before commit:

- **P1 — merging an unvalidated tip.** The table was a snapshot, so an agent
  committing after it was read meant "merge winner" landed a tip nobody
  ranked or validated. `merge` now takes an optional expected slot tip,
  checked under the lock; the pane passes the compared tip, and the exact SHA
  is merged.
- **Winner's own archive prompt was overwritten.** It survives the summary,
  and a winner worktree left behind is named.
- **Bulk skip hit slots with working agents.** Unfinished slots are left
  running and named, not skipped.
- **Stale locus in the confirm.** If where the merge lands changed, the pane
  asks again.
- **Failed diff read as "disjoint".** The file list is `null` and overlap
  shows `unknown`.
- **Tab-joined rows.** Now `\x1f`-separated; rows with a separator inside a
  field are left out loudly.
- **Diff handoff env.** Inherited git routing is dropped;
  `--no-ext-diff --no-textconv`.

The items below were accepted as residual.

## 1. Each bulk skip/archive takes the lock separately

Another pane or an abort can act between the winner merge and the bulk skip.
Every verb re-reads the manifest, so this is not destructive, but the banner
can describe a state already overtaken.

## 2. The pager is the user's

`d` shows agent-written patch bytes through the user's configured git pager.
With `less` (git's default, `LESS=FRX`) only colour sequences pass. A user
who set `cat` as pager gets raw bytes, exactly as `git diff` in their shell
would.

## 3. Ranking puts validation ahead of "finished"

A slot that passed validation but is still working ranks above finished
slots. With the tip pin, merging it either merges exactly what was
validated or refuses. "Finished" stays visible in its own column.

## 4. `compare` holds the repo lock while it reads every worktree

`git status --porcelain` per slot, under the lock. On very large repos or
with fsmonitor hooks this could approach the 120 s step timeout. The
SIGTERM releases the lock, but compare.mjs and its git children are left to
finish on their own.

## 5. `skip` ignores a stale journal without MERGE_HEAD

This is pre-existing `skip` behaviour, now reachable in bulk. The common
conflict case is still blocked by the sequencer scan.
