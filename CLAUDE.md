# herdr-swarm — agent notes

Bash + git + Node ≥ 20 Herdr plugin, deliberately dependency-free. Its value
is its safety model; most rules below guard destructive paths. CONTRIBUTING.md
is the longer human-facing version; CONCEPTS.md is the domain glossary
(Run/Slot/Fork SHA/Manifest/Harvest/Locus/Journal/Snapshot/Publish — read it
before renaming anything).

## Commands

- `npm test` — full suite (`node --test`, one process per test file).
- `node --test tests/<file>.test.mjs` — one suite.
- `shellcheck -x scripts/*.sh` — must stay fully clean at default severity.
- `bash -n scripts/*.sh` and `node scripts/check-manifest.mjs` — CI also runs
  these, on ubuntu AND macos.

## Hard rules (tests enforce most of these)

- **One harness.** `tests/harness.mjs` is the only test harness; extend it
  there, never re-invent per file. Create temp dirs via its `mkdtemp()` —
  they are swept at process exit.
- **Real git, stubbed herdr.** Merge/worktree behavior is tested against
  throwaway real repos; the `herdr` CLI is stubbed with JSON captured from
  live herdr — never invent wire shapes.
- **Destructive git lives in scripts/ only.** No git-mutation or raw-CLI
  strings in `bin/` (a test greps every file there). Every Herdr invocation
  goes through the `lib.sh` wrappers (another test greps for violations).
- **Typed exit codes are a contract.** `harvest-step.sh`'s `HS_EC_*` and the
  renderer's `STEP_EC` are lockstep-asserted; change both or fail loudly.
- **Verbs never block on a read.** Every prompt has an env override; missing
  input with no TTY is a loud refusal naming the variable.
- **Safety nevers**: no `--force` removals or pushes, dry-run/preview by
  default, snapshot before discard, exact one-use approvals for ignored-file
  deletion, nothing deleted on a timer, slot ownership verified
  (`verify_slot_ownership`) before touching anything the manifest names.

## Docs conventions

- Behavior changes → `CHANGELOG.md` under `[Unreleased]`; versions live in
  lockstep in `herdr-plugin.toml` + `package.json` (check-manifest enforces).
- Design plans → `docs/plans/`; platform learnings → `docs/solutions/`;
  accepted review residuals → `docs/residual-review-findings/` (append dated
  addenda, never rewrite history).
- Commit style: `feat:`/`fix:`/`docs:`/`test:`/`ci:` with bodies that explain
  why.
