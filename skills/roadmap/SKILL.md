---
name: roadmap
description: The roadmap/ convention for design artifacts. Describes the file format, status tracking, and universal core that every design artifact must have. Load when creating or consuming roadmap items.
---

# The Roadmap

Design artifacts live in `roadmap/` in the project repo, as a numbered, ordered sequence:

```
roadmap/
├── 01-project-setup.md
├── 02-core-data-model.md
├── 03-recipe-search.md
├── 04-user-avatars.md
└── 05-fix-login-edge-case.md
```

The number prefix defines the build order. The coding loop works through them sequentially — it should not skip ahead, because later items may depend on earlier ones.

## Status Tracking

Each file has YAML frontmatter with a `status` field:

```yaml
---
status: queued     # queued → building → done
---
```

The coding loop picks up the first `queued` item, marks it `building`, works through it via BDD, and marks it `done` when complete.

## File Format

Each design artifact is a markdown document with a universal core — four sections that are always present regardless of what you're building.

```markdown
---
status: queued
---
# [Title]

## Problem
[What we're building and why — one or two sentences]

## Behaviour
[How it should behave, from the outside]

## Acceptance Criteria
- Given ..., when ..., then ...
- Given ..., when ..., then ...

## Constraints
- ...
- ...

## [Any additional design sections]
...
```

Additional sections beyond the core can contain anything that helps the coding loop: UI design, API design, technical architecture, game mechanics, visual design, data model — whatever was explored during the design conversation. The coding loop uses whatever is there and doesn't require a specific structure for these extra sections.

## The Universal Core

### Problem

What we're building and why. Short and clear.

**Good:** "Users can't find recipes by ingredient, so they leave the app when looking for something specific."

**Good:** "The build script doesn't handle Windows paths, so CI fails on Windows runners."

**Vague:** "We need better search." (Better than what? For whom? Why?)

If you can't state the problem concisely, it probably needs to be broken down into multiple roadmap items.

### Behaviour

How the thing should behave, described from the outside — from the perspective of whoever uses it (a user, a caller, an operator, a player).

This is NOT internal design. It's what the thing does, not how it works. The coding loop figures out the internals.

Describe:
- What the thing does in the normal case
- What happens in important edge cases
- What the observable states and transitions are

The level of detail depends on complexity. A script might need two sentences. A game mechanic might need a page.

### Acceptance Criteria

Specific, testable scenarios that define "done." These map directly to BDD acceptance specs.

Format: **Given** [context], **when** [action], **then** [outcome].

Cover:
- The happy path
- Important edge cases
- Boundary conditions

Don't try to be exhaustive — the coding loop will discover additional scenarios during outside-in decomposition. But cover enough that the broad behaviour is specified.

### Constraints

What NOT to do. Boundaries the coding loop should stay within:
- Things that must not break
- Compatibility requirements
- Resource limits
- Scope limits
- Technology constraints (e.g. "use `npx sv create`", "use the existing design system")

## Who Writes These Files?

Anyone or anything. The coding loop doesn't care where the file came from:
- A design conversation in pi (with whatever design skills are relevant)
- A product research agent
- A human writing markdown directly
- Any combination

The `roadmap/` directory is the interface between design and implementation. It decouples them completely — design can run ahead, queueing up multiple items, while the coding loop works through them at its own pace.

## Cold Start

For a new project, the first roadmap item should describe the project setup:

```markdown
---
status: queued
---
# Project Setup

## Problem
We need a SvelteKit web app for the recipe project.

## Behaviour
A fresh SvelteKit project with TypeScript, using canonical scaffolding.

## Acceptance Criteria
- Given the project is set up, the dev server starts and shows the default page
- Given vitest is configured, `npm test` runs successfully

## Constraints
- Use `npx sv create` — don't build the directory structure manually
- TypeScript, not JavaScript
```

This ensures the coding loop uses canonical tooling rather than guessing at project structure.
