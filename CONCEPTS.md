# Concepts

Shared domain vocabulary for this project — entities, named processes, and
status concepts with project-specific meaning. Seeded with core domain
vocabulary, then accretes as ce-compound and ce-compound-refresh process
learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Run and slots

### Run
One fan-out invocation and everything it created: a set of Slots, the base
branch it targets, and the Fork SHA every diff and merge is measured against.
A repo has at most one active Run at a time; a Run ends when it is fully
harvested or aborted.

Every Run carries an identifier unique to that invocation. This is a
correctness requirement rather than hygiene: branch names derived from a reused
identifier silently resurrect a previous Run's half-finished work.

### Slot
One agent's isolated unit of work within a Run — its own worktree, its own
branch, its own agent process. Slots are independent by construction: two
agents in the same Run cannot see or overwrite each other's edits.

Lifecycle: pending (recorded before anything is created), running, then a
settled state once the agent stops. From settled a Slot moves to merged,
skipped, or failed, and finally to archived once its worktree is gone.

### Fork SHA
The commit every Slot branched from, recorded once when the Run starts. All
change counts and diffs measure against it rather than against the base
branch's moving tip — otherwise counts inflate the moment base advances, and
the display would claim agents touched files they never opened.

### Manifest
The Run's on-disk record of truth: its identity, base ref, Fork SHA, and a row
per Slot. Written ahead of every mutation, so it is always a superset of what
exists on disk — recovery may over-approximate and verify, but never has to
guess.

The Manifest is what makes a crashed Run recoverable rather than orphaned. It
is archived rather than deleted when a Run ends, because it remains the record
that lets cleanup resolve what a Run left behind.

### Preset
A named agent configuration a Slot runs. Presets are what make fan-out
agent-agnostic: any command can be a Slot's agent, not a fixed list.

## Harvest

### Harvest
The review-first act of merging Slots' work back to the base branch, one Slot
at a time, with the user choosing order. Distinct from anything automatic:
nothing merges without an explicit per-Slot decision, and the base ref is
re-checked for drift before every merge rather than once per session.

### Locus
Where a merge physically executes. Two cases, and the distinction is
load-bearing: when the base branch is not checked out anywhere, the merge runs
in a plugin-owned detached worktree and the base ref advances by atomic
compare-and-swap. When the base *is* the user's checked-out branch, the merge
runs in the user's own tree after an explicit confirmation and a clean-tree
check.

The Locus determines ownership, which is why it gates destruction: a
detached-Locus record names a worktree the plugin created and may remove, while
a user-tree-Locus record names the user's own checkout, which nothing may
touch.

### Journal
The merge-intent record written before git mutates anything — which Slot, which
Locus, the base commit expected, and the merge commit's identity the moment one
exists. A crash inside the merge is detected on next open and offered for
completion or reported for manual recovery, so a completed merge is never
silently unreachable.

### Drift
The base branch moving between the moment a merge was previewed and the moment
it would land. Detected drift sends the Slot back to re-preview rather than
merging against a base the user never reviewed.

### Snapshot
A copy of a Slot's uncommitted work — tracked and untracked — written to a
plugin-owned ref before any discard. Discard is the only operation that
destroys work outright, so it refuses to run without a Snapshot recorded first.

## Cleanup

### Archive
Removing a Slot's worktree while keeping its branch. Deliberately decoupled
from branch deletion: the worktree is disposable once its work has landed, but
the branch remains the handle for recovering that work.

### Prune
The separate, explicitly requested deletion of branches and Snapshots a Run
left behind. Prune lists before it deletes and never runs on a timer — nothing
in this project garbage-collects on its own, because a background sweep either
never fires or fires while work is still live.

### Detritus
Leftover branches and worktrees from a previous Run found still present when a
new one starts. Surfaced for a decision rather than cleared automatically,
since the leftovers may hold committed work that never landed.

## Flagged ambiguities

- "Archive" applies to two different things and both are intentional: a Slot is
  archived (worktree removed, branch kept), and a Manifest is archived (kept as
  a recovery record rather than deleted). Neither means "delete."
