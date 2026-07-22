# herdr-swarm

Parallel coding agents on one repo, safely, inside [Herdr](https://herdr.dev).
One action fans out N agents — each into its own git worktree on a run-unique
branch forked from a recorded base SHA — a status pane shows what each agent
actually *changes* (committed and uncommitted counts, not just terminal
output), and a review-first harvest pane merges the work back to base one slot
at a time. Agents commit locally and never push; the orchestrator merges.

## Requirements

- **herdr 0.7.4 or newer.** Fan-out works on both 0.7.4 and 0.7.5+, by two
  different routes, because 0.7.5 replaced `agent start --cwd/--workspace`
  with a pane-targeting form whose `--kind` is a closed whitelist with no
  arbitrary-argv member:
  - On **0.7.4**, `agent start --cwd` builds each slot and herdr detects the
    agent natively, so slot state in the status pane is herdr's own.
  - On **0.7.5+**, the plugin builds each slot itself — `pane split` into the
    worktree, `pane run` for the slot's argv, `pane report-agent` to register
    it — so slots run *any* command, but their state is **plugin-reported**:
    `working` when the slot starts, `idle` once a harvest preview finds the
    slot finished. Nothing polls in between, so a 0.7.5 slot that finishes on
    its own still reads `working` until you open harvest. This is cosmetic:
    committed work is harvestable regardless, and nothing in the plugin gates
    on agent state.
  - On **0.7.5+**, `pane run` hands the slot's argv to the pane's **shell**,
    not to `exec` — a preset containing shell metacharacters is interpreted
    there, unlike on 0.7.4. Presets are your own config, but keep them to a
    plain command and its flags.

  Harvest, abort, and prune of an existing run work on every supported
  version (they are mostly git). Versions above the newest tested get a
  warning, never a refusal.
- **git >= 2.38** recommended (relies on `git worktree`, three-arg
  `git update-ref` compare-and-swap, and `git merge-base --is-ancestor`).
- **Node.js >= 20** on your PATH (manifest handling and the pane renderers).
- macOS or Linux.

## Install

```sh
herdr plugin install StructuPath/herdr-swarm
```

For development:

```sh
git clone https://github.com/StructuPath/herdr-swarm
herdr plugin link ./herdr-swarm
npm test
```

## Quick start

The plugin ships five actions (Herdr plugins cannot ship default keybindings —
add your own, see below):

1. **Fan out** (`structupath.swarm.fanout`) — opens the fan-out pane, which
   prompts for: leftover-detritus handling if a previous run left `swarm/*`
   branches (delete / rename to `swarm-kept/` / quit), slot count N (soft cap
   6, raise with `HERDR_SWARM_MAX_SLOTS`), a preset per slot, a shared task
   prompt (finish with a single `.` on its own line), and optional per-slot
   task overrides. It then creates one worktree + branch
   (`swarm/<run-id>/<slot>`) per slot, writes the task to `.swarm-task.md` in
   each worktree (kept out of `git status` via the repo's `info/exclude`),
   starts the agents, and opens the status pane.
2. **Status** (`structupath.swarm.status`) — per-slot agent state (`blocked`
   rendered loud), branch, and committed/uncommitted change counts measured
   against the recorded fork SHA, never the moving base tip. Keys: `1`–`9`
   jump to that slot's agent, `q` closes the pane. Survives a Herdr restart;
   unreachable agents show as `unknown` with their committed work still
   harvestable.
3. **Harvest** (`structupath.swarm.harvest`) — review-first merge-back. Keys:
   `1`–`9` select a slot, `r` re-previews, `q` quits. Per slot:
   - *Clean slot* — merged `--no-ff` with a templated message. The base ref is
     drift-checked before **every** merge; if it moved, all slots re-preview.
     When base is not checked out anywhere, the merge runs in a plugin-owned
     detached worktree and the base ref advances by atomic compare-and-swap.
     When base *is* your checked-out branch, you get an explicit confirm and
     the merge runs in your tree only after a clean-tree re-check.
   - *Dirty slot* — prompt: `w` commit as WIP, `s` skip, `d` discard (typed
     branch-name confirmation; a snapshot ref is written first).
   - *Conflict or hook failure* — classified distinctly; `s` shells into the
     merge tree, `a` aborts the merge (`git merge --abort`), `b` backs out.
   - *Archive* — after merge/skip, the worktree is removed (branch kept); an
     inventory of ignored files that removal would silently delete is shown
     first and requires acknowledgment.
4. **Abort** (`structupath.swarm.abort`) — abandon the run, mid-flight or
   post-crash: stops agents, closes swarm panes/workspaces, removes clean
   swarm worktrees, keeps everything questionable, prints a summary. Branches
   are never deleted by abort.
5. **Prune** (`structupath.swarm.prune`) — dry-run listing of fully-merged
   `swarm/*` branches, discard-snapshot backup refs, and archived run
   manifests. Deletion is gated per resource class, because the classes are
   not equally recoverable (a zero-TTY action's only confirmation channel is
   its environment):
   - `HERDR_SWARM_PRUNE_CONFIRM=yes` — delete the listed fully-merged
     `swarm/*` branches. This flag never touches backup refs.
   - `HERDR_SWARM_PRUNE_ACK_REVERTED=yes` — additionally required for a
     branch flagged merged-then-reverted.
   - `HERDR_SWARM_PRUNE_BACKUPS=yes` — delete `refs/swarm-backups/*` discard
     snapshots. Separate on purpose: a merged branch is recoverable from the
     merge it landed in, but a snapshot is the *last* copy of discarded work.
     Snapshots belonging to the **active run** are never deleted, even with
     this flag — abort or harvest the run first.

### Scripting fan-out

Fan-out normally prompts, but every prompt has an environment override, so an
agent, a script, or a CI job can start a run with no TTY. Each variable replaces
exactly one prompt; anything you leave unset still prompts, so interactive use is
unchanged.

| Variable | Replaces |
|---|---|
| `HERDR_SWARM_SLOTS` | slot count (same cap check, raise with `HERDR_SWARM_MAX_SLOTS`) |
| `HERDR_SWARM_PRESETS` | comma-separated preset names, one per slot; a single name applies to all slots |
| `HERDR_SWARM_TASK_FILE` | path to a file whose contents become the shared task |
| `HERDR_SWARM_TASK` | single-line shared task; **`HERDR_SWARM_TASK_FILE` wins if both are set** |
| `HERDR_SWARM_DETRITUS` | `delete` \| `rename` \| `abort` — the leftover-branch prompt |
| `HERDR_SWARM_DETRITUS_ACK_UNMERGED=yes` | the typed `delete-unmerged` second confirmation |

```sh
printf 'Add retry-with-backoff to the HTTP client.\nKeep the public API unchanged.\n' > /tmp/brief.md

HERDR_SWARM_SLOTS=3 \
HERDR_SWARM_PRESETS=claude,claude,codex \
HERDR_SWARM_TASK_FILE=/tmp/brief.md \
HERDR_SWARM_DETRITUS=rename \
  herdr plugin action run structupath.swarm.fanout
```

Notes:

- **The task file is a file, not a variable, on purpose.** The task is normally
  multi-line, and the stdin protocol terminates a task on a lone `.` line — an
  environment variable has no equivalent terminator.
- **`delete` does not bypass the unmerged-work guard.** If a leftover `swarm/*`
  branch holds commits that are not in your base, `HERDR_SWARM_DETRITUS=delete`
  refuses and the fan-out exits non-zero rather than reaching `git branch -D`.
  `HERDR_SWARM_DETRITUS_ACK_UNMERGED=yes` is the explicit opt-in, exactly as
  prune gates its destructive classes separately. `rename` keeps the work under
  `swarm-kept/` and always succeeds.
- **Per-slot task overrides stay interactive-only.** Fan out once per distinct
  task instead; there is no env encoding for N free-form multi-line prompts.
- **Nothing blocks on a read.** With any of these variables set and stdin not a
  terminal, a missing piece is a loud refusal naming the variable — never a
  process waiting forever for input nobody will type.

### Can an agent drive the whole plugin?

Yes — all four mutating capabilities are scriptable:

| Capability | Scriptable path |
|---|---|
| Fan out | the variables above (zero-TTY) |
| Harvest | `scripts/harvest-step.sh <verb>` — a verb CLI with typed exit codes and `key<TAB>value` stdout |
| Abort | `scripts/abort.sh` — a zero-TTY action, env-gated |
| Prune | `scripts/prune.sh` — a zero-TTY action, dry run by default, env-gated per resource class |

### Keybinding

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+s"
type = "plugin_action"
command = "structupath.swarm.fanout"
description = "swarm fan-out"
```

## Presets

Each slot runs the argv of a named preset. Config file:
`$(herdr plugin config-dir structupath.swarm)/presets.conf`, one preset per
line:

```text
name|kind|args...

estimator|argv|claude --model opus
codex-fast|argv|codex --profile fast
```

- `name` — letters, digits, `_`, `-` only (it becomes part of branch and
  worktree names).
- `kind` — inert. It was reserved for dispatching on herdr's integration kind
  on 0.7.5, but that path turned out to be a closed whitelist with no
  arbitrary-argv member, so the plugin builds slot topology itself instead and
  always treats `args` as argv. Any non-empty value is accepted; the field
  stays for config compatibility.
- `args` — split on whitespace at spawn time; no shell quoting.
- Missing or empty file yields two built-in defaults: `claude` and `codex`.
  A malformed line fails the whole catalog loudly rather than being skipped.

## Fresh worktrees lack your env

Every slot starts in a **fresh** worktree: gitignored files — `.env`,
`node_modules`, build caches, installed deps — are absent. This is the most
likely cause of "all my agents failed instantly": either have the task prompt
tell agents to install deps first, or prep each worktree yourself before the
agents get going. The same applies to repo hooks during harvest: a hook that
shells into `node_modules/.bin` fails in the plugin-owned merge worktree —
`HERDR_SWARM_HARVEST_WT_NO_HOOKS=1` disables hooks in that worktree *only*
(never in your tree). To automate worktree prep, drop a `setup.sh` in the
plugin config dir (`herdr plugin config-dir structupath.swarm`): fan-out runs
it inside each new worktree before the agent starts (timeout
`HERDR_SWARM_SETUP_TIMEOUT`, default 300s). A failing hook warns loudly and
starts the agent anyway; output lands in the plugin state dir.

## Safety model

- Agents commit locally and never push (standing instructions in every task
  file); merging back is always the orchestrator's explicit act.
- Merges are `--no-ff` and review-first; the base ref is drift-checked before
  every merge and advanced by an atomic compare-and-swap (or, in your own
  tree, verified post-merge and rolled back on mismatch).
- Nothing is ever force-removed: `git worktree remove` runs without `--force`,
  so dirty state always fails loudly into the commit-WIP/skip/discard flow.
- Discard writes the dirty tree — tracked and untracked — to
  `refs/swarm-backups/<run-id>/<slot>` before touching anything, and refuses
  without a recorded snapshot.
- Abort touches only what the plugin created (manifest-tracked resources plus
  panes matching its own titles) and always prints what it closed, removed,
  and kept.
- Prune is a dry run by default; deletion is an ancestry test against the
  manifest-recorded base (never `git branch -d`'s HEAD-relative view alone),
  and nothing is deleted on a timer, ever.
- A crash mid-merge is journaled: reopening harvest detects the interrupted
  merge and offers to complete or abandon it; a dangling merge commit is
  reported, never silently unreachable, and its worktree is never auto-deleted.

## Sharp edges

- **Squash merges are invisible.** A slot you squash-merged yourself still
  shows as pending and will conflict on re-merge — skip it by hand. Fast-
  forward and plain external merges *are* auto-detected via ancestry.
- **Ignored files sit outside every safety net** — not in WIP commits, not in
  discard snapshots, not protected by no-`--force` removal. The archive-time
  ignored-file inventory prompt is the only guard.
- **Closing the parent repo workspace kills swarm agents silently** (the
  worktree workspaces are grouped under it). Committed work survives and
  stays harvestable; uncommitted editor state in the agent does not.

## Uninstall / cleanup

Harvest or abort the active run, then prune, before uninstalling — the plugin
never garbage-collects on its own. Plugin state (run manifests, archived as
recovery records) lives in herdr's plugin state dir
(`~/.local/state/herdr/plugins/structupath.swarm`); remove it by hand if you
want a truly clean slate. Plugin logs:
`herdr plugin log list --plugin structupath.swarm`. Uninstall with
`herdr plugin uninstall structupath.swarm`.

## Publishing

This repo does not carry the `herdr-plugin` marketplace topic yet. The reason
it was deferred is gone — fan-out no longer refuses on current stable — but
adding the topic is a separate decision, not an automatic consequence. The
repo is private for now; `herdr plugin link` against a local clone is the
supported install path.

MIT © StructuPath
