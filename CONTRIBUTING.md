# Contributing

Thanks for improving Swarm. The plugin is deliberately dependency-free —
bash + git + Node ≥ 20 — and its value is its safety model, so most of the
rules below exist to keep destructive paths guarded.

## Dev setup

```sh
git clone https://github.com/StructuPath/herdr-swarm
herdr plugin link ./herdr-swarm   # disk edits stay live
npm test
```

There is no build step and there are no npm dependencies. `npm test` runs
`node --test` over `tests/`; CI additionally runs `bash -n scripts/*.sh`,
`shellcheck -x scripts/*.sh` (default severity — the tree is fully clean;
keep it that way), and `node scripts/check-manifest.mjs`, on both Linux and
macOS.

## Test conventions

- **One harness.** `tests/harness.mjs` is the single shared harness; extend
  it there rather than re-inventing fixtures per file. `node --test` gives
  each test file its own process, so per-file `createHarness()` state never
  crosses files.
- **Real git, stubbed herdr.** Merge/worktree semantics are exercised
  against throwaway real repositories (`makeRepo`, `makeFannedOutRun`) — a
  stub git would fake away exactly what the tests must prove. The `herdr`
  CLI is stubbed, and stub responses mirror the real wire JSON captured
  from live herdr; don't invent shapes.
- **Temp dirs are tracked.** Create them via the harness `mkdtemp()` helper
  so they're swept at process exit (`HS_KEEP_TMP=1` keeps them).
- **Exit codes are a contract.** `harvest-step.sh`'s typed exit codes are
  lockstep-asserted in both the bash and the renderer test suites; change
  them in all places or the suites fail loudly (that is the point).

## Shell conventions

- Every prompt has an environment override; nothing may ever block on a
  read when stdin is not a TTY — a missing input is a loud refusal naming
  the variable.
- Destructive operations are the exception, not the rule: no `--force`
  removals, dry-run/preview by default, exact one-use approvals for
  ignored-file deletion, snapshots before discard, and nothing ever deleted
  on a timer. A patch that weakens one of these guards needs a very good
  story.
- Slot-consuming verbs must verify slot ownership (`verify_slot_ownership`)
  before touching anything the manifest names.

## Docs conventions

- `CONCEPTS.md` is the domain glossary — new named concepts belong there.
- `docs/plans/` holds design plans; `docs/solutions/` holds recorded
  platform learnings; `docs/residual-review-findings/` records accepted
  review residuals. Append dated addenda rather than rewriting history.
- User-facing behavior changes belong in `CHANGELOG.md` under
  `[Unreleased]`.

## Pull requests

Keep PRs scoped, keep CI green on both OSes, and describe *why* — the
commit history here (`feat:`/`fix:`/`docs:`/`test:`/`ci:` prefixes, bodies
explaining the reasoning) is the convention to match.
