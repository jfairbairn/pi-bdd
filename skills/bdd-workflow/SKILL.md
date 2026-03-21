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
2. Load `measurement-design` — confirm success conditions are specific and measurable, and derive the telemetry spec. Update PRODUCT.md before writing any spec or code.
3. Identify the outermost boundary (acceptance test? API endpoint? UI component?)
4. Load `bdd-testing-strategy` to determine the right spec style for that boundary
5. Write the outer spec file (functional behaviour AND telemetry event emission)
6. Call `set_bdd_phase("AWAITING_RED", featureName: "<name>", layer: "<outer-layer>")`
7. Call `run_tests(layer: "<outer-layer>")` → system confirms RED
8. Identify what inner layer the outer spec depends on
9. Repeat the inner loop:
   a. `set_bdd_phase("AWAITING_RED", layer: "<inner-layer>")`
   b. Write inner spec
   c. `run_tests(layer: "<inner-layer>")` → confirm RED
   d. Write minimum implementation
   e. `run_tests(layer: "<inner-layer>")` → confirm GREEN
   f. `set_bdd_phase("REFACTOR")` → refactor → `run_tests` → confirm GREEN
   g. `set_bdd_phase("AWAITING_RED")` for next inner layer, or proceed to outer
10. Implement outer layer
11. `run_tests()` (all tests, not just focused) → confirm outer GREEN
12. `set_bdd_phase("REFACTOR")` → refactor → `run_tests` → GREEN
13. `set_bdd_phase("IDLE")` → triggers documentation check + security scan prompt
14. `check_docs(atIdle: true)` → `update_roadmap` → `update_doc_status`
15. `security_scan` → resolve any critical/high findings before deployment
16. `/release` → run the six release gates → deploy to production when all pass

## After IDLE: The Release Process

`set_bdd_phase("IDLE")` ends the development cycle. Everything through to staging then proceeds automatically:

1. **Security scan** fires automatically (follow-up message after IDLE)
2. **If Gate 2 passes cleanly** → the system automatically instructs the agent to run `check_release_readiness`, which runs Gates 3, 4, and 5 in parallel:
   - Gate 3 (non-functional) — load/perf tests
   - Gate 4 (staging) — deploy → sanitise verify → migrate → test suite on real data
   - Gate 5 (measurement) — PostHog success conditions queryable
3. **If Gate 2 requires manual review** → system pauses, you review the diff, call `mark_gate_passed(2)`, then `check_release_readiness` proceeds
4. **Gate 6** — the single human checkpoint before production: rollback readiness checklist
5. Production deploy runs, ROADMAP updated to deployed

**Staging is autonomous when security passes. You only touch the process twice: once if manual security review is flagged, once at Gate 6 before production.**

Use `/release` at any time to see current gate status.

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
