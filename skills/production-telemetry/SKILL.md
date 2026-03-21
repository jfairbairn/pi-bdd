---
name: production-telemetry
description: How to query and interpret production telemetry using the telemetry-access tools. Load when investigating production issues, running a signal review, verifying Gate 5 (measurement readiness), or closing the loop from production back to the BDD cycle.
---

# Production Telemetry

## The Six Tools

| Tool | When to use |
|------|------------|
| `query_logs` | Investigate a specific error, trace a request, or search for a pattern |
| `query_errors` | Get grouped error summary sorted by frequency |
| `query_metrics` | Check infrastructure metrics (latency, throughput, error rate) |
| `query_analytics` | Run a HogQL query against PostHog — funnels, adoption, user behaviour |
| `check_success_conditions` | Read PRODUCT.md and verify all deployed success conditions automatically |
| `query_signals` | Comprehensive signal review — product signals + technical health (closed loop) |

**The key distinction:**
- `query_logs`, `query_errors`, `query_metrics` → technical health (is the software broken?)
- `query_analytics`, `check_success_conditions` → product signals (is the software achieving its purpose?)

Check the configured providers with `/telemetry` before querying. If nothing is configured, the tools will tell you what to add to `.pi/telemetry.config.json`.

## Investigating a Reported Issue

When a user reports unexpected behaviour:

```
1. query_logs(pattern: "<error or behaviour described>", timeWindowMinutes: 60)
2. If log lines found → query_errors to see if it's a known group
3. Form a hypothesis about bug type (load bdd-bug-workflow for the diagnostic flow)
4. File with report_bug once the type is confirmed
```

Don't file a bug based on a description alone. Always verify the behaviour exists in production logs/errors before starting the BDD cycle.

## Running a Signal Review

The `/signal-review` prompt is the structured entry point. Manually:

```
1. query_signals(timeWindowMinutes: 1440)  ← last 24h
2. Load signal-to-spec to map each signal to a BDD action
3. Present prioritised list to the user
4. User approves or defers each
5. For approved signals: start the appropriate BDD cycle
```

Signal reviews should be run regularly (weekly or after deployments) to prevent production signals from accumulating unaddressed.

## Verifying Gate 5 (Measurement Readiness)

Before marking a feature as ready to deploy:

```
1. Confirm the telemetry spec is implemented:
   query_logs(pattern: "<event_name>")  → events must appear in logs

2. Confirm success conditions are queryable:
   check_success_conditions(feature: "<feature_name>")

   Possible results:
   ✅ Met / values returned → Gate 5 passes for this condition
   ❌ Not met → valid (feature just deployed; observe over time)
   ⚪ No data → events not emitting → BDD cycle incomplete
   📝 No query → HogQL query missing from PRODUCT.md → add it

3. If "no data": check event emission with query_logs, then re-run
4. If "no query": use measurement-design skill to add HogQL to PRODUCT.md
```

The PostHog UI provides the same data for human inspection — load the events explorer and verify the same events appear there.

Gate 5 passes only when you can confirm: the events exist in the logs AND you can compute the success condition from them.

## Interpreting Common Patterns

**Spike in error logs** → Gap bug. No spec covered this case.
**Errors that were passing, now failing** → Regression. An existing spec should have caught this.
**Metric trending wrong direction** → Check PRODUCT.md: is a success condition being missed?
**Events in logs but wrong properties** → Spec defect in the telemetry spec itself.
**Events not appearing** → Telemetry spec not implemented — BDD cycle incomplete.
**High escalation rate** → Capability gap. The agent/system can't handle this case autonomously.

## What NOT to Do

- ❌ File a bug report without first verifying in logs/errors that the behaviour exists
- ❌ Automatically create specs without presenting signals to the user for approval
- ❌ Treat all log errors as bugs — some are expected and handled correctly
- ❌ Query logs with overly broad patterns — you'll get noise that obscures signal
