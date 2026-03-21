---
name: signal-to-spec
description: Translates production signals into BDD cycle inputs. For each type of signal from query_signals or manual investigation, determines the correct BDD entry point and the form the spec should take. This is the operational mechanism of the closed loop.
---

# Signal to Spec

## The Translation

Every production signal maps to one of four BDD actions:

| Signal type | BDD entry point | Tool |
|---|---|---|
| Behaviour that fails and has no test | Gap bug → regression spec | `report_bug(bugType: "gap")` |
| Behaviour that fails and has a passing test | Spec defect → fix the test | `report_bug(bugType: "spec-defect")` |
| Feature not meeting success conditions | Non-functional bug | `report_bug(bugType: "non-functional")` |
| Users trying to do something unsupported | New feature spec | `/feature` prompt |
| Success condition metric trending wrong | Revised requirement | Update PRODUCT.md, then `/feature` |

## Signal Types and Their Translations

### Error spike in logs or error tracker
```
Signal: 500 errors on /api/payments, 3% error rate, rising
Hypothesis: gap bug (no spec covers malformed payment payload)

Verify: query_logs(pattern: "payment failed")
Check: does any existing spec cover this case?
  → No → report_bug(bugType: "gap", description: "...", expectedBehaviour: "...")
  → Yes but test passing → report_bug(bugType: "spec-defect")
```

### Success condition not met
```
Signal: query_metrics shows onboarding completion rate at 42%, target 70%
Hypothesis: non-functional bug (feature not achieving its success condition)

Check PRODUCT.md: what does the telemetry spec say?
  → Is the event emitting correctly? query_logs(pattern: "onboarding.completed")
  → If events are there but rate is low: non-functional bug — the UX or flow is failing
  → report_bug(bugType: "non-functional", description: "onboarding completion at 42%, target 70%")
  → The spec: "Given a new user, after completing onboarding, completion rate >= 70%"
```

### High escalation or abandonment rate
```
Signal: 40% of sessions abandon at step 3 of onboarding
Hypothesis: the step is too hard, confusing, or broken

This is likely a new acceptance spec needed:
  → "As a new user, I can complete step 3 without confusion"
  → May need instrumented prototype session to understand WHY before speccing the fix
  → /feature prompt with the acceptance criteria derived from the abandonment data
```

### Users attempting something unsupported
```
Signal: logs show "feature X not found" 200 times/day
Hypothesis: users want feature X, it doesn't exist

This is a new feature requirement:
  → Document as a specified item in ROADMAP.md
  → Run measurement-design to define success conditions for the new feature
  → /feature prompt once success conditions are clear
```

### Telemetry gap (events missing)
```
Signal: PRODUCT.md specifies "payment.completed" event but query_logs shows nothing
Hypothesis: telemetry spec not implemented

This is NOT a bug report — it means the BDD cycle was incomplete:
  → The acceptance spec should have asserted the event fires
  → Go back to the feature's spec and add the telemetry assertion
  → Run the BDD cycle again (the missing assertion will fail → RED)
```

## The Signal Review Format

After `query_signals`, present findings to the user in this structure:

```
Signal Review — [date]
Sources: logs, errors, metrics

HIGH PRIORITY
1. [source] [title]
   Evidence: [what the data shows]
   Suggested: [report_bug / /feature / update PRODUCT.md]
   Estimated impact: [users affected / frequency]

MEDIUM PRIORITY
2. ...

ACTION REQUIRED FROM USER:
For each signal: approve (start BDD cycle), defer (add to ROADMAP), or dismiss (expected behaviour)
```

Never start a BDD cycle from a signal without explicit user approval. Signals are candidates, not mandates.

## Prioritisation

Order signals by:
1. **Impact × frequency** — high-frequency errors affecting many users first
2. **Success condition proximity** — if a success condition is close to threshold, prioritise
3. **Reversibility** — data loss or security issues always top priority regardless of frequency
4. **Recency** — new signals (last 24h) before ongoing known issues
