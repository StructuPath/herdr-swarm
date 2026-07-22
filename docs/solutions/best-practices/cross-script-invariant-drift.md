---
module: fan-out-lifecycle-scripts
date: 2026-07-22
problem_type: best_practice
component: development_workflow
severity: critical
category: best-practices
related_components:
  - tooling
  - testing_framework
tags:
  - safety-guard
  - code-review
  - data-loss-prevention
  - shared-helper
  - parity-testing
  - parallel-authorship
applies_when:
  - "Two or more scripts must independently uphold the same safety invariant"
  - "A guard exists in one file with only a prose comment explaining why, and a sibling file performs the analogous destructive action"
  - "Work is split across parallel authors or agents owning disjoint files"
symptoms:
  - "A guard is present in one script and silently absent from its sibling"
  - "The full test suite stays green while the gap exists"
  - "The missing guard sits in cleanup or recovery code that normal runs never reach"
---

# Encode cross-script invariants once, or test them — comments don't survive parallel authorship

## Context

`herdr-swarm` is a ~7.6k-line plugin built by parallel agents, each owning
disjoint files, gated on a 137-test suite that stayed green throughout. A
nine-persona review afterward found two P0 data-loss bugs that shared one shape:
**a guard present in one script and absent in its sibling, because the invariant
was written as a comment instead of enforced as code.**

**Bug 1 — the locus guard.** `scripts/abort.sh` gated journaled-worktree removal
on the locus, with a comment stating the rule outright:

```sh
# Only the detached locus owns a plugin worktree; the user-tree locus
# journals the USER's checkout, which abort never touches.
if [ "$jlocus" = "detached" ]; then
	reap_harvest_worktree "$slot" "$jmsha" "$jwt"
fi
```

`scripts/harvest-step.sh`'s two resume paths read the same `locus` field from
the journal into a variable and never checked it, feeding `journal.worktree`
straight into `git worktree remove`. Git refuses to remove a **main** working
tree, which masked the bug whenever the user's base checkout happened to be the
repo's primary worktree. But git will happily remove a base checked out in a
**linked** worktree — an ordinary worktree-per-feature workflow — so a user with
an active checkout elsewhere would have had their own working directory deleted.

**Bug 2 — the run_id charset guard.** `abort.sh` refused a manifest whose
`run_id` failed a path-charset round-trip before running any git command.
`harvest-step.sh` interpolated that same `run_id` into worktree paths
(`$(state_dir)/harvest-$RUN_ID-s<slot>`) and ref names
(`refs/swarm-backups/$RUN_ID/<slot>`) with no equivalent guard.

## Guidance

Name the shape: **parallel authorship plus a shared invariant that only one
author encoded as a runtime check equals drift.** Three countermeasures, all of
which the fix actually used — none of which is "review harder."

### 1. Put the guard inside the shared helper every caller must pass through

The fix added an ownership check *inside* `swap_base`, the function both the
live-merge path and the resume-complete path call, so the rule is no longer
something each caller must remember:

```sh
# journal.worktree holds the USER's checkout for the user-tree locus, and
# `git worktree remove` DOES delete a base checked out in a linked worktree
# (only a MAIN working tree is refused). Callers already gate on
# locus = detached; this is the second lock on the same door.
if [ -n "$hwt" ]; then
	case "$hwt" in
	"$(state_dir)"/harvest-*) ;;
	*)
		echo "herdr-swarm: refusing to remove $hwt — not a plugin-owned harvest worktree." >&2
		hwt=""
		;;
	esac
fi
```

Note what makes this work: it is a **namespace** check, not a second copy of the
locus comparison. A different mechanism guarding the same door means a future
caller that gets the locus logic wrong still cannot reach the removal. Two
locks, different keys.

### 2. Write a parity test asserting the invariant holds in every file that must honor it

This pattern already existed in the suite — it simply had not been pointed at
these two invariants. Prior art in the same repo:

- `tests/lib.test.mjs` — greps every script for a bare `herdr` call outside
  `lib.sh`, asserting the "always go through the wrapper" invariant holds
  everywhere, not only where someone remembered.
- `tests/renderer.test.mjs` — asserts the bash and JS halves resolve the
  manifest path identically, tilde expansion included.

The fix added the missing members of that family: tests asserting the resume
scan never removes a user-tree-locus worktree, that resume-complete never hands
the user's checkout to the removal tail, that `swap_base` refuses any path
outside the plugin's `harvest-` namespace, and that a charset-escaping `run_id`
is refused before any git command runs.

### 3. When a fixture could pass for the wrong reason, build it to fail loudly

The regression test deliberately puts the base branch in a **linked** worktree:

```js
// git refuses to `worktree remove` a main working tree, so a main-tree
// fixture would pass for the wrong reason. A linked checkout is the case
// git will happily delete — and the case real users hit.
```

A main-worktree fixture is exactly what masked the original bug. Reusing it in
the regression test would have verified nothing.

## Why This Matters

A green 137-test suite was not evidence these invariants held across files. It
was evidence they held wherever someone had written a test.

Both bugs lived in **cleanup and recovery** code — the abort reap path, the
resume/swap path. That code only runs after something has already gone wrong: a
crash mid-merge, a re-run of abort. It is by construction the least-exercised
path in normal use, demos, and manual testing, which is precisely why an
unencoded invariant survives there longest.

## When to Apply

Any time an invariant must hold in more than one file — "only touch X under
condition Y," "this identifier must be safe to interpolate into a path" — and
especially when the files are owned by different authors or different parallel
agents, where nobody reads both and notices the asymmetry.

Concrete trigger: **when a comment says "the other file also enforces this,"
that is a task to add a shared-helper guard or a parity test — not the guard
itself.**

## Related

- Commit `27b3c92` — the incident record: "close two data-loss paths and seven
  reliability gaps."
- `docs/residual-review-findings/main-27b3c92.md` — finding 2 is an **open**
  instance of this same class: `SLOT_PATH` and `SLOT_BRANCH` still reach
  `rm -rf`-class git commands without the ownership assertion `run_id` now has.
  The lesson is documented here; it is not yet fully applied.
- `docs/plans/2026-07-22-001-feat-herdr-swarm-plugin-plan.md` — the plan whose
  Key Technical Decisions state both invariants in prose, which is exactly how
  they ended up enforced in one file and not the other.
