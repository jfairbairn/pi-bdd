---
name: bdd-workflow
description: Outside-in BDD red-green-refactor workflow. Use when building any new feature, component, endpoint, or layer. Explains the full cycle, the outside-in decomposition strategy, and how to use the run_tests and set_bdd_phase tools.
---

# BDD Workflow — Outside-In Red-Green-Refactor

## The Core Method

BDD is **outside-in**: you always start at the outermost boundary of the behaviour you're describing, write a failing spec there, then work inward — discovering and implementing each layer as the outer spec demands it.

At every level:
1. **Write a failing spec** (appropriate for this layer — see `bdd-testing-strategy`)
2. **Run tests** (`run_tests`) → confirm RED
3. **Write minimum production code** to satisfy the spec
4. **Run tests** → confirm GREEN
5. **Refactor** without changing behaviour → `set_bdd_phase(REFACTOR)` → run tests → confirm still GREEN
6. **Commit** → `set_bdd_phase(IDLE)` or loop to next scenario/layer

## The Double Loop

```
┌─── Outer loop (acceptance / API / UI boundary) ────────────────────────────┐
│                                                                            │
│  Write outer spec (RED)                                                    │
│  └── outer spec fails because inner layer doesn't exist yet                │
│       │                                                                    │
│       │  ┌─── Inner loop (service / domain / repo / component) ──────────┐ │
│       │  │                                                                │ │
│       │  │  Write inner spec (RED)                                        │ │
│       │  │  Implement inner layer (GREEN)                                 │ │
│       │  │  Refactor inner layer                                          │ │
│       │  │  (repeat for each inner dependency)                            │ │
│       │  │                                                                │ │
│       │  └────────────────────────────────────────────────────────────────┘ │
│       │                                                                    │
│  Implement outer layer (outer spec goes GREEN)                             │
│  Refactor outer layer                                                      │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

## Phase Rules (enforced by the system)

| Phase | What you can do | What is blocked |
|---|---|---|
| IDLE | Write specs, feature files | Production code writes |
| AWAITING_RED | Write specs | Production code writes |
| RED | Write production code, write specs | — |
| GREEN | Refactor, write next inner spec | — |
| REFACTOR | Refactor only | — |

**The system will block writes to production paths in IDLE and AWAITING_RED. Do not attempt workarounds.**

## Starting a Bug Fix

Use `/bugfix` or describe the bug. Before writing anything:
1. Load `bdd-bug-workflow` to run the diagnostic flow and identify the bug type
2. Call `report_bug(bugType, description, expectedBehaviour, featureName?, affectedComponent?, issueRef?)`
3. Follow the type-specific first move (new regression test, correct existing test, revise spec, or non-functional spec)
4. The rest of the cycle is identical to feature development from RED onward

## Step-by-Step: Starting a New Feature

1. Use `/feature` template or describe the feature to establish what needs to be built
2. Identify the outermost boundary (acceptance test? API endpoint? UI component?)
3. Load `bdd-testing-strategy` to determine the right spec style for that boundary
4. Write the outer spec file
5. Call `set_bdd_phase("AWAITING_RED", featureName: "<name>", layer: "<outer-layer>")`
6. Call `run_tests(layer: "<outer-layer>")` → system confirms RED
7. Identify what inner layer the outer spec depends on
8. Repeat the inner loop:
   a. `set_bdd_phase("AWAITING_RED", layer: "<inner-layer>")`
   b. Write inner spec
   c. `run_tests(layer: "<inner-layer>")` → confirm RED
   d. Write minimum implementation
   e. `run_tests(layer: "<inner-layer>")` → confirm GREEN
   f. `set_bdd_phase("REFACTOR")` → refactor → `run_tests` → confirm GREEN
   g. `set_bdd_phase("AWAITING_RED")` for next inner layer, or proceed to outer
9. Implement outer layer
10. `run_tests()` (all tests, not just focused) → confirm outer GREEN
11. `set_bdd_phase("REFACTOR")` → refactor → `run_tests` → GREEN
12. `set_bdd_phase("IDLE")` → BDD cycle complete

## After IDLE

`set_bdd_phase("IDLE")` ends the coding cycle. What happens next depends on what other lifecycle loop plugins are installed (delivery, observation, etc.). If nothing else is configured, you're done — the code is tested and committed.

## On "Minimum Code to Go Green"

Write only what is needed to make the failing spec pass. No more.

- Do not implement the next scenario's behaviour speculatively
- Do not add error handling that no spec requires yet
- Do not optimise prematurely
- If you find yourself thinking "while I'm here, I'll also..." — stop. Write a spec for it first.

This is not laziness — it is discipline. Speculative code is untested code.

## On the Refactor Phase

Refactoring is restructuring without changing behaviour. During REFACTOR:
- Run `run_tests` before every change
- Run `run_tests` after every change — confirm still GREEN
- Only touch code written in this cycle
- No new behaviour, no new specs

If tests go RED during refactor: your refactoring changed behaviour. Revert, understand why, try again.

## Choosing the Right Spec Style

Load `bdd-testing-strategy` to identify:
- Which layer you're about to implement
- What kind of isolation is appropriate (mocks, fixtures, harnesses)
- Which spec style fits (Gherkin scenario, RSpec describe/it, Vitest describe/it)

Gherkin is appropriate when:
- The outer boundary is user-facing behaviour
- A stakeholder (non-engineer) needs to read and verify the spec
- Example tables or data tables add genuine clarity

Plain describe/it is appropriate for everything else.
