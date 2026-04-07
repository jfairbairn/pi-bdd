# pi-bdd

Outside-in BDD for the [pi coding agent](https://github.com/badlogic/pi-mono). Red-green-refactor discipline with a write gate, semantic git commits, and a `roadmap/` convention for feeding design artifacts into the coding loop.

## How It Works

**Design** your features however you like — conversation with an AI, a product research agent, or just writing markdown. Put the design artifacts in `roadmap/` as numbered files.

**Build** with `/build`. The coding loop picks up the next queued item and implements it via BDD — writing tests first, confirming they fail, implementing the minimum code, confirming they pass, refactoring.

```
roadmap/                          The interface between design and implementation
├── 01-project-setup.md           ← done
├── 02-recipe-search.md           ← building (BDD cycles in progress)
├── 03-user-avatars.md            ← queued (next up)
└── 04-fix-login-edge-case.md     ← queued
```

## The Roadmap Convention

Each file in `roadmap/` is a markdown design artifact with:

```markdown
---
status: queued
---
# Recipe Search

## Problem
Users can't find recipes by ingredient.

## Behaviour
Search bar at top of list, filters as you type.

## Acceptance Criteria
- Given recipes with "chicken", when I search "chicken", then I see those recipes
- Given no matches, when I search "xyzzy", then I see "No results"

## Constraints
- Don't modify the recipes table schema
- Use the existing design system components
```

**Problem, Behaviour, Acceptance Criteria, Constraints** — always present. Additional sections (UI design, API design, technical architecture, etc.) can be added from whatever design skills you use. Load the `roadmap` skill for the full format specification.

## What It Enforces

Mechanically, not by suggestion:
- **Write gate**: cannot write production code until a failing test is confirmed
- **Phase transitions**: driven by actual test output, not agent judgment
- **REFACTOR boundary**: write-locks declared spec files to preserve contracts
- **Semantic git history**: every phase boundary commits with a meaningful message

## Installation

```bash
pi install git:github.com/jfairbairn/pi-bdd
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

## Prompts

| Prompt | When to use |
|--------|------------|
| `/build` | Work through the next roadmap item via BDD |
| `/bugfix` | Start a bug fix cycle |

## Commands

| Command | What it does |
|---------|-------------|
| `/bdd-setup` | Detect stack and create `.pi/bdd.config.json` |
| `/bdd` | Show current BDD phase, state, and config |

## Tools

| Tool | What it does |
|------|-------------|
| `run_tests` | Run tests and advance BDD phase (the only way to confirm RED or GREEN) |
| `set_bdd_phase` | Advance to REFACTOR, IDLE, or AWAITING_RED |
| `report_bug` | Start a bug fix cycle with type classification |

## Skills

| Skill | What it teaches the agent |
|-------|--------------------------|
| `roadmap` | The `roadmap/` file format, status tracking, universal core |
| `bdd-workflow` | The full outside-in red-green-refactor cycle |
| `bdd-testing-strategy` | How to choose the right spec style for each layer |
| `bdd-acceptance-spec` | Writing acceptance-level specs (Gherkin and plain) |
| `bdd-bug-workflow` | BDD approach to bug fixing (four bug types) |
| `bdd-refactor` | Safe refactoring within the REFACTOR phase |

## Bring Your Own Design Skills

Pi-bdd has no opinion on how you design. The `roadmap/` format is the contract. Use whatever design skills suit your project:

- Anthropic's frontend design skill for web UIs
- A game design skill for game mechanics
- Your own domain-specific skills
- Or just write the markdown by hand

As long as the design artifact has the universal core (problem, behaviour, acceptance criteria, constraints), the coding loop can implement it.

## Autonomous Operation

The coding loop runs autonomously when given a populated `roadmap/` directory:

```bash
while true; do
  git pull --rebase
  pi --no-input --prompt "/build"
  [ $? -ne 0 ] && break
  git push
done
```

The git checkpoint extension auto-commits at every BDD phase boundary with semantic messages (`test(red):`, `feat(green):`, `fix:`, `refactor:`).

## Requirements

- [pi coding agent](https://github.com/badlogic/pi-mono) installed

## License

MIT
