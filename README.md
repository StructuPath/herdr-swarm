# herdr-swarm

Parallel coding agents on one repo, safely, inside [Herdr](https://herdr.dev).
One action fans out N agents — each into its own git worktree on a run-unique
branch forked from a recorded base SHA — a status pane shows what each agent
actually *changes* (committed and uncommitted counts, not just terminal
output), and a review-first harvest pane merges the work back to base one slot
at a time. Agents commit locally and never push; the orchestrator merges.

## Requirements

- **herdr 0.7.4** — exactly, for fan-out: 0.7.5 replaced `agent start
  --cwd/--workspace` with a pane-targeting form whose `--kind` whitelist has
  no arbitrary-argv path, so fan-out refuses there with a clear message.
  Harvest, abort, and prune of an *existing* run still work on 0.7.5 (they
  are mostly git). Marketplace listing is deferred until an arbitrary-argv
  start path exists on current herdr — see [Publishing](#publishing).
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
   manifests. Deleting requires `HERDR_SWARM_PRUNE_CONFIRM=yes` in the
   action's environment (a zero-TTY action's only confirmation channel);
   merged-then-reverted branches additionally require
   `HERDR_SWARM_PRUNE_ACK_REVERTED=yes`.

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
- `kind` — reserved for future 0.7.5 support (integration-kind dispatch); v1
  accepts any non-empty value and always treats `args` as argv.
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

This repo deliberately does **not** carry the `herdr-plugin` marketplace topic
yet: fan-out refuses on herdr 0.7.5 (the current latest stable), and listing a
fan-out tool whose entry point refuses on the version fresh installers run
would be a first-use dead end. The topic push waits until an arbitrary-argv
agent-start path exists there. Until then the repo is public and
link-installable.

MIT © StructuPath
