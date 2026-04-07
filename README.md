# pi-bdd

Outside-in BDD for the [pi coding agent](https://github.com/badlogic/pi-mono). Implements the **coding loop** of the [software lifecycle](https://github.com/jfairbairn/pi-software-lifecycle): design → spec → build → verify, enforced through red-green-refactor discipline.

## What It Does

**Enforces** (mechanically, not by suggestion):
- Outside-in BDD: the agent cannot write production code until a failing test is confirmed
- Red-green-refactor: phases are driven by actual test output, not agent judgment
- REFACTOR boundary: write-locks declared spec files to preserve behavioural contracts
- Semantic git history: every phase boundary commits with a meaningful message

**Supports** any language and test framework: Vitest, Jest, RSpec, pytest, go test, cargo test, and others.

## Installation

```bash
pi install git:github.com/jfairbairn/pi-bdd
```

Optionally install the lifecycle coordination layer for integration with delivery, observation, and steering plugins:

```bash
pi install @jfairbairn/pi-software-lifecycle
```

## Setup

Create `.pi/bdd.config.json` in your project (or run `/bdd-setup` to auto-detect):

```json
{
  "productionPaths": ["src/"],
  "testPaths": ["tests/"],
  "testFilePatterns": ["\\.test\\.", "\\.spec\\."],
  "testCommand": "npm test"
}
```

Use `/feature` to start your first BDD cycle.

## Tools

| Tool | What it does |
|------|-------------|
| `run_tests` | Run tests and advance BDD phase (the only way to confirm RED or GREEN) |
| `set_bdd_phase` | Advance to REFACTOR, IDLE, or AWAITING_RED |
| `report_bug` | Start a bug fix cycle with type classification |

## Commands

| Command | What it shows |
|---------|--------------|
| `/bdd` | Current BDD phase and state |
| `/bdd-setup` | Auto-detect stack and create config |

## Prompts

| Prompt | When to use |
|--------|------------|
| `/feature` | Start a new feature with outside-in BDD |
| `/scenario` | Add a scenario to an existing feature |
| `/bugfix` | Start a bug fix cycle |
| `/refactor` | Enter the refactor phase |

## Skills

| Skill | What it teaches the agent |
|-------|--------------------------|
| `bdd-workflow` | The full outside-in red-green-refactor cycle |
| `bdd-testing-strategy` | How to choose the right spec style for each layer |
| `bdd-acceptance-spec` | Writing acceptance-level specs (Gherkin and plain) |
| `bdd-bug-workflow` | BDD approach to bug fixing (four bug types) |
| `bdd-refactor` | Safe refactoring within the REFACTOR phase |

## Lifecycle Integration

When `@jfairbairn/pi-software-lifecycle` is installed, pi-bdd:
- Registers as a **coding loop** implementation
- Emits `lifecycle:coding_complete` when a BDD cycle reaches IDLE
- Delivery plugins (if any) can listen for this to trigger their workflow

Without the lifecycle package, pi-bdd works standalone — just the BDD discipline, nothing else.

## Requirements

- [pi coding agent](https://github.com/badlogic/pi-mono) installed

## License

MIT
