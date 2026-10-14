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

### Finished
A running Slot whose agent has stopped working on its task, recorded as
`finished: {at, reason}` on the Slot while its status stays `running`. It is
evidence for the operator, not a lifecycle state: it never merges, skips or
archives anything by itself. Two reasons, and they differ in strength:
`marker` (the agent created the Finish marker) is final; `exited` (the pane is
back at its bare shell) is reversible, and is cleared if the agent is seen
busy again. Anything that acts on Finished re-reads it at the moment it acts,
because the operator may have given the agent more work since.

### Finish marker
The empty `.swarm-done` file an agent creates in its worktree root to declare
it is done, as the task file asks. Excluded from git status like the task
file. Only an empty marker is exempt from the ignored-file approval at archive;
one with content is agent output like any other file.

### Preset
A named agent configuration a Slot runs. Presets are what make fan-out
agent-agnostic: any command can be a Slot's agent, not a fixed list.

## Harvest

### Harvest
The review-first act of merging Slots' work back to the base branch, one Slot
at a time, with the user choosing order. Distinct from anything automatic:
nothing merges without an explicit per-Slot decision, and the base ref is
re-checked for drift before every merge rather than once per session.

### Publish
The PR-based alternative to a local merge: pushing a Slot's branch to a
configured remote (plain push, never force) so review and merge happen on the
forge. Publish deliberately introduces no new terminal state — once the forge
merge lands and base updates, the ordinary preview detection (ancestry or
squash containment) settles the Slot.

### Draft PR handoff
An opt-in extension of Publish that creates a draft GitHub pull request for
the exact repository, slot branch, and recorded base branch, or reuses that
same PR. Supplied validation is bound to the published commit, not inferred
from an agent's completion state. Reuse preserves the existing PR body; it
does not replace earlier evidence or turn a review-ready PR back into a draft.

### CI snapshot
A read of GitHub's checks for the PR's current head, reported alongside the
local slot head so callers can identify drift. Empty checks mean not run.
Passing checks are observations, not approval to merge or proof that all
required checks exist.

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

### Compared tip
The exact commit a Slot's branch pointed at when the compare view read it.
Picking a winner pins this SHA: the merge refuses if the branch has moved and
merges the SHA itself, not the branch name, so what lands is what was
compared.

### Validation result
The checks file the `validate` verb writes for one Slot, bound to the HEAD it
ran against. Because it sits at a predictable path, a file there counts only if
it proves it is Swarm's own record for exactly this Run and Slot, with the
hook's own `validate` check present. One rule decides that, shared by the
compare ranking and the strict candidate handoff. A result for an older commit
is stale, never a pass.

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
- "Settle" has an older and a newer meaning. In the Slot lifecycle, a settled
  Slot is one whose agent has stopped (merged, skipped and failed come after
  it). The `settle` verb and its `settled<TAB>slot<TAB>reason` output line are
  Finish detection: they record Finished on a Slot that stays `running`. The
  verb name is a scripting contract and is kept; in prose, say Finished for
  the verb's result.
