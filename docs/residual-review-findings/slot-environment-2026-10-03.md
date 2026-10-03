# Residual review findings — slot environment, accepted 2026-10-03

From an adversarial review of the uncommitted slot-environment change: five
findings, including two P1s. The reviewer found no issue with the `rm -rf` /
`mv` targets, path validation, Linux reflink failures, or env injection.
Fixed before commit:

- **P1 — cleanup approval impossible for real dependency trees.** The
  ignored-file inventory was passed to Node as one argv string. A worktree
  with `node_modules` puts it past ARG_MAX, and `exec` failed with E2BIG.
  This was latent before this change (any `setup.sh` running `npm install`
  hit it); default cloning would have made it routine. The inventory now
  travels as a file. A 10,000-file regression test was mutation-checked: the
  argv path fails it with "Argument list too long".
- **P1 — an orphaned `cp` after a clone timeout.** It kept writing a
  non-ignored temp tree the agent could commit. Clones now run under the
  process-group timeout, `.swarm-clone.*` is excluded, and a temp that
  survives `rm` is reported. The test was mutation-checked.
- **Mid-loop port refusal.** The highest slot's range is now validated
  before any worktree is created.
- **Octal/leading-zero port values.** Normalized as decimal.
- **Non-relocatable clones (`.venv`).** Documented.
- **The docs claimed macOS skips rather than copies.** Corrected:
  `cp -c` falls back to a full copy.

The items below were accepted as residual.

## 1. Clones are the main checkout's current state

The clone is not built from the fork commit's lockfile. A `setup.sh`
guarded by `[ -d node_modules ] || npm ci` now never installs. The README
says to run the installer unconditionally where that matters.

## 2. Absolute symlinks inside a cloned tree still point at the repo

Deletion is safe: worktree removal does not follow symlinks. But writes
through such a link, such as `npm link` targets, land in the main checkout.
Not detected; documented through the relocatable-paths guidance.

## 3. The 0.7.4 agent gets no environment variables

`agent start` has no env field. The port range reaches the agent through
the task file only.
