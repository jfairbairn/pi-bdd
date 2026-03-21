---
name: release-gate
description: Guidance for the six release readiness gates — from BDD IDLE to production deployment. Covers what each gate checks, what passes it, what blocks it, and the Coolify/Docker Compose staging workflow.
---

# Release Gate

## The Six Gates

```
IDLE
  │
  Gate 1: Functional correctness   ← auto (BDD cycle complete)
  Gate 2: Security                 ← auto (security_scan)
  │          │
  │    [manual review flagged?]── PAUSE ── human reviews diff ── mark_gate_passed(2)
  │          │
  │    [clean pass]
  │          │
  │          ▼  ← Gates 3, 4, 5 run automatically in parallel ─────────────┐
  │                                                                         │
  Gate 3: Non-functional      Gate 4: Pre-production staging    Gate 5: Measurement
  (load/perf tests)           (deploy → sanitise → migrate      (check_success_
                               → health → test suite)            conditions)
  │
  [all three complete]
  │
  Gate 6: Rollback readiness   ← ONLY human checkpoint before production
  │
DEPLOYED
```

**Staging is autonomous when security passes. Production requires Gate 6 human confirmation.**

The system sends a follow-up message automatically when Gate 2 passes cleanly, instructing the agent to call `check_release_readiness`. You do not need to manually trigger staging deployment.

Use `/release` to see current gate status at any time.

## Gate 1: Functional Correctness

**Auto-passes** when the BDD cycle reaches IDLE. All tests are green; the implementation satisfies its specs. Nothing to do here — it's tracked automatically from the `bdd:phase_change` event.

## Gate 2: Security

**Auto-evaluated** from the `security_scan` result. Critical/high findings block this gate. Medium/low findings pass it with a note.

If manual security review was flagged (auth, payments, crypto, PII, agent tools), Gate 2 stays pending until the review is complete. After completing the security-review checklist:
```
mark_gate_passed(2, notes: "Reviewed auth changes — no user enumeration, constant-time comparison in place")
```

## Gate 3: Non-Functional Requirements

**Auto-runs** the `nonFunctional.testCommand` from release.config.json. If not configured, gate is skipped.

Configure a load test (k6, locust, wrk) or performance benchmark. The command must exit 0 on pass, non-zero on fail.

```bash
# Example: k6 run with exit code based on thresholds
k6 run --out json=results.json load-test.js
```

If no automated test exists, skip the gate or mark it passed manually after manual performance assessment:
```
mark_gate_passed(3, notes: "Load tested manually — p95 latency 180ms at 100 rps, well within 500ms threshold")
```

## Gate 4: Pre-Production Staging

**Auto-runs** — the most important gate for catching real-data issues.

**Note:** Gate 4 will FAIL (not skip) if `release.config.json` has no staging section, unless gate 4 is listed in `skipGates`. Missing staging config is a deployment blocker. To skip deliberately, add `4` to `skipGates` in release.config.json — but this means deploying without staging validation, which is not recommended.

Steps executed in order:
1. **Deploy** — runs `staging.deployCommand` (Coolify deploy or docker compose up)
2. **Health check** — polls `staging.url` + `staging.healthCheckPath` until 2xx (up to 2 minutes)
3. **Sanitisation check** — runs `staging.sanitisationCheckQuery` to verify no real PII in staging DB
4. **Migrations** — runs `staging.migrationsCommand` against the staging database
5. **Tests** — runs `staging.testCommand` against the staging environment

**Why staging against real data matters:** Migrations that pass on synthetic test data sometimes fail on real data (unexpected nulls, constraint violations, volume-related timeouts). Gate 4 catches these before they reach production.

**If Gate 4 fails on migrations:** Fix the migration and restart the gate. Never skip this failure.

**The sanitisation check** is critical — staging data is restored from production via wal-g. If the sanitisation script hasn't run or missed a field, staging contains real PII. The check query should return 0 for a sanitised database:

```sql
-- Example sanitisation check (run via psql or similar)
-- Returns count of rows with real-looking email addresses (should be 0 after sanitisation)
psql $STAGING_DATABASE_URL -c "SELECT COUNT(*) FROM users WHERE email NOT LIKE '%@staging.%' AND email NOT LIKE '%@example.%'"
```

## Gate 5: Measurement Readiness

**Auto-runs** by checking PRODUCT.md for HogQL queries, then prompts you to run `check_success_conditions`.

Two things must be true:
1. PRODUCT.md has measurable success conditions with HogQL queries
2. Those queries return data (events are being emitted from the staging/production environment)

After running `check_success_conditions`:
- **All met:** `mark_gate_passed(5, notes: "Onboarding completion 72% (target 70%), payment error 0.08% (target <0.1%)")`
- **Not met (new feature, no data yet):** `mark_gate_passed(5, notes: "Recently deployed — 0 events yet. Will monitor via signal-review.")`
- **Not met (significant miss):** **Do not pass.** This is a product-level signal — load signal-to-spec.
- **No data (events not emitting):** **Do not pass.** The telemetry spec is not implemented — BDD cycle incomplete.

## Gate 6: Rollback Readiness

**Human checklist.** The extension will ask four questions interactively. Answer honestly.

Key questions:
- Is the rollback procedure documented? (Which command, who runs it, how long does it take?)
- If there's a migration: is it reversible? If not, what's the risk acceptance?
- Has the procedure been mentally rehearsed for this specific deployment?
- Is someone available to monitor for the next 24-48 hours?

For Coolify + Docker Compose deployments: rollback is typically redeploying the previous image tag. Document the exact command before deploying.

## After All Gates Pass

```
1. Run production deploy command (from release.config.json production.deployCommand)
2. Run production migrations (production.migrationsCommand)
3. Confirm production health check passes
4. Monitor error rates for 30 minutes
5. update_roadmap(feature, "deployed")
6. update_doc_status(component-README, "deployed")
7. Update PRODUCT.md validation status: "collecting data"
```

## Coolify-Specific Notes

Coolify exposes a REST API for triggering deployments. The deploy command in release.config.json would be:
```bash
curl -X POST "https://coolify.yourdomain.com/api/v1/deploy?uuid=APP_UUID&force=false" \
  -H "Authorization: Bearer $COOLIFY_API_TOKEN"
```

Or if using git-based deploys, a simple push to the staging branch:
```bash
git push staging main
```

Configure whichever matches your Coolify setup in `staging.deployCommand`.
