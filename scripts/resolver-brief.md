# Resolve a merge conflict

This directory is a merge of `{{SLOT_BRANCH}}` ({{SLOT_TIP}}) into `{{BASE_BRANCH}}` ({{BASE_SHA}}) that stopped on conflicts.
Conflicted files:

{{CONFLICTED}}

## Instructions

- Resolve every conflict so both sides' intent survives; read each side's history if unsure.
- Change nothing beyond what resolving the conflicts requires.
- `git add` the resolved files, then conclude the merge with exactly ONE `git commit --no-edit`.
- Never push, never create or switch branches, never rebase, reset, or `git merge --abort`.
- Then stop. A person reviews the result and decides whether it lands.
