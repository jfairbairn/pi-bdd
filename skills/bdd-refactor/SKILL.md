---
name: bdd-refactor
description: Guidance for the REFACTOR phase of red-green-refactor. Load when tests are green and refactoring is the next step. Covers scope, safe refactoring moves, and completion criteria.
---

# BDD Refactor Phase

Refactoring means improving the structure of code without changing its behaviour. All tests must remain green throughout.

## Rules

1. **Run `run_tests` before your first change** — establish the green baseline
2. **Make one structural change at a time** — the smaller the step, the easier to diagnose if tests go red
3. **Run `run_tests` after every change** — confirm green before the next change
4. **If tests go red: revert immediately.** Understand why, then try a smaller step.
5. **Do not add behaviour** — if you spot a missing case, write a spec for it in the next cycle
6. **Do not expand scope** — only touch code written in this cycle

## What Counts as Refactoring

| Refactoring | Safe to do |
|---|---|
| Rename variable, method, class | ✓ |
| Extract method / function | ✓ |
| Extract class / module | ✓ |
| Inline temporary variable | ✓ |
| Move method to a more appropriate class | ✓ |
| Simplify conditional logic | ✓ |
| Remove duplication (DRY) | ✓ |
| Improve naming for clarity | ✓ |

## What Does NOT Count as Refactoring

| Action | What to do instead |
|---|---|
| Adding a new method for future use | Write a spec for it first — next cycle |
| Changing error handling behaviour | Write a spec for the new behaviour — next cycle |
| Optimising an algorithm | Write a performance spec or benchmark first |
| Restructuring the entire module | Break into multiple small refactors |

## Completion

When the code is clean and tests are green:

```
run_tests()             → confirm GREEN
set_bdd_phase(IDLE)     → BDD cycle complete
```

The git checkpoint extension will auto-commit the refactor.

If starting the next scenario immediately, use `set_bdd_phase("AWAITING_RED")` instead.
