---
module: herdr-cli-integration
date: 2026-07-22
problem_type: documentation_gap
component: tooling
severity: high
category: documentation-gaps
related_components:
  - development_workflow
tags:
  - herdr
  - git-worktree
  - agent-lifecycle
  - fan-out
  - version-gating
  - data-loss
applies_when:
  - "Scripting herdr 0.7.4 worktree-per-agent fan-out (agent start/stop, worktree create/remove, workspace close)"
  - "Evaluating whether orchestration can move to herdr 0.7.5"
  - "Writing git worktree cleanup or abort logic that must not silently destroy data"
---

# Herdr 0.7.4 and git 2.55 behaviors that break naive worktree orchestration

## Context

Captured from a live spike against a running herdr 0.7.4 server (protocol 16)
and git 2.55.0 on macOS, 2026-07-22, using a throwaway scratch repo. Raw
evidence lives in `spike-out/` (14 dated files); each fact below cites its own.

These are the six behaviors that a reading of `herdr --help` would predict
differently, and every one of them changed how `herdr-swarm`'s scripts had to
be written. None of them is filed upstream — a `gh` search across
`ogulcancelik/herdr` for each behavior returned nothing relevant, so the vendor
has not documented them either.

## Guidance

### 1. There is no agent-stop verb — pane close is the stop mechanism, and worktree remove is a hidden kill switch

*Evidence: `spike-out/a-agent-stop.txt`*

`herdr agent` has no `stop`. `herdr pane close <pane_id>` kills the process
(PID gone within ~2s, agent drops out of `agent list`).

More surprising: `herdr worktree remove --workspace <id>` on a **clean** tree
holding a **live** agent does not refuse and does not orphan anything. It kills
the agent, closes the grouped workspace, and removes the worktree in one shot,
returning `{"forced":false,"type":"worktree_removed"}`. It refuses only when the
tree is dirty, with error code `dirty_worktree_requires_force`.

Detect that refusal by the error **code**, never by parsing the git fatal text
embedded in `message`.

### 2. Closing a parent workspace cascades silently and orphans the git worktrees

*Evidence: `spike-out/b-parent-close-cascade.txt`*

`herdr workspace close <parent>` closes every grouped worktree workspace beneath
it and kills every live agent inside, with no prompt and no per-child result.
The underlying git worktrees and branches survive on disk, no longer attached to
any workspace.

Any reconciliation layer must therefore treat "the manifest says this workspace
exists" as unverified, and must expect rows where the agent is gone but the
worktree is still on disk.

### 3. `worktree create` silently reuses a stale branch, and a failed create still leaks one

*Evidence: `spike-out/d-worktree-create.txt`*

If the branch already exists and simply is not checked out anywhere,
`herdr worktree create` **silently reuses it at its old tip** — no warning, and
`--base` is ignored. A run that reuses a branch name from a previous attempt
resurrects that attempt's half-finished code with nothing on screen to indicate
it.

Separately, a **failed** create (path collision) still leaves behind the branch
it half-created — there is no rollback.

Two consequences: branch names must be run-unique (a correctness requirement,
not hygiene), and cleanup must sweep branches even for slots whose `create` call
errored.

### 4. `agent start --workspace` does not set cwd

*Evidence: `spike-out/k-agent-start-output.txt`*

Starting an agent scoped to a worktree workspace does **not** run it in that
worktree. Observed cwd was the herdr **server's** own cwd, despite `--workspace`
pointing at a worktree. Always pass `--cwd` explicitly; omitting it puts an
agent to work in the wrong directory with no error anywhere.

Useful corollary from the same capture: the `agent start` JSON response already
returns `pane_id`, `terminal_id`, `workspace_id`, and `cwd` inline, so no
follow-up `agent list` correlation pass is needed to build a manifest row.

### 5. git 2.55's no-`--force` guard has an ignored-file hole

*Evidence: `spike-out/h-git-worktree-remove.txt`*

`git worktree remove` without `--force` refuses for untracked files and for
modified tracked files (exit 128, same message for both — the two cases are not
distinguished). But it **succeeds and silently deletes** a worktree whose only
dirty content is an ignored or excluded file: an agent-written `.env`, a SQLite
database, a log file matched in `.git/info/exclude`.

So "we never pass `--force`, therefore a refusal protects us" is wrong for
anything gitignored. A cleanup path that relies on the refusal as its safety net
needs its own inventory of ignored files before calling remove.

### 6. herdr 0.7.5 replaced arbitrary-argv agent start with a `--kind` whitelist

*Evidence: `spike-out/j-075-agent-start.txt` (docs and release notes; not
live-tested — upgrading was out of scope for the spike window)*

0.7.5's shape is `herdr agent start <name> --kind KIND --pane ID [--timeout MS]
[-- args]`, where `--kind` must be one of roughly 21 whitelisted agent kinds
(`pi`, `claude`, `codex`, `gemini`, `cursor`, …). There is no arbitrary-argv
path — you can no longer spawn an arbitrary command as a tracked, named agent.

For any tool built to be agent-agnostic, this is a hard version gate rather than
a conservative choice: 0.7.5 structurally cannot start a non-whitelisted process
as a tracked agent. `herdr pane split --cwd <path> --no-focus` (verified working
on 0.7.4, unchanged per 0.7.5 docs) is the fallback host-pane primitive both
versions share.

## Why This Matters

Every item above is a place where the CLI's surface behavior — its exit code, or
the absence of an error — does not match what the flags suggest. An
orchestration layer that assumes "clean exit means safe," "no error means
nothing happened," or "the flag I passed took effect" will kill live agent
state, resurrect stale code, or silently work in the wrong directory, with no
exception thrown anywhere in the call chain.

## When to Apply

Any code calling `herdr worktree remove`, `herdr workspace close`,
`herdr worktree create`, or `herdr agent start` programmatically — fan-out,
harvest, and abort scripts, CI glue, any orchestration layer.

## Verify before trusting

Captured on **herdr 0.7.4** (protocol 16, stable channel), **git 2.55.0**,
macOS, **2026-07-22**.

herdr's CLI moves fast: four surfaces broke in the single week between 0.7.4 and
0.7.5 (`agent start` cwd/workspace semantics, plugin global-vs-per-workspace
scoping, `agent send` renamed to `agent send-keys`, top-level `wait` removed in
favor of `agent wait` / `pane wait-output`). Do not assume facts 1–5 hold on a
later version without re-running the spike — check `herdr status` for the
installed version first.

## Related

- `docs/plans/2026-07-22-001-feat-herdr-swarm-plugin-plan.md` — the design these
  facts constrain; its Key Technical Decisions cite them individually.
- Sibling plugin `StructuPath/herdr-browser`, `docs/plans/2026-07-18-001-feat-herdr-browser-plugin-plan.md`
  — independently verified the same per-plugin-id state-dir convention
  (`~/.local/state/herdr/plugins/<plugin_id>/`), which is the one fact here with
  two-repo corroboration.
- `spike-out/` — the raw captures, kept as evidence rather than summarized away.
