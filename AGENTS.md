# BDD Project Configuration
# Copy this to your project root as AGENTS.md and fill in the blanks.

## BDD Method

This project uses outside-in BDD with strict red-green-refactor enforcement.

Rules (enforced by the bdd-enforcer extension):
1. Never write to production paths before a failing test is confirmed
2. Never write production code before running tests and seeing them fail
3. Write the minimum code to make the test pass — no speculative implementation
4. Refactor only when tests are green
5. Every phase boundary (RED, GREEN, REFACTOR complete) is a git commit

## Stack

Language: [TypeScript / Ruby / Python / Go]
Test framework: [Vitest / RSpec / pytest / go test]
Test command: npm test
Acceptance layer: [Cucumber+Gherkin / plain Vitest describe / Playwright / RSpec feature specs]
HTTP testing: [supertest / rack-test / httpx / net/http/httptest]
UI testing: [@testing-library/react / @testing-library/vue / Capybara]
DB fixtures: [knex seeds / factory_bot / pytest fixtures / testcontainers]

## File Layout

Production code:  src/          (lib/ for shared libraries)
Test/spec code:   tests/        (or spec/ for RSpec projects)
Feature files:    features/     (Gherkin only)
Fixtures:         tests/fixtures/
Mocks:            tests/mocks/  (or __mocks__/ for Jest/Vitest auto-mocking)
Test helpers:     tests/support/ (or spec/support/)

## BDD Config (.pi/bdd.config.json)

Create this file to override defaults:

```json
{
  "productionPaths": ["src/", "lib/"],
  "testPaths": ["tests/", "spec/", "features/", "__tests__/"],
  "testFilePatterns": ["\\.test\\.", "\\.spec\\.", "\\.feature$"],
  "testCommand": "npm test"
}
```

## Naming Conventions

Spec files mirror source files:
  src/auth/AuthService.ts       → tests/auth/AuthService.test.ts
  src/components/LoginForm.tsx  → tests/components/LoginForm.test.tsx
  app/models/user.rb            → spec/models/user_spec.rb

## Test Data

Use builder functions (not literals) for test data:
  tests/builders/userBuilder.ts    (or spec/factories/ with FactoryBot)

Fixtures (for persistence tests) live in:
  tests/fixtures/

## Documentation

Minimum-viable documentation per component: README.md in component directory.
Six categories: purpose, what it does, how it does it, status, decisions, roadmap.
Tests are documentation of behaviour — prose only for what tests don't express.

Project roadmap: ROADMAP.md at root — tracks all features through specified→implementing→implemented→deployed.
Product success conditions: PRODUCT.md at root — defines measurable success conditions and telemetry
  specs per feature. Required for Gate 5 (measurement readiness) of release readiness.
Component templates: pi-bdd/templates/component-README.md, pi-bdd/templates/PRODUCT.md

Documentation tools: check_docs, update_doc_status, update_roadmap

## Release Gate

Release config: .pi/release.config.json (see pi-bdd/templates/release.config.json)
Staging URL: [https://staging.myapp.com]
Production URL: [https://myapp.com]
Coolify API token: COOLIFY_API_TOKEN (environment variable)

Commands: /release — show gate status
Tools: check_release_readiness, mark_gate_passed

Six gates between IDLE and deployed:
  1. Functional correctness (auto — BDD cycle)
  2. Security (auto — security_scan)
  3. Non-functional (auto — configured load test)
  4. Pre-production staging (auto — deploy + migrate + health + test)
  5. Measurement readiness (auto — check_success_conditions)
  6. Rollback readiness (human checklist)

## Security

Security config (optional): .pi/security.config.json (see pi-bdd/templates/security.config.json)
Tools required: gitleaks (brew install gitleaks), semgrep (brew install semgrep)
Auto-scan: runs after every BDD cycle IDLE transition
Pre-commit hook: run setup_precommit once to catch secrets before every commit

Commands: /security — show status
Tools: security_scan, setup_precommit

## Production Telemetry Access

Telemetry config: .pi/telemetry.config.json (see pi-bdd/templates/telemetry.config.json)
Credentials: [e.g. SENTRY_AUTH_TOKEN, DD_API_KEY in environment]

Commands:
  /telemetry       — show configured sources
  /signal-review   — run closed-loop production signal review

Tools: query_logs, query_errors, query_metrics, query_analytics, query_signals,
       check_success_conditions

## Common Commands

Run all tests:    [npm test]
Run focused:      [npx vitest run src/auth]
Run single file:  [npx vitest run tests/auth/AuthService.test.ts]
Watch mode:       [npx vitest]
Coverage:         [npx vitest --coverage]
