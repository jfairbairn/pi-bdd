---
name: measurement-design
description: Translates product success conditions into a telemetry spec — the specific events, metrics, and properties required to make success measurable in production. Load before writing a /feature spec, when defining PRODUCT.md, or when Gate 5 (measurement readiness) needs to be verified.
---

# Measurement Design

## The Core Question

Before writing a line of code or a line of spec, the team must be able to answer: **how will we know, from production data, whether this feature achieved what we built it to achieve?**

If that question doesn't have a specific, measurable answer, the success condition isn't defined yet. Vague conditions ("users will find it easier", "it will be faster") are not success conditions — they are hopes. A success condition must be falsifiable by data.

## From Success Condition to Telemetry Spec

The translation has two steps:

**Step 1: Make the success condition specific and measurable**

| Vague | Specific |
|-------|----------|
| Users complete onboarding | 70% of new users complete all 3 onboarding steps within their first session |
| The feature is fast | 95th percentile response time < 2 seconds at 100 concurrent users |
| Errors are rare | Payment failure rate < 0.1% of initiated transactions |
| Users engage with it | Feature used by ≥ 40% of active users within 30 days of release |

A good success condition names: the metric, the threshold, the time window or context, and the population.

**Step 2: Derive the telemetry required to compute it**

For each success condition, ask: "What events, with what properties, allow me to compute this?"

```
Success condition:
  "70% of new users complete all 3 onboarding steps within their first session"

Required events:
  onboarding.step_completed
    properties: user_id, step_number (1|2|3), session_id, timestamp

  onboarding.completed
    properties: user_id, session_id, total_duration_seconds, timestamp

  onboarding.abandoned
    properties: user_id, session_id, last_step_reached, reason (optional), timestamp

How the metric is computed:
  rate = count(onboarding.completed WHERE first_session = true)
       / count(users WHERE created_at > feature_release_date)
  target: ≥ 0.70
```

**Checklist for a complete telemetry spec:**
- [ ] Every success condition maps to at least one event or metric
- [ ] Events carry enough properties to compute the condition (user_id, timestamps, relevant context)
- [ ] Happy path AND abandonment/failure paths are covered (you need both to understand the full picture)
- [ ] Events fire at the right granularity — not so coarse you can't distinguish cases, not so fine you drown in noise

## Common Telemetry Patterns by Success Condition Type

### Funnel / completion rate
"X% of users complete Y"

Events needed: step_started, step_completed, step_abandoned for each step, plus an overall completion event. Properties: user_id, session_id, step identifier, timestamps.

### Latency / performance
"P95 latency < N ms"

Events needed: a timing event at the operation boundary. Properties: duration_ms, operation_name, relevant context (e.g. payload_size, user_tier). Compute percentiles on the duration field.

### Error rate
"Error rate < X%"

Events needed: request_succeeded, request_failed. Properties: error_type, error_code, context. Rate = failed / (succeeded + failed).

### Adoption / engagement
"Feature used by ≥ X% of active users within N days"

Events needed: feature_used (once per use) and a user_active event or cohort definition. Properties: user_id, timestamp, feature_name. Compute: distinct users with feature_used / distinct active users.

### Quality (for AI output)
"Users accept AI output without editing ≥ X% of the time"

Events needed: output_accepted, output_edited (with diff summary), output_rejected. Properties: user_id, session_id, output_type. Rate = accepted / (accepted + edited + rejected).

## When to Raise a Design Concern

If you cannot derive a telemetry spec from the success condition, the success condition may be:

- **Unmeasurable as stated** — no events could compute it; needs refinement
- **Measuring the wrong thing** — the metric is a proxy, not the actual outcome; push back on the condition itself
- **Too expensive to instrument** — the events required would be prohibitively costly to emit or store; negotiate a lower-fidelity approximation

Raise the concern before writing code. A feature built toward an unmeasurable success condition cannot be validated.

## Telemetry Spec in the BDD Cycle

Once the spec is defined, event emission becomes a first-class requirement in the BDD cycle:

```
Scenario: User completes onboarding step 2
  Given a new user on onboarding step 2
  When they complete the step
  Then they advance to step 3
  And an onboarding.step_completed event is emitted
    with step_number: 2, user_id, and session_id
```

The event emission is testable — assert in the acceptance spec that the event fires with the correct properties. This ensures the telemetry is present from day one in production, not as an afterthought.

## Output: What to Write in PRODUCT.md

After running this skill, the output goes into PRODUCT.md under the feature's section:

1. **The refined success conditions** — specific, measurable, falsifiable
2. **The telemetry spec table** — event name, trigger, required properties
3. **A HogQL query for each success condition** — this is what `check_success_conditions` runs automatically
4. **Initial validation status** — "not yet deployed"

### Writing the HogQL Query

Each success condition needs a corresponding HogQL query that computes it. HogQL is standard SQL against the PostHog `events` table. The query must include a `-- target:` comment so `check_success_conditions` knows what "success" means.

**Key columns:** `event` (event name), `timestamp`, `distinct_id` (user ID), `properties` (JSON — access with `properties.field_name`)

**Template:**
```sql
-- [Describe what this measures]
SELECT [metric expression] AS [name]
FROM events
WHERE timestamp >= now() - interval 30 day
  AND [any additional filters]
-- target: [threshold, e.g. 0.70 for 70%, 1000 for count]
```

**Examples by success condition type:**

Completion rate:
```sql
-- Onboarding completion rate (new users, first session)
SELECT countIf(event = 'onboarding.completed') / countIf(event = 'onboarding.started') AS rate
FROM events
WHERE timestamp >= now() - interval 30 day
-- target: >= 0.70
```

Feature adoption:
```sql
-- % of active users who used the export feature
SELECT uniqIf(distinct_id, event = 'export.initiated') / uniq(distinct_id) AS adoption_rate
FROM events
WHERE timestamp >= now() - interval 30 day
  AND event IN ('export.initiated', 'session.started')
-- target: 0.40
```

Error rate:
```sql
-- Payment error rate
SELECT countIf(event = 'payment.failed') / countIf(event = 'payment.initiated') AS error_rate
FROM events
WHERE timestamp >= now() - interval 7 day
-- target: 0.001
```

AI output quality:
```sql
-- AI output acceptance rate (not edited or rejected)
SELECT countIf(event = 'ai_output.accepted') / countIf(event IN ('ai_output.accepted', 'ai_output.edited', 'ai_output.rejected')) AS acceptance_rate
FROM events
WHERE timestamp >= now() - interval 30 day
-- target: 0.60
```

### Verification

After adding the HogQL queries to PRODUCT.md:
1. Run `query_analytics` with the query manually to confirm it returns a value
2. If it returns null/no data → the events aren't being emitted yet (telemetry spec not implemented)
3. If it returns a value → Gate 5 check will be automated going forward

This is the artifact that Gate 5 (measurement readiness) checks. `check_success_conditions` reads these queries directly from PRODUCT.md and runs them against PostHog automatically.
