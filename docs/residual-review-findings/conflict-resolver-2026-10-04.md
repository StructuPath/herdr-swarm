# Residual review findings — conflict resolver and conclude, accepted 2026-10-04

From an adversarial review of the uncommitted resolver change: five
findings, two blocking P1s on the core promise that nothing lands that the
operator did not review and that is not this slot's merge. Fixed before
commit:

- **P1 — unreviewed land.** `conclude` journaled the commit before the
  operator confirmed, and the review cut the stat to its last 15 lines with
  no notice. `conclude` is now read-only. `apply <sha>` records only the
  reviewed HEAD (exit 30 otherwise) and runs, then lands, only on `y`. The
  review lists every path the resolution changed beyond git's own automatic
  merge (`git merge-tree --write-tree` of the same parents), plus the full
  stat or the head of it with an "N more" line.
- **P1 — uncompared slot work.** The second parent only had to be somewhere
  in the slot's history. The exact merged tip (MERGE_HEAD) is now journaled
  as `merge_tip` when a merge stops on conflicts, and the second parent must
  equal it. Mutation-checked: the old ancestor rule fails the test.
- **Abort deleting a live resolver's tree on uncertainty.** The resolver
  state is now three-way. `gone` needs positive evidence: the pane is absent
  from its own workspace's list, its terminal changed, or the bare shell is in
  front. `unknown` blocks like `live`. Mutation-checked: treating unknown as
  gone fails the test.
- **Amend-after-conclude deadlock.** A journaled-but-unlanded commit can be
  re-reviewed and re-applied.
- **Landing under a live resolver.** `conclude` (and so `apply` and landing)
  refuses until the resolver is proven gone.

The items below were accepted as residual.

## 1. The `outside_conflict` check covers file paths, not hunks

A resolution that adds unrelated lines *inside* a conflicted file is not
flagged separately: those lines show only in the file's diff. Review the
conflicted files' content, not just the list.

## 2. A resolver shares the repository's `.git`

From the merge tree it can still move refs or edit files in the state dir.
Moving the base is caught by the compare-and-swap; moving the slot ref no
longer matters (the pin is `merge_tip`, recorded before the agent started).
Editing the manifest is the same same-uid trust boundary every slot agent
already has.

## 3. `HERDR_SWARM_RESOLVER_STOPPED=yes` is trusted as stated

It exists so a closed workspace cannot block abort forever. It is an
explicit human statement, never inferred.

## 4. Only the 0.7.5+ start path, and only partly live-verified

0.7.4 is refused. On 0.8.2, a split into a detached worktree mid-conflict
reported that worktree as its cwd. Running a command inside it was not
re-probed; it is fan-out's existing `pane run` path. Resolver quality with a
real agent was not exercised.

## 5. Interpreter-launched agents read as `unknown`

They show up as `node cli.js`, which blocks destructive actions until the
agent exits or the operator states it stopped. That is safe but sometimes
inconvenient.
