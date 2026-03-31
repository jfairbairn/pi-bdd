# pi-bdd

**Status:** implemented

Agentic software delivery system for the [pi coding agent](https://github.com/badlogic/pi-mono). Enforces outside-in BDD discipline, runs security scans, orchestrates staged deployment, and measures product success — from requirements to production.

**Design:** A set of pi extensions that intercept tool calls and session events to enforce the BDD state machine. The `bdd-enforcer` extension owns the write gate (blocks production writes before RED), phase transitions (driven only by real test output), and the REFACTOR boundary (write-locks declared spec files). Other extensions layer on security scanning, release gates, and telemetry access — all wired through the same event bus.

## What It Does

**Enforces** (mechanically, not by suggestion):
- Outside-in BDD: the agent cannot write production code until a failing test is confirmed
- Red-green-refactor: phases are driven by actual test output, not agent judgment
- Semantic git history: every phase boundary commits with a meaningful message

**Automates** (when the project is configured):
- Pre-commit secrets detection and post-cycle security scanning (SAST, dependency auditing)
- Six-gate release readiness: staging deployment against sanitised production data, migrations, acceptance tests, product measurement
- Closed-loop signal review: production data maps back to BDD cycle inputs

## Installation

```bash
pi install git:github.com/jfairbairn/pi-bdd
```

This makes the extensions, skills, and prompt templates available in all projects.

## New Project Setup

In a new project directory:

```bash
# Start pi
pi

# First-run prompt appears automatically, or run manually:
/bdd-setup
```

`/bdd-setup` detects your stack, creates `AGENTS.md`, `.pi/bdd.config.json`, `PRODUCT.md`, `ROADMAP.md`, and example config files. Then:

```
setup_precommit    # install pre-commit secrets hook
```

You're ready to build. Use `/feature` to start your first BDD cycle.

## Prompts

| Prompt | When to use |
|--------|------------|
| `/feature` | Start a new feature — captures success conditions and telemetry spec |
| `/scenario` | Add a scenario to an existing feature |
| `/bugfix` | Start a bug fix cycle with the diagnostic flow |
| `/refactor` | Enter the refactor phase |
| `/release` | Run the six release gates before deploying to production |
| `/signal-review` | Closed-loop: surface production signals as BDD cycle inputs |

## Tools

| Tool | What it does |
|------|-------------|
| `run_tests` | Run tests and advance BDD phase (the only thing that can confirm RED or GREEN) |
| `set_bdd_phase` | Advance to REFACTOR, IDLE, or AWAITING_RED |
| `report_bug` | Start a bug fix cycle with type classification |
| `check_docs` | Verify minimum-viable documentation at IDLE transition |
| `update_roadmap` | Move a feature through the R→I→D loop in ROADMAP.md |
| `update_doc_status` | Update component status (implementing → implemented → deployed) |
| `security_scan` | Run secrets detection, SAST, and dependency scanning |
| `setup_precommit` | Install pre-commit secrets hook |
| `check_release_readiness` | Orchestrate all six release gates |
| `mark_gate_passed` | Manually pass a gate after human verification |
| `query_logs` | Search production logs |
| `query_errors` | Get grouped error summary from error tracking |
| `query_metrics` | Query infrastructure metrics |
| `query_analytics` | Run HogQL query against PostHog |
| `query_signals` | Combined product + technical signal review |
| `check_success_conditions` | Verify PRODUCT.md success conditions against live production data |

## Commands

| Command | What it shows |
|---------|--------------|
| `/bdd` | Current BDD phase and state |
| `/bdd-setup` | First-run project setup |
| `/docs` | ROADMAP.md status |
| `/security` | Security config status |
| `/telemetry` | Telemetry config status |
| `/release` | Release gate status |

## Configuration

`/bdd-setup` creates these files with sensible defaults. Edit them for your project:

**.pi/bdd.config.json** — required
```json
{
  "productionPaths": ["src/"],
  "testPaths": ["tests/"],
  "testFilePatterns": ["\\.test\\.", "\\.spec\\."],
  "testCommand": "npm test"
}
```

**.pi/release.config.json** — needed for staging deployment (Gate 4)
See `.pi/release.config.json.example` created by `/bdd-setup`.

**.pi/telemetry.config.json** — needed for product analytics and measurement (Gate 5)
See `.pi/telemetry.config.json.example` created by `/bdd-setup`.

## The Delivery Flow

```
/feature → BDD cycle → security_scan → release gates → production
                                            │
                          ┌─────────────────┼──────────────────┐
                          │                 │                   │
                     Gate 3:           Gate 4:             Gate 5:
                     load tests        staging             PostHog
                                    (deploy → sanitise     success
                                     → migrate → test)   conditions
                                          │
                                     Gate 6: human confirms rollback
                                          │
                                     production deploy
```

Staging is autonomous when security passes. Gate 6 is the only human checkpoint before production.

## Requirements

- [pi coding agent](https://github.com/badlogic/pi-mono) installed
- `gitleaks` for secrets scanning: `brew install gitleaks`
- `semgrep` for SAST: `brew install semgrep`
- PostHog for product analytics (self-hosted or cloud)
- A configured staging environment for Gate 4

## License

MIT
