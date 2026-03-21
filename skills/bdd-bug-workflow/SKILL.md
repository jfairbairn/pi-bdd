---
name: bdd-bug-workflow
description: BDD approach to bug fixing. Load when a bug is reported, an unexpected behaviour is observed, or a regression is discovered. Covers the four bug types, how to identify which you have, and the correct BDD first move for each.
---

# BDD Bug Workflow

## What a Bug Is (in BDD terms)

A bug is always a failure of specification — either the spec had a gap, the spec was wrong, the spec was misunderstood, or the spec didn't cover a non-functional dimension. The code is, in a sense, innocent: it did exactly what the tests allowed it to do.

This framing matters because it determines the first move: **always fix the spec before fixing the code**.

## The Four Bug Types

### Type 1: Gap Bug
**The spec said nothing about this case. The behaviour was assumed, never encoded.**

This is the most common type. No test covers the failing case. The assumption about what would happen was wrong, and nothing was watching.

Examples:
- Login accepts empty passwords (nobody wrote a test for that)
- API returns 500 on null input instead of 400
- A calculation overflows with large numbers
- Unicode characters break a string comparison

**First move:** Write a failing regression test specifying the *correct* behaviour. Confirm RED. Fix. Confirm GREEN.

---

### Type 2: Spec Defect Bug
**A test exists for this behaviour, but the test is wrong — too weak, testing a proxy, or encoding an incorrect assumption. The test has been silently passing despite wrong behaviour.**

Examples:
- A test checks `expect(result).toBeDefined()` when it should check the actual value
- A test mocks too aggressively and doesn't catch a real integration problem
- A test checks the happy path but the assertion doesn't verify the important property

**First move:** Strengthen or correct the existing test until it fails against the current (wrong) implementation. This is the hardest type to spot — the instinct is to fix the code, but the spec needs fixing first.

After correcting the test and confirming RED, fix the implementation to satisfy the corrected spec.

---

### Type 3: Requirements Misunderstanding Bug
**The feature was built correctly according to an accepted spec. Tests pass. But the spec didn't capture what was actually needed. Users experience it as wrong; engineers see green.**

This is not a code bug — it's a communication failure at the specification stage. The code faithfully implements a flawed agreement.

Examples:
- "Sort by date" was implemented as ascending but users expected descending
- "Delete account" was implemented as soft-delete but users expected hard-delete
- An API response shape was agreed but turns out not to fit the consumer's needs

**First move:** Do not touch code. Revise the feature description/scenario to reflect the *correct* behaviour — and get agreement. Then update the test to match the revised spec (it will fail). Then update the implementation.

**Important:** If the existing test gets changed, document *why* — the decision record matters here. Someone accepted the original spec; that acceptance should be acknowledged and superseded deliberately.

---

### Type 4: Non-Functional Bug
**The behaviour is functionally correct but violates an implicit non-functional requirement: performance, security, concurrent safety, resource usage, accessibility.**

These are gap bugs at the non-functional level: the expectation was real but never encoded as a test.

Examples:
- A query returns correct results in 30 seconds (implicit: should be < 200ms)
- An authentication flow has a timing side-channel (implicit: should be constant-time)
- A background job leaks file handles under load
- A component is inaccessible to screen readers

**First move:** Write a failing non-functional spec (performance test, security test, load test, accessibility test). Confirm it fails. Fix. Confirm it passes.

Treat non-functional requirements as requirements — they need specs too.

---

## The Diagnostic Flow

When a bug is reported, before writing any code or tests:

```
1. Find the relevant component and its existing tests
   └── Do any existing tests cover this case?
       ├── YES, and the test is FAILING  →  Regression. Investigate what changed.
       │                                    Fix the code (spec is correct).
       │
       ├── YES, and the test is PASSING  →  Type 2 (Spec Defect).
       │                                    The test is wrong. Fix the test first.
       │
       └── NO test covers this case
           ├── Is the behaviour described in the feature spec/scenario?
           │   ├── YES, as correct behaviour  →  Type 3 (Requirements Misunderstanding).
           │   │                                  Revise the spec, get agreement.
           │   └── NO                         →  Type 1 (Gap Bug).
           │                                     Write a regression test.
           │
           └── Is this a non-functional concern (perf, security, concurrency)?
               └── YES  →  Type 4. Write a non-functional spec.
```

**Check the spec before writing any code.** If the current behaviour matches the spec and the spec is correct — this may not be a bug at all. It may be a documentation or UX problem.

## Edge Case: The Bug Report Might Be Wrong

Before doing anything, verify the reported behaviour actually occurs. Then check whether it violates the *current* spec. If the behaviour is correct per the spec and the spec is correct — the fix is to improve documentation or UX, not to change behaviour. Close the bug with explanation.

## Using report_bug

Start every bug fix cycle with `report_bug`:
```
report_bug(
  bugType: "gap" | "spec-defect" | "requirements" | "non-functional",
  description: "what is currently happening",
  expectedBehaviour: "what should happen instead",
  featureName: "user-login",    // optional — parent feature this bug belongs to
  affectedComponent: "AuthService",  // optional — specific component or layer
  issueRef: "GH-42"             // optional — issue tracker reference
)
```

This sets the phase to `AWAITING_RED` and tracks bug metadata for commit messages and status display.

## Issue Tracker Integration

If the project uses an issue tracker (GitHub Issues, Linear, Jira, etc.):
- Use an MCP tool or web search to fetch the issue content before calling `report_bug`
- Include the issue reference (`issueRef`) so it appears in commit messages
- Close or transition the issue once GREEN is confirmed

## BDD Cycle for Bugs

The cycle is identical to feature development — the entry point and commit conventions differ:

```
report_bug()           →  AWAITING_RED  (bug registered)
Write regression test  →  run_tests()  →  RED confirmed
Fix implementation     →  run_tests()  →  GREEN confirmed
set_bdd_phase(REFACTOR) → refactor     →  run_tests()  → GREEN
set_bdd_phase(IDLE)    →  check_docs() + update_roadmap()
```

## Documentation at IDLE (Bug Cycles)

At IDLE after a bug fix:
- `check_docs`: verify the component README covers the fixed behaviour (or cross-references the new regression test)
- `update_roadmap`: no entry needed for most bugs; add one if the bug revealed a missing specified behaviour that should be tracked
- If Type 3 (Requirements): update the relevant feature description/scenario to reflect the revised spec
- If the fix revealed a broader spec gap: consider whether other scenarios need adding

The regression test *is* the primary documentation of what was wrong and what the correct behaviour is. The semantic commit message (`fix: <description>`) is what the CI/build system uses to generate release notes from git history.
