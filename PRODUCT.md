# Product

> What this product is for, and how we'll know it's working.

## Purpose

[One paragraph: what problem does this product solve, for whom, and why it matters.]

---

## Success Conditions

Each feature's success conditions define the measurable outcomes that confirm it is working as intended. They are hypotheses — resolved by production data after deployment.

Format: "We will know [feature] is working when [specific measurable outcome]."

### [Feature name]

**We will know this is working when:**
- [Specific measurable condition, e.g. "70% of new users complete onboarding in their first session"]
- [Specific measurable condition, e.g. "payment error rate stays below 0.1%"]
- [Performance condition if applicable, e.g. "95th percentile checkout latency < 3 seconds"]

**Telemetry spec** (events required to measure the above):

| Event | Trigger | Required properties |
|-------|---------|-------------------|
| `[event.name]` | [When it fires] | [Properties needed to compute success conditions] |

**Success condition queries (HogQL):**

Use `check_success_conditions` to run these automatically. Format: SQL query + `-- target:` comment.

```sql
-- [Describe what this measures]
SELECT countIf(event = 'feature.completed') / countIf(event = 'feature.started') AS rate
FROM events
WHERE timestamp >= now() - interval 30 day
-- target: 0.70
```

```sql
-- [Describe what this measures — one query per success condition]
SELECT count() AS adoption_count
FROM events
WHERE event = 'feature.used'
  AND timestamp >= now() - interval 30 day
-- target: 1000
```

**Validation status:** not yet deployed / collecting data / confirmed / refuted

---

## Notes

- Success conditions should be specific enough to be falsifiable — "users like it" is not measurable
- The telemetry spec is a first-class requirement: event emission is specced and tested in the BDD cycle
- Gate 5 of release readiness (measurement readiness) cannot pass without success conditions and a telemetry spec
- Validation status is updated once sufficient production data has been collected
