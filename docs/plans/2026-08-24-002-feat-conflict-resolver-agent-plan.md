# Plan: agent-assisted conflict resolution (deferred follow-up, design)

Status: **design for review** — implementation gated on live-herdr validation
of the spawn path (marked below). Everything else is buildable and testable
under the existing stub harness.

## Goal

The harvest conflict phase today offers `[s]hell into merge tree`, `[a]bort
merge`, `[b]ack` — v1 deliberately stopped there. This plan adds a fourth
option: `[g]` **spawn a resolver agent** in the conflicted merge tree
(vibe-kanban's pattern, named in the original plan's deferred list), so the
user can hand a conflict to an agent instead of resolving it by hand.

## Why the existing machinery makes this small

A conflicted merge already leaves exactly the environment a resolver needs,
with recovery guaranteed by machinery that ships today:

- The merge tree is left in place with the conflict markers, and the
  **journal** records the merge intent (slot, locus, expected base) before
  git mutated anything.
- A human who shells in resolves, `git add`s, and commits; on the next
  harvest open the **resume scan** sees the journaled expectation and offers
  to complete the swap (`resume_offer`), or reports it stale/dangling.
- `abort-merge` remains the escape hatch at every point.

A resolver agent therefore needs **no new lifecycle**: it sits precisely
where the human shell sits, and everything after it is the existing
journal/resume flow. If the agent fails or wanders, the journal still
guards the swap and abort-merge still cleans up.

## Design

### Verb: `harvest-step.sh resolve <slot>`

Non-destructive by construction (it only *starts* an agent; it merges
nothing):

1. `read_slot` (ownership check as every verb).
2. Refuse unless the slot's journal shows a merge in flight with **detached
   locus** — the merge tree must be the plugin-owned worktree.
   **User-tree conflicts are refused** with a message: spawning an agent in
   the user's own checkout is outside the plugin's ownership model (the
   Locus KTD gates exactly this).
3. Refuse unless the merge tree currently has unmerged paths (`ls-files -u`
   non-empty) — a resolved or clean tree has nothing to hand over.
4. Write the resolver brief to `.swarm-task.md` in the merge tree (already
   excluded via `info/exclude`): the conflicted file list, the base and slot
   tips, and standing instructions — resolve every conflict, `git add`, make
   exactly one commit concluding the merge, never push, never touch refs.
5. Start the agent via the existing `herdr_agent_start` seam (the one
   version-gated function; 0.7.4 `agent start --cwd` / 0.7.5 pane-built
   topology), using a preset chosen the same way fan-out chooses one
   (`HERDR_SWARM_RESOLVER_PRESET`, or prompt in the pane).
6. Record `resolver: {pane_id, terminal_id, agent_name}` on the slot row
   (manifest JSON merge; additive field), and emit typed stdout facts.

### Renderer

- Conflict phase adds `[g]` → runs the verb, banners the result, returns to
  list. The conflict stays a conflict in the UI until the agent's commit
  exists; the existing `r` re-preview / resume flow picks up the completed
  merge exactly as if a human had resolved it.
- Status pane: nothing new — the resolver registers as an agent like any
  slot agent (plugin-reported on 0.7.5).

### Cleanup composition

- `abort-merge` and Abort must stop a recorded resolver before removing the
  merge tree — same "settled check" archive already does (idle/absent only),
  reusing `herdr_agent_list` + the recorded ids.
- The resolver record clears when the journal clears.

## What must be validated against live herdr before shipping

- (a) `herdr_agent_start` into an **existing** directory that is a linked
  worktree with a conflicted index — fan-out only ever starts agents in
  fresh worktrees; the pane-built 0.7.5 path should be identical, the 0.7.4
  native path needs a live probe.
- (b) Whether the resolver's workspace grouping (it is not a `swarm/…`
  branch worktree) collides with the pane-title cleanup sweeps.
- (c) UX: whether a second agent pane inside the harvest workspace is
  usable or confusing.

## Test strategy (stub harness, same as everything else)

- Verb refusals: no journal, user-tree locus, no unmerged paths, unknown
  preset — all typed exit codes.
- Happy path: fixture conflict (two branches editing one file), merge →
  HS_EC_CONFLICT, `resolve` → stub herdr records the start call with the
  merge-tree cwd; brief file exists in the tree with the conflicted paths.
- Composition: after a scripted "agent" resolves and commits, `resume`
  offers the swap (this test exists for the human path; parameterize it).
- Cleanup: abort with a recorded live resolver refuses/stops per the
  settled-check rules.

## Out of scope

- Auto-accepting the agent's resolution: the swap stays behind the existing
  resume confirmation. Nothing merges without an explicit decision.
- Multiple resolvers per slot; resolver retries (re-run `g` after abort).
